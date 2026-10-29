/**
 * SCRIPT DE CONEXIÓN AUTOMÁTICA GOOGLE SHEETS <-> SUPABASE (APUESTIN)
 *
 * Cómo activarlo (1 sola vez, toma 30 segundos):
 * 1. En tu Google Sheet "Apuestin", ve al menú superior: Extensiones -> Apps Script
 * 2. Borra el código de ejemplo, pega todo este archivo y dale al icono de Guardar (💾).
 * 3. Arriba a la derecha haz clic en "Implementar" -> "Nueva implementación":
 *    - Tipo: "Aplicación web" (Web App)
 *    - Ejecutar como: "Yo"
 *    - Quién tiene acceso: "Cualquier persona" (Anyone)
 * 4. Copia la URL de la aplicación web y ejecuta la función `registrarWebhookEnSupabase("TU_URL")`
 *    o pégala en la tabla `configuracion_apuestin` de Supabase.
 */

const SUPABASE_URL = "https://mscrcnzqvgxqgiurexhh.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zY3Jjbnpxdmd4cWdpdXJleGhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyOTYxOTUsImV4cCI6MjEwODg3MjE5NX0.OadZBz988PDRCJGc3pxuX8iKX7SoxB4NZETPntMvweM";

function evaluarMercado(mercado, golesLocal, golesVisita) {
  const total = golesLocal + golesVisita;
  const mapa = {
    "Victoria Local (1)": golesLocal > golesVisita,
    "Empate (X)": golesLocal === golesVisita,
    "Victoria Visitante (2)": golesLocal < golesVisita,
    "Doble Oportunidad (1X)": golesLocal >= golesVisita,
    "Doble Oportunidad (X2)": golesLocal <= golesVisita,
    "Más de 1.5 Goles": total >= 2,
    "Más de 2.5 Goles": total >= 3,
    "Menos de 3.5 Goles": total <= 3,
    "Ambos Anotan (Sí)": golesLocal >= 1 && golesVisita >= 1,
    "Ambos Anotan (No)": golesLocal === 0 || golesVisita === 0
  };
  return mapa[mercado] ? "GANADA" : "PERDIDA";
}

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const panel = ss.getSheetByName("Panel_Control");
  const stake = Number(panel.getRange("B3").getValue() || 3);
  const modo = String(panel.getRange("B4").getValue() || "TOP_3").toUpperCase();
  return ContentService.createTextOutput(
    JSON.stringify({ ok: true, stake_bs: stake, modo: modo })
  ).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const payload = JSON.parse(e.postData.contents || "{}");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetApuestas = ss.getSheetByName("Apuestas");
  const panel = ss.getSheetByName("Panel_Control");

  const stakePanel = Number(panel.getRange("B3").getValue() || payload.stake_bs || 3);
  const modoPanel = String(panel.getRange("B4").getValue() || payload.modo || "TOP_3").toUpperCase();

  if (payload.action === "append_bets") {
    const lastRow = sheetApuestas.getLastRow();
    const existingIds = new Set();
    if (lastRow >= 2) {
      const ids = sheetApuestas.getRange(2, 1, lastRow - 1, 1).getValues();
      ids.forEach(r => {
        if (r[0]) existingIds.add(String(r[0]).trim());
      });
    }

    let nextRow = lastRow + 1;
    let added = 0;

    (payload.partidos || []).forEach(p => {
      const mercados = modoPanel === "TOP_1" ? (p.top_3 || []).slice(0, 1) : (p.top_3 || []);
      mercados.forEach((m, idx) => {
        const betId = `${p.match_id}-${idx + 1}`;
        if (existingIds.has(betId)) return;

        const r = nextRow;
        const fPotencial = `=IF(ISBLANK(A${r}), "", ROUND(H${r}*(G${r}-1), 2))`;
        const fBalance = `=IF(J${r}="GANADA", ROUND(H${r}*(G${r}-1), 2), IF(J${r}="PERDIDA", -H${r}, 0))`;

        sheetApuestas.getRange(r, 1, 1, 12).setValues([[
          betId,
          p.hora_bo,
          p.liga,
          `${p.equipo_local} vs ${p.equipo_visita}`,
          m.mercado,
          m.probabilidad,
          m.cuota_aprox,
          stakePanel,
          fPotencial,
          "PENDIENTE",
          "-",
          fBalance
        ]]);
        existingIds.add(betId);
        nextRow++;
        added++;
      });
    });

    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, added: added })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  if (payload.action === "update_results") {
    const resultados = payload.resultados || {};
    const lastRow = sheetApuestas.getLastRow();
    let updated = 0;

    if (lastRow >= 2) {
      const data = sheetApuestas.getRange(2, 1, lastRow - 1, 11).getValues();
      for (let i = 0; i < data.length; i++) {
        const betId = String(data[i][0] || "").trim();
        const matchId = betId.split("-")[0];
        if (!resultados[matchId]) continue;

        const [golesL, golesV] = resultados[matchId];
        const mercado = String(data[i][4] || "").trim();
        const nuevoEstado = evaluarMercado(mercado, Number(golesL), Number(golesV));
        const marcadorFt = `${golesL} - ${golesV}`;

        const filaReal = i + 2;
        sheetApuestas.getRange(filaReal, 10, 1, 2).setValues([[nuevoEstado, marcadorFt]]);
        updated++;
      }
    }

    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, updated: updated })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(
    JSON.stringify({ ok: false, error: "Accion no reconocida" })
  ).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Si cambias el monto fijo en Panel_Control!B3 o el modo en B4,
 * sincroniza automáticamente el nuevo valor hacia Supabase.
 */
function onEdit(e) {
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== "Panel_Control") return;

  const row = range.getRow();
  const col = range.getColumn();
  if (col === 2 && (row === 3 || row === 4)) {
    const stake = Number(sheet.getRange("B3").getValue() || 3);
    const modo = String(sheet.getRange("B4").getValue() || "TOP_3").toUpperCase();
    UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/configuracion_apuestin?id=eq.1`, {
      method: "patch",
      contentType: "application/json",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "Prefer": "return=minimal"
      },
      payload: JSON.stringify({
        stake_fijo_bs: stake,
        modo_mercados: modo,
        actualizado_en: new Date().toISOString()
      })
    });
  }
}
