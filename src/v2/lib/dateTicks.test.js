import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyTicks, pickDateStep } from "./dateTicks.js";

const days = (n) =>
  Array.from({ length: n }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);

test("mostra todo dia quando cabe", () => {
  assert.equal(pickDateStep(7, 700), 1);
  assert.deepEqual(dailyTicks(days(7), 700), days(7));
});

test("passo uniforme ancorado no último dia", () => {
  // 27 dias em ~1600px: 59px por dia → cabe todo dia
  assert.equal(pickDateStep(27, 1600), 1);
  // 27 dias em ~900px: 33px por dia → a cada 2
  const ticks = dailyTicks(days(27), 900);
  assert.equal(ticks.at(-1), "2026-09-27");
  assert.equal(ticks[0], "2026-09-01");
  assert.equal(ticks.length, 14);
});

test("intervalo entre ticks é sempre o mesmo", () => {
  for (const [n, w] of [[30, 600], [60, 900], [90, 1200], [45, 320], [180, 700]]) {
    const all = days(Math.min(n, 30)).concat(
      Array.from({ length: Math.max(0, n - 30) }, (_, i) => `d${i}`),
    );
    const idx = dailyTicks(all, w).map((d) => all.indexOf(d));
    const gaps = new Set(idx.slice(1).map((v, i) => v - idx[i]));
    assert.equal(gaps.size <= 1, true, `n=${n} w=${w} gaps=${[...gaps]}`);
    assert.equal(idx.at(-1), n - 1);
  }
});

test("períodos longos usam passo semanal", () => {
  assert.equal(pickDateStep(60, 900), 7);
});

test("sem largura medida não quebra", () => {
  assert.ok(pickDateStep(30, 0) >= 1);
  assert.deepEqual(dailyTicks([], 500), []);
  assert.deepEqual(dailyTicks(["2026-09-01"], 500), ["2026-09-01"]);
});

test("passo mensal usa trimestre/semestre", async () => {
  const { pickStep, uniformTicks, MONTH_STEPS } = await import("./dateTicks.js");
  assert.equal(pickStep(12, 900, 44, MONTH_STEPS), 1);
  assert.equal(pickStep(24, 300, 44, MONTH_STEPS), 6);
  const months = Array.from({ length: 24 }, (_, i) => `m${i}`);
  const t = uniformTicks(months, 300, { slotPx: 44, steps: MONTH_STEPS });
  assert.deepEqual(t, ["m5", "m11", "m17", "m23"]);
});

test("fillDailyGaps completa o calendário sem inventar métrica", async () => {
  const { fillDailyGaps } = await import("./dateTicks.js");
  const rows = [
    { date: "2026-09-29", clicks: 1 },
    { date: "2026-10-02", clicks: 3 },
  ];
  const out = fillDailyGaps(rows);
  assert.deepEqual(out.map((r) => r.date), ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  assert.equal(out[0], rows[0]);
  assert.deepEqual(out[1], { date: "2026-09-30" });
  // sem buraco, devolve a mesma referência
  const full = [{ date: "2026-09-01" }, { date: "2026-09-02" }];
  assert.equal(fillDailyGaps(full), full);
  // formato inesperado passa intacto
  const odd = [{ date: "01/09" }, { date: "05/09" }];
  assert.equal(fillDailyGaps(odd), odd);
});

test("fillMonthlyGaps atravessa a virada de ano", async () => {
  const { fillMonthlyGaps } = await import("./dateTicks.js");
  const rows = [{ month: "2025-11", v: 1 }, { month: "2026-02", v: 2 }];
  const out = fillMonthlyGaps(rows, "month", (m) => ({ month: m, v: 0 }));
  assert.deepEqual(out.map((r) => r.month), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(out[1], { month: "2025-12", v: 0 });
  const full = [{ month: "2026-01" }, { month: "2026-02" }];
  assert.equal(fillMonthlyGaps(full), full);
});
