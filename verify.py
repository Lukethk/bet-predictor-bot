import os
import time
from datetime import datetime, timedelta, timezone
import requests
from supabase import create_client
from main import (
    cargar_dotenv_local,
    BASE_URL,
    HEADERS,
    SUPABASE_URL,
    SUPABASE_KEY,
    enviar_telegram,
)
from sheets_sync import evaluar_mercado, actualizar_resultados_sheet, obtener_config_sheet


def main():
    cargar_dotenv_local()
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # 1. Buscar en Supabase todos los pronósticos en estado PENDIENTE
    res_pendientes = (
        sb.table("pronosticos_diarios")
        .select("*")
        .eq("estado", "PENDIENTE")
        .order("fecha_partido", desc=False)
        .execute()
    )
    pendientes = res_pendientes.data or []
    if not pendientes:
        print("ℹ️ No hay partidos pendientes de verificar en Supabase.")
        return

    # 2. Consultar resultados en Football-Data.org por lista de IDs
    ids_csv = ",".join(str(p["match_id"]) for p in pendientes)

    r_api = requests.get(
        f"{BASE_URL}/matches",
        headers=HEADERS,
        params={"ids": ids_csv}
    )

    partidos_api = {}
    if r_api.status_code == 200:
        for m in r_api.json().get("matches", []):
            partidos_api[m["id"]] = m

    stake_bs, _ = obtener_config_sheet()
    resultados_para_sheet = {}
    bloques_telegram = []
    ganancia_neta_total = 0.0
    aciertos = 0
    total_evaluados = 0

    for reg in pendientes:
        match_id = reg["match_id"]
        datos_m = partidos_api.get(match_id)

        # Si no vino en el listado general, consultar el partido individualmente
        if not datos_m:
            time.sleep(6.5)
            r_ind = requests.get(f"{BASE_URL}/matches/{match_id}", headers=HEADERS)
            if r_ind.status_code == 200:
                datos_m = r_ind.json()

        if not datos_m or datos_m.get("status") != "FINISHED":
            continue

        full_time = datos_m.get("score", {}).get("fullTime", {})
        goles_l = full_time.get("home")
        goles_v = full_time.get("away")
        if goles_l is None or goles_v is None:
            continue

        goles_l = int(goles_l)
        goles_v = int(goles_v)
        resultados_para_sheet[match_id] = (goles_l, goles_v)

        mercados_actualizados = []
        lineas_mercados = []
        for idx, m in enumerate(reg.get("top_3_mercados", []), 1):
            estado_m = evaluar_mercado(m["mercado"], goles_l, goles_v)
            cuota = float(m.get("cuota_aprox", 1.0))
            balance_m = round(stake_bs * (cuota - 1), 2) if estado_m == "GANADA" else -round(stake_bs, 2)
            ganancia_neta_total += balance_m
            total_evaluados += 1
            if estado_m == "GANADA":
                aciertos += 1
                icono = "✅"
                signo = f"+{balance_m:.2f} Bs"
            else:
                icono = "❌"
                signo = f"{balance_m:.2f} Bs"

            m_copia = dict(m)
            m_copia["resultado"] = estado_m
            m_copia["stake_bs"] = stake_bs
            m_copia["balance_bs"] = balance_m
            mercados_actualizados.append(m_copia)
            lineas_mercados.append(
                f"  {idx}. {icono} *{m['mercado']}* (@{cuota}) -> `{estado_m}` ({signo})"
            )

        # Actualizar fila en Supabase
        sb.table("pronosticos_diarios").update({
            "goles_local_real": goles_l,
            "goles_visita_real": goles_v,
            "top_3_mercados": mercados_actualizados,
            "estado": "FINALIZADO"
        }).eq("match_id", match_id).execute()

        bloque = (
            f"🏁 *{reg['equipo_local']} {goles_l} - {goles_v} {reg['equipo_visita']}* ({reg['liga']})\n"
            + "\n".join(lineas_mercados)
        )
        bloques_telegram.append(bloque)

    if not resultados_para_sheet:
        print("ℹ️ Ninguno de los partidos pendientes ha finalizado aún (FT).")
        return

    # 3. Actualizar estados (GANADA / PERDIDA) y marcador FT en Google Sheets
    actualizar_resultados_sheet(resultados_para_sheet)

    # 4. Enviar resumen a Telegram
    signo_total = f"+{ganancia_neta_total:.2f}" if ganancia_neta_total >= 0 else f"{ganancia_neta_total:.2f}"
    resumen = (
        f"📋 *REPORTE DE RESULTADOS Y LIQUIDACIÓN*\n"
        f"💰 _Stake Fijo: {stake_bs:.2f} Bs | Aciertos: {aciertos}/{total_evaluados} | Balance: {signo_total} Bs_\n\n"
        + "\n\n".join(bloques_telegram)
    )
    enviar_telegram(resumen)
    print(f"✅ Se verificaron {len(resultados_para_sheet)} partidos finalizados y se actualizó Google Sheets.")


if __name__ == "__main__":
    main()
