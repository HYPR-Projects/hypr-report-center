import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDailySeries,
  lastValues,
  availableTrendMetrics,
  periodElapsedPct,
  yesterdayInSaoPaulo,
} from "./overviewSeries.js";

const detail = [
  { date: "2026-09-02", media_type: "DISPLAY", impressions: 1000, viewable_impressions: 800, clicks: 8, effective_total_cost: 16 },
  { date: "2026-09-01", media_type: "DISPLAY", impressions: 500, viewable_impressions: 400, clicks: 2, effective_total_cost: 8 },
  { date: "2026-09-01", media_type: "VIDEO", impressions: 300, viewable_impressions: 200, clicks: 0, video_starts: 190, video_view_100: 150, effective_total_cost: 18 },
  { date: "2026-09-02", media_type: "VIDEO", impressions: 250, viewable_impressions: 100, clicks: 1, video_starts: 95, video_view_100: 80, effective_total_cost: 9.6 },
];

test("agrupa Display e Vídeo por data, em ordem crescente, com custo", () => {
  const s = buildDailySeries(detail);
  assert.deepEqual(s.map((d) => d.date), ["2026-09-01", "2026-09-02"]);
  assert.equal(s[0].viewable_impressions, 600);
  assert.equal(s[0].cost, 26);
  assert.equal(s[1].cost, 25.6);
  assert.equal(s[0].video_view_100, 150);
  assert.equal(s[0].display_viewable, 400);
  assert.equal(s[0].video_viewable, 200);
});

test("taxas saem das somas: CTR sobre todas as visíveis, VTR só sobre vídeo", () => {
  const [d1, d2] = buildDailySeries(detail);
  assert.equal(d1.ctr, (2 / 600) * 100);
  assert.equal(d1.vtr, (150 / 200) * 100);
  assert.equal(d2.ctr, (9 / 900) * 100);
  assert.equal(d2.vtr, 80);
});

test("sem visíveis a taxa é nula, não zero", () => {
  const [d] = buildDailySeries([{ date: "2026-09-01", media_type: "DISPLAY", impressions: 10 }]);
  assert.equal(d.ctr, null);
  assert.equal(d.vtr, null);
});

test("série vazia e linhas sem data não quebram", () => {
  assert.deepEqual(buildDailySeries(null), []);
  assert.deepEqual(buildDailySeries([{ media_type: "DISPLAY", impressions: 1 }]), []);
});

test("sparkline de custo deixa de ser plana", () => {
  const s = buildDailySeries(detail);
  assert.deepEqual(lastValues(s, "cost", 14), [26, 25.6]);
  assert.deepEqual(lastValues(s, "cost", 1), [25.6]);
});

test("métricas do seletor dependem do que a campanha tem", () => {
  assert.deepEqual(availableTrendMetrics(buildDailySeries(detail)), [
    "viewable_impressions", "clicks", "ctr", "video_view_100", "vtr", "cost",
  ]);
  const soDisplaySemClique = buildDailySeries([
    { date: "2026-09-01", media_type: "DISPLAY", impressions: 10, viewable_impressions: 8 },
  ]);
  assert.deepEqual(availableTrendMetrics(soDisplaySemClique), ["viewable_impressions"]);
});

test("período decorrido conta até a data do dado, inclusive", () => {
  assert.equal(periodElapsedPct("2026-09-01", "2026-09-30", "2026-09-15"), 50);
  assert.equal(periodElapsedPct("2026-09-01", "2026-09-30", "2026-08-20"), 0);
  assert.equal(periodElapsedPct("2026-09-01", "2026-09-30", "2026-10-20"), 100);
  assert.equal(periodElapsedPct("2026-09-01", "2026-09-01", "2026-09-01"), 100);
  assert.equal(periodElapsedPct(null, "2026-09-30", "2026-09-15"), null);
  assert.equal(periodElapsedPct("2026-09-30", "2026-09-01", "2026-09-15"), null);
});

test("ontem em Brasília respeita o fuso (02:00 UTC ainda é o dia anterior)", () => {
  assert.equal(yesterdayInSaoPaulo(new Date("2026-09-23T02:00:00Z")), "2026-09-21");
  assert.equal(yesterdayInSaoPaulo(new Date("2026-09-23T12:00:00Z")), "2026-09-22");
});
