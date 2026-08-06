// src/v2/portal/portalMetrics.js
//
// Matemática e vocabulário de filtro COMPARTILHADOS pelas duas visões do Portal
// do Cliente (aba Campanhas = ClientPortalPage, aba Analytics = PortalAnalytics).
//
// Existe pra que os dois lados calculem exatamente a mesma coisa. Antes cada um
// tinha a sua própria agregação (e divergiam: a Visão Geral fazia média de VTR,
// o Analytics também, e nenhum dos dois recortava por formato).
//
// Três problemas que este módulo resolve:
//
//  1. FILTRO DE FORMATO ERA UM NO-OP. Ele filtrava por *presença* de mídia
//     ("mostre campanhas que têm display") — e como praticamente toda campanha
//     roda display E vídeo, marcar "Display" não mudava nada na tela. O certo é
//     RECORTE: escolher Display recalcula todos os números com a parcela de
//     display (investimento, impressões, cliques, CTR…). Ver `mediaMode`.
//
//  2. AGREGADO DE RAZÃO. CTR/VTR agregados precisam ser Σnumerador/Σdenominador,
//     nunca média das razões por campanha (uma campanha de 100 mil impressões
//     pesaria igual a uma de 10 milhões).
//
//  3. VOCABULÁRIO DE FEATURES CONGELADO. As opções eram 3 fixas (Survey/RMND/
//     PDOOH) contra o campo `features`, que só lista o que já foi ATIVADO no hub
//     — na prática vinha vazio, então o filtro nunca casava com nada. O que o
//     cliente negociou vive em `negotiated_features` (Survey, Tap To Go,
//     Downloaded Apps, CTV, Topics, Footfall…). Aqui as opções são derivadas dos
//     dados reais do cliente, então toda opção oferecida casa com ≥1 campanha.
//
// Compatibilidade: o recorte por mídia depende de campos que o backend passou a
// emitir junto com esta mudança (`display_impressions`, `video_impressions`…).
// Enquanto o backend não for deployado, `hasMediaSplit` devolve false e tudo
// degrada pro comportamento antigo (filtro por presença, CPM/CPCV em "—") — sem
// nunca mostrar número errado.

import { startOfMonth, endOfMonth, subMonths } from "date-fns";
import { parseYmd, ymd } from "../../shared/dateFilter";
import { formatMonthLabel } from "../admin/lib/format";

export const num = (v) => Number(v) || 0;

// ── Investimento ────────────────────────────────────────────────────────────
// PI contratado (display + vídeo). Campo seguro: é o que o cliente comprou,
// não o custo real da HYPR.
export const investedOf = (c) => num(c.d_client_budget) + num(c.v_client_budget);

// ── Features ────────────────────────────────────────────────────────────────

// Rótulos das 3 features canônicas (campo `features`, derivado dos assets já
// ativos no hub). Fallback quando `negotiated_features` não veio no payload.
export const CANON_FEATURE_LABEL = { survey: "Survey", rmnd: "RMND", pdooh: "PDOOH" };

// Ordem de exibição das features mais recorrentes; o resto entra alfabético.
// Espelha o vocabulário real do Sales Center (extras.cl_features).
const FEATURE_PRIORITY = [
  "survey", "pdooh", "rmnd", "taptogo", "downloadedapps", "footfall",
  "topics", "ctv", "purchasecontext", "tvsync", "weather", "attentionad",
];

/** Chave estável p/ comparar feature: sem acento, sem caixa, sem pontuação.
 *  "P-DOOH" → "pdooh" · "Tap to Go" ≡ "Tap To Go" → "taptogo" */
export function featureKey(label) {
  return String(label || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Features de UMA campanha, como rótulos de exibição. Prioriza o pacote
 *  negociado (completo); cai nas canônicas ativas quando ausente. */
export function featuresOf(c) {
  if (c?.negotiated_features?.length) return c.negotiated_features;
  return (c?.features || []).map((k) => CANON_FEATURE_LABEL[k] || k);
}

/** Set de chaves de feature de uma campanha (p/ o predicado do filtro). */
export function featureKeysOf(c) {
  return new Set(featuresOf(c).map(featureKey));
}

/** Opções do dropdown de Features, derivadas dos dados reais do cliente.
 *  Toda opção oferecida casa com pelo menos uma campanha — nunca mais um
 *  filtro que existe na UI mas não existe nos dados. */
export function buildFeatureOptions(campaigns) {
  const byKey = new Map(); // key → {label, count}
  for (const c of campaigns || []) {
    for (const key of featureKeysOf(c)) {
      const entry = byKey.get(key);
      if (entry) entry.count += 1;
      else byKey.set(key, { label: null, count: 1 });
    }
    // Rótulo de exibição: o primeiro visto (já vem normalizado do backend).
    for (const label of featuresOf(c)) {
      const entry = byKey.get(featureKey(label));
      if (entry && !entry.label) entry.label = label;
    }
  }
  return [...byKey.entries()]
    .map(([value, { label, count }]) => ({ value, label: label || value, count }))
    .sort((a, b) => {
      const pa = FEATURE_PRIORITY.indexOf(a.value);
      const pb = FEATURE_PRIORITY.indexOf(b.value);
      if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
      return a.label.localeCompare(b.label, "pt-BR");
    });
}

// ── Recorte por mídia ───────────────────────────────────────────────────────

/** O payload tem o split por mídia? (false = backend antigo → sem recorte.) */
export function hasMediaSplit(campaigns) {
  return (campaigns || []).some(
    (c) => c?.display_impressions != null || c?.video_impressions != null,
  );
}

/** Modo de recorte a partir da seleção do filtro Formato.
 *  Nenhum ou os dois marcados = "ALL" (combinado); um só = recorte naquele. */
export function mediaMode(fmts, splitAvailable = true) {
  if (!splitAvailable) return "ALL";
  if (!Array.isArray(fmts) || fmts.length !== 1) return "ALL";
  return fmts[0] === "VIDEO" ? "VIDEO" : "DISPLAY";
}

/** Métricas de uma campanha no recorte pedido.
 *
 *  Devolve sempre a mesma forma, com os componentes por mídia preservados —
 *  o agregado precisa deles pro CPM de display e o CPCV de vídeo mesmo quando
 *  o recorte é combinado. `null` em impressão por mídia = backend antigo (não
 *  sabemos), distinto de 0 (sabemos que não houve). */
export function sliceCampaign(c, mode = "ALL") {
  const dInvested = num(c.d_client_budget);
  const vInvested = num(c.v_client_budget);
  const dImp = c.display_impressions != null ? num(c.display_impressions) : null;
  const vImp = c.video_impressions != null ? num(c.video_impressions) : null;
  const dClicks = c.display_clicks != null ? num(c.display_clicks) : null;
  const vClicks = c.video_clicks != null ? num(c.video_clicks) : null;

  if (mode === "DISPLAY") {
    return {
      invested: dInvested,
      impressions: dImp ?? 0,
      clicks: dClicks ?? 0,
      completions: 0,
      dInvested, dImp, vInvested: 0, vImp: 0,
      vtrSample: null,
      pacing: c.display_pacing ?? null,
      hasVideo: false,
    };
  }
  if (mode === "VIDEO") {
    return {
      invested: vInvested,
      impressions: vImp ?? 0,
      clicks: vClicks ?? 0,
      completions: num(c.completions),
      dInvested: 0, dImp: 0, vInvested, vImp,
      vtrSample: c.vtr != null ? Number(c.vtr) : null,
      pacing: c.video_pacing ?? null,
      hasVideo: true,
    };
  }
  return {
    invested: dInvested + vInvested,
    // Combinado usa o total autoritativo do payload (não dImp+vImp), que
    // continua correto mesmo sem o split.
    impressions: num(c.viewable_impressions),
    clicks: num(c.clicks),
    completions: num(c.completions),
    dInvested, dImp, vInvested, vImp,
    vtrSample: c.vtr != null ? Number(c.vtr) : null,
    pacing: c.pacing ?? null,
    hasVideo: (c.media || []).includes("VIDEO"),
  };
}

/** Agrega as fatias e deriva as razões. Toda razão é Σnum/Σdenom. */
export function aggregateSlices(rows) {
  const t = {
    invested: 0, impressions: 0, clicks: 0, completions: 0,
    dInvested: 0, dImp: 0, vInvested: 0, vImp: 0,
  };
  let dImpKnown = false, vImpKnown = false;
  const vtrSamples = [];
  for (const r of rows) {
    t.invested += r.invested;
    t.impressions += r.impressions;
    t.clicks += r.clicks;
    t.completions += r.completions;
    t.dInvested += r.dInvested;
    t.vInvested += r.vInvested;
    if (r.dImp != null) { t.dImp += r.dImp; dImpKnown = true; }
    if (r.vImp != null) { t.vImp += r.vImp; vImpKnown = true; }
    if (r.vtrSample != null) vtrSamples.push(r.vtrSample);
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    ...t,
    count: rows.length,
    ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null,
    // VTR = Σviews 100% / Σimpressões visíveis de vídeo. Sem o split (backend
    // antigo) cai na média das campanhas — aproximação, mas melhor que "—".
    vtr: vImpKnown && t.vImp > 0
      ? (t.completions / t.vImp) * 100
      : mean(vtrSamples),
    // CPC total = investimento do recorte ÷ cliques do recorte.
    cpc: t.clicks > 0 ? t.invested / t.clicks : null,
    // CPM efetivo de display = PI de display ÷ impressões visíveis de display.
    // "Efetivo" porque usa a entrega REAL (não a contratada): quando a campanha
    // sobreentrega, o CPM efetivo cai abaixo do CPM negociado.
    cpmDisplay: dImpKnown && t.dImp > 0 ? (t.dInvested / t.dImp) * 1000 : null,
    // CPCV efetivo de vídeo = PI de vídeo ÷ views 100% entregues.
    cpcvVideo: t.completions > 0 && t.vInvested > 0 ? t.vInvested / t.completions : null,
  };
}

/** Atalho: campanhas → totais no recorte. */
export function summarize(campaigns, mode = "ALL") {
  return aggregateSlices((campaigns || []).map((c) => sliceCampaign(c, mode)));
}

// ── Eficiência (custo unitário efetivo) ─────────────────────────────────────
//
// "Efetivo" = investimento CONTRATADO ÷ entrega REAL. Quando a campanha
// sobreentrega, o custo unitário cai abaixo do negociado — é exatamente essa a
// leitura que interessa ao cliente. Client-safe: usa só o PI (o que ele
// comprou) e a entrega, nunca o custo real da HYPR.
//
// CPCV com 3 casas (valores tipicamente < R$ 0,50), igual ao report (VideoV2).
export const formatCpcv = (v) =>
  v == null || !Number.isFinite(Number(v)) ? "—" : `R$ ${Number(v).toFixed(3).replace(".", ",")}`;

/** Os 3 tiles de eficiência, na mesma ordem e com a mesma explicação nas duas
 *  abas. `value` já vem formatado; `raw` fica pro caller decidir estados. */
export function efficiencyTiles(summary, formatMoney) {
  return [
    {
      key: "cpc",
      label: "CPC",
      sub: "custo por clique",
      raw: summary.cpc,
      value: summary.cpc == null ? "—" : formatMoney(summary.cpc),
      hint: "Investimento do recorte ÷ cliques entregues",
    },
    {
      key: "cpm",
      label: "CPM efetivo",
      sub: "display",
      raw: summary.cpmDisplay,
      value: summary.cpmDisplay == null ? "—" : formatMoney(summary.cpmDisplay),
      hint: "Investimento de display ÷ impressões visíveis de display × 1.000",
    },
    {
      key: "cpcv",
      label: "CPCV efetivo",
      sub: "vídeo",
      raw: summary.cpcvVideo,
      value: formatCpcv(summary.cpcvVideo),
      hint: "Investimento de vídeo ÷ views 100% entregues",
    },
  ];
}

// ── Presets de período do portal ────────────────────────────────────────────
//
// Os presets do report ("Ontem", "Últimos 7 dias", "Este mês"…) são de janela
// CURTA, pensados pra uma campanha no ar. Num portal — arquivo de meses/anos de
// campanhas já encerradas — todos eles caíam FORA dos limites dos dados e o
// `clamp` do buildPresets os colapsava em `range: null`, que o filtro
// interpreta como "Todo o período". Resultado: clicar em qualquer preset não
// fazia absolutamente nada.
//
// Aqui os presets são derivados dos DADOS do cliente: os meses que ele
// realmente tem, os anos, e janelas relativas — e um preset só é oferecido se
// tiver interseção com os dados e não for redundante com "Todo o período".

const MAX_MONTH_PRESETS = 12;

export function buildPortalPresets(today, firstStart, lastEnd, months = []) {
  const out = [{ id: "all", label: "Todo o período", range: null, wasClamped: false }];
  const lo = parseYmd(firstStart);
  const hi = parseYmd(lastEnd);
  if (!lo || !hi) return out;

  const loKey = ymd(lo);
  const hiKey = ymd(hi);
  const seen = new Set();

  // `rank` define a ORDEM DE EXIBIÇÃO (janelas relativas → anos → meses), que é
  // independente da ordem de REGISTRO (= prioridade de rótulo, ver abaixo).
  const add = (rank, id, label, from, to) => {
    // Recorta aos limites dos dados; sem interseção → preset não é oferecido
    // (em vez de virar `null` e silenciosamente cair em "Todo o período").
    const f = from < lo ? lo : from;
    const t = to > hi ? hi : to;
    if (f > t) return;
    const key = `${ymd(f)}|${ymd(t)}`;
    // Redundante com "Todo o período", ou já coberto por um preset anterior.
    if ((ymd(f) === loKey && ymd(t) === hiKey) || seen.has(key)) return;
    seen.add(key);
    out.push({ rank, id, label, range: { from: f, to: t }, wasClamped: f > from || t < to });
  };

  // Ordem de REGISTRO = prioridade de rótulo. Dois presets podem colapsar no
  // mesmo range depois do recorte (num portal de maio–junho, "Últimos 3 meses"
  // vira exatamente junho); quem registra primeiro fica com o range, então
  // registramos do rótulo mais específico pro mais genérico — "Junho de 2026"
  // é mais informativo que "Últimos 3 meses" pra descrever a mesma janela.

  // Meses presentes nos dados — o recorte mais usado num portal.
  for (const m of [...months].sort().reverse().slice(0, MAX_MONTH_PRESETS)) {
    const [y, mm] = m.split("-").map(Number);
    if (!y || !mm) continue;
    add(3, `m-${m}`, formatMonthLabel(m, "long"), new Date(y, mm - 1, 1), endOfMonth(new Date(y, mm - 1, 1)));
  }

  // Anos presentes nos dados, quando o portal cruza mais de um.
  const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort().reverse();
  if (years.length > 1) {
    for (const y of years) {
      add(2, `y-${y}`, y, new Date(Number(y), 0, 1), new Date(Number(y), 11, 31));
    }
  }

  const ref = today || new Date();
  add(1, "last3m", "Últimos 3 meses", startOfMonth(subMonths(ref, 2)), endOfMonth(ref));
  add(1, "last6m", "Últimos 6 meses", startOfMonth(subMonths(ref, 5)), endOfMonth(ref));
  add(1, "last12m", "Últimos 12 meses", startOfMonth(subMonths(ref, 11)), endOfMonth(ref));

  // Exibição: janelas relativas (da mais ampla) → anos → meses, sempre do mais
  // recente pro mais antigo. Mesmo sentido de leitura da lista de campanhas.
  // "Todo o período" fica no topo.
  const [all, ...rest] = out;
  rest.sort((a, b) =>
    a.rank - b.rank ||
    (a.rank === 1
      ? (b.range.to - b.range.from) - (a.range.to - a.range.from)
      : b.range.from - a.range.from),
  );
  return [all, ...rest];
}

/** Meses (YYYY-MM) cobertos pelo VOO de cada campanha — não só o de início.
 *  Uma campanha de 11/05 a 15/06 aparece nos presets de maio E de junho. */
export function monthsCovered(campaigns) {
  const set = new Set();
  for (const c of campaigns || []) {
    const s = parseYmd(c.start_date);
    if (!s) continue;
    const e = parseYmd(c.end_date) || s;
    const cur = new Date(s.getFullYear(), s.getMonth(), 1);
    const last = new Date(e.getFullYear(), e.getMonth(), 1);
    while (cur <= last) {
      set.add(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`);
      cur.setMonth(cur.getMonth() + 1);
    }
  }
  return [...set];
}

/** Predicado de período: a campanha entra se o voo dela cruza o range. */
export function overlapsPeriod(c, period) {
  if (!period?.from || !period?.to) return true;
  const from = ymd(period.from);
  const to = ymd(period.to);
  const cs = c.start_date || "";
  const ce = c.end_date || cs;
  if (!cs) return false;
  return !(cs > to || ce < from);
}
