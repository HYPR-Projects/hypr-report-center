// Agregação dos KQIs do DoubleVerify. O ponto central: taxa do recorte é
// soma(num) / soma(den), nunca média das taxas das linhas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, filterOptions, formatRate, formatDelta, formatCompact } from "./dvQuality.js";

const columns = [
  "monitored_ads", "measured_impressions", "viewable_impressions", "requests", "blocks",
];
// [brand, campaign, day, monitored, measured, viewable, requests, blocks]
const payload = {
  from: "2026-09-10", to: "2026-09-12", prev_from: "2026-09-07", prev_to: "2026-09-09",
  brands: ["Pepsi", "Quaker"],
  campaigns: [{ name: "P1", brand: 0 }, { name: "P2", brand: 0 }, { name: "Q1", brand: 1 }],
  columns,
  rows: [
    [0, 0, "2026-09-08", 100, 100, 50, 10, 5],   // anterior
    [0, 0, "2026-09-10", 100, 100, 90, 10, 1],
    [0, 1, "2026-09-11", 300, 100, 10, 0, 0],
    [1, 2, "2026-09-12", 600, 800, 800, 90, 2],
    [1, 2, "2026-09-20", 999, 999, 999, 999, 999], // fora das duas janelas
  ],
};

test("taxa do recorte é razão das somas, não média das taxas", () => {
  const s = summarize(payload);
  assert.equal(s.totals.monitored_ads, 1000);
  assert.equal(s.rates.viewable, 900 / 1000);      // (90+10+800)/(100+100+800)
  assert.equal(s.rates.blocks, 3 / 100);
  assert.equal(s.prevRates.viewable, 0.5);
  assert.ok(Math.abs(s.deltas.viewable - 0.4) < 1e-12);
});

test("filtro por brand e por campanha", () => {
  const pepsi = summarize(payload, { brands: [0] });
  assert.equal(pepsi.totals.monitored_ads, 400);
  assert.equal(pepsi.rates.viewable, 100 / 200);
  assert.deepEqual(pepsi.campaigns.map((c) => c.name), ["P2", "P1"]); // por volume
  const p1 = summarize(payload, { campaigns: [0] });
  assert.equal(p1.rates.viewable, 0.9);
  assert.equal(p1.deltas.viewable, 0.9 - 0.5);
});

test("denominador zero vira null, não NaN", () => {
  const s = summarize(payload, { campaigns: [1] });
  assert.equal(s.rates.blocks, null);
  assert.equal(s.deltas.blocks, null);
  assert.equal(s.rates.authentic, null); // coluna ausente no payload
});

test("opções: campanhas restritas às brands escolhidas, por volume", () => {
  const all = filterOptions(payload);
  assert.deepEqual(all.brands.map((b) => b.label), ["Quaker", "Pepsi"]);
  const pepsi = filterOptions(payload, [0]);
  assert.deepEqual(pepsi.campaigns.map((c) => c.label), ["P2", "P1"]);
});

test("formatação estilo Pinnacle", () => {
  assert.equal(formatRate(0.853), "85%");
  assert.equal(formatRate(0.9995), ">99%");
  assert.equal(formatRate(0.004), "<1%");
  assert.equal(formatRate(1), "100%");
  assert.equal(formatRate(null), "—");
  assert.deepEqual(formatDelta(-0.07), { text: "7 p.p.", dir: "down" });
  assert.deepEqual(formatDelta(0.003), { text: "<1 p.p.", dir: "flat" });
  assert.equal(formatCompact(23_400_000), "23.4M");
  assert.equal(formatCompact(8_300), "8.3K");
});

test("série diária de bloqueio: um ponto por dia, taxa sobre requests, dia vazio = null", async () => {
  const { dailyBlocking } = await import("./dvQuality.js");
  const p = {
    from: "2026-09-10", to: "2026-09-12", prev_from: "2026-09-07", prev_to: "2026-09-09",
    brands: ["A", "B"], campaigns: [{ name: "a", brand: 0 }, { name: "b", brand: 1 }],
    columns: ["requests", "blocks", "fraud_blocks"],
    rows: [
      [0, 0, "2026-09-08", 100, 100, 100],   // período anterior: fora
      [0, 0, "2026-09-10", 100, 40, 10],
      [1, 1, "2026-09-10", 100, 0, 0],
      [0, 0, "2026-09-12", 50, 5, 0],
    ],
  };
  const s = dailyBlocking(p, {}, { minRequests: 0 });
  assert.deepEqual(s.map((d) => d.day), ["2026-09-10", "2026-09-11", "2026-09-12"]);
  assert.equal(s[0].requests, 200);
  assert.equal(s[0].block_rate, 40 / 200);
  assert.equal(s[0].fraud_rate, 10 / 200);
  assert.equal(s[0].geo_rate, 0);          // coluna ausente = 0 bloqueios
  assert.equal(s[1].block_rate, null);     // dia sem request
  assert.equal(dailyBlocking(p, { brands: [1] })[0].block_rate, 0);
  // Padrão: dia com menos de 100 requests fica sem taxa.
  assert.equal(dailyBlocking(p)[2].block_rate, null);
  assert.equal(dailyBlocking(p)[2].requests, 50);
});
