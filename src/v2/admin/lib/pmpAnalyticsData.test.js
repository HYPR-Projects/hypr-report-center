// O pipeline da aba Analytics do PMP. O que estes testes travam:
//
//   1. cada filtro (fonte via recorte da página, cliente, campanha, status,
//      bid, período) muda de fato os números — o bug original era o Analytics
//      somar tudo, independentemente do filtro;
//   2. as regras que separam JANELA de CONTRATO: receita/margem/imps refletem
//      o período; PI e % entregue são acumulados;
//   3. a chave de entrega é o par (fonte, line_id) — um dealMetaId da PubMatic
//      com o mesmo número de uma line do Xandr não pode somar nas duas.

import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveAnalyticsOptions, pruneSelection, filterAnalyticsLines, filterTimeseries,
  computeDataBounds, computeKpis, computeContract, computePrevPeriod,
  buildSeries, buildStatusMix, buildContractRows, buildDealRows,
} from "./pmpAnalyticsData.js";
import { filterPmpLines } from "./pmpFilters.js";
import { effectiveStatus } from "./pmpFormat.js";

// ── Fixture ──────────────────────────────────────────────────────────────────
// Duas fontes, dois clientes, um grupo com PI compartilhado, uma cancelada, e
// uma COLISÃO de line_id entre Xandr e PubMatic (777 nas duas).
const LINES = [
  { line_id: 101, source: "xandr", customer: "Ambev", campaign_name: "Brahma", line_name: "L101",
    bid_type: "flex", status: "Andamento", pi_brl: 100000, curator_revenue: 90000, curator_margin: 80000 },
  { line_id: 102, source: "pubmatic", customer: "Ambev", campaign_name: "Brahma", line_name: "L102",
    bid_type: "fixed", status: "Andamento", pi_brl: 50000, curator_revenue: 40000, curator_margin: 30000 },
  { line_id: 103, source: "pubmatic", customer: "Itaú", campaign_name: "Cartões", line_name: "L103",
    bid_type: "flex", status: "Finalizado", pi_brl: 20000, curator_revenue: 25000, curator_margin: 18000 },
  { line_id: 104, source: "xandr", customer: "Itaú", campaign_name: "Cartões", line_name: "L104",
    bid_type: "flex", status: "Cancelado", pi_brl: 999999, curator_revenue: 1, curator_margin: 1 },
  // Grupo: PI mora num membro só; group_curator_* já vem agregado do backend.
  { line_id: 105, source: "xandr", customer: "Vivo", campaign_name: "Fibra", line_name: "L105",
    bid_type: "flex", status: "Andamento", group_id: "g1", pi_brl: 200000,
    curator_revenue: 60000, curator_margin: 50000,
    group_curator_revenue: 100000, group_curator_margin: 90000 },
  { line_id: 106, source: "xandr", customer: "Vivo", campaign_name: "Fibra", line_name: "L106",
    bid_type: "flex", status: "Andamento", group_id: "g1", pi_brl: null,
    curator_revenue: 40000, curator_margin: 40000,
    group_curator_revenue: 100000, group_curator_margin: 90000 },
  { line_id: 777, source: "xandr", customer: "Colisão X", campaign_name: "Colide", line_name: "X777",
    bid_type: "flex", status: "Andamento" },
  { line_id: 777, source: "pubmatic", customer: "Colisão P", campaign_name: "Colide", line_name: "P777",
    bid_type: "flex", status: "Andamento" },
];

const ts = (source, line_id, day, revenue, margin, imps, clicks = 0) => ({
  source, line_id, day,
  curator_revenue: revenue, curator_margin: margin, curator_total_cost: revenue - margin,
  imps, viewable_imps: imps, clicks,
});

const TS = [
  // agosto/2026
  ts("xandr",    101, "2026-08-02", 1000, 900, 100000),
  ts("xandr",    101, "2026-08-03", 2000, 1800, 200000, 5),
  ts("pubmatic", 102, "2026-08-03",  500, 400,  50000),
  ts("pubmatic", 103, "2026-08-10", 3000, 2000, 300000),
  ts("xandr",    105, "2026-08-11", 4000, 3000, 400000),
  ts("xandr",    106, "2026-08-11", 1000,  800, 100000),
  ts("xandr",    777, "2026-08-12",  700,  600,  70000),
  ts("pubmatic", 777, "2026-08-12",  900,  800,  90000),
  // julho/2026 (período anterior)
  ts("xandr",    101, "2026-07-05", 5000, 4000, 500000),
  ts("pubmatic", 102, "2026-07-06", 1500, 1000, 150000),
];

const AUG = { from: "2026-08-01", to: "2026-08-31" };
const statusOf = effectiveStatus;

const rowsFor = (lines, window = null) => filterTimeseries(TS, {
  lines, resolverLines: LINES, from: window?.from || null, to: window?.to || null,
});

// ── Opções ───────────────────────────────────────────────────────────────────

test("opções saem das lines recebidas, ordenadas em pt-BR", () => {
  const o = deriveAnalyticsOptions(LINES);
  assert.deepEqual(o.customerOpts, ["Ambev", "Colisão P", "Colisão X", "Itaú", "Vivo"]);
  assert.deepEqual(o.campaignOpts, ["Brahma", "Cartões", "Colide", "Fibra"]);
  assert.deepEqual(o.statusOpts, ["Andamento", "Cancelado", "Finalizado"]);
  assert.deepEqual(o.bidOpts.map((b) => b.value).sort(), ["fixed", "flex"]);
  assert.deepEqual(o.bidOpts.find((b) => b.value === "flex").label, "Flex");
});

test("opções encolhem quando a página recorta por fonte", () => {
  const onlyPub = filterPmpLines(LINES, { source: "pubmatic", statusOf });
  const o = deriveAnalyticsOptions(onlyPub);
  assert.deepEqual(o.customerOpts, ["Ambev", "Colisão P", "Itaú"]);
  assert.equal(o.customerOpts.includes("Vivo"), false);
});

// ── Poda de seleção órfã ─────────────────────────────────────────────────────

test("seleção que não existe mais nas opções é descartada", () => {
  assert.deepEqual(pruneSelection(["Vivo", "Ambev"], ["Ambev", "Itaú"]), ["Ambev"]);
  assert.deepEqual(pruneSelection(["Vivo"], ["Ambev"]), []);
});

test("poda preserva a referência quando nada muda (não invalida memo)", () => {
  const sel = ["Ambev"];
  assert.equal(pruneSelection(sel, ["Ambev", "Itaú"]), sel);
  assert.equal(pruneSelection([], ["Ambev"]).length, 0);
});

test("poda entende opções em objeto {value,label} (bid)", () => {
  const opts = [{ value: "flex", label: "Flex" }];
  assert.deepEqual(pruneSelection(["flex", "fixed"], opts), ["flex"]);
});

test("sem a poda, um filtro invisível zeraria a aba", () => {
  // Cenário real: usuário escolhe Cliente=Vivo no Analytics e depois filtra
  // Fonte=PubMatic na página. "Vivo" só existe no Xandr → o multi-select
  // desaparece da barra (≤1 opção) e a seleção fica órfã.
  const onlyPub = filterPmpLines(LINES, { source: "pubmatic", statusOf });
  const stale = filterAnalyticsLines(onlyPub, { customers: ["Vivo"] });
  assert.equal(stale.length, 0);                       // era o bug em potencial
  const opts = deriveAnalyticsOptions(onlyPub).customerOpts;
  const pruned = filterAnalyticsLines(onlyPub, { customers: pruneSelection(["Vivo"], opts) });
  assert.equal(pruned.length, onlyPub.length);         // com poda, mostra tudo
});

// ── Filtros de dimensão ──────────────────────────────────────────────────────

test("cliente, campanha, status e bid recortam as lines", () => {
  assert.deepEqual(filterAnalyticsLines(LINES, { customers: ["Ambev"] }).map((l) => l.line_id), [101, 102]);
  assert.deepEqual(filterAnalyticsLines(LINES, { campaigns: ["Fibra"] }).map((l) => l.line_id), [105, 106]);
  assert.deepEqual(filterAnalyticsLines(LINES, { statuses: ["Finalizado"] }).map((l) => l.line_id), [103]);
  assert.deepEqual(filterAnalyticsLines(LINES, { bidTypes: ["fixed"] }).map((l) => l.line_id), [102]);
  // AND entre dimensões
  assert.deepEqual(filterAnalyticsLines(LINES, { customers: ["Ambev"], bidTypes: ["fixed"] }).map((l) => l.line_id), [102]);
});

// ── Casamento série × line ───────────────────────────────────────────────────

test("só entram rows das lines sobreviventes", () => {
  const rows = rowsFor(filterAnalyticsLines(LINES, { customers: ["Ambev"] }), AUG);
  assert.deepEqual(rows.map((r) => r.line_id), [101, 101, 102]);
});

test("colisão de line_id entre fontes não soma nas duas", () => {
  const x = rowsFor(LINES.filter((l) => l.line_id === 777 && l.source === "xandr"), AUG);
  const p = rowsFor(LINES.filter((l) => l.line_id === 777 && l.source === "pubmatic"), AUG);
  assert.deepEqual(x.map((r) => r.curator_revenue), [700]);
  assert.deepEqual(p.map((r) => r.curator_revenue), [900]);
});

test("row sem `source` (backend antigo) casa quando o id é único e é descartada quando é ambíguo", () => {
  const legacy = [
    { line_id: 101, day: "2026-08-02", curator_revenue: 10, curator_margin: 5, imps: 1 },
    { line_id: 777, day: "2026-08-02", curator_revenue: 99, curator_margin: 9, imps: 1 },
  ];
  const rows = filterTimeseries(legacy, { lines: LINES, resolverLines: LINES });
  assert.deepEqual(rows.map((r) => r.line_id), [101]);   // 777 é ambíguo → fora
});

test("desambiguação usa o dataset COMPLETO, não o filtrado", () => {
  const legacy = [{ line_id: 777, day: "2026-08-02", curator_revenue: 99, curator_margin: 9, imps: 1 }];
  const onlyXandr = filterPmpLines(LINES, { source: "xandr", statusOf });
  // Com o dataset completo como resolvedor, a row segue ambígua (correto).
  assert.equal(filterTimeseries(legacy, { lines: onlyXandr, resolverLines: LINES }).length, 0);
  // Sem ele, o próprio filtro faria a row parecer resolvida — e a receita da
  // PubMatic entraria no total do Xandr.
  assert.equal(filterTimeseries(legacy, { lines: onlyXandr }).length, 1);
});

test("filtro de período recorta a janela de dias", () => {
  const all = rowsFor(LINES);
  const aug = rowsFor(LINES, AUG);
  assert.equal(all.length, 10);
  assert.equal(aug.length, 8);
  const early = rowsFor(LINES, { from: "2026-08-01", to: "2026-08-03" });
  assert.deepEqual(early.map((r) => r.day), ["2026-08-02", "2026-08-03", "2026-08-03"]);
});

test("bounds do calendário vêm da série inteira", () => {
  assert.deepEqual(computeDataBounds(TS), { lo: "2026-07-05", hi: "2026-08-12" });
  assert.deepEqual(computeDataBounds([]), { lo: null, hi: null });
});

// ── Big numbers ──────────────────────────────────────────────────────────────

test("KPIs somam receita, margem, imps, cliques e contam deals distintos", () => {
  const k = computeKpis(rowsFor(LINES, AUG));
  assert.equal(k.revenue, 1000 + 2000 + 500 + 3000 + 4000 + 1000 + 700 + 900);
  assert.equal(k.margin, 900 + 1800 + 400 + 2000 + 3000 + 800 + 600 + 800);
  assert.equal(k.imps, 100000 + 200000 + 50000 + 300000 + 400000 + 100000 + 70000 + 90000);
  assert.equal(k.clicks, 5);
  assert.equal(k.deals, 7);                       // 7 pares (fonte, line_id)
  assert.equal(k.cost, k.revenue - k.margin);
  assert.ok(Math.abs(k.ecpm - (k.revenue / k.imps) * 1000) < 1e-9);
  assert.ok(Math.abs(k.marginPct - k.margin / k.revenue) < 1e-9);
});

test("KPI de fonte única = só a fonte filtrada (o bug do 'Fonte · PubMatic')", () => {
  const total = computeKpis(rowsFor(LINES, AUG)).revenue;
  const pub = computeKpis(rowsFor(filterPmpLines(LINES, { source: "pubmatic", statusOf }), AUG));
  const xan = computeKpis(rowsFor(filterPmpLines(LINES, { source: "xandr", statusOf }), AUG));
  assert.equal(pub.revenue, 500 + 3000 + 900);
  assert.equal(xan.revenue, 1000 + 2000 + 4000 + 1000 + 700);
  assert.equal(pub.revenue + xan.revenue, total);   // partição exata
  assert.ok(pub.revenue < total);                   // e MENOR que o total
});

test("KPIs de série vazia não viram NaN", () => {
  const k = computeKpis([]);
  assert.equal(k.revenue, 0);
  assert.equal(k.deals, 0);
  assert.equal(k.ecpm, null);
  assert.equal(k.marginPct, null);
  assert.equal(k.ctr, null);
});

// ── Contrato (PI) ────────────────────────────────────────────────────────────

test("PI dedup por grupo, ignora canceladas e não filtra por período", () => {
  const c = computeContract(LINES);
  // 100k + 50k + 20k + 200k (grupo conta 1×); a cancelada de 999.999 fica fora.
  assert.equal(c.pi, 370000);
  assert.equal(c.dealsWithPi, 4);
  // margem lifetime: 80k + 30k + 18k + 90k (grupo agregado, 1×)
  assert.ok(Math.abs(c.pctEntregue - (80000 + 30000 + 18000 + 90000) / 370000) < 1e-9);
});

test("PI acompanha o filtro de fonte", () => {
  const pub = computeContract(filterPmpLines(LINES, { source: "pubmatic", statusOf }));
  assert.equal(pub.pi, 50000 + 20000);
});

test("sem PI vinculado, % entregue é null (e não divisão por zero)", () => {
  const c = computeContract([{ line_id: 1, source: "xandr", curator_margin: 500 }]);
  assert.equal(c.pi, 0);
  assert.equal(c.pctEntregue, null);
});

// ── Período anterior ─────────────────────────────────────────────────────────

test("período anterior é a janela imediatamente antes, de mesma duração", () => {
  // Ago 01→31 são 31 dias → anterior é Jul 01→31 (mesma duração, colado).
  const p = computePrevPeriod(rowsFor(LINES), { from: "2026-08-01", to: "2026-08-31" });
  assert.equal(p.from, "2026-07-01");
  assert.equal(p.to, "2026-07-31");
  assert.equal(p.revenue, 5000 + 1500);            // julho inteiro
  // Janela curta: Ago 10→12 (3 dias) → anterior Ago 07→09, sem entrega.
  const curta = computePrevPeriod(rowsFor(LINES), { from: "2026-08-10", to: "2026-08-12" });
  assert.equal(curta.from, "2026-08-07");
  assert.equal(curta.to, "2026-08-09");
  assert.equal(curta.revenue, 0);
});

test("sem janela finita não há comparação", () => {
  assert.equal(computePrevPeriod(rowsFor(LINES), { from: null, to: null }), null);
  assert.equal(computePrevPeriod(rowsFor(LINES), {}), null);
});

test("comparação respeita os filtros de dimensão", () => {
  const pubRows = filterTimeseries(TS, { lines: filterPmpLines(LINES, { source: "pubmatic", statusOf }), resolverLines: LINES });
  const p = computePrevPeriod(pubRows, AUG);
  assert.equal(p.revenue, 1500);                   // só a row 102 de julho
});

// ── Séries ───────────────────────────────────────────────────────────────────

test("série diária agrupa por dia, em ordem", () => {
  const s = buildSeries(rowsFor(LINES, AUG), "day");
  assert.deepEqual(s.map((e) => e.key),
    ["2026-08-02", "2026-08-03", "2026-08-10", "2026-08-11", "2026-08-12"]);
  assert.equal(s[1].revenue, 2000 + 500);          // dois deals no mesmo dia
  assert.equal(s[3].imps, 400000 + 100000);
});

test("série mensal agrupa por mês", () => {
  const s = buildSeries(rowsFor(LINES), "month");
  assert.deepEqual(s.map((e) => e.key), ["2026-07", "2026-08"]);
  assert.equal(s[0].revenue, 5000 + 1500);
});

test("série vazia é [] (gráfico cai no estado vazio, não em NaN)", () => {
  assert.deepEqual(buildSeries([], "day"), []);
});

// ── Mix por status ───────────────────────────────────────────────────────────

test("mix por status usa o status efetivo e conta deals do período", () => {
  const lines = filterAnalyticsLines(LINES, {});
  const mix = buildStatusMix(rowsFor(lines, AUG), lines);
  const and = mix.rows.find((r) => r.status === "Andamento");
  const fin = mix.rows.find((r) => r.status === "Finalizado");
  assert.equal(fin.revenue, 3000);
  assert.equal(fin.count, 1);
  assert.equal(and.revenue, 1000 + 2000 + 500 + 4000 + 1000 + 700 + 900);
  assert.equal(and.count, 6);
  assert.equal(mix.total, and.revenue + fin.revenue);
  // ordenado por receita desc
  assert.deepEqual(mix.rows.map((r) => r.status), ["Andamento", "Finalizado"]);
});

// ── Realizado vs. contratado ─────────────────────────────────────────────────

test("realizado vs. contratado por cliente: grupo conta 1×, cancelada fora", () => {
  const rows = buildContractRows(LINES, "customer");
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by["Ambev"].pi, 150000);
  assert.equal(by["Ambev"].revenue, 90000 + 40000);
  assert.equal(by["Vivo"].pi, 200000);              // PI do grupo, uma vez
  assert.equal(by["Vivo"].revenue, 100000);         // group_curator_revenue, uma vez
  assert.equal(by["Itaú"].pi, 20000);               // 104 (Cancelado) fora
  assert.equal(by["Colisão X"], undefined);         // sem PI → não compara
  assert.ok(Math.abs(by["Itaú"].pctRevenue - 25000 / 20000) < 1e-9);
});

test("realizado vs. contratado por campanha", () => {
  const rows = buildContractRows(LINES, "campaign");
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by["Brahma"].pi, 150000);
  assert.equal(by["Fibra"].pi, 200000);
  assert.equal(by["Cartões"].pi, 20000);
});

test("realizado vs. contratado segue o filtro de fonte", () => {
  const rows = buildContractRows(filterPmpLines(LINES, { source: "pubmatic", statusOf }), "customer");
  assert.deepEqual(rows.map((r) => r.name).sort(), ["Ambev", "Itaú"]);
  assert.equal(rows.find((r) => r.name === "Ambev").pi, 50000);
});

// ── Tabela por deal ──────────────────────────────────────────────────────────

test("tabela por deal traz só quem entregou na janela, ordenado por receita", () => {
  const lines = filterAnalyticsLines(LINES, {});
  const rows = buildDealRows(rowsFor(lines, AUG), lines);
  assert.equal(rows.length, 7);                     // 104 (sem entrega) fora
  assert.equal(rows[0].revenue, 4000);
  assert.equal(rows[0].line.line_id, 105);
  const l101 = rows.find((r) => r.line.line_id === 101);
  assert.equal(l101.revenue, 3000);                 // 1000 + 2000 na janela
  assert.ok(Math.abs(l101.marginPct - 2700 / 3000) < 1e-9);
  // % entrega é ACUMULADA (margem lifetime ÷ PI), não da janela
  assert.ok(Math.abs(l101.pctEntregue - 80000 / 100000) < 1e-9);
});

test("tabela por deal separa as duas lines 777 (uma por fonte)", () => {
  const rows = buildDealRows(rowsFor(LINES, AUG), LINES);
  const x = rows.find((r) => r.line.customer === "Colisão X");
  const p = rows.find((r) => r.line.customer === "Colisão P");
  assert.equal(x.revenue, 700);
  assert.equal(p.revenue, 900);
});

test("janela sem entrega devolve tabela vazia (e não linhas de zero)", () => {
  const rows = buildDealRows(rowsFor(LINES, { from: "2026-09-01", to: "2026-09-30" }), LINES);
  assert.deepEqual(rows, []);
});

// ── Coerência de ponta a ponta ───────────────────────────────────────────────

test("filtro da página + filtro da aba compõem sem furo", () => {
  const pageFiltered = filterPmpLines(LINES, { source: "pubmatic", statusOf });
  const tabLines = filterAnalyticsLines(pageFiltered, { statuses: ["Andamento"] });
  const rows = rowsFor(tabLines, AUG);
  const k = computeKpis(rows);
  assert.deepEqual(tabLines.map((l) => l.line_id), [102, 777]);
  assert.equal(k.revenue, 500 + 900);
  assert.equal(k.deals, 2);
  assert.equal(buildDealRows(rows, tabLines).length, 2);
  assert.equal(buildStatusMix(rows, tabLines).total, 1400);
});

test("soma das partes por fonte = total (nenhuma row entra duas vezes)", () => {
  const partes = ["xandr", "pubmatic"].map((src) =>
    computeKpis(rowsFor(filterPmpLines(LINES, { source: src, statusOf }), AUG)));
  const total = computeKpis(rowsFor(LINES, AUG));
  assert.equal(partes.reduce((s, k) => s + k.revenue, 0), total.revenue);
  assert.equal(partes.reduce((s, k) => s + k.imps, 0), total.imps);
  assert.equal(partes.reduce((s, k) => s + k.deals, 0), total.deals);
});
