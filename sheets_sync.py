import json
import os
import shutil
import subprocess
import tempfile
import requests

DEFAULT_SHEET_ID = "1POqGlV7Mx0R__TwE34fUDFuYswBZhkLQXcZ70RNGGb0"
GSHEETS_BIN_FALLBACK = "/Users/lucas/.gemini/antigravity/bin/gsheets"


def _encontrar_gsheets_bin() -> str:
    bin_path = shutil.which("gsheets")
    if bin_path:
        return bin_path
    if os.path.exists(GSHEETS_BIN_FALLBACK):
        return GSHEETS_BIN_FALLBACK
    return ""


def obtener_config_sheet(sheet_id: str = None) -> tuple[float, str]:
    """
    Lee de Panel_Control!B3:B4 el monto fijo por apuesta (Bs) y el modo (TOP_1 o TOP_3).
    Por defecto devuelve (3.0, 'TOP_3').
    """
    sheet_id = sheet_id or os.environ.get("GOOGLE_SHEET_ID", DEFAULT_SHEET_ID)
    webhook_url = os.environ.get("GOOGLE_SHEETS_WEBHOOK_URL", "")

    if webhook_url:
        try:
            r = requests.get(webhook_url, params={"action": "config"}, timeout=10)
            if r.status_code == 200:
                data = r.json()
                return float(data.get("stake_bs", 3.0)), str(data.get("modo", "TOP_3")).upper()
        except Exception:
            pass

    gsheets_bin = _encontrar_gsheets_bin()
    if gsheets_bin and sheet_id:
        try:
            proc = subprocess.run(
                [gsheets_bin, "readonly", "read", sheet_id, "Panel_Control!B3:B4", "--json"],
                capture_output=True,
                text=True,
                timeout=15
            )
            if proc.returncode == 0 and proc.stdout.strip():
                rows = json.loads(proc.stdout)
                stake = float(rows[0][0]) if len(rows) > 0 and rows[0] else 3.0
                modo = str(rows[1][0]).strip().upper() if len(rows) > 1 and rows[1] else "TOP_3"
                if modo not in ("TOP_1", "TOP_3"):
                    modo = "TOP_3"
                return stake, modo
        except Exception:
            pass

    return 3.0, "TOP_3"


def evaluar_mercado(mercado: str, goles_local: int, goles_visita: int) -> str:
    """Evalúa si un mercado resultó en 'GANADA' o 'PERDIDA' según el marcador final."""
    total = goles_local + goles_visita
    condiciones = {
        "Victoria Local (1)": goles_local > goles_visita,
        "Empate (X)": goles_local == goles_visita,
        "Victoria Visitante (2)": goles_local < goles_visita,
        "Doble Oportunidad (1X)": goles_local >= goles_visita,
        "Doble Oportunidad (X2)": goles_local <= goles_visita,
        "Más de 1.5 Goles": total >= 2,
        "Más de 2.5 Goles": total >= 3,
        "Menos de 3.5 Goles": total <= 3,
        "Ambos Anotan (Sí)": (goles_local >= 1 and goles_visita >= 1),
        "Ambos Anotan (No)": (goles_local == 0 or goles_visita == 0),
    }
    gano = condiciones.get(mercado, False)
    return "GANADA" if gano else "PERDIDA"


def sincronizar_apuestas_nuevas(apuestas_partidos: list[dict], sheet_id: str = None) -> int:
    """
    Recibe una lista de partidos procesados y agrega a la pestaña 'Apuestas'
    aquellas apuestas cuyo ID (match_id-idx) aún no exista en la hoja.
    """
    sheet_id = sheet_id or os.environ.get("GOOGLE_SHEET_ID", DEFAULT_SHEET_ID)
    stake_bs, modo = obtener_config_sheet(sheet_id)
    webhook_url = os.environ.get("GOOGLE_SHEETS_WEBHOOK_URL", "")

    if webhook_url:
        try:
            r = requests.post(
                webhook_url,
                json={"action": "append_bets", "stake_bs": stake_bs, "modo": modo, "partidos": apuestas_partidos},
                timeout=20
            )
            if r.status_code == 200:
                return r.json().get("added", 0)
        except Exception as e:
            print(f"⚠️ Error enviando a GOOGLE_SHEETS_WEBHOOK_URL: {e}")

    gsheets_bin = _encontrar_gsheets_bin()
    if not gsheets_bin or not sheet_id:
        return 0

    # Leer filas actuales en Apuestas!A1:A1000 para saber qué IDs ya existen y en qué fila insertar
    existing_ids = set()
    next_row = 2
    try:
        proc = subprocess.run(
            [gsheets_bin, "readonly", "read", sheet_id, "Apuestas!A1:A1000", "--json"],
            capture_output=True,
            text=True,
            timeout=15
        )
        if proc.returncode == 0 and proc.stdout.strip():
            rows = json.loads(proc.stdout)
            next_row = len(rows) + 1
            for r in rows[1:]:
                if r and str(r[0]).strip():
                    existing_ids.add(str(r[0]).strip())
    except Exception as e:
        print(f"⚠️ No se pudo leer Apuestas existentes: {e}")
        return 0

    nuevas_filas = []
    for p in apuestas_partidos:
        mercados = p["top_3"][:1] if modo == "TOP_1" else p["top_3"]
        for idx, m in enumerate(mercados, 1):
            bet_id = f"{p['match_id']}-{idx}"
            if bet_id in existing_ids:
                continue
            r_num = next_row + len(nuevas_filas)
            formula_potencial = f'=IF(ISBLANK(A{r_num}), "", ROUND(H{r_num}*(G{r_num}-1), 2))'
            formula_balance = f'=IF(J{r_num}="GANADA", ROUND(H{r_num}*(G{r_num}-1), 2), IF(J{r_num}="PERDIDA", -H{r_num}, 0))'
            nuevas_filas.append([
                bet_id,
                p["hora_bo"],
                p["liga"],
                f"{p['equipo_local']} vs {p['equipo_visita']}",
                m["mercado"],
                m["probabilidad"],
                m["cuota_aprox"],
                stake_bs,
                formula_potencial,
                "PENDIENTE",
                "-",
                formula_balance
            ])
            existing_ids.add(bet_id)

    if not nuevas_filas:
        return 0

    end_row = next_row + len(nuevas_filas) - 1
    batch_payload = [
        {
            "op": "write",
            "range": f"Apuestas!A{next_row}:L{end_row}",
            "data": nuevas_filas
        }
    ]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
        json.dump(batch_payload, tmp, ensure_ascii=False)
        tmp_path = tmp.name

    try:
        subprocess.run(
            [gsheets_bin, "mutate", "batch", sheet_id, "-f", tmp_path],
            check=True,
            capture_output=True,
            text=True,
            timeout=20
        )
        return len(nuevas_filas)
    except Exception as e:
        print(f"⚠️ Error escribiendo nuevas apuestas en Google Sheets: {e}")
        return 0
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def actualizar_resultados_sheet(resultados_partidos: dict[int, tuple[int, int]], sheet_id: str = None) -> list[dict]:
    """
    Dado un diccionario {match_id: (goles_local, goles_visita)}, busca en 'Apuestas'
    las filas correspondientes, evalúa cada mercado ('GANADA' o 'PERDIDA') y actualiza
    las columnas J (Estado) y K (Resultado FT). Devuelve el detalle de apuestas liquidadas.
    """
    sheet_id = sheet_id or os.environ.get("GOOGLE_SHEET_ID", DEFAULT_SHEET_ID)
    webhook_url = os.environ.get("GOOGLE_SHEETS_WEBHOOK_URL", "")

    if webhook_url:
        try:
             requests.post(
                webhook_url,
                json={"action": "update_results", "resultados": {str(k): list(v) for k, v in resultados_partidos.items()}},
                timeout=20
            )
        except Exception as e:
            print(f"⚠️ Error actualizando resultados vía webhook: {e}")

    gsheets_bin = _encontrar_gsheets_bin()
    if not gsheets_bin or not sheet_id:
        return []

    try:
        proc = subprocess.run(
            [gsheets_bin, "readonly", "read", sheet_id, "Apuestas!A1:L1000", "--json"],
            capture_output=True,
            text=True,
            timeout=15
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return []
        rows = json.loads(proc.stdout)
    except Exception as e:
        print(f"⚠️ Error leyendo Apuestas para actualizar resultados: {e}")
        return []

    ops = []
    liquidadas = []

    for idx_Zero, row in enumerate(rows[1:], start=2):
        if len(row) < 10:
            continue
        bet_id = str(row[0]).strip()
        if "-" not in bet_id:
            continue
        match_id_str = bet_id.split("-", 1)[0]
        if not match_id_str.isdigit():
            continue
        match_id = int(match_id_str)
        if match_id not in resultados_partidos:
            continue

        estado_actual = str(row[9]).strip().upper()
        goles_l, goles_v = resultados_partidos[match_id]
        mercado = str(row[4]).strip()
        cuota = float(row[6]) if row[6] else 1.0
        stake = float(row[7]) if row[7] else 3.0

        nuevo_estado = evaluar_mercado(mercado, goles_l, goles_visita=goles_v)
        marcador_ft = f"{goles_l} - {goles_v}"

        if estado_actual != nuevo_estado or (len(row) > 10 and str(row[10]).strip() != marcador_ft):
            ops.append({
                "op": "write",
                "range": f"Apuestas!J{idx_Zero}:K{idx_Zero}",
                "data": [[nuevo_estado, marcador_ft]]
            })
            balance = round(stake * (cuota - 1), 2) if nuevo_estado == "GANADA" else -round(stake, 2)
            liquidadas.append({
                "bet_id": bet_id,
                "partido": str(row[3]),
                "mercado": mercado,
                "cuota": cuota,
                "stake": stake,
                "estado": nuevo_estado,
                "marcador": marcador_ft,
                "balance": balance
            })

    if not ops:
        return []

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
        json.dump(ops, tmp, ensure_ascii=False)
        tmp_path = tmp.name

    try:
        subprocess.run(
            [gsheets_bin, "mutate", "batch", sheet_id, "-f", tmp_path],
            check=True,
            capture_output=True,
            text=True,
            timeout=20
        )
    except Exception as e:
        print(f"⚠️ Error actualizando estados en Google Sheets: {e}")
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    return liquidadas
