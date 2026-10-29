import os
import time
from pathlib import Path
import requests
import numpy as np
from scipy.stats import poisson
from datetime import datetime, timedelta, timezone
from supabase import create_client
from sheets_sync import obtener_config_sheet, sincronizar_apuestas_nuevas


def cargar_dotenv_local():
    """Carga variables desde .env local si existe (para pruebas locales sin dependencias extra)."""
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        return
    for linea in env_path.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, valor = linea.split("=", 1)
        clave = clave.strip()
        valor = valor.strip().strip('"').strip("'")
        if clave and clave not in os.environ:
            os.environ[clave] = valor


cargar_dotenv_local()

# Credenciales desde GitHub Secrets o archivo .env local
FOOTBALL_API_KEY = os.environ["FOOTBALL_API_KEY"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

BASE_URL = "https://api.football-data.org/v4"
HEADERS = {"X-Auth-Token": FOOTBALL_API_KEY}


def resolver_chat_id() -> str:
    """Devuelve TELEGRAM_CHAT_ID o intenta detectarlo automáticamente vía getUpdates."""
    if TELEGRAM_CHAT_ID and TELEGRAM_CHAT_ID != "PENDIENTE":
        return TELEGRAM_CHAT_ID
    try:
        r = requests.get(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates", timeout=10)
        if r.status_code == 200:
            updates = r.json().get("result", [])
            for u in reversed(updates):
                msg = u.get("message") or u.get("channel_post") or {}
                chat = msg.get("chat", {})
                if chat.get("id"):
                    return str(chat["id"])
    except Exception:
        pass
    return ""


def calcular_top_3_poisson(lambda_local: float, lambda_visita: float):
    max_goles = 6
    matriz = np.zeros((max_goles, max_goles))

    for i in range(max_goles):
        for j in range(max_goles):
            matriz[i][j] = poisson.pmf(i, lambda_local) * poisson.pmf(j, lambda_visita)

    mercados = {
        "Victoria Local (1)": float(np.sum(np.tril(matriz, -1))),
        "Empate (X)": float(np.sum(np.diag(matriz))),
        "Victoria Visitante (2)": float(np.sum(np.triu(matriz, 1))),
        "Doble Oportunidad (1X)": float(np.sum(np.tril(matriz, 0))),
        "Doble Oportunidad (X2)": float(np.sum(np.triu(matriz, 0))),
        "Más de 1.5 Goles": float(1 - (matriz[0][0] + matriz[1][0] + matriz[0][1])),
        "Más de 2.5 Goles": float(1 - sum(matriz[i][j] for i in range(3) for j in range(3) if i + j <= 2)),
        "Menos de 3.5 Goles": float(sum(matriz[i][j] for i in range(4) for j in range(4) if i + j <= 3)),
        "Ambos Anotan (Sí)": float(np.sum(matriz[1:, 1:])),
        "Ambos Anotan (No)": float(1 - np.sum(matriz[1:, 1:]))
    }

    # Filtrar probabilidades útiles (entre 53% y 85% -> cuotas aprox entre 1.15 y 1.78)
    filtrados = [(m, p) for m, p in mercados.items() if 0.53 <= p <= 0.85]
    if len(filtrados) < 3:
        filtrados = list(mercados.items())

    top_3 = sorted(filtrados, key=lambda x: x[1], reverse=True)[:3]

    resultados = []
    for nombre, prob in top_3:
        cuota_justa = round(1 / prob, 2)
        # Aplicamos ~6% de margen (vig) de las casas de apuestas
        cuota_aprox_casa = round(1 / (prob * 1.06), 2)
        resultados.append({
            "mercado": nombre,
            "probabilidad": round(prob * 100, 1),
            "cuota_aprox": max(1.05, cuota_aprox_casa),
            "cuota_justa": cuota_justa
        })
    return resultados


def calcular_lambdas_partido(standings: list, id_local: int, id_visita: int):
    """
    Calcula (lambda_local, lambda_visita) usando las tablas HOME y AWAY si están disponibles
    y cuentan con suficientes partidos; de lo contrario usa la tabla TOTAL con factor de localía.
    """
    tabla_total = next((s["table"] for s in standings if s.get("type") == "TOTAL"), [])
    tabla_home = next((s["table"] for s in standings if s.get("type") == "HOME"), [])
    tabla_away = next((s["table"] for s in standings if s.get("type") == "AWAY"), [])

    if not tabla_total:
        return None

    st_local_total = next((eq for eq in tabla_total if eq["team"]["id"] == id_local), None)
    st_visita_total = next((eq for eq in tabla_total if eq["team"]["id"] == id_visita), None)

    # Ignorar si llevan menos de 3 partidos jugados en la temporada
    if not st_local_total or not st_visita_total:
        return None
    if st_local_total["playedGames"] < 3 or st_visita_total["playedGames"] < 3:
        return None

    # Intentar cálculo específico con tablas HOME (Local) y AWAY (Visitante)
    if tabla_home and tabla_away:
        st_local_h = next((eq for eq in tabla_home if eq["team"]["id"] == id_local), None)
        st_visita_a = next((eq for eq in tabla_away if eq["team"]["id"] == id_visita), None)
        partidos_h = sum(eq["playedGames"] for eq in tabla_home)
        partidos_a = sum(eq["playedGames"] for eq in tabla_away)
        goles_h = sum(eq["goalsFor"] for eq in tabla_home)
        goles_a = sum(eq["goalsFor"] for eq in tabla_away)

        if (
            st_local_h and st_visita_a
            and st_local_h["playedGames"] >= 2
            and st_visita_a["playedGames"] >= 2
            and partidos_h > 0 and partidos_a > 0
            and goles_h > 0 and goles_a > 0
        ):
            media_goles_h = goles_h / partidos_h
            media_goles_a = goles_a / partidos_a

            ataque_local = (st_local_h["goalsFor"] / st_local_h["playedGames"]) / media_goles_h
            defensa_local = (st_local_h["goalsAgainst"] / st_local_h["playedGames"]) / media_goles_a
            ataque_visita = (st_visita_a["goalsFor"] / st_visita_a["playedGames"]) / media_goles_a
            defensa_visita = (st_visita_a["goalsAgainst"] / st_visita_a["playedGames"]) / media_goles_h

            lambda_l = max(0.20, round(ataque_local * defensa_visita * media_goles_h, 2))
            lambda_v = max(0.20, round(ataque_visita * defensa_local * media_goles_a, 2))
            return lambda_l, lambda_v

    # Fallback a tabla TOTAL con factor de localía (1.08 local / 0.92 visita)
    total_goles = sum(eq["goalsFor"] for eq in tabla_total)
    total_partidos = sum(eq["playedGames"] for eq in tabla_total)
    if total_partidos == 0 or total_goles == 0:
        return None

    media_goles_liga = total_goles / total_partidos

    ataque_local = (st_local_total["goalsFor"] / st_local_total["playedGames"]) / media_goles_liga
    defensa_local = (st_local_total["goalsAgainst"] / st_local_total["playedGames"]) / media_goles_liga
    ataque_visita = (st_visita_total["goalsFor"] / st_visita_total["playedGames"]) / media_goles_liga
    defensa_visita = (st_visita_total["goalsAgainst"] / st_visita_total["playedGames"]) / media_goles_liga

    lambda_l = max(0.20, round(ataque_local * defensa_visita * media_goles_liga * 1.08, 2))
    lambda_v = max(0.20, round(ataque_visita * defensa_local * media_goles_liga * 0.92, 2))
    return lambda_l, lambda_v


def enviar_telegram(texto: str):
    chat_id = resolver_chat_id()
    if not chat_id:
        print("⚠️ No se encontró TELEGRAM_CHAT_ID. Envía 'Hola' a @ApuestinBetaBot en Telegram.")
        print("Vista previa del mensaje:\n" + texto)
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    # Dividir en bloques si supera los 4000 caracteres de límite de Telegram
    for i in range(0, len(texto), 4000):
        fragmento = texto[i:i + 4000]
        r = requests.post(url, json={
            "chat_id": chat_id,
            "text": fragmento,
            "parse_mode": "Markdown"
        })
        if r.status_code != 200:
            # Reintentar sin parse_mode por si algún nombre de equipo tiene caracteres especiales
            requests.post(url, json={
                "chat_id": chat_id,
                "text": fragmento
            })


def main():
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # Ventana de las próximas 24 horas a partir del momento de ejecución
    tz_bo = timezone(timedelta(hours=-4))
    ahora_utc = datetime.now(timezone.utc)
    limite_utc = ahora_utc + timedelta(hours=24)

    ahora_bo = ahora_utc.astimezone(tz_bo)
    limite_bo = limite_utc.astimezone(tz_bo)
    rango_texto = f"{ahora_bo.strftime('%d/%m %H:%M')} a {limite_bo.strftime('%d/%m %H:%M')} (BO)"

    # Consultar API en el rango de fechas UTC que cubren las próximas 24h
    date_from = ahora_utc.strftime("%Y-%m-%d")
    date_to = limite_utc.strftime("%Y-%m-%d")

    res = requests.get(
        f"{BASE_URL}/matches",
        headers=HEADERS,
        params={"dateFrom": date_from, "dateTo": date_to}
    )

    if res.status_code != 200:
        print(f"Error consultando API ({res.status_code}): {res.text}")
        return

    todos_los_partidos = res.json().get("matches", [])
    partidos = []
    for p in todos_los_partidos:
        utc_date_str = p.get("utcDate")
        if not utc_date_str:
            continue
        fecha_p = datetime.fromisoformat(utc_date_str.replace("Z", "+00:00"))
        if ahora_utc <= fecha_p <= limite_utc:
            partidos.append(p)

    if not partidos:
        enviar_telegram(f"📭 No hay partidos en las ligas principales en las próximas 24h ({rango_texto}).")
        print(f"No hay partidos en el rango {rango_texto}.")
        return

    tablas_cache = {}
    stake_bs, modo_sheet = obtener_config_sheet()
    lineas_mensaje = [
        f"📊 *PRONÓSTICOS PRÓXIMAS 24H*\n"
        f"🕒 _{rango_texto}_\n"
        f"💵 _Stake Fijo en Sheet: {stake_bs:.2f} Bs ({modo_sheet})_\n"
    ]
    partidos_procesados = 0
    apuestas_para_sheet = []

    for p in partidos:
        liga_code = p["competition"]["code"]
        liga_nombre = p["competition"]["name"]

        # Descargar tabla de posiciones 1 sola vez por liga
        if liga_code not in tablas_cache:
            time.sleep(6.5)  # Respetar límite gratis de 10 peticiones/minuto
            r_st = requests.get(f"{BASE_URL}/competitions/{liga_code}/standings", headers=HEADERS)
            if r_st.status_code == 200:
                tablas_cache[liga_code] = r_st.json()
            else:
                tablas_cache[liga_code] = None

        datos_liga = tablas_cache.get(liga_code)
        if not datos_liga or not datos_liga.get("standings"):
            continue

        standings = datos_liga["standings"]
        id_local = p["homeTeam"]["id"]
        id_visita = p["awayTeam"]["id"]

        lambdas = calcular_lambdas_partido(standings, id_local, id_visita)
        if not lambdas:
            continue

        lambda_l, lambda_v = lambdas
        top_3 = calcular_top_3_poisson(lambda_l, lambda_v)

        # Guardar pronóstico en Supabase
        registro = {
            "match_id": p["id"],
            "fecha_partido": p["utcDate"],
            "liga": liga_nombre,
            "equipo_local": p["homeTeam"]["name"],
            "equipo_visita": p["awayTeam"]["name"],
            "lambda_local": lambda_l,
            "lambda_visita": lambda_v,
            "top_3_mercados": top_3
        }
        sb.table("pronosticos_diarios").upsert(registro, on_conflict="match_id").execute()

        # Hora del partido en Bolivia (UTC-4)
        hora_bo = datetime.fromisoformat(p["utcDate"].replace("Z", "+00:00")).astimezone(tz_bo).strftime("%d/%m %H:%M")

        # Armar bloque de texto para Telegram
        bloque = (
            f"⚽ *{p['homeTeam']['name']} vs {p['awayTeam']['name']}* ({liga_nombre})\n"
            f"🕒 _{hora_bo} BO_ | 📈 _xG Calculado: {lambda_l} - {lambda_v}_\n"
        )
        for idx, m in enumerate(top_3, 1):
            bloque += f"  {idx}. *{m['mercado']}* — `{m['probabilidad']}%` (Cuota aprox: *@{m['cuota_aprox']}*)\n"

        lineas_mensaje.append(bloque)
        partidos_procesados += 1
        apuestas_para_sheet.append({
            "match_id": p["id"],
            "hora_bo": hora_bo,
            "liga": liga_nombre,
            "equipo_local": p["homeTeam"]["name"],
            "equipo_visita": p["awayTeam"]["name"],
            "top_3": top_3
        })

    if partidos_procesados > 0:
        nuevas_en_sheet = sincronizar_apuestas_nuevas(apuestas_para_sheet)
        if nuevas_en_sheet > 0:
            lineas_mensaje.append(f"📝 _Se anotaron {nuevas_en_sheet} apuestas nuevas en Google Sheets ({stake_bs:.2f} Bs c/u)._")
        enviar_telegram("\n".join(lineas_mensaje))
        print(f"Se procesaron y enviaron {partidos_procesados} partidos ({nuevas_en_sheet} filas nuevas en Google Sheets).")
    else:
        enviar_telegram(f"⚠️ Hay partidos en las próximas 24h ({rango_texto}), pero aún no tienen suficientes estadísticas en liga.")
        print("Partidos encontrados pero sin suficientes estadísticas.")


if __name__ == "__main__":
    main()
