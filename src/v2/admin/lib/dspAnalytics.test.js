// O pipeline do Analytics › Saúde das DSPs. O que estes testes travam:
//
//   1. fórmulas no padrão HYPR: CTR e VTR sobre VISÍVEIS, viewability sobre
//      mensuráveis, eCPM e vCPM sobre o custo total da DSP;
//   2. todo filtro muda de fato os números, e o toggle de survey tira o
//      custo de survey da análise;
//   3. o custo do ABS compara com × sem ignorando o filtro de ABS;
//   4. red flags seguem as réguas do admin e respeitam o piso de volume;
//   5. a série por semana/mês soma o mesmo que o total.

import test from "node:test";
import assert from "node:assert/strict";
import {
  decodePayload, DEFAULT_FILTERS, filterRows, aggregate, delta, buildTimeseries,
  weekStart, autoGranularity, enrichLines, rankLines, buildScorecards, buildAbsCost,
  buildFormatMatrix, buildDataQuality, buildFilterOptions, pruneFilters, NO_TOKEN,
  decodeLineDaily,
} from "./dspAnalytics.js";

const METRICS = ["imp", "meas", "view", "clk", "cost", "vst", "v100", "vcomp", "fee"];
const SERIES_COLS = ["d", "s", "m", "abs", "sv", "tk", "io", ...METRICS];
const PREV_COLS = ["s", "m", "abs", "sv", "tk", "io", ...METRICS];
const LINE_COLS = ["key", "s", "m", "abs", "reason", "sv", "tk", "io", "name", "tag", "first", "last", ...METRICS];

// Fixture: DV360 com e sem ABS, Yahoo com mensuração baixa, um vídeo, uma
// line de survey e entrega sem short_token.
//            imp     meas   view  clk  cost   vst  v100 vcomp fee
const L = {
  dvAbs:    [100000, 98000, 88000, 800, 128.0,   0,    0,    0, 45.0],
  dvPlain:  [400000, 394000, 354000, 2900, 336.0, 0,   0,    0, 0],
  dvVideo:  [50000,  49000, 46000, 80, 125.0, 48000, 42000, 39000, 0],
  yahoo:    [200000, 96000, 73000, 1000, 90.0,  0,    0,    0, 0],
  survey:   [10000,  9900, 9000,  10,  20.0,   0,    0,    0, 0],
  orphan:   [3000,   2900, 2600,  5,   2.0,    0,    0,    0, 0],
};

const PAYLOAD = {
  from: "2026-09-01", to: "2026-09-30", prev_from: "2026-08-02", prev_to: "2026-08-31",
  sources: ["YAHOO", "DV360"],
  dates: ["2026-09-01", "2026-09-02", "2026-09-08"],
  tokens: [
    { t: "AAA111", client: "Kenvue", campaign: "Neutrogena" },
    { t: "BBB222", client: "Atacadão", campaign: "Festival" },
    { t: null, client: "Sem campanha", campaign: "Entrega sem short_token" },
  ],
  ios: ["HYPR_KENVUE_O2O", "HYPR_ATACADAO_O2O", "HYPR_DIAGEO"],
  series_cols: SERIES_COLS,
  prev_cols: PREV_COLS,
  line_cols: LINE_COLS,
  series: [
    [0, "DV360", "DISPLAY", 1, 0, 0, 0, ...L.dvAbs],
    [1, "DV360", "DISPLAY", 0, 0, 1, 1, ...L.dvPlain],
    [2, "DV360", "VIDEO", 0, 0, 1, 1, ...L.dvVideo],
    [2, "YAHOO", "DISPLAY", 1, 0, 0, 2, ...L.yahoo],
    [0, "DV360", "DISPLAY", 0, 1, 1, 1, ...L.survey],
    [1, "DV360", "DISPLAY", 0, 0, 2, 1, ...L.orphan],
  ],
  prev: [
    ["DV360", "DISPLAY", 0, 0, 1, 1, 400000, 390000, 340000, 2000, 400.0, 0, 0, 0, 0],
  ],
  lines: [
    ["DV360|1|0", "DV360", "DISPLAY", 1, "fee", 0, 0, 0, "ID-AAA111_KENVUE_NO-ABS_DISPLAY", "NO-ABS", "2026-09-01", "2026-09-01", ...L.dvAbs],
    ["DV360|2|0", "DV360", "DISPLAY", 0, null, 0, 1, 1, "ID-BBB222_ATACADAO_DISPLAY", null, "2026-09-02", "2026-09-02", ...L.dvPlain],
    ["DV360|3|0", "DV360", "VIDEO", 0, null, 0, 1, 1, "ID-BBB222_ATACADAO_VIDEO", null, "2026-09-08", "2026-09-08", ...L.dvVideo],
    ["YAHOO|9|0", "YAHOO", "DISPLAY", 1, "cliente", 0, 0, 2, "ID-AAA111_KENVUE_DISPLAY", null, "2026-09-08", "2026-09-08", ...L.yahoo],
    ["DV360|4|1", "DV360", "DISPLAY", 0, null, 1, 1, 1, "ID-BBB222_SURVEY_CONTROLE", null, "2026-09-01", "2026-09-01", ...L.survey],
    ["DV360|5|0", "DV360", "DISPLAY", 0, null, 0, 2, 1, "LINE_FORA_DA_NOMENCLATURA", null, "2026-09-02", "2026-09-02", ...L.orphan],
  ],
  landings: [{ source: "DV360", max_date: "2026-09-29" }, { source: "Yahoo", max_date: "2026-09-26" }],
};

const data = decodePayload(PAYLOAD);
const F = (over = {}) => ({ ...DEFAULT_FILTERS, ...over });
const sum = (key, ...rows) => rows.reduce((a, r) => a + r[METRICS.indexOf(key)], 0);

test("decode: dimensões resolvidas e fontes na ordem de investimento", () => {
  assert.deepEqual(data.sources, ["DV360", "YAHOO"]);
  const orphan = data.lines.find((l) => l.key === "DV360|5|0");
  assert.equal(orphan.token, NO_TOKEN);
  assert.equal(orphan.client, "Sem campanha");
  assert.equal(data.series[0].d, "2026-09-01");
  assert.equal(data.series[3].io, "HYPR_DIAGEO");
  assert.equal(data.lines[0].reason, "fee");
});

test("fórmulas no padrão HYPR (CTR/VTR sobre visíveis)", () => {
  const t = aggregate(filterRows(data.lines, F({ sources: ["DV360"], media: "VIDEO" })));
  assert.equal(t.vtr, (39000 / 46000) * 100);          // vcomp ÷ visíveis de vídeo
  assert.equal(t.ctr, (80 / 46000) * 100);              // cliques ÷ visíveis
  assert.equal(t.cpcv, 125 / 39000);
  const y = aggregate(filterRows(data.lines, F({ sources: ["YAHOO"] })));
  assert.equal(y.viewability, (73000 / 96000) * 100);  // visíveis ÷ mensuráveis
  assert.equal(y.measRate, (96000 / 200000) * 100);
  assert.equal(y.ecpm, (90 / 200000) * 1000);
  assert.equal(y.vcpm, (90 / 73000) * 1000);
  assert.equal(y.vtr, null);                            // sem vídeo, sem VTR
});

test("lines e série somam igual para o mesmo recorte", () => {
  for (const f of [F(), F({ sources: ["DV360"] }), F({ abs: "abs" }), F({ includeSurvey: false })]) {
    const a = aggregate(filterRows(data.lines, f));
    const b = aggregate(filterRows(data.series, f));
    assert.equal(a.imp, b.imp);
    assert.equal(a.cost, b.cost);
  }
});

test("toggle de survey tira o custo de survey", () => {
  const all = aggregate(filterRows(data.lines, F()));
  const noSurvey = aggregate(filterRows(data.lines, F({ includeSurvey: false })));
  assert.equal(all.cost - noSurvey.cost, 20);
});

test("cada filtro reduz o conjunto", () => {
  const n = (f) => filterRows(data.lines, f).length;
  assert.equal(n(F()), 6);
  assert.equal(n(F({ abs: "abs" })), 2);
  assert.equal(n(F({ abs: "noabs" })), 4);
  assert.equal(n(F({ media: "VIDEO" })), 1);
  assert.equal(n(F({ clients: ["Kenvue"] })), 2);
  assert.equal(n(F({ campaigns: [NO_TOKEN] })), 1);
  assert.equal(n(F({ ios: ["HYPR_DIAGEO"] })), 1);
  assert.equal(n(F({ lines: ["DV360|2|0", "YAHOO|9|0"] })), 2);
});

test("variação: % em volume e dinheiro, p.p. em taxa", () => {
  const f = F({ campaigns: ["BBB222"], media: "DISPLAY", includeSurvey: false });
  const cur = aggregate(filterRows(data.lines, f));
  const prev = aggregate(filterRows(data.prev, f));
  const d = delta(cur, prev, "imp");
  assert.equal(d.kind, "pct");
  assert.equal(Math.round(d.value), 0);                 // 400k × 400k
  const v = delta(cur, prev, "viewability");
  assert.equal(v.kind, "pp");
  assert.ok(Math.abs(v.value - ((354000 / 394000) * 100 - (340000 / 390000) * 100)) < 1e-9);
  assert.equal(delta(cur, { imp: 0 }, "imp"), null);
});

test("série: semana começa na segunda e mês/semana somam o total", () => {
  assert.equal(weekStart("2026-09-06"), "2026-08-31");  // domingo → segunda anterior
  assert.equal(weekStart("2026-09-07"), "2026-09-07");
  const rows = filterRows(data.series, F());
  const total = aggregate(rows).imp;
  for (const g of ["day", "week", "month"]) {
    const ts = buildTimeseries(rows, data.dates, g);
    assert.equal(ts.reduce((a, b) => a + b.total.imp, 0), total, g);
  }
  const weekly = buildTimeseries(rows, data.dates, "week");
  assert.deepEqual(weekly.map((b) => b.key), ["2026-08-31", "2026-09-07"]);
  assert.equal(weekly[1].bySource.YAHOO.imp, 200000);
  assert.equal(weekly[0].bySource.YAHOO, null);
  assert.equal(autoGranularity("2026-09-01", "2026-09-30"), "day");
  assert.equal(autoGranularity("2026-07-01", "2026-09-29"), "week");
  assert.equal(autoGranularity("2026-04-01", "2026-09-29"), "month");
});

test("red flags: réguas do admin, com piso de volume", () => {
  const lines = enrichLines(data.lines);
  const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
  // DV360 ABS: eCPM 1,28 < 1,80 (régua ABS) → sem eCPM alto; divergente (fee em NO-ABS)
  assert.deepEqual(byKey["DV360|1|0"].flags, ["abs_divergent"]);
  // DV360 sem ABS: eCPM 0,84 ≥ 0,80 → eCPM alto
  assert.ok(byKey["DV360|2|0"].flags.includes("ecpm_high"));
  // Yahoo: mensuração 48% < 70%
  assert.ok(byKey["YAHOO|9|0"].flags.includes("meas_low"));
  // Line com menos de 5 mil imps não é avaliada
  assert.deepEqual(byKey["DV360|5|0"].flags, []);
  const flagged = rankLines(lines, "flags");
  assert.ok(flagged.every((l) => l.flags.length > 0));
  assert.equal(rankLines(lines, "cost")[0].key, "DV360|2|0");
  // engajamento: índice vs régua verde da mídia; vídeo VTR 84,8% / 80
  const eng = rankLines(lines, "engagement");
  assert.ok(eng.every((l) => l.imp >= 5000));
  assert.ok(Math.abs(byKey["DV360|3|0"].engagement - (39000 / 46000 * 100) / 80) < 1e-9);
});

test("custo do ABS ignora o filtro de ABS e mede o delta de eCPM", () => {
  const rows = filterRows(data.lines, F({ abs: "abs", includeSurvey: false }), { abs: true });
  const abs = buildAbsCost(rows);
  const dv = abs.find((r) => r.source === "DV360" && r.media === "DISPLAY");
  assert.equal(dv.withAbs.ecpm, 1.28);
  assert.ok(Math.abs(dv.ecpmDelta - (1.28 - (338 / 403000) * 1000)) < 1e-9);
  assert.equal(dv.withAbs.feeCpm, 0.45);
  const y = abs.find((r) => r.source === "YAHOO");
  assert.equal(y.without, null);
  assert.equal(y.ecpmDelta, null);
});

test("cards por DSP e matriz de formato", () => {
  const cards = buildScorecards(data.lines, data.sources);
  assert.deepEqual(cards.map((c) => c.source), ["DV360", "YAHOO"]);
  const total = cards.reduce((a, c) => a + c.shareCost, 0);
  assert.ok(Math.abs(total - 100) < 1e-9);
  const matrix = buildFormatMatrix(data.lines);
  assert.equal(matrix[0].VIDEO.imp, 50000);
  assert.equal(matrix[1].VIDEO, null);
});

test("qualidade do dado", () => {
  const q = buildDataQuality(data.lines, data.landings, data.to);
  assert.equal(q.unattributed.imp, 3000);
  assert.equal(q.divergent.count, 1);
  assert.equal(q.divergent.fee, 45);
  assert.deepEqual(q.lowMeasurement.map((x) => x.source), ["YAHOO"]);
  const y = q.freshness.find((f) => f.source === "YAHOO");
  assert.equal(y.daysBehind, 4);
});

test("cascata de opções e poda após troca de período", () => {
  const opts = buildFilterOptions(data.lines, F({ clients: ["Kenvue"] }));
  assert.equal(opts.clients.length, 3);                 // o próprio nível não se filtra
  assert.deepEqual(opts.campaigns.map((c) => c.id), ["AAA111"]);
  assert.deepEqual(new Set(opts.ios.map((c) => c.id)), new Set(["HYPR_DIAGEO", "HYPR_KENVUE_O2O"]));
  const pruned = pruneFilters(F({ campaigns: ["AAA111", "ZZZ999"], lines: ["X|1|0"] }), data.lines);
  assert.deepEqual(pruned.campaigns, ["AAA111"]);
  assert.deepEqual(pruned.lines, []);
});

test("série diária de lines", () => {
  const rows = decodeLineDaily({
    dates: ["2026-09-01"], cols: ["key", "d", ...METRICS],
    rows: [["DV360|2|0", 0, ...L.dvPlain]],
  });
  assert.equal(rows[0].d, "2026-09-01");
  assert.equal(rows[0].cost, sum("cost", L.dvPlain));
});

// ── Rodada 2 ─────────────────────────────────────────────────────────────

test("Visíveis / Total = visíveis ÷ impressões (mensuração × viewability)", () => {
  const y = aggregate(filterRows(data.lines, F({ sources: ["YAHOO"] })));
  assert.equal(y.viewShare, (73000 / 200000) * 100);
  assert.ok(Math.abs(y.viewShare - (y.measRate * y.viewability) / 100) < 1e-9);
});

test("série traz quem puxou cada ponto (por impressão e por custo)", () => {
  const rows = filterRows(data.series, F());
  const daily = buildTimeseries(rows, data.dates, "day");
  const d2 = daily.find((b) => b.key === "2026-09-02");
  assert.equal(d2.topByImp[0].token, "BBB222");
  assert.equal(d2.topByImp[0].imp, 400000);
  assert.ok(d2.topByImp.length <= 3);
  const d8 = daily.find((b) => b.key === "2026-09-08");
  // 08/09: Yahoo (Kenvue) 200k imps e R$ 90 vs DV360 vídeo 50k imps e R$ 125
  assert.equal(d8.topByImp[0].s, "YAHOO");
  assert.equal(d8.topByCost[0].s, "DV360");
});

test("mês a mês: variação só entre meses inteiros e fatia de custo por DSP", async () => {
  const { buildMonthly } = await import("./dspAnalytics.js");
  const rows = [
    { d: "2026-07-10", s: "DV360", m: "DISPLAY", imp: 1000, meas: 1000, view: 900, clk: 9, cost: 1, vst: 0, v100: 0, vcomp: 0, fee: 0 },
    { d: "2026-08-10", s: "DV360", m: "DISPLAY", imp: 1000, meas: 1000, view: 900, clk: 9, cost: 2, vst: 0, v100: 0, vcomp: 0, fee: 0 },
    { d: "2026-08-10", s: "YAHOO", m: "DISPLAY", imp: 1000, meas: 500, view: 400, clk: 9, cost: 2, vst: 0, v100: 0, vcomp: 0, fee: 0 },
  ];
  const dates = [];
  for (let i = 1; i <= 31; i++) dates.push(`2026-07-${String(i).padStart(2, "0")}`, `2026-08-${String(i).padStart(2, "0")}`);
  const mo = buildMonthly(rows, dates, "ecpm");
  assert.deepEqual(mo.rows.map((r) => r.key), ["2026-07", "2026-08"]);
  const aug = mo.rows[1];
  assert.equal(aug.cells.DV360.value, 2);
  assert.equal(Math.round(aug.cells.DV360.delta.value), 100);   // R$1 → R$2 = +100%
  assert.equal(aug.cells.YAHOO.delta, null);                     // sem julho
  assert.equal(aug.cells.DV360.costShare, 50);
  // mês parcial: volume perde a variação, razão (eCPM) mantém
  const cut = dates.filter((d) => d <= "2026-08-15");
  const partialImp = buildMonthly(rows, cut, "imp");
  assert.equal(partialImp.rows[1].partial, true);
  assert.equal(partialImp.rows[1].cells.DV360.delta, null);
  const partialEcpm = buildMonthly(rows, cut, "ecpm");
  assert.equal(Math.round(partialEcpm.rows[1].cells.DV360.delta.value), 100);
});

test("variação em p.p. respeita a precisão da métrica", async () => {
  const { fmtDelta } = await import("../components/dspAnalytics/dspFormat.js");
  assert.equal(fmtDelta({ kind: "pp", value: 0.03 }, 2).dir, "up");      // CTR: 0,03 p.p. não é estável
  assert.equal(fmtDelta({ kind: "pp", value: 0.03 }, 1).dir, "flat");    // viewability: é
  assert.equal(fmtDelta({ kind: "pp", value: -0.03 }, 2).text, "0,03 p.p.");
  assert.equal(fmtDelta({ kind: "pct", value: 0.3 }).dir, "flat");
});

test("export: linha da planilha com números crus e flags por extenso", async () => {
  const { lineRowAoA, LINE_HEADERS } = await import("./dspAnalyticsExport.js");
  const l = enrichLines(data.lines).find((x) => x.key === "DV360|1|0");
  const row = lineRowAoA(l);
  assert.equal(row.length, LINE_HEADERS.length);
  const at = (h) => row[LINE_HEADERS.indexOf(h)];
  assert.equal(at("DSP"), "DV360");
  assert.equal(at("Motivo ABS"), "Fee DV");
  assert.equal(at("Impressões").v, 100000);
  assert.equal(at("Custo (R$)").v, 128);
  assert.match(at("Red flags"), /ABS divergente/);
  const orphan = lineRowAoA(enrichLines(data.lines).find((x) => x.key === "DV360|5|0"));
  assert.equal(orphan[LINE_HEADERS.indexOf("Short token")], "");
});

// ── Rodada 3: táticas ────────────────────────────────────────────────────

const TAC = decodePayload({
  ...PAYLOAD,
  series_cols: [...SERIES_COLS.slice(0, 7), "tc", ...METRICS],
  line_cols: [...LINE_COLS.slice(0, 8), "tc", ...LINE_COLS.slice(8)],
  series: PAYLOAD.series.map((r, i) => [...r.slice(0, 7), ["tp_high", "tp_low", "max_viewable", "tp_high", "none", "max_views"][i], ...r.slice(7)]),
  lines: PAYLOAD.lines.map((r, i) => [...r.slice(0, 8), ["tp_high", "tp_low", "max_viewable", "tp_high", "none", "max_views"][i], ...r.slice(8)]),
});

test("tática: decodifica, filtra série e lines igual e soma certo", async () => {
  const { buildTactics } = await import("./dspAnalytics.js");
  assert.equal(TAC.lines[0].tactic, "tp_high");
  assert.equal(data.lines[0].tactic, "none");               // payload antigo, sem coluna
  const f = F({ tactics: ["tp_high"] });
  assert.equal(aggregate(filterRows(TAC.lines, f)).imp, 300000);
  assert.equal(aggregate(filterRows(TAC.series, f)).imp, 300000);
  const rows = buildTactics(enrichLines(TAC.lines));
  assert.deepEqual(rows.map((r) => r.tactic), ["tp_high", "tp_low", "max_viewable", "max_views", "none"]);
  const high = rows[0];
  assert.equal(high.lines, 2);
  assert.deepEqual(high.bySource.map((s) => s.source), ["DV360", "YAHOO"]);
  assert.ok(Math.abs(rows.reduce((a, r) => a + r.shareImp, 0) - 100) < 1e-9);
});

test("tática: gráfico dobra as menores em Outras e mês a mês segue a visão", async () => {
  const { buildMonthly } = await import("./dspAnalytics.js");
  const ts = buildTimeseries(TAC.series, TAC.dates, "day", "tactic");
  const keys = new Set(ts.flatMap((b) => Object.keys(b.bySource)));
  assert.ok(keys.has("tp_high") && keys.has("other"));
  assert.ok(!keys.has("max_views") && !keys.has("none"));
  const total = ts.reduce((a, b) => a + b.total.imp, 0);
  const summed = ts.reduce((a, b) => a + Object.values(b.bySource).reduce((x, m) => x + (m?.imp || 0), 0), 0);
  assert.equal(total, summed);
  const mo = buildMonthly(TAC.series, TAC.dates, "imp", "tactic");
  assert.equal(mo.by, "tactic");
  assert.equal(mo.sources[0], "tp_high");
  assert.equal(mo.sources.at(-1), "other");
});

test("tática: opção de filtro com rótulo e export com coluna", async () => {
  const opts = buildFilterOptions(TAC.lines, F());
  assert.equal(opts.tactics[0].id, "tp_high");
  assert.equal(opts.tactics[0].label, "Top Performance High");
  const pruned = pruneFilters(F({ tactics: ["tp_high", "premium_list"] }), TAC.lines);
  assert.deepEqual(pruned.tactics, ["tp_high"]);
  const { lineRowAoA, LINE_HEADERS } = await import("./dspAnalyticsExport.js");
  const row = lineRowAoA(enrichLines(TAC.lines)[1]);
  assert.equal(row[LINE_HEADERS.indexOf("Tática")], "Top Performance Low");
  assert.equal(row.length, LINE_HEADERS.length);
});
