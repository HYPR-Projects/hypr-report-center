// src/shared/overviewSeries.js
//
// Série diária da Visão Geral e as contas de ritmo que acompanham os KPIs.
//
// Fonte: `aggregates.detail` (campaign_results, custo já rateado por
// enrichDetailCosts). É a mesma fonte dos KPIs de topo, do Resumo por mídia
// e da tabela "Entrega por dia" — assim o gráfico de tendência soma
// exatamente o que os números ao redor dizem.
//
// Por que não `chartDisplay`/`chartVideo`: essas séries vêm do `daily`
// (UNIFIED) e não carregam custo. A sparkline do custo no herói lia
// `effective_total_cost` delas e saía sempre plana (todos os pontos 0).

/**
 * Agrupa o detail por data (Display + Vídeo no mesmo balde) e recalcula as
 * taxas a partir das somas. Datas em ordem crescente.
 *
 * CTR usa todos os cliques sobre todas as imp. visíveis (mesma conta da
 * visão "Agregado" da tabela diária). VTR usa só o lado de vídeo.
 */
export function buildDailySeries(detail) {
  if (!Array.isArray(detail) || detail.length === 0) return [];
  const byDate = new Map();
  for (const r of detail) {
    const date = typeof r?.date === "string" ? r.date.slice(0, 10) : null;
    if (!date) continue;
    let e = byDate.get(date);
    if (!e) {
      e = {
        date,
        impressions: 0,
        viewable_impressions: 0,
        clicks: 0,
        video_starts: 0,
        video_view_100: 0,
        display_viewable: 0,
        video_viewable: 0,
        cost: 0,
      };
      byDate.set(date, e);
    }
    const vi = Number(r.viewable_impressions) || 0;
    e.impressions += Number(r.impressions) || 0;
    e.viewable_impressions += vi;
    e.clicks += Number(r.clicks) || 0;
    e.cost += Number(r.effective_total_cost) || 0;
    if (r.media_type === "VIDEO") {
      e.video_viewable += vi;
      e.video_starts += Number(r.video_starts) || 0;
      e.video_view_100 += Number(r.video_view_100) || 0;
    } else if (r.media_type === "DISPLAY") {
      e.display_viewable += vi;
    }
  }
  return Array.from(byDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({
      ...e,
      ctr: e.viewable_impressions > 0 ? (e.clicks / e.viewable_impressions) * 100 : null,
      vtr: e.video_viewable > 0 ? (e.video_view_100 / e.video_viewable) * 100 : null,
    }));
}

/** Últimos `n` valores de uma chave da série (para sparklines). */
export function lastValues(series, key, n = 14) {
  if (!Array.isArray(series)) return [];
  return series.slice(-n).map((d) => Number(d?.[key]) || 0);
}

/**
 * Métricas do seletor de tendência que fazem sentido para a campanha.
 * Cliques/CTR só com clique; Views 100%/VTR só com vídeo; custo só quando
 * há custo (campanha 100% bonificada não tem).
 */
export function availableTrendMetrics(series) {
  const sum = (k) => (series || []).reduce((s, d) => s + (Number(d?.[k]) || 0), 0);
  const out = ["viewable_impressions"];
  if (sum("clicks") > 0) out.push("clicks", "ctr");
  if (sum("video_viewable") > 0 || sum("video_view_100") > 0) out.push("video_view_100", "vtr");
  if (sum("cost") > 0) out.push("cost");
  return out;
}

const ONE_DAY = 86_400_000;

function ymdToUtc(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** "Hoje menos 1" em Brasília, como YYYY-MM-DD (o dado de mídia chega D-1). */
export function yesterdayInSaoPaulo(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const t = ymdToUtc(parts);
  return new Date(t - ONE_DAY).toISOString().slice(0, 10);
}

/**
 * Quanto do período da campanha já passou, em %, contando até `asOf`
 * (inclusive). `asOf` deve ser a data do dado ("dados até"), para a frase
 * "X% do budget em Y% do período" comparar coisas da mesma data. Sem
 * `asOf`, usa ontem em Brasília. Antes do início → 0; depois do fim → 100.
 */
export function periodElapsedPct(startISO, endISO, asOf = null) {
  const start = ymdToUtc(startISO);
  const end = ymdToUtc(endISO);
  if (start == null || end == null || end < start) return null;
  const ref = ymdToUtc(asOf || yesterdayInSaoPaulo());
  if (ref == null) return null;
  const totalDays = Math.round((end - start) / ONE_DAY) + 1;
  const elapsed = Math.round((Math.min(ref, end) - start) / ONE_DAY) + 1;
  if (elapsed <= 0) return 0;
  return Math.min(100, (elapsed / totalDays) * 100);
}
