// src/v2/admin/lib/pmpAnalyticsData.js
//
// Pipeline de dados da aba Analytics do PMP Deals, como funções PURAS.
//
// Antes tudo isso morava em `useMemo`s dentro do PmpAnalytics.jsx — o que
// significava que a única forma de conferir se um filtro somava certo era
// abrir o navegador e olhar. Aqui as mesmas contas ficam testáveis (ver
// pmpAnalyticsData.test.js) e o componente vira só a camada visual.
//
// Régua de consistência (mantida do componente):
//   • filtros de dimensão (cliente/campanha/status/bid) reduzem o CONJUNTO DE
//     LINES → e por consequência as rows de série que sobrevivem;
//   • o filtro de período reduz a JANELA DE DIAS das rows;
//   • PI é valor de CONTRATO: não tem janela. Cards de contrato e o fechamento
//     mensal respeitam dimensão e ignoram período — de propósito.

import {
  effectiveStatus, bidTypeLabel, pctEntrega, resolveGroupPi,
  buildDeliveryKeyResolver, lineKey,
} from "./pmpFormat.js";

const num = (v) => Number(v) || 0;

// ── Opções de filtro ────────────────────────────────────────────────────────

/** Opções dos multi-selects, derivadas das lines que chegaram na aba. */
export function deriveAnalyticsOptions(lines = []) {
  const c = new Set(), ca = new Set(), st = new Set(), bd = new Set();
  for (const l of lines) {
    if (l.customer) c.add(l.customer);
    if (l.campaign_name) ca.add(l.campaign_name);
    st.add(effectiveStatus(l));
    if (l.bid_type) bd.add(l.bid_type);
  }
  const sort = (arr) => [...arr].sort((a, b) => a.localeCompare(b, "pt-BR"));
  return {
    customerOpts: sort(c),
    campaignOpts: sort(ca),
    statusOpts: sort(st),
    bidOpts: [...bd].map((v) => ({ value: v, label: bidTypeLabel(v) || v })),
  };
}

/**
 * Seleção EFETIVA = seleção ∩ opções existentes. O componente guarda a
 * escolha original, então o valor volta a valer quando a opção reaparece —
 * aqui ele só fica suspenso.
 *
 * Necessário desde que os filtros da PÁGINA (fonte, cliente, status, bid,
 * busca) passaram a recortar o dataset do Analytics: filtrar "Fonte ·
 * PubMatic" pode fazer o cliente selecionado aqui desaparecer da lista, e o
 * multi-select some da barra quando sobra ≤ 1 opção. Sem esta poda, a seleção
 * órfã continuaria valendo por baixo — zerando a aba com um filtro invisível.
 *
 * Devolve a MESMA referência quando nada muda (não invalida memo).
 */
export function pruneSelection(selected = [], options = []) {
  if (selected.length === 0) return selected;
  const valid = new Set(options.map((o) => (typeof o === "string" ? o : o.value)));
  const kept = selected.filter((v) => valid.has(v));
  return kept.length === selected.length ? selected : kept;
}

// ── Recorte ─────────────────────────────────────────────────────────────────

/** Lines que passam nos filtros de dimensão da própria aba. */
export function filterAnalyticsLines(lines = [], sel = {}) {
  const { customers = [], campaigns = [], statuses = [], bidTypes = [] } = sel;
  return lines.filter((l) => {
    if (customers.length && !customers.includes(l.customer)) return false;
    if (campaigns.length && !campaigns.includes(l.campaign_name)) return false;
    if (statuses.length && !statuses.includes(effectiveStatus(l))) return false;
    if (bidTypes.length && !bidTypes.includes(l.bid_type)) return false;
    return true;
  });
}

/**
 * Rows da série que pertencem às lines sobreviventes, opcionalmente dentro da
 * janela [from, to]. Carrega a chave resolvida em `_k` pra não recalcular em
 * cada agregação.
 *
 * `resolverLines` é o conjunto COMPLETO de lines (não o filtrado): a
 * desambiguação de um line_id que existe em duas fontes precisa enxergar as
 * duas, senão uma row sem `source` (backend antigo) casaria com a única fonte
 * que sobrou no filtro.
 */
export function filterTimeseries(timeseries = [], { lines = [], resolverLines, from = null, to = null } = {}) {
  const rowKey = buildDeliveryKeyResolver(resolverLines || lines);
  const lineIds = new Set(lines.map(lineKey));
  const out = [];
  for (const r of timeseries) {
    const k = rowKey(r);
    if (!k || !lineIds.has(k)) continue;
    if (from && r.day < from) continue;
    if (to && r.day > to) continue;
    out.push(r._k === k ? r : { ...r, _k: k });
  }
  return out;
}

/** Primeiro e último dia com entrega na série (bounds do calendário). */
export function computeDataBounds(timeseries = []) {
  let lo = null, hi = null;
  for (const r of timeseries) {
    if (lo == null || r.day < lo) lo = r.day;
    if (hi == null || r.day > hi) hi = r.day;
  }
  return { lo, hi };
}

// ── Agregados ───────────────────────────────────────────────────────────────

/** Big numbers do período (soma das rows filtradas). */
export function computeKpis(tsRows = []) {
  let revenue = 0, margin = 0, cost = 0, imps = 0, viewable = 0, clicks = 0;
  const ids = new Set();
  for (const r of tsRows) {
    revenue += num(r.curator_revenue);
    margin += num(r.curator_margin);
    cost += num(r.curator_total_cost);
    imps += num(r.imps);
    viewable += num(r.viewable_imps);
    clicks += num(r.clicks);
    ids.add(r._k);
  }
  return {
    revenue, margin, cost, imps, viewable, clicks,
    deals: ids.size,
    marginPct: revenue > 0 ? margin / revenue : null,
    ecpm: imps > 0 ? (revenue / imps) * 1000 : null,
    ctr: imps > 0 ? clicks / imps : null,
  };
}

/**
 * PI contratado + % entregue acumulada (margem lifetime ÷ PI).
 * Dedup por grupo (membros compartilham o mesmo PI) e canceladas de fora —
 * mesma régua dos KPIs da página, pra que os dois números batam.
 */
export function computeContract(filteredLines = []) {
  const piByKey = new Map();
  const marginByKey = new Map();
  for (const l of filteredLines) {
    if (effectiveStatus(l) === "Cancelado") continue;
    const key = l.group_id ? `g:${l.group_id}` : `l:${lineKey(l)}`;
    if (l.pi_brl != null && !piByKey.has(key)) piByKey.set(key, num(l.pi_brl));
    if (l.group_id) {
      if (!marginByKey.has(key)) marginByKey.set(key, num(l.group_curator_margin));
    } else {
      marginByKey.set(key, num(l.curator_margin));
    }
  }
  const pi = [...piByKey.values()].reduce((s, v) => s + v, 0);
  let lifeMargin = 0;
  for (const [k, m] of marginByKey) if (piByKey.has(k)) lifeMargin += m;
  return { pi, pctEntregue: pi > 0 ? lifeMargin / pi : null, dealsWithPi: piByKey.size };
}

/** Soma do período imediatamente anterior, de mesma duração (base do delta). */
export function computePrevPeriod(tsAllPeriods = [], { from, to } = {}) {
  if (!from || !to) return null;
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (!isFinite(fromMs) || !isFinite(toMs)) return null;
  const days = Math.round((toMs - fromMs) / 86400000) + 1;
  const prevTo = new Date(fromMs - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000);
  const pf = prevFrom.toISOString().slice(0, 10);
  const pt = prevTo.toISOString().slice(0, 10);
  let revenue = 0, margin = 0, imps = 0;
  for (const r of tsAllPeriods) {
    if (r.day < pf || r.day > pt) continue;
    revenue += num(r.curator_revenue);
    margin += num(r.curator_margin);
    imps += num(r.imps);
  }
  return { revenue, margin, imps, from: pf, to: pt };
}

/** Série agregada por dia ou por mês. */
export function buildSeries(tsRows = [], granularity = "day") {
  const map = new Map();
  for (const r of tsRows) {
    const k = granularity === "month" ? String(r.day).slice(0, 7) : r.day;
    let e = map.get(k);
    if (!e) { e = { key: k, revenue: 0, margin: 0, cost: 0, imps: 0, clicks: 0 }; map.set(k, e); }
    e.revenue += num(r.curator_revenue);
    e.margin += num(r.curator_margin);
    e.cost += num(r.curator_total_cost);
    e.imps += num(r.imps);
    e.clicks += num(r.clicks);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Mix de receita por status (período) + nº de deals que entregaram em cada. */
export function buildStatusMix(tsRows = [], filteredLines = []) {
  const lineToStatus = new Map(filteredLines.map((l) => [lineKey(l), effectiveStatus(l)]));
  const rev = new Map(), ids = new Map();
  for (const r of tsRows) {
    const s = lineToStatus.get(r._k);
    if (!s) continue;
    rev.set(s, (rev.get(s) || 0) + num(r.curator_revenue));
    if (!ids.has(s)) ids.set(s, new Set());
    ids.get(s).add(r._k);
  }
  const rows = [...rev.entries()]
    .map(([status, revenue]) => ({ status, revenue, count: ids.get(status)?.size || 0 }))
    .filter((r) => r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);
  const total = rows.reduce((s, r) => s + r.revenue, 0);
  return { rows, total };
}

/**
 * Realizado (lifetime) vs. PI contratado, por cliente ou campanha.
 * Dedup: lines do mesmo group_id compartilham o PI (conta 1×) e usam
 * group_curator_* já agregado; lines soltas usam curator_*.
 */
export function buildContractRows(filteredLines = [], dim = "customer") {
  const units = new Map();
  for (const l of filteredLines) {
    if (effectiveStatus(l) === "Cancelado") continue;
    const name = (dim === "campaign" ? (l.campaign_name || l.line_name) : l.customer) || "—";
    const groupKey = l.group_id ? `g:${l.group_id}` : `l:${lineKey(l)}`;
    const dedupKey = `${name}|${groupKey}`;
    let u = units.get(dedupKey);
    if (!u) { u = { name, members: [] }; units.set(dedupKey, u); }
    u.members.push(l);
  }
  const buckets = new Map();
  for (const { name, members } of units.values()) {
    const first = members[0];
    const pi = num(first.group_id ? resolveGroupPi(members) : first.pi_brl);
    if (pi <= 0) continue;
    const revenue = first.group_id ? num(first.group_curator_revenue) : num(first.curator_revenue);
    const margin = first.group_id ? num(first.group_curator_margin) : num(first.curator_margin);
    let b = buckets.get(name);
    if (!b) { b = { name, pi: 0, revenue: 0, margin: 0 }; buckets.set(name, b); }
    b.pi += pi;
    b.revenue += revenue;
    b.margin += margin;
  }
  return [...buckets.values()].map((b) => ({
    ...b,
    pctRevenue: b.pi > 0 ? b.revenue / b.pi : null,
    pctMargin: b.pi > 0 ? b.margin / b.pi : null,
  }));
}

/** Tabela por deal: métricas do período + % entregue acumulada. Só deals que
 *  entregaram na janela (zeros são ruído e contradizem "deals entregando"). */
export function buildDealRows(tsRows = [], filteredLines = []) {
  const per = new Map();
  for (const r of tsRows) {
    let e = per.get(r._k);
    if (!e) { e = { revenue: 0, margin: 0, imps: 0, clicks: 0 }; per.set(r._k, e); }
    e.revenue += num(r.curator_revenue);
    e.margin += num(r.curator_margin);
    e.imps += num(r.imps);
    e.clicks += num(r.clicks);
  }
  return filteredLines
    .map((l) => {
      const p = per.get(lineKey(l)) || { revenue: 0, margin: 0, imps: 0, clicks: 0 };
      return {
        line: l,
        revenue: p.revenue,
        margin: p.margin,
        imps: p.imps,
        marginPct: p.revenue > 0 ? p.margin / p.revenue : null,
        pctEntregue: pctEntrega(l),
      };
    })
    .filter((r) => r.revenue > 0 || r.imps > 0)
    .sort((a, b) => b.revenue - a.revenue);
}
