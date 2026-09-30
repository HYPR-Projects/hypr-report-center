// src/v2/admin/lib/dvQuality.js
//
// Agregação dos KQIs do DoubleVerify (seção DoubleVerify do admin).
//
// O backend (`dv_quality`) devolve só CONTAGENS por Brand × Campaign × Dia,
// cobrindo o período pedido e o anterior. Toda taxa do Pinnacle é razão de
// duas contagens aditivas (conferido contra os totais da própria DV), então
// aqui soma-se o recorte filtrado e divide-se no fim — nunca média de taxas.
// É isso que deixa o filtro de Brand/Campaign instantâneo e exato.

// Taxa = num / den. `key` é o id usado na UI; num/den são colunas do payload.
export const KQI_DEFS = [
  { key: "viewable",           label: "Viewable",           num: "viewable_impressions",    den: "measured_impressions" },
  { key: "authentic_viewable", label: "Authentic Viewable", num: "authentic_viewable_imps", den: "measured_impressions" },
  { key: "authentic",          label: "Authentic",          num: "authentic_ads",           den: "monitored_ads" },
  { key: "brand_suitable",     label: "Brand Suitable",     num: "brand_suitable_ads",      den: "monitored_ads" },
  { key: "fraud_free",         label: "Fraud/SIVT Free",    num: "fraud_free_ads",          den: "monitored_ads" },
  { key: "in_geo",             label: "In Geo",             num: "in_geo_ads",              den: "monitored_ads" },
];

// "At a Glance" do Pinnacle. Aqui a taxa ALTA é ruim (bloqueio/incidente).
export const GLANCE_DEFS = [
  { key: "filters",   label: "Filters",   num: "filters",          den: "evaluations",   denLabel: "Evaluations" },
  { key: "blocks",    label: "Blocks",    num: "blocks",           den: "requests",      denLabel: "Requests" },
  { key: "incidents", label: "Incidents", num: "unique_incidents", den: "monitored_ads", denLabel: "Monitored Ads" },
];

function ratio(num, den) {
  return den > 0 ? num / den : null;
}

/** Índices das colunas: { monitored_ads: 3, ... } (offset das 3 dimensões). */
function columnIndex(columns) {
  const idx = {};
  columns.forEach((c, i) => { idx[c] = i + 3; });
  return idx;
}

function emptyTotals(columns) {
  const t = {};
  for (const c of columns) t[c] = 0;
  return t;
}

function addRow(totals, row, columns, idx) {
  for (const c of columns) totals[c] += Number(row[idx[c]]) || 0;
}

/** Taxas derivadas de um bloco de totais. */
export function deriveRates(totals) {
  const out = {};
  for (const d of [...KQI_DEFS, ...GLANCE_DEFS]) {
    // Coluna ausente (métrica saiu do catálogo da DV) = sem dado, não 0%.
    out[d.key] = d.num in totals && d.den in totals ? ratio(totals[d.num], totals[d.den]) : null;
  }
  return out;
}

/**
 * Filtro por brand/campanha. `brands` e `campaigns` são arrays de índices
 * (vazio = todos). Uma campanha pertence a uma brand só (o backend separa
 * mesmo nome em brands diferentes), então os dois filtros combinam em E.
 */
function rowMatcher(payload, { brands = [], campaigns = [] }) {
  const b = brands.length ? new Set(brands) : null;
  const c = campaigns.length ? new Set(campaigns) : null;
  return (row) => (!b || b.has(row[0])) && (!c || c.has(row[1]));
}

/**
 * Resumo do recorte: totais e taxas do período e do anterior, variação em
 * pontos percentuais, e a quebra por campanha (só período atual).
 */
export function summarize(payload, filters = {}) {
  const { columns, rows, from, to, prev_from: prevFrom, prev_to: prevTo } = payload;
  const idx = columnIndex(columns);
  const match = rowMatcher(payload, filters);

  const cur = emptyTotals(columns);
  const prev = emptyTotals(columns);
  const byCampaign = new Map();

  for (const row of rows) {
    if (!match(row)) continue;
    const day = row[2];
    if (day >= from && day <= to) {
      addRow(cur, row, columns, idx);
      let t = byCampaign.get(row[1]);
      if (!t) { t = emptyTotals(columns); byCampaign.set(row[1], t); }
      addRow(t, row, columns, idx);
    } else if (day >= prevFrom && day <= prevTo) {
      addRow(prev, row, columns, idx);
    }
  }

  const rates = deriveRates(cur);
  const prevRates = deriveRates(prev);
  const deltas = {};
  for (const k of Object.keys(rates)) {
    deltas[k] = rates[k] != null && prevRates[k] != null ? rates[k] - prevRates[k] : null;
  }

  const campaignRows = [...byCampaign.entries()].map(([ci, totals]) => {
    const c = payload.campaigns[ci];
    return {
      id: ci,
      name: c?.name ?? "",
      brand: payload.brands[c?.brand] ?? "",
      totals,
      rates: deriveRates(totals),
    };
  });
  campaignRows.sort((a, b) => b.totals.monitored_ads - a.totals.monitored_ads);

  return { totals: cur, prevTotals: prev, rates, prevRates, deltas, campaigns: campaignRows };
}

// "Blocking Trends" do Pinnacle: bloqueio por dia, total e por motivo.
// Todas sobre Requests — mesma base do Block Rate (conferido contra a DV).
export const BLOCKING_DEFS = [
  { key: "block_rate",     label: "Block Rate",                 num: "blocks" },
  { key: "brand_rate",     label: "Brand Suitability Block Rate", num: "brand_suitability_blocks" },
  { key: "fraud_rate",     label: "Fraud/SIVT Block Rate",      num: "fraud_blocks" },
  { key: "geo_rate",       label: "Out of Geo Block Rate",      num: "out_of_geo_blocks" },
];

/**
 * Série diária de bloqueio do recorte (período atual, mesmos filtros do
 * resto da página). Um ponto por dia do período — dia sem request entra com
 * taxa null (buraco na linha), não 0% (que leria como "nada bloqueado").
 * Dia com menos de `minRequests` também fica sem taxa: 8 requests com 8
 * bloqueios viram um pico de 100% ao lado de uma barra invisível.
 */
export const BLOCKING_MIN_REQUESTS = 100;

export function dailyBlocking(payload, filters = {}, { minRequests = BLOCKING_MIN_REQUESTS } = {}) {
  const { columns, rows, from, to } = payload;
  const idx = columnIndex(columns);
  const match = rowMatcher(payload, filters);
  const byDay = new Map();
  for (const row of rows) {
    const day = row[2];
    if (day < from || day > to || !match(row)) continue;
    let d = byDay.get(day);
    if (!d) { d = { requests: 0, blocks: 0, brand_suitability_blocks: 0, fraud_blocks: 0, out_of_geo_blocks: 0 }; byDay.set(day, d); }
    for (const k of Object.keys(d)) d[k] += idx[k] != null ? Number(row[idx[k]]) || 0 : 0;
  }
  const out = [];
  for (let day = from; day <= to; day = nextDay(day)) {
    const d = byDay.get(day) || { requests: 0, blocks: 0, brand_suitability_blocks: 0, fraud_blocks: 0, out_of_geo_blocks: 0 };
    const point = { day, requests: d.requests, blocks: d.blocks };
    for (const def of BLOCKING_DEFS) {
      point[def.key] = d.requests >= Math.max(1, minRequests) ? ratio(d[def.num], d.requests) : null;
    }
    out.push(point);
  }
  return out;
}

function nextDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Opções dos filtros. Campanhas se restringem às brands escolhidas (escolher
 * "Pepsi" e ver campanhas da Quaker na lista seria ruído). Ordenadas por
 * volume de Monitored Ads no período, maior primeiro.
 */
export function filterOptions(payload, selectedBrands = []) {
  const { columns, rows, from, to } = payload;
  const mi = columnIndex(columns).monitored_ads;
  const brandVol = new Map();
  const campVol = new Map();
  for (const row of rows) {
    if (row[2] < from || row[2] > to) continue;
    const v = Number(row[mi]) || 0;
    brandVol.set(row[0], (brandVol.get(row[0]) || 0) + v);
    campVol.set(row[1], (campVol.get(row[1]) || 0) + v);
  }
  const brandSet = selectedBrands.length ? new Set(selectedBrands) : null;
  const brands = [...brandVol.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([i, vol]) => ({ id: i, label: payload.brands[i], volume: vol }));
  const campaigns = [...campVol.entries()]
    .filter(([ci]) => !brandSet || brandSet.has(payload.campaigns[ci]?.brand))
    .sort((a, b) => b[1] - a[1])
    .map(([ci, vol]) => ({
      id: ci,
      label: payload.campaigns[ci]?.name ?? "",
      brand: payload.brands[payload.campaigns[ci]?.brand] ?? "",
      volume: vol,
    }));
  return { brands, campaigns };
}

/** Taxa → "85%", com ">99%" / "<1%" como o Pinnacle (evita "100%" mentiroso). */
export function formatRate(r) {
  if (r == null) return "—";
  const p = r * 100;
  if (p > 99 && p < 100) return ">99%";
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

/**
 * Variação em pontos percentuais → { text: "7 p.p.", dir }. O Pinnacle escreve
 * "▼7%", mas aqui é diferença de taxa (85% → 78% = 7 p.p.), e "%" leria como
 * variação relativa.
 */
export function formatDelta(d) {
  if (d == null) return null;
  const pp = d * 100;
  const abs = Math.abs(pp);
  const dir = abs < 0.5 ? "flat" : pp > 0 ? "up" : "down";
  const text = abs > 0 && abs < 1 ? "<1 p.p." : `${Math.round(abs)} p.p.`;
  return { text, dir };
}

/** 23.4M / 8.3M / 540K — mesma escala compacta do Pinnacle. */
export function formatCompact(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
