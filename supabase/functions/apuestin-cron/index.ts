import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const BASE_URL = "https://api.football-data.org/v4";
const MAX_PARTIDOS_POR_JORNADA = 3;

function factorial(n: number): number {
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

function poissonPmf(k: number, lambda: number): number {
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

function calcularTop3Poisson(
  lambdaLocal: number,
  lambdaVisita: number,
  stakeBs: number
) {
  const maxGoles = 6;
  const matriz: number[][] = Array.from({ length: maxGoles }, () =>
    Array(maxGoles).fill(0)
  );

  for (let i = 0; i < maxGoles; i++) {
    for (let j = 0; j < maxGoles; j++) {
      matriz[i][j] = poissonPmf(i, lambdaLocal) * poissonPmf(j, lambdaVisita);
    }
  }

  let probLocal = 0;
  let probEmpate = 0;
  let probVisita = 0;
  let probMenos25 = 0;
  let probMenos35 = 0;
  let probAmbosSi = 0;

  for (let i = 0; i < maxGoles; i++) {
    for (let j = 0; j < maxGoles; j++) {
      const p = matriz[i][j];
      if (i > j) probLocal += p;
      else if (i === j) probEmpate += p;
      else probVisita += p;

      if (i + j <= 2) probMenos25 += p;
      if (i + j <= 3) probMenos35 += p;
      if (i >= 1 && j >= 1) probAmbosSi += p;
    }
  }

  const mercados: Record<string, number> = {
    "Victoria Local (1)": probLocal,
    "Empate (X)": probEmpate,
    "Victoria Visitante (2)": probVisita,
    "Doble Oportunidad (1X)": probLocal + probEmpate,
    "Doble Oportunidad (X2)": probEmpate + probVisita,
    "Más de 1.5 Goles": 1 - (matriz[0][0] + matriz[1][0] + matriz[0][1]),
    "Más de 2.5 Goles": 1 - probMenos25,
    "Menos de 3.5 Goles": probMenos35,
    "Ambos Anotan (Sí)": probAmbosSi,
    "Ambos Anotan (No)": 1 - probAmbosSi,
  };

  let filtrados = Object.entries(mercados).filter(
    ([, p]) => p >= 0.53 && p <= 0.85
  );
  if (filtrados.length < 3) {
    filtrados = Object.entries(mercados);
  }

  const top3 = filtrados.sort((a, b) => b[1] - a[1]).slice(0, 3);
  return top3.map(([nombre, prob]) => {
    const cuotaJusta = Number((1 / prob).toFixed(2));
    const cuotaAproxCasa = Number((1 / (prob * 1.06)).toFixed(2));
    return {
      mercado: nombre,
      probabilidad: Number((prob * 100).toFixed(1)),
      cuota_aprox: Math.max(1.05, cuotaAproxCasa),
      cuota_justa: cuotaJusta,
      stake_bs: stakeBs,
    };
  });
}

function calcularLambdasPartido(
  standings: any[],
  idLocal: number,
  idVisita: number
): [number, number] | null {
  const tablaTotal =
    standings.find((s: any) => s.type === "TOTAL")?.table || [];
  const tablaHome = standings.find((s: any) => s.type === "HOME")?.table || [];
  const tablaAway = standings.find((s: any) => s.type === "AWAY")?.table || [];

  if (!tablaTotal.length) return null;

  const stLocalTotal = tablaTotal.find((eq: any) => eq.team.id === idLocal);
  const stVisitaTotal = tablaTotal.find((eq: any) => eq.team.id === idVisita);
  if (
    !stLocalTotal ||
    !stVisitaTotal ||
    stLocalTotal.playedGames < 3 ||
    stVisitaTotal.playedGames < 3
  ) {
    return null;
  }

  if (tablaHome.length && tablaAway.length) {
    const stLocalH = tablaHome.find((eq: any) => eq.team.id === idLocal);
    const stVisitaA = tablaAway.find((eq: any) => eq.team.id === idVisita);
    const partidosH = tablaHome.reduce(
      (acc: number, eq: any) => acc + eq.playedGames,
      0
    );
    const partidosA = tablaAway.reduce(
      (acc: number, eq: any) => acc + eq.playedGames,
      0
    );
    const golesH = tablaHome.reduce(
      (acc: number, eq: any) => acc + eq.goalsFor,
      0
    );
    const golesA = tablaAway.reduce(
      (acc: number, eq: any) => acc + eq.goalsFor,
      0
    );

    if (
      stLocalH &&
      stVisitaA &&
      stLocalH.playedGames >= 2 &&
      stVisitaA.playedGames >= 2 &&
      partidosH > 0 &&
      partidosA > 0 &&
      golesH > 0 &&
      golesA > 0
    ) {
      const mediaGolesH = golesH / partidosH;
      const mediaGolesA = golesA / partidosA;
      const ataqueLocal =
        stLocalH.goalsFor / stLocalH.playedGames / mediaGolesH;
      const defensaLocal =
        stLocalH.goalsAgainst / stLocalH.playedGames / mediaGolesA;
      const ataqueVisita =
        stVisitaA.goalsFor / stVisitaA.playedGames / mediaGolesA;
      const defensaVisita =
        stVisitaA.goalsAgainst / stVisitaA.playedGames / mediaGolesH;

      const lambdaL = Math.max(
        0.2,
        Number((ataqueLocal * defensaVisita * mediaGolesH).toFixed(2))
      );
      const lambdaV = Math.max(
        0.2,
        Number((ataqueVisita * defensaLocal * mediaGolesA).toFixed(2))
      );
      return [lambdaL, lambdaV];
    }
  }

  const totalGoles = tablaTotal.reduce(
    (acc: number, eq: any) => acc + eq.goalsFor,
    0
  );
  const totalPartidos = tablaTotal.reduce(
    (acc: number, eq: any) => acc + eq.playedGames,
    0
  );
  if (totalPartidos === 0 || totalGoles === 0) return null;

  const mediaLiga = totalGoles / totalPartidos;
  const ataqueLocal =
    stLocalTotal.goalsFor / stLocalTotal.playedGames / mediaLiga;
  const defensaLocal =
    stLocalTotal.goalsAgainst / stLocalTotal.playedGames / mediaLiga;
  const ataqueVisita =
    stVisitaTotal.goalsFor / stVisitaTotal.playedGames / mediaLiga;
  const defensaVisita =
    stVisitaTotal.goalsAgainst / stVisitaTotal.playedGames / mediaLiga;

  const lambdaL = Math.max(
    0.2,
    Number((ataqueLocal * defensaVisita * mediaLiga * 1.08).toFixed(2))
  );
  const lambdaV = Math.max(
    0.2,
    Number((ataqueVisita * defensaLocal * mediaLiga * 0.92).toFixed(2))
  );
  return [lambdaL, lambdaV];
}

function evaluarMercado(
  mercado: string,
  golesLocal: number,
  golesVisita: number
): "GANADA" | "PERDIDA" {
  const total = golesLocal + golesVisita;
  const map: Record<string, boolean> = {
    "Victoria Local (1)": golesLocal > golesVisita,
    "Empate (X)": golesLocal === golesVisita,
    "Victoria Visitante (2)": golesLocal < golesVisita,
    "Doble Oportunidad (1X)": golesLocal >= golesVisita,
    "Doble Oportunidad (X2)": golesLocal <= golesVisita,
    "Más de 1.5 Goles": total >= 2,
    "Más de 2.5 Goles": total >= 3,
    "Menos de 3.5 Goles": total <= 3,
    "Ambos Anotan (Sí)": golesLocal >= 1 && golesVisita >= 1,
    "Ambos Anotan (No)": golesLocal === 0 || golesVisita === 0,
  };
  return map[mercado] ? "GANADA" : "PERDIDA";
}

function formatearHoraBo(isoUtc: string): string {
  const d = new Date(new Date(isoUtc).getTime() - 4 * 3600 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${min}`;
}

function csvEscape(val: unknown): string {
  const s = String(val ?? "").replace(/"/g, '""');
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s}"`;
  }
  return s;
}

async function enviarTelegram(
  token: string,
  chatId: string,
  texto: string
): Promise<void> {
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  for (let i = 0; i < texto.length; i += 4000) {
    const fragmento = texto.slice(i, i + 4000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: fragmento,
        parse_mode: "Markdown",
      }),
    });
    if (!res.ok) {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: fragmento }),
      });
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, supabaseServiceKey);

  const reqUrl = new URL(req.url);

  // ENDPOINT GET PARA GOOGLE SHEETS (=IMPORTDATA)
  if (req.method === "GET" && reqUrl.searchParams.get("format") === "csv") {
    const stakeParam = Number(reqUrl.searchParams.get("stake") || "0");
    const modoParam = (reqUrl.searchParams.get("modo") || "").toUpperCase();

    const { data: cfg } = await sb
      .from("configuracion_apuestin")
      .select("*")
      .eq("id", 1)
      .single();

    let stakeActual = Number(cfg?.stake_fijo_bs ?? 3.0);
    let modoActual = String(cfg?.modo_mercados ?? "TOP_3").toUpperCase();

    const updatesCfg: Record<string, unknown> = {};
    if (stakeParam > 0 && stakeParam !== stakeActual) {
      stakeActual = stakeParam;
      updatesCfg.stake_fijo_bs = stakeParam;
    }
    if (
      (modoParam === "TOP_1" || modoParam === "TOP_3") &&
      modoParam !== modoActual
    ) {
      modoActual = modoParam;
      updatesCfg.modo_mercados = modoParam;
    }
    if (Object.keys(updatesCfg).length > 0) {
      updatesCfg.actualizado_en = new Date().toISOString();
      await sb.from("configuracion_apuestin").update(updatesCfg).eq("id", 1);
    }

    const { data: partidos } = await sb
      .from("pronosticos_diarios")
      .select("*")
      .in("estado", ["PENDIENTE", "FINALIZADO"])
      .order("fecha_partido", { ascending: true })
      .order("id", { ascending: true });

    const csvRows: string[] = [];
    for (const p of partidos || []) {
      const horaBo = formatearHoraBo(p.fecha_partido);
      const todosMercados: any[] = (p.top_3_mercados || []).slice(0, 3);
      const mercados =
        modoActual === "TOP_1" ? todosMercados.slice(0, 1) : todosMercados;
      const finalizado =
        p.estado === "FINALIZADO" &&
        p.goles_local_real !== null &&
        p.goles_visita_real !== null;
      const marcadorFt = finalizado
        ? `${p.goles_local_real} - ${p.goles_visita_real}`
        : "-";

      mercados.forEach((m: any, idx: number) => {
        const betId = `${p.match_id}-${idx + 1}`;
        const cuota = Number(m.cuota_aprox || 1.0);
        const prob = Number(m.probabilidad || 0);
        const stakeFila = finalizado
          ? Number(m.stake_bs ?? stakeActual)
          : stakeActual;
        const gananciaPotencial = Number((stakeFila * (cuota - 1)).toFixed(2));

        let estadoFila = "PENDIENTE";
        let balanceNeto = 0;
        if (finalizado) {
          estadoFila =
            m.resultado ||
            evaluarMercado(
              m.mercado,
              Number(p.goles_local_real),
              Number(p.goles_visita_real)
            );
          balanceNeto =
            estadoFila === "GANADA"
              ? gananciaPotencial
              : -Number(stakeFila.toFixed(2));
        }

        const row = [
          betId,
          horaBo,
          p.liga,
          `${p.equipo_local} vs ${p.equipo_visita}`,
          m.mercado,
          prob,
          cuota,
          stakeFila,
          gananciaPotencial,
          estadoFila,
          marcadorFt,
          balanceNeto,
        ].map(csvEscape);

        csvRows.push(row.join(","));
      });
    }

    return new Response(csvRows.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
      },
    });
  }

  let body: any = {};
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      body = {};
    }
  }

  const cronSecret =
    req.headers.get("x-cron-secret") || body.cron_secret || "";
  if (cronSecret !== "apuestin_cron_secret_2026_bo") {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const footballApiKey =
    body.football_api_key || Deno.env.get("FOOTBALL_API_KEY") || "";
  const telegramToken =
    body.telegram_token || Deno.env.get("TELEGRAM_TOKEN") || "";
  const telegramChatId =
    body.telegram_chat_id || Deno.env.get("TELEGRAM_CHAT_ID") || "";
  const mode = body.mode || "both";
  const silent = Boolean(body.silent);

  const { data: cfg } = await sb
    .from("configuracion_apuestin")
    .select("*")
    .eq("id", 1)
    .single();
  const stakeBs = Number(cfg?.stake_fijo_bs ?? 3.0);
  const modoMercados = String(cfg?.modo_mercados ?? "TOP_3");
  const webhookUrl = cfg?.google_sheets_webhook_url || "";

  const headers = { "X-Auth-Token": footballApiKey };
  let verificadosCount = 0;
  let pronosticadosCount = 0;

  // 1. VERIFICAR PARTIDOS PENDIENTES USANDO ?ids=...
  if (mode === "verify" || mode === "both") {
    const hace100Min = new Date(Date.now() - 100 * 60 * 1000).toISOString();
    const { data: pendientes } = await sb
      .from("pronosticos_diarios")
      .select("*")
      .eq("estado", "PENDIENTE")
      .lte("fecha_partido", hace100Min)
      .order("fecha_partido", { ascending: true });

    if (pendientes && pendientes.length > 0) {
      const idsCsv = pendientes.map((p: any) => p.match_id).join(",");
      const rApi = await fetch(`${BASE_URL}/matches?ids=${idsCsv}`, {
        headers,
      });

      const partidosMap: Record<number, any> = {};
      if (rApi.ok) {
        const json = await rApi.json();
        for (const m of json.matches || []) {
          partidosMap[m.id] = m;
        }
      }

      const bloquesTelegram: string[] = [];
      const resultadosSheet: Record<string, [number, number]> = {};
      let gananciaNetaTotal = 0;
      let aciertos = 0;
      let totalEvaluados = 0;

      for (const reg of pendientes) {
        const datosM = partidosMap[reg.match_id];
        if (!datosM || datosM.status !== "FINISHED") continue;

        const golesL = datosM.score?.fullTime?.home;
        const golesV = datosM.score?.fullTime?.away;
        if (
          golesL === null ||
          golesL === undefined ||
          golesV === null ||
          golesV === undefined
        ) {
          continue;
        }

        resultadosSheet[String(reg.match_id)] = [golesL, golesV];
        const mercadosActualizados: any[] = [];
        const lineasMercados: string[] = [];

        for (let idx = 0; idx < (reg.top_3_mercados || []).length; idx++) {
          const m = reg.top_3_mercados[idx];
          const estadoM = evaluarMercado(m.mercado, golesL, golesV);
          const cuota = Number(m.cuota_aprox || 1.0);
          const stakeUsado = Number(m.stake_bs ?? stakeBs);
          const balanceM =
            estadoM === "GANADA"
              ? Number((stakeUsado * (cuota - 1)).toFixed(2))
              : -Number(stakeUsado.toFixed(2));
          gananciaNetaTotal += balanceM;
          totalEvaluados++;
          if (estadoM === "GANADA") aciertos++;

          const icono = estadoM === "GANADA" ? "✅" : "❌";
          const signo =
            balanceM >= 0
              ? `+${balanceM.toFixed(2)} Bs`
              : `${balanceM.toFixed(2)} Bs`;

          mercadosActualizados.push({
            ...m,
            resultado: estadoM,
            stake_bs: stakeUsado,
            balance_bs: balanceM,
          });
          lineasMercados.push(
            `  ${idx + 1}. ${icono} *${m.mercado}* (@${cuota}) -> \`${estadoM}\` (${signo})`
          );
        }

        await sb
          .from("pronosticos_diarios")
          .update({
            goles_local_real: golesL,
            goles_visita_real: golesV,
            top_3_mercados: mercadosActualizados,
            estado: "FINALIZADO",
          })
          .eq("match_id", reg.match_id);

        bloquesTelegram.push(
          `🏁 *${reg.equipo_local} ${golesL} - ${golesV} ${reg.equipo_visita}* (${reg.liga})\n` +
            lineasMercados.join("\n")
        );
        verificadosCount++;
      }

      if (verificadosCount > 0) {
        if (webhookUrl) {
          try {
            await fetch(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "update_results",
                resultados: resultadosSheet,
              }),
            });
          } catch (_) {}
        }

        if (!silent) {
          const signoTotal =
            gananciaNetaTotal >= 0
              ? `+${gananciaNetaTotal.toFixed(2)}`
              : `${gananciaNetaTotal.toFixed(2)}`;
          const resumen =
            `📋 *REPORTE DE RESULTADOS Y LIQUIDACIÓN*\n` +
            `💰 _Stake Fijo: ${stakeBs.toFixed(2)} Bs | Aciertos: ${aciertos}/${totalEvaluados} | Balance: ${signoTotal} Bs_\n\n` +
            bloquesTelegram.join("\n\n");
          await enviarTelegram(telegramToken, telegramChatId, resumen);
        }
      }
    }
  }

  // 2. PRONOSTICAR TOP 3 PARTIDOS DE LAS PRÓXIMAS 24 HORAS (3 PROBABLES POR PARTIDO)
  if (mode === "predict" || mode === "both") {
    const ahoraUtc = new Date();
    const limiteUtc = new Date(ahoraUtc.getTime() + 24 * 3600 * 1000);
    // Sumamos 1 día extra a dateTo porque la API de Football-Data toma dateTo exclusivo cuando dateFrom != dateTo
    const dateToApi = new Date(limiteUtc.getTime() + 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const dateFrom = ahoraUtc.toISOString().slice(0, 10);
    const rangoTexto = `${formatearHoraBo(ahoraUtc.toISOString())} a ${formatearHoraBo(limiteUtc.toISOString())} (BO)`;

    const resMatches = await fetch(
      `${BASE_URL}/matches?dateFrom=${dateFrom}&dateTo=${dateToApi}`,
      { headers }
    );

    if (resMatches.ok) {
      const jsonMatches = await resMatches.json();
      const todos = jsonMatches.matches || [];
      const partidos = todos.filter((p: any) => {
        if (!p.utcDate) return false;
        const t = new Date(p.utcDate).getTime();
        return t >= ahoraUtc.getTime() && t <= limiteUtc.getTime();
      });

      if (partidos.length === 0) {
        if (!silent) {
          await enviarTelegram(
            telegramToken,
            telegramChatId,
            `📭 No hay partidos en las ligas principales en las próximas 24h (${rangoTexto}).`
          );
        }
      } else {
        const tablasCache: Record<string, any> = {};
        const candidatos: any[] = [];

        for (const p of partidos) {
          const ligaCode = p.competition.code;
          const ligaNombre = p.competition.name;

          if (!(ligaCode in tablasCache)) {
            await sleep(6500);
            const rSt = await fetch(
              `${BASE_URL}/competitions/${ligaCode}/standings`,
              { headers }
            );
            tablasCache[ligaCode] = rSt.ok ? await rSt.json() : null;
          }

          const datosLiga = tablasCache[ligaCode];
          if (!datosLiga?.standings) continue;

          const lambdas = calcularLambdasPartido(
            datosLiga.standings,
            p.homeTeam.id,
            p.awayTeam.id
          );
          if (!lambdas) continue;

          const [lambdaL, lambdaV] = lambdas;
          const top3 = calcularTop3Poisson(lambdaL, lambdaV, stakeBs);
          const confianzaMedia =
            top3.reduce((acc: number, m: any) => acc + m.probabilidad, 0) /
            top3.length;

          candidatos.push({
            partido: p,
            ligaNombre,
            lambdaL,
            lambdaV,
            top3,
            confianzaMedia,
          });
        }

        // Seleccionar únicamente los TOP 3 partidos con mayor probabilidad promedio en sus 3 mercados
        const topPartidos = candidatos
          .sort((a, b) => b.confianzaMedia - a.confianzaMedia)
          .slice(0, MAX_PARTIDOS_POR_JORNADA)
          .sort(
            (a, b) =>
              new Date(a.partido.utcDate).getTime() -
              new Date(b.partido.utcDate).getTime()
          );

        const lineasMensaje = [
          `📊 *TOP ${topPartidos.length} PARTIDOS PRÓXIMAS 24H (3 Probables c/u)*\n🕒 _${rangoTexto}_\n💵 _Stake Fijo: ${stakeBs.toFixed(2)} Bs_\n`,
        ];
        const apuestasSheet: any[] = [];

        for (const item of topPartidos) {
          const { partido: p, ligaNombre, lambdaL, lambdaV, top3 } = item;

          await sb.from("pronosticos_diarios").upsert(
            {
              match_id: p.id,
              fecha_partido: p.utcDate,
              liga: ligaNombre,
              equipo_local: p.homeTeam.name,
              equipo_visita: p.awayTeam.name,
              lambda_local: lambdaL,
              lambda_visita: lambdaV,
              top_3_mercados: top3,
            },
            { onConflict: "match_id" }
          );

          const horaBo = formatearHoraBo(p.utcDate);
          let bloque =
            `⚽ *${p.homeTeam.name} vs ${p.awayTeam.name}* (${ligaNombre})\n` +
            `🕒 _${horaBo} BO_ | 📈 _xG Calculado: ${lambdaL} - ${lambdaV}_\n`;
          top3.forEach((m: any, idx: number) => {
            bloque += `  ${idx + 1}. *${m.mercado}* — \`${m.probabilidad}%\` (Cuota aprox: *@${m.cuota_aprox}*)\n`;
          });

          lineasMensaje.push(bloque);
          pronosticadosCount++;
          apuestasSheet.push({
            match_id: p.id,
            hora_bo: horaBo,
            liga: ligaNombre,
            equipo_local: p.homeTeam.name,
            equipo_visita: p.awayTeam.name,
            top_3: top3,
          });
        }

        if (pronosticadosCount > 0) {
          if (webhookUrl) {
            try {
              await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "append_bets",
                  stake_bs: stakeBs,
                  modo: "TOP_3",
                  partidos: apuestasSheet,
                }),
              });
            } catch (_) {}
          }
          if (!silent) {
            await enviarTelegram(
              telegramToken,
              telegramChatId,
              lineasMensaje.join("\n")
            );
          }
        }
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      verificados: verificadosCount,
      pronosticados: pronosticadosCount,
      stake_bs: stakeBs,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
