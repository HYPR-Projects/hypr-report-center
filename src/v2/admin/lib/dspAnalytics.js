// src/v2/admin/lib/dspAnalytics.js
//
// Pipeline de dados do Analytics › Saúde das DSPs. Funções puras: a página
// só desenha. Ver dspAnalytics.test.js.
//
// Régua de consistência (a mesma do Analytics do PMP): os filtros reduzem o
// CONJUNTO de linhas; KPIs, cards por DSP, custo do ABS, matriz formato × DSP
// e tabela de lines somam as MESMAS linhas sobreviventes, então tudo reage
// junto e nenhum número de um bloco contradiz o de outro.
//
// Três blocos do payload (backend/dsp_analytics.py):
//   series — dia × DSP × formato × ABS × survey × campanha × IO → gráfico;
//   prev   — o período anterior sem data                          → variações;
//   lines  — lines agregadas no período                           → todo o resto.
// `lines` e `series` saem da mesma base no backend, então a soma de um bate
// com a do outro para qualquer recorte que não seja por line.
//
// Fórmulas (padrão HYPR, iguais às do report e das réguas do admin):
//   CTR          = cliques ÷ impressões visíveis
//   VTR          = completions visíveis ÷ impressões visíveis (só vídeo)
//   Viewability  = visíveis ÷ mensuráveis (MRC)
//   Mensuração   = mensuráveis ÷ impressões
//   eCPM         = custo ÷ impressões × 1000
//   vCPM         = custo ÷ visíveis × 1000
//   CPCV         = custo de vídeo ÷ completions visíveis
// O custo é o que a DSP cobrou, com todas as fees, em BRL (DV360: Total Media
// Cost; Yahoo: Advertiser Spending).

import { ECPM_TIERS } from "./format.js";
import { sortSources } from "../../../shared/dspMeta.js";
import { sortTactics, chartTacticKey, tacticLabel } from "../../../shared/tacticMeta.js";

export const METRIC_KEYS = ["imp", "meas", "view", "clk", "cost", "vst", "v100", "vcomp", "fee"];
export const NO_TOKEN = "__none__";

// ── Decodificação ─────────────────────────────────────────────────────────

function decodeRows(rows, cols, ctx, withDate) {
  const idx = Object.fromEntries(cols.map((c, i) => [c, i]));
  return (rows || []).map((r) => {
    const tok = ctx.tokens[r[idx.tk]] || {};
    const out = {
      s: r[idx.s],
      m: r[idx.m],
      abs: r[idx.abs] === 1,
      sv: r[idx.sv] === 1,
      token: tok.t || NO_TOKEN,
      client: tok.client || "Sem cliente",
      campaign: tok.campaign || tok.t || "Sem campanha",
      io: ctx.ios[r[idx.io]] ?? "",
      tactic: (idx.tc != null && r[idx.tc]) || "none",
    };
    if (withDate) out.d = ctx.dates[r[idx.d]];
    for (const k of METRIC_KEYS) out[k] = Number(r[idx[k]]) || 0;
    if (idx.key != null) {
      out.key = r[idx.key];
      out.reason = r[idx.reason] || null;
      out.name = r[idx.name] || "";
      out.tag = r[idx.tag] || null;
      out.first = r[idx.first] || null;
      out.last = r[idx.last] || null;
    }
    return out;
  });
}

/** Payload do backend → objetos. Tolerante a bloco ausente. */
export function decodePayload(p) {
  if (!p) return null;
  const ctx = { tokens: p.tokens || [], ios: p.ios || [], dates: p.dates || [] };
  const series = decodeRows(p.series, p.series_cols || [], ctx, true);
  const prev = decodeRows(p.prev, p.prev_cols || [], ctx, false);
  const lines = decodeRows(p.lines, p.line_cols || [], ctx, false);
  const sources = sortSources(p.sources || [...new Set(lines.map((l) => l.s))]);
  return {
    from: p.from, to: p.to, prevFrom: p.prev_from, prevTo: p.prev_to,
    dates: ctx.dates, sources, series, prev, lines,
    absClients: p.abs_clients || [],
    tactics: p.tactics || [],
    landings: p.landings || [],
    generatedAt: p.generated_at || null,
  };
}

/** Série diária de lines (endpoint dsp_analytics_line_daily) → objetos. */
export function decodeLineDaily(p) {
  if (!p) return [];
  const cols = p.cols || [];
  const idx = Object.fromEntries(cols.map((c, i) => [c, i]));
  return (p.rows || []).map((r) => {
    const out = { key: r[idx.key], d: (p.dates || [])[r[idx.d]] };
    for (const k of METRIC_KEYS) out[k] = Number(r[idx[k]]) || 0;
    return out;
  });
}

// ── Filtros ───────────────────────────────────────────────────────────────

export const DEFAULT_FILTERS = Object.freeze({
  sources: [],          // [] = todas
  media: "all",         // all | DISPLAY | VIDEO
  abs: "all",           // all | abs | noabs
  includeSurvey: true,  // custo de survey é custo real da DSP; a tela deixa tirar
  clients: [],
  campaigns: [],        // short_tokens (NO_TOKEN = entrega sem campanha)
  ios: [],
  tactics: [],          // chaves de tática (tp_high, premium_list…)
  lines: [],            // chaves SOURCE|line_id|survey
});

/**
 * A linha passa no filtro? `skip` ignora dimensões — usado no custo do ABS
 * (compara com × sem, então ignora o filtro de ABS) e na cascata de opções.
 */
export function matchRow(r, f, skip = {}) {
  if (!skip.sources && f.sources.length && !f.sources.includes(r.s)) return false;
  if (!skip.media && f.media !== "all" && r.m !== f.media) return false;
  if (!skip.abs && f.abs === "abs" && !r.abs) return false;
  if (!skip.abs && f.abs === "noabs" && r.abs) return false;
  if (!f.includeSurvey && r.sv) return false;
  if (!skip.clients && f.clients.length && !f.clients.includes(r.client)) return false;
  if (!skip.campaigns && f.campaigns.length && !f.campaigns.includes(r.token)) return false;
  if (!skip.ios && f.ios.length && !f.ios.includes(r.io)) return false;
  if (!skip.tactics && f.tactics.length && !f.tactics.includes(r.tactic)) return false;
  if (!skip.lines && f.lines.length && r.key != null && !f.lines.includes(r.key)) return false;
  return true;
}

export function hasLineFilter(f) {
  return f.lines.length > 0;
}

export function filterRows(rows, f, skip) {
  return rows.filter((r) => matchRow(r, f, skip));
}

// ── Agregação ─────────────────────────────────────────────────────────────

export function emptyAgg() {
  const a = { vview: 0, vcost: 0, vimp: 0, dview: 0, dclk: 0 };
  for (const k of METRIC_KEYS) a[k] = 0;
  return a;
}

export function addInto(a, r) {
  for (const k of METRIC_KEYS) a[k] += r[k] || 0;
  if (r.m === "VIDEO") {
    a.vview += r.view || 0;
    a.vcost += r.cost || 0;
    a.vimp += r.imp || 0;
  }
  return a;
}

const ratio = (num, den, mult = 1) => (den > 0 ? (num / den) * mult : null);

/** Métricas derivadas de um agregado. null = sem denominador. */
export function derive(a) {
  return {
    ...a,
    measRate: ratio(a.meas, a.imp, 100),
    viewability: ratio(a.view, a.meas, 100),
    // Visíveis ÷ total: o rendimento da compra (o que a HYPR entrega é
    // impressão visível contabilizada). É mensuração × viewability.
    viewShare: ratio(a.view, a.imp, 100),
    ctr: ratio(a.clk, a.view, 100),
    vtr: ratio(a.vcomp, a.vview, 100),
    ecpm: ratio(a.cost, a.imp, 1000),
    vcpm: ratio(a.cost, a.view, 1000),
    cpcv: ratio(a.vcost, a.vcomp),
    feeCpm: ratio(a.fee, a.imp, 1000),
  };
}

export function aggregate(rows) {
  const a = emptyAgg();
  for (const r of rows) addInto(a, r);
  return derive(a);
}

export function groupAggregate(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    let a = map.get(k);
    if (!a) { a = emptyAgg(); map.set(k, a); }
    addInto(a, r);
  }
  const out = new Map();
  for (const [k, a] of map) out.set(k, derive(a));
  return out;
}

// ── Métricas exibidas ─────────────────────────────────────────────────────
// kind: count | money | rate (pp) — decide o formato e o tipo de variação.
// better: up | down | null (neutro: volume não é bom nem ruim por si).
export const METRICS = {
  imp:         { label: "Impressões",        kind: "count", better: null },
  meas:        { label: "Mensuráveis",       kind: "count", better: null },
  view:        { label: "Visíveis",          kind: "count", better: null },
  clk:         { label: "Cliques",           kind: "count", better: null },
  vcomp:       { label: "Completions",       kind: "count", better: null },
  cost:        { label: "Custo total",       kind: "money", better: null },
  ecpm:        { label: "eCPM",              kind: "money", better: "down", digits: 2 },
  vcpm:        { label: "vCPM",              kind: "money", better: "down", digits: 2 },
  cpcv:        { label: "CPCV",              kind: "money", better: "down", digits: 3 },
  ctr:         { label: "CTR",               kind: "rate",  better: "up",   digits: 2 },
  vtr:         { label: "VTR",               kind: "rate",  better: "up",   digits: 1 },
  viewability: { label: "Viewability",       kind: "rate",  better: "up",   digits: 1 },
  measRate:    { label: "Taxa de mensuração", kind: "rate", better: "up",   digits: 1 },
  viewShare:   { label: "Visíveis / Total",  kind: "rate",  better: "up",   digits: 1 },
};

/**
 * Variação atual × anterior. Volume e dinheiro: % relativa. Taxas: pontos
 * percentuais. null quando não há base de comparação.
 */
export function delta(cur, prev, key) {
  const def = METRICS[key];
  const c = cur?.[key];
  const p = prev?.[key];
  if (c == null || p == null || !def) return null;
  if (def.kind === "rate") return { kind: "pp", value: c - p };
  if (p === 0) return null;
  return { kind: "pct", value: ((c - p) / p) * 100 };
}

// ── Série temporal ────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, "0");

/** Segunda-feira da semana (ISO) de um "YYYY-MM-DD", em UTC pra não escorregar. */
export function weekStart(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // 0 = segunda
  dt.setUTCDate(dt.getUTCDate() - dow);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function bucketOf(iso, granularity) {
  if (granularity === "month") return iso.slice(0, 7);
  if (granularity === "week") return weekStart(iso);
  return iso;
}

/** Granularidade padrão pro tamanho da janela. */
export function autoGranularity(from, to) {
  if (!from || !to) return "day";
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  if (days > 120) return "month";
  if (days > 45) return "week";
  return "day";
}

/**
 * Buckets ordenados com o agregado total e por DSP:
 *   [{ key, total: derived, bySource: { DV360: derived, ... } }]
 * `dates` garante bucket pra dia sem entrega (linha cai a zero, não some).
 */
/**
 * `by`: "source" (uma série por DSP) ou "tactic" (uma por tática, com as
 * menores dobradas em "Outras"). O agregado fica em `bySource` nos dois
 * casos, pra o gráfico não precisar saber qual é.
 */
export function buildTimeseries(rows, dates, granularity, by = "source") {
  const groupOf = by === "tactic" ? (r) => chartTacticKey(r.tactic) : (r) => r.s;
  const keySet = new Set((dates || []).map((d) => bucketOf(d, granularity)));
  const total = new Map();
  const bySource = new Map();
  // Quem puxou cada ponto: impressão e custo por campanha dentro do bucket.
  // É o que explica um pico (ex.: 09/09/26, uma campanha fez 33 mi no DV360).
  const byToken = new Map();
  for (const r of rows) {
    const k = bucketOf(r.d, granularity);
    keySet.add(k);
    if (!total.has(k)) total.set(k, emptyAgg());
    addInto(total.get(k), r);
    const sk = `${k}|${groupOf(r)}`;
    if (!bySource.has(sk)) bySource.set(sk, emptyAgg());
    addInto(bySource.get(sk), r);
    if (r.token != null) {
      if (!byToken.has(k)) byToken.set(k, new Map());
      const tm = byToken.get(k);
      const tk = `${r.token}|${r.s}`;
      const cur = tm.get(tk) || { token: r.token, campaign: r.campaign, client: r.client, s: r.s, imp: 0, cost: 0 };
      cur.imp += r.imp || 0;
      cur.cost += r.cost || 0;
      tm.set(tk, cur);
    }
  }
  const keys = [...keySet].sort();
  const sources = [...new Set(rows.map(groupOf))];
  // Dias do período em cada bucket: semana/mês cortado pela janela vira
  // "parcial" — soma de volume dele não é comparável com a dos vizinhos.
  const daysIn = new Map();
  for (const d of dates || []) {
    const k = bucketOf(d, granularity);
    daysIn.set(k, (daysIn.get(k) || 0) + 1);
  }
  return keys.map((k) => {
    const src = {};
    for (const s of sources) {
      const a = bySource.get(`${k}|${s}`);
      src[s] = a ? derive(a) : null;
    }
    const days = daysIn.get(k) || 0;
    const full = granularity === "day" ? 1 : granularity === "week" ? 7 : daysInMonth(k);
    const contributors = [...(byToken.get(k)?.values() || [])];
    return {
      key: k, total: derive(total.get(k) || emptyAgg()), bySource: src,
      days, partial: granularity !== "day" && days > 0 && days < full,
      topByImp: topN(contributors, "imp"),
      topByCost: topN(contributors, "cost"),
    };
  });
}

function topN(list, key, n = 3) {
  return list.filter((x) => x[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, n);
}

/**
 * Mês a mês por DSP: valor da métrica em cada mês e a variação contra o mês
 * anterior da MESMA DSP (a leitura de "a DSP melhorou ou piorou?").
 */
export function buildMonthly(rows, dates, metric, by = "source") {
  const buckets = buildTimeseries(rows, dates, "month", by);
  // Mês parcial distorce SOMA (volume, custo), não razão: eCPM, CTR ou
  // viewability de 12 dias se comparam com o mês cheio. Só volume perde a
  // variação quando um dos dois meses está cortado.
  const isSum = METRICS[metric]?.kind === "count" || metric === "cost";
  const groups = [...new Set(rows.map(by === "tactic" ? (r) => chartTacticKey(r.tactic) : (r) => r.s))];
  const sources = by === "tactic" ? sortTactics(groups) : sortSources(groups);
  return {
    by,
    sources,
    rows: buckets.map((b, i) => {
      const prevB = buckets[i - 1];
      const cells = {};
      for (const s of [...sources, "__total__"]) {
        const cur = s === "__total__" ? b.total : b.bySource[s];
        const prv = prevB ? (s === "__total__" ? prevB.total : prevB.bySource[s]) : null;
        cells[s] = { value: cur?.[metric] ?? null, delta: prv && !(isSum && (b.partial || prevB.partial)) ? delta(cur, prv, metric) : null, costShare: null };
        if (s !== "__total__" && cur && b.total.cost > 0) cells[s].costShare = (cur.cost / b.total.cost) * 100;
      }
      return { key: b.key, partial: b.partial, days: b.days, cells };
    }),
  };
}

function daysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ── Réguas e red flags ────────────────────────────────────────────────────
// Réguas do admin (format.js / CampaignLines): quem muda uma muda a outra.
export const MIN_LINE_IMPS = 5000;
export const CTR_RED = { plain: 0.5, abs: 0.3 };      // ctrColorClass: vermelho abaixo
export const CTR_GOOD = { plain: 0.7, abs: 0.5 };
export const VTR_RED = 70;                            // vtrColorClass
export const VTR_GOOD = 80;
export const VIEWABILITY_RED = 60;                    // CampaignLines (MRC)
export const MEAS_RED = 70;                           // nova: abaixo disso CTR/VTR inflam

export function ecpmKind(media, abs) {
  if (media === "VIDEO") return "video";
  return abs ? "displayAbs" : "display";
}

export const FLAG_DEFS = {
  ecpm_high:     { label: "eCPM alto",        hint: "Acima da régua de eCPM do admin (display R$ 0,80 · display ABS R$ 1,80 · vídeo R$ 3,50)" },
  ctr_low:       { label: "CTR baixo",        hint: "Display abaixo de 0,50% (0,30% com ABS)" },
  vtr_low:       { label: "VTR baixo",        hint: "Vídeo abaixo de 70%" },
  view_low:      { label: "Viewability baixa", hint: "Abaixo de 60% das mensuráveis" },
  meas_low:      { label: "Mensuração baixa", hint: "Menos de 70% das impressões mensuradas: CTR e VTR sobre visíveis ficam inflados" },
  abs_divergent: { label: "ABS divergente",   hint: "Pagou fee pré-bid da DV numa line nomeada NO-ABS" },
};

/** Flags de UMA line já derivada. Line sem volume não é avaliada. */
export function lineFlags(l) {
  const flags = [];
  if (l.tag === "NO-ABS" && l.fee > 0) flags.push("abs_divergent");
  if ((l.imp || 0) < MIN_LINE_IMPS) return flags;
  const tier = ECPM_TIERS[ecpmKind(l.m, l.abs)];
  if (l.ecpm != null && tier && l.ecpm >= tier.warning) flags.push("ecpm_high");
  if (l.m === "DISPLAY" && l.ctr != null && l.ctr < (l.abs ? CTR_RED.abs : CTR_RED.plain)) flags.push("ctr_low");
  if (l.m === "VIDEO" && l.vtr != null && l.vtr < VTR_RED) flags.push("vtr_low");
  if (l.viewability != null && l.viewability < VIEWABILITY_RED) flags.push("view_low");
  if (l.measRate != null && l.measRate < MEAS_RED) flags.push("meas_low");
  return flags;
}

/**
 * Índice de engajamento: métrica ÷ régua "verde" da mídia (CTR em display,
 * VTR em vídeo). 1,0 = no alvo. Deixa comparar display com vídeo no mesmo
 * ranking sem somar maçã com laranja.
 */
export function engagementIndex(l) {
  if (l.m === "VIDEO") return l.vtr != null ? l.vtr / VTR_GOOD : null;
  if (l.ctr == null) return null;
  return l.ctr / (l.abs ? CTR_GOOD.abs : CTR_GOOD.plain);
}

/** Lines derivadas, com flags e índice de engajamento. */
export function enrichLines(lines) {
  return lines.map((l) => {
    const d = derive(addInto(emptyAgg(), l));
    const out = { ...l, ...d };
    out.flags = lineFlags(out);
    out.engagement = engagementIndex(out);
    return out;
  });
}

export const LINE_TABS = {
  volume:     { label: "Mais entregam",      sort: (a, b) => b.imp - a.imp },
  cost:       { label: "Maior custo",        sort: (a, b) => b.cost - a.cost },
  engagement: { label: "Melhor engajamento", sort: (a, b) => (b.engagement ?? -1) - (a.engagement ?? -1) },
  flags:      { label: "Red flags",          sort: (a, b) => b.cost - a.cost },
};

export function rankLines(enriched, tab) {
  const def = LINE_TABS[tab] || LINE_TABS.volume;
  let rows = enriched;
  if (tab === "engagement") rows = rows.filter((l) => l.imp >= MIN_LINE_IMPS && l.engagement != null);
  if (tab === "flags") rows = rows.filter((l) => l.flags.length > 0);
  return [...rows].sort(def.sort);
}

// ── Blocos da página ──────────────────────────────────────────────────────

/** Cards por DSP: métricas + share de impressões e custo. */
export function buildScorecards(lines, sources) {
  const by = groupAggregate(lines, (l) => l.s);
  const total = aggregate(lines);
  return sortSources(sources.filter((s) => by.has(s))).map((s) => {
    const m = by.get(s);
    return {
      source: s,
      metrics: m,
      shareImp: ratio(m.imp, total.imp, 100),
      shareCost: ratio(m.cost, total.cost, 100),
    };
  });
}

/**
 * Custo do ABS: por DSP × formato, com vs sem ABS. Ignora o filtro de ABS
 * (a pergunta é a diferença) e respeita todos os outros.
 */
export function buildAbsCost(lines) {
  const by = groupAggregate(lines, (l) => `${l.s}|${l.m}|${l.abs ? 1 : 0}`);
  const out = [];
  const pairs = new Set(lines.filter((l) => l.m !== "OUTRO").map((l) => `${l.s}|${l.m}`));
  for (const p of pairs) {
    const [s, m] = p.split("|");
    const withAbs = by.get(`${p}|1`) || null;
    const without = by.get(`${p}|0`) || null;
    const d = withAbs?.ecpm != null && without?.ecpm != null ? withAbs.ecpm - without.ecpm : null;
    out.push({ source: s, media: m, withAbs, without, ecpmDelta: d });
  }
  const order = sortSources([...new Set(out.map((r) => r.source))]);
  return out.sort((a, b) =>
    order.indexOf(a.source) - order.indexOf(b.source) || a.media.localeCompare(b.media));
}

/** Matriz formato × DSP. */
export function buildFormatMatrix(lines) {
  const by = groupAggregate(lines.filter((l) => l.m !== "OUTRO"), (l) => `${l.s}|${l.m}`);
  const sources = sortSources([...new Set(lines.map((l) => l.s))]);
  return sources.map((s) => ({
    source: s,
    DISPLAY: by.get(`${s}|DISPLAY`) || null,
    VIDEO: by.get(`${s}|VIDEO`) || null,
  }));
}

/** Sparkline de impressões por DSP (dia a dia da série filtrada). */
export function sparkBySource(seriesRows, dates) {
  const map = new Map();
  for (const r of seriesRows) {
    if (!map.has(r.s)) map.set(r.s, new Map());
    const m = map.get(r.s);
    m.set(r.d, (m.get(r.d) || 0) + r.imp);
  }
  const out = {};
  for (const [s, m] of map) out[s] = (dates || []).map((d) => m.get(d) || 0);
  return out;
}

/**
 * Qualidade do dado: entrega sem campanha, divergência de ABS, mensuração
 * baixa por DSP e frescor (aterrissagem vs ontem).
 */
export function buildDataQuality(lines, landings, to) {
  const noToken = lines.filter((l) => l.token === NO_TOKEN);
  const unattributed = aggregate(noToken);
  const total = aggregate(lines);
  const divergent = lines.filter((l) => l.tag === "NO-ABS" && l.fee > 0);
  const nameVsList = lines.filter((l) => l.tag === "NO-ABS" && l.reason === "cliente");
  const bySource = groupAggregate(lines, (l) => l.s);
  const lowMeasurement = [...bySource]
    .filter(([, m]) => m.measRate != null && m.measRate < MEAS_RED && m.imp > 0)
    .map(([s, m]) => ({ source: s, measRate: m.measRate }));
  // Só as DSPs do recorte: com filtro de DSP, atraso de outra fonte é ruído.
  const present = new Set(lines.map((l) => l.s));
  const freshness = (landings || []).filter((l) => present.has(String(l.source || "").toUpperCase())).map((l) => ({
    source: String(l.source || "").toUpperCase(),
    maxDate: l.max_date || null,
    daysBehind: l.max_date && to
      ? Math.round((Date.parse(to) - Date.parse(l.max_date)) / 86_400_000)
      : null,
  }));
  return {
    unattributed: { ...unattributed, shareCost: ratio(unattributed.cost, total.cost, 100) },
    divergent: { count: divergent.length, fee: divergent.reduce((a, l) => a + l.fee, 0) },
    nameVsList: { count: nameVsList.length },
    lowMeasurement,
    freshness,
  };
}

// ── Opções dos filtros (cascata) ──────────────────────────────────────────

function optionList(rows, keyFn, labelFn, subFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const cur = map.get(k) || { id: k, label: labelFn(r), sub: subFn?.(r), volume: 0 };
    cur.volume += r.imp;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => b.volume - a.volume);
}

/**
 * Cliente → Campanha → IO → Line. Cada nível respeita os de cima e os
 * filtros de DSP/formato/ABS/survey, nunca o próprio (senão a seleção
 * esconderia as irmãs).
 */
export function buildFilterOptions(lines, f) {
  const base = { clients: true, campaigns: true, ios: true, lines: true };
  const lvl1 = filterRows(lines, f, base);
  const lvl2 = filterRows(lines, f, { campaigns: true, ios: true, lines: true });
  const lvl3 = filterRows(lines, f, { ios: true, lines: true });
  const lvl4 = filterRows(lines, f, { lines: true });
  const lvlTac = filterRows(lines, f, { tactics: true, lines: true });
  return {
    clients: optionList(lvl1, (r) => r.client, (r) => r.client),
    campaigns: optionList(lvl2, (r) => r.token, (r) => r.campaign, (r) => (r.token === NO_TOKEN ? "sem short_token" : `${r.client} · ${r.token}`)),
    ios: optionList(lvl3, (r) => r.io, (r) => r.io || "(sem IO)", (r) => r.s),
    tactics: sortTacticOptions(optionList(lvlTac, (r) => r.tactic, (r) => tacticLabel(r.tactic))),
    lines: optionList(lvl4, (r) => r.key, (r) => r.name || r.key, (r) => `${r.s} · ${r.m === "VIDEO" ? "Vídeo" : "Display"}${r.sv ? " · survey" : ""}`),
  };
}

function sortTacticOptions(list) {
  const order = sortTactics(list.map((o) => o.id));
  return order.map((id) => list.find((o) => o.id === id));
}

/**
 * Quebra por tática: métricas de cada tática no recorte, share de impressão e
 * custo, nº de lines e de lines com red flag. `bySource` abre cada tática nas
 * DSPs (a mesma tática rende diferente no DV360 e na Yahoo).
 */
export function buildTactics(enriched) {
  const total = aggregate(enriched);
  const by = groupAggregate(enriched, (l) => l.tactic);
  const bySrc = groupAggregate(enriched, (l) => `${l.tactic}|${l.s}`);
  const count = new Map();
  const flagged = new Map();
  for (const l of enriched) {
    count.set(l.tactic, (count.get(l.tactic) || 0) + 1);
    if (l.flags?.length) flagged.set(l.tactic, (flagged.get(l.tactic) || 0) + 1);
  }
  const sources = sortSources([...new Set(enriched.map((l) => l.s))]);
  return sortTactics([...by.keys()]).map((t) => {
    const m = by.get(t);
    return {
      tactic: t,
      metrics: m,
      lines: count.get(t) || 0,
      flagged: flagged.get(t) || 0,
      shareImp: ratio(m.imp, total.imp, 100),
      shareCost: ratio(m.cost, total.cost, 100),
      bySource: sources
        .filter((s) => bySrc.has(`${t}|${s}`))
        .map((s) => ({ source: s, metrics: bySrc.get(`${t}|${s}`) })),
    };
  });
}

/** Remove da seleção o que não existe mais no payload novo (troca de período). */
export function pruneFilters(f, lines) {
  const has = (key) => new Set(lines.map((l) => l[key]));
  const clients = has("client"); const tokens = has("token");
  const ios = has("io"); const keys = has("key"); const tactics = has("tactic");
  return {
    ...f,
    clients: f.clients.filter((x) => clients.has(x)),
    campaigns: f.campaigns.filter((x) => tokens.has(x)),
    ios: f.ios.filter((x) => ios.has(x)),
    tactics: (f.tactics || []).filter((x) => tactics.has(x)),
    lines: f.lines.filter((x) => keys.has(x)),
  };
}
