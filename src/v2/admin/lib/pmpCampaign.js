// src/v2/admin/lib/pmpCampaign.js
//
// Modelo de CAMPANHA do PMP Deals — a camada que faltava entre "cliente" e
// "line".
//
// Hierarquia real do negócio:
//
//   Cliente  (Amazon)
//     └─ Campanha            "Brand Copa"          ← esta camada
//          └─ Flight (1 PI)  grupo JoEb-FAC · R$ 250.000
//               ├─ Line  HYPR_AMAZON_DSP_..._JUN-26   (Xandr)
//               └─ Line  HYPR_AMAZON_DV360_..._AGO-26 (Xandr)
//
// Duas regras de identidade, nesta ordem:
//
//   1. FLIGHT (unidade de conta) = grupo de lines com PI compartilhado
//      (`group_id`) ou, quando a line é solta, a própria line. É a mesma régua
//      de dedupe que os KPIs e o "Realizado vs. contratado" já usam: o PI de um
//      grupo conta UMA vez, mesmo que só um membro carregue `pi_brl`.
//
//   2. CAMPANHA = flights que dividem o mesmo NOME CURADO dentro do mesmo
//      cliente. "Nome curado" = `campaign_name` diferente de `line_name`, ou
//      seja, veio do checklist do Command (ou de um override manual) e não do
//      nome cru do deal. Isso junta os N flights de uma mesma campanha (o caso
//      "Engov Copa = 3 flights de R$ 80k") sem nunca fundir deals diferentes
//      por acidente: nome cru de deal é único por line, então flights sem
//      checklist continuam sendo cada um a sua campanha.
//
// Dinheiro: revenue/margem/custo/imps são somados SEMPRE por line (a soma dos
// membros é igual ao agregado do grupo) — assim o overlay janelado do Histórico
// funciona sem tratamento especial. PI vem do flight, contado uma vez.
//
// Canceladas: seguem a régua dos KPIs da página — ficam FORA do dinheiro
// (PI, receita, margem, custo, imps) mas continuam listadas na campanha, com o
// pill de status, pra não sumirem do histórico.

import { effectiveStatus, resolveGroupPi, LIVE_STATUSES } from "./pmpFormat";

const num = (v) => Number(v) || 0;

/** Normaliza nome pra chave de agrupamento: sem acento, minúsculo, espaços
 *  colapsados. "Saldão da Copa" e "SALDAO DA COPA " caem na mesma chave. */
function normalizeName(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Nome de campanha CURADO da line (veio do checklist do Command ou de um
 *  override), ou null quando `campaign_name` é só o eco do nome cru do deal. */
export function curatedCampaignName(line) {
  const name = line?.campaign_name;
  if (!name) return null;
  if (line.line_name && name === line.line_name) return null;
  return name;
}

// Boilerplate do padrão de nomenclatura dos deals
// (HYPR_<CLIENTE>_<DSP>_<AGÊNCIA>_<CAMPANHA>_..._<MÊS-ANO>): tokens que se
// repetem em toda line e não distinguem nada.
const DEAL_NOISE = new Set([
  "HYPR", "DEAL", "DEALS", "PMP", "LI",
  "DV360", "DSP", "XANDR", "PUBMATIC", "CURATE", "CURATED",
  "FLEX-BID", "FIXED-BID", "BID", "DISPLAY", "VIDEO",
]);

/**
 * Título legível a partir do nome cru do deal, SEM inventar nome: só remove o
 * boilerplate (HYPR_, DSP, DEAL, cliente, agência) e normaliza a caixa.
 * Mês/ano e versão (V2, FY25) são preservados — é o que distingue dois flights
 * da mesma campanha. O nome cru continua visível no card, abaixo do título.
 * Devolve null quando não sobra nada de útil (aí a UI usa o nome cru).
 */
export function prettyDealName(raw, customer, agency) {
  if (!raw || !raw.includes("_")) return null;
  const cust = normalizeName(customer).replace(/[\s-]/g, "");
  const ag = normalizeName(agency).replace(/[\s-]/g, "");
  const kept = [];
  for (const token of String(raw).split("_")) {
    const t = token.trim();
    if (!t) continue;
    const up = t.toUpperCase();
    if (DEAL_NOISE.has(up)) continue;
    const flat = normalizeName(t).replace(/[\s-]/g, "");
    if (flat && flat === cust) continue;
    // Agência costuma vir abreviada no nome do deal (ALMAP ⊂ almapbbdo).
    if (flat.length >= 3 && ag && (ag === flat || ag.startsWith(flat))) continue;
    kept.push(t);
  }
  if (!kept.length) return null;
  const titled = kept
    .join(" ")
    .replace(/-/g, " ")
    .toLowerCase()
    .replace(/\b([a-z0-9À-ÿ])/g, (m) => m.toUpperCase())
    // FY25 / FY26 mantêm a caixa que o time usa.
    .replace(/\bFy(\d{2})\b/g, "FY$1");
  return titled.length > 2 ? titled : null;
}

/** Nomes de grupo são gravados como "Cliente · Nome do grupo". Pro título da
 *  campanha, o cliente já aparece do lado — tira o prefixo redundante. */
function stripCustomerPrefix(groupName, customer) {
  if (!groupName) return null;
  if (!customer) return groupName;
  const prefix = `${customer} · `;
  return groupName.startsWith(prefix) ? groupName.slice(prefix.length) : groupName;
}

/** Menor valor não-nulo (usado pra "há quanto tempo entregou"). */
function minOf(values) {
  let out = null;
  for (const v of values) {
    if (v == null || v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (out == null || n < out) out = n;
  }
  return out;
}

function minDate(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a < b ? a : b;
}
function maxDate(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a > b ? a : b;
}

// ── Flights (unidades de conta: 1 PI cada) ──────────────────────────────────
function buildFlights(lines) {
  const byGroup = new Map();
  const flights = [];
  for (const l of lines) {
    if (l.group_id) {
      let f = byGroup.get(l.group_id);
      if (!f) {
        f = { key: `g:${l.group_id}`, kind: "group", groupId: l.group_id, lines: [] };
        byGroup.set(l.group_id, f);
        flights.push(f);
      }
      f.lines.push(l);
    } else {
      flights.push({ key: `l:${l.source || "xandr"}:${l.line_id}`, kind: "line", groupId: null, lines: [l] });
    }
  }

  for (const f of flights) {
    const first = f.lines[0];
    f.customer = first.customer || null;
    f.agency = f.lines.find((l) => l.agency)?.agency || null;
    f.token = f.lines.find((l) => l.short_token)?.short_token || first.group_short_token || null;

    // PI do flight: grupo → primeiro membro com PI; line solta → o seu.
    // Canceladas não entram (mesma régua dos KPIs).
    //
    // Number() obrigatório: o BQ serializa NUMERIC como STRING ("250000"), e
    // somar isso direto vira concatenação/NaN em vez de soma. Mesma pegadinha
    // que o resto do PMP já trata com Number() em toda agregação de PI.
    const billable = f.lines.filter((l) => effectiveStatus(l) !== "Cancelado");
    const rawPi = f.kind === "group"
      ? resolveGroupPi(billable)
      : (billable.length ? billable[0].pi_brl : null);
    const piNum = rawPi == null ? null : Number(rawPi);
    f.pi = piNum != null && Number.isFinite(piNum) ? piNum : null;

    // Membros do grupo que declaram PI com valores DIFERENTES: o dedupe pega o
    // primeiro e os outros somem em silêncio. A UI mostra um aviso.
    const declared = new Set(
      billable.filter((l) => l.pi_brl != null && Number(l.pi_brl) > 0).map((l) => String(Number(l.pi_brl))),
    );
    f.piMismatch = declared.size > 1;

    // Nome: nome curado de qualquer membro > nome do grupo > nome cru do deal.
    // Sem nome curado, o título é o nome cru LIMPO (boilerplate fora) e o cru
    // fica visível abaixo — nada de inventar nome, mas também nada de um
    // "HYPR_AMAZON_DSP_ALMAP_..." de 60 caracteres como título de card.
    f.curatedName = f.lines.map(curatedCampaignName).find(Boolean) || null;
    const rawName = stripCustomerPrefix(first.group_name, f.customer)
      || first.campaign_name
      || first.line_name
      || `Line ${first.line_id}`;
    f.rawName = f.curatedName ? null : rawName;
    f.name = f.curatedName || prettyDealName(rawName, f.customer, f.agency) || rawName;

    let revenue = 0, margin = 0, cost = 0, imps = 0;
    for (const l of billable) {
      revenue += num(l.curator_revenue);
      margin += num(l.curator_margin);
      cost += num(l.curator_total_cost);
      imps += num(l.imps);
    }
    f.revenue = revenue; f.margin = margin; f.cost = cost; f.imps = imps;
    f.linesWithoutPi = f.kind === "group" && f.pi != null
      ? billable.filter((l) => l.pi_brl == null).length
      : 0;
  }
  return flights;
}

/**
 * Constrói as campanhas a partir de um conjunto de lines já filtrado.
 * Devolve array ordenado (mais receita primeiro, campanhas no ar na frente).
 */
export function buildCampaigns(lines) {
  const flights = buildFlights(lines || []);
  const byKey = new Map();

  for (const f of flights) {
    // Só flights com nome CURADO se fundem por nome; os demais viram uma
    // campanha própria (nome cru de deal é único por line).
    const key = f.curatedName
      ? `n:${normalizeName(f.customer)}|${normalizeName(f.curatedName)}`
      : `f:${f.key}`;
    let c = byKey.get(key);
    if (!c) {
      c = {
        key,
        name: f.name,
        // Nome cru do deal — mostrado sob o título quando ele foi derivado,
        // pra que o operador sempre consiga casar o card com o Xandr/PubMatic.
        rawName: f.rawName || null,
        customer: f.customer,
        agency: f.agency,
        named: !!f.curatedName,
        flights: [],
        lines: [],
        pi: 0, revenue: 0, margin: 0, cost: 0, imps: 0,
        flightsWithPi: 0, linesWithoutPi: 0, piMismatch: false,
        tokens: [], sources: new Set(),
        startDate: null, endDate: null, lastDeliveryDay: null,
        liveCount: 0, stoppedCount: 0, statusCount: new Map(),
      };
      byKey.set(key, c);
    }
    c.flights.push(f);
    c.lines.push(...f.lines);
    c.revenue += f.revenue;
    c.margin += f.margin;
    c.cost += f.cost;
    c.imps += f.imps;
    if (f.pi != null) { c.pi += f.pi; c.flightsWithPi += 1; }
    c.linesWithoutPi += f.linesWithoutPi;
    if (f.piMismatch) c.piMismatch = true;
    if (f.token && !c.tokens.includes(f.token)) c.tokens.push(f.token);
    if (!c.agency && f.agency) c.agency = f.agency;
  }

  const out = [];
  for (const c of byKey.values()) {
    for (const l of c.lines) {
      c.sources.add(l.source || "xandr");
      c.startDate = minDate(c.startDate, l.start_date);
      c.endDate = maxDate(c.endDate, l.end_date);
      c.lastDeliveryDay = maxDate(c.lastDeliveryDay, l.last_delivery_day);
      if (LIVE_STATUSES.has(l.delivery_status)) c.liveCount += 1;
      // `stopped` = segue active no DSP mas sem entrega há mais de 7 dias.
      if (l.delivery_status === "stopped") c.stoppedCount += 1;
      const st = effectiveStatus(l);
      c.statusCount.set(st, (c.statusCount.get(st) || 0) + 1);
    }
    c.sources = [...c.sources].sort();
    c.hoursSinceLastDelivery = minOf(c.lines.map((l) => l.hours_since_last_delivery));
    c.marginPct = c.revenue > 0 ? c.margin / c.revenue : null;
    c.pctMargin = c.pi > 0 ? c.margin / c.pi : null;
    c.pctRev = c.pi > 0 ? c.revenue / c.pi : null;
    c.ecpm = c.imps > 0 ? (c.revenue * 1000) / c.imps : null;
    // Status dominante: o mais frequente entre as lines, com desempate pela
    // ordem operacional (uma campanha com 1 line no ar está "em andamento").
    c.status = pickDominantStatus(c.statusCount);
    // Flights ordenados: os que estão entregando primeiro, depois por receita.
    c.flights.sort((a, b) => (b.revenue - a.revenue) || String(a.name).localeCompare(String(b.name), "pt-BR"));
    out.push(c);
  }

  out.sort((a, b) => {
    if (a.liveCount !== b.liveCount) return b.liveCount - a.liveCount;
    if (a.revenue !== b.revenue) return b.revenue - a.revenue;
    return String(a.name).localeCompare(String(b.name), "pt-BR");
  });
  return out;
}

const STATUS_PRIORITY = ["Andamento", "Revisão", "Pausado", "Pendente", "Finalizado", "Cancelado"];
function pickDominantStatus(counts) {
  let best = null, bestN = -1;
  for (const st of STATUS_PRIORITY) {
    const n = counts.get(st) || 0;
    if (n > bestN) { best = st; bestN = n; }
  }
  return bestN > 0 ? best : "Pendente";
}

/** Opções do seletor "Ordenar" da Carteira. */
export const CAMPAIGN_SORTS = [
  { value: "recent_start", label: "Início · mais recente" },
  { value: "oldest_start", label: "Início · mais antigo" },
  { value: "recent", label: "Última entrega" },
  { value: "revenue", label: "Receita Bruta" },
  { value: "margin", label: "Margem HYPR" },
  { value: "pi", label: "PI" },
  { value: "pctMargin", label: "% Entrega" },
  { value: "name", label: "Nome" },
];

// ── Dois eixos de recorte da Carteira ───────────────────────────────────────
//
// SITUAÇÃO responde "está rodando?"; CICLO responde "já entregou o que foi
// contratado?". São perguntas independentes — uma campanha pode estar no ar E
// já ter batido 100% (over-delivery), ou estar encerrada faltando entregar
// (dinheiro que não foi capturado). Por isso dois filtros, não um só.

export const CAMPAIGN_SITUATIONS = [
  { value: "all",     label: "Todas",      hint: "Sem filtro de situação." },
  { value: "live",    label: "No ar",      hint: "Tem pelo menos uma line entregando nos últimos 7 dias." },
  { value: "stalled", label: "Pararam",    hint: "Nenhuma line no ar, mas alguma segue ativa no DSP sem entregar há mais de 7 dias — é o alarme operacional." },
  { value: "ended",   label: "Encerradas", hint: "Sem entrega recente e sem line pendente no DSP." },
];

export const CAMPAIGN_CYCLES = [
  { value: "all",      label: "Todos",             hint: "Sem filtro de ciclo." },
  { value: "open",     label: "Falta entregar",    hint: "Tem PI e a Receita Bruta ainda não fechou 100% do contratado." },
  { value: "complete", label: "Ciclo completo",    hint: "Receita Bruta entregue ≥ 100% do PI contratado." },
  { value: "no_pi",    label: "Sem PI",            hint: "Sem PI vinculado — não dá pra medir ciclo." },
];

/** "está rodando?" — derivado das lines da campanha. */
export function campaignSituation(c) {
  if (c.liveCount > 0) return "live";
  if (c.stoppedCount > 0) return "stalled";
  return "ended";
}

/** "já entregou o contratado?" — Receita Bruta ÷ PI. Usa receita (e não
 *  margem) porque é ela que fecha o faturamento do contrato; a régua de 85%
 *  da margem é outra pergunta e continua na coluna % Entrega. */
export function campaignCycle(c) {
  if (!(c.pi > 0)) return "no_pi";
  return (c.pctRev != null && c.pctRev >= 1) ? "complete" : "open";
}

/** Contagem por bucket ANTES do filtro — cada chip mostra quantas campanhas
 *  apareceriam se você clicasse nele agora. */
export function countCampaignBuckets(campaigns) {
  const situation = { all: campaigns.length, live: 0, stalled: 0, ended: 0 };
  const cycle = { all: campaigns.length, open: 0, complete: 0, no_pi: 0 };
  for (const c of campaigns) {
    situation[campaignSituation(c)] += 1;
    cycle[campaignCycle(c)] += 1;
  }
  return { situation, cycle };
}

export function filterCampaigns(campaigns, { situation = "all", cycle = "all" } = {}) {
  if (situation === "all" && cycle === "all") return campaigns;
  return campaigns.filter((c) =>
    (situation === "all" || campaignSituation(c) === situation) &&
    (cycle === "all" || campaignCycle(c) === cycle));
}

export function sortCampaigns(campaigns, sortBy) {
  const arr = [...campaigns];
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), "pt-BR");
  const desc = (get) => (a, b) => {
    const va = get(a), vb = get(b);
    if (va == null && vb == null) return byName(a, b);
    if (va == null) return 1;
    if (vb == null) return -1;
    return vb - va || byName(a, b);
  };
  // Datas comparam como string ("2026-08-03") — formato ISO ordena
  // lexicograficamente. Sem data vai sempre pro fim, nos dois sentidos.
  const byDate = (dir) => (a, b) => {
    const va = a.startDate, vb = b.startDate;
    if (!va && !vb) return byName(a, b);
    if (!va) return 1;
    if (!vb) return -1;
    if (va === vb) return byName(a, b);
    return dir === "desc" ? (va < vb ? 1 : -1) : (va > vb ? 1 : -1);
  };
  switch (sortBy) {
    case "recent_start": return arr.sort(byDate("desc"));
    case "oldest_start": return arr.sort(byDate("asc"));
    case "margin": return arr.sort(desc((c) => c.margin));
    case "pi": return arr.sort(desc((c) => c.pi));
    case "pctMargin": return arr.sort(desc((c) => c.pctMargin));
    // Menor "horas desde a última entrega" = entregou mais recentemente.
    case "recent": return arr.sort((a, b) => {
      const va = a.hoursSinceLastDelivery, vb = b.hoursSinceLastDelivery;
      if (va == null && vb == null) return byName(a, b);
      if (va == null) return 1;
      if (vb == null) return -1;
      return va - vb || byName(a, b);
    });
    case "name": return arr.sort(byName);
    case "revenue":
    default: return arr.sort(desc((c) => c.revenue));
  }
}

/** Totais de um conjunto de campanhas — alimenta os big numbers da view. */
export function campaignTotals(campaigns) {
  let pi = 0, revenue = 0, margin = 0, cost = 0, imps = 0, lines = 0, live = 0;
  for (const c of campaigns) {
    pi += c.pi; revenue += c.revenue; margin += c.margin; cost += c.cost;
    imps += c.imps; lines += c.lines.length; live += c.liveCount;
  }
  return {
    campaigns: campaigns.length, lines, live,
    pi, revenue, margin, cost, imps,
    marginPct: revenue > 0 ? margin / revenue : null,
    pctMargin: pi > 0 ? margin / pi : null,
    pctRev: pi > 0 ? revenue / pi : null,
  };
}

// ── Fechamento mensal (controle financeiro) ─────────────────────────────────
//
// Duas coortes DIFERENTES na mesma tabela, de propósito:
//
//   • ENTRADA  — PI que entrou na carteira naquele mês (o contrato assinado).
//   • CONSUMO  — receita/margem efetivamente entregues DENTRO daquele mês,
//                venham de PIs de qualquer mês anterior.
//
// Um PI fechado em julho costuma ser consumido em julho E agosto — por isso as
// duas colunas não batem e não devem bater. A coluna "consumo ÷ entrada" existe
// só como termômetro de ritmo do mês, nunca como "% de entrega do PI".

/**
 * Mês (YYYY-MM) de entrada do PI de um flight = mês de INÍCIO do flight.
 *
 * Por que não a data de fechamento do checklist no Command, que seria o
 * conceito mais fiel de "entrou na carteira": a base não sustenta. Só 23
 * checklists têm `deal_dv360 = TRUE` (R$ 3,97 mi, o mais antigo de abr/26)
 * contra R$ 14,3 mi de PI na carteira, e 46 dos 62 PIs são valor digitado à
 * mão no override, sem checklist nenhum. Uma tabela por data de fechamento
 * mostraria 5 meses e menos de um terço do dinheiro.
 *
 * Se um dia a vinculação de checklist cobrir a carteira, isto vira um
 * parâmetro — hoje seria um seletor que não muda nada.
 */
function flightEntryMonth(flight) {
  const start = flight.lines.map((l) => l.start_date).filter(Boolean).sort()[0];
  return start ? String(start).slice(0, 7) : null;
}

/**
 * Tabela mensal: entrada de PI × consumo de receita/margem.
 *
 * @param lines       lines já filtradas pelas dimensões ativas
 * @param tsRows      rows diárias JÁ filtradas pelo mesmo conjunto de lines
 *                    (sem filtro de período — a tabela é lifetime por design)
 */
export function buildMonthlyLedger({ lines = [], tsRows = [] } = {}) {
  const months = new Map();
  const touch = (m) => {
    let e = months.get(m);
    if (!e) {
      e = { month: m, pi: 0, piCount: 0, campaigns: new Set(), clients: new Set(),
            revenue: 0, margin: 0, cost: 0, imps: 0 };
      months.set(m, e);
    }
    return e;
  };

  // ENTRADA — 1 contribuição por flight com PI.
  const campaigns = buildCampaigns(lines);
  let flightsWithPi = 0;
  for (const c of campaigns) {
    for (const f of c.flights) {
      if (f.pi == null || f.pi <= 0) continue;
      flightsWithPi += 1;
      const m = flightEntryMonth(f);
      if (!m) continue;
      const e = touch(m);
      e.pi += f.pi;
      e.piCount += 1;
      e.campaigns.add(c.key);
      if (c.customer) e.clients.add(c.customer);
    }
  }

  // CONSUMO — soma das rows diárias no mês.
  for (const r of tsRows) {
    const m = String(r.day).slice(0, 7);
    const e = touch(m);
    e.revenue += num(r.curator_revenue);
    e.margin += num(r.curator_margin);
    e.cost += num(r.curator_total_cost);
    e.imps += num(r.imps);
  }

  const rows = [...months.values()]
    .map((e) => ({
      ...e,
      campaigns: e.campaigns.size,
      clients: e.clients.size,
      marginPct: e.revenue > 0 ? e.margin / e.revenue : null,
      consumoVsEntrada: e.pi > 0 ? e.revenue / e.pi : null,
    }))
    .sort((a, b) => b.month.localeCompare(a.month));

  const totals = rows.reduce(
    (acc, r) => {
      acc.pi += r.pi; acc.piCount += r.piCount;
      acc.revenue += r.revenue; acc.margin += r.margin; acc.cost += r.cost; acc.imps += r.imps;
      return acc;
    },
    { pi: 0, piCount: 0, revenue: 0, margin: 0, cost: 0, imps: 0 },
  );
  totals.marginPct = totals.revenue > 0 ? totals.margin / totals.revenue : null;
  totals.consumoVsEntrada = totals.pi > 0 ? totals.revenue / totals.pi : null;

  return {
    rows,
    totals,
    flightsWithPi,
  };
}
