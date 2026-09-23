// CPM/CPCV/CPC efetivos do Portal do Cliente com campanha no ar.
//
// Caso real (23/09/2026): Selo (Diageo), R$ 200 mil de display a CPM R$ 14,40,
// voo 15/09 → 11/10. Com o PI cheio no numerador, o CPM efetivo do portal saía
// ~3× o negociado porque a entrega ainda era parcial. O custo unitário tem que
// usar o investimento consumido até hoje.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  elapsedRatio, investedToDateOf, sliceCampaign, aggregateSlices, efficiencyTiles,
} from "./portalMetrics.js";

const TODAY = new Date(2026, 8, 23); // 23/09/2026

const selo = {
  start_date: "2026-09-15",
  end_date: "2026-10-11",
  d_client_budget: 200000,
  display_impressions: 3_500_000,
  viewable_impressions: 3_500_000,
  clicks: 2_450,
  media: ["DISPLAY"],
};

test("elapsedRatio: antes, durante e depois do voo", () => {
  assert.equal(elapsedRatio({ start_date: "2026-10-01", end_date: "2026-10-31" }, TODAY), 0);
  assert.equal(elapsedRatio({ start_date: "2026-08-01", end_date: "2026-08-31" }, TODAY), 1);
  // 15/09 → 11/10 = 27 dias; 8 decorridos em 23/09.
  assert.equal(elapsedRatio(selo, TODAY), 8 / 27);
});

test("investido até hoje: campo do backend vence o pró-rata", () => {
  assert.equal(investedToDateOf({ ...selo, d_invested_to_date: 50400 }, "d", TODAY), 50400);
  assert.equal(investedToDateOf(selo, "d", TODAY), 200000 * (8 / 27));
  assert.equal(investedToDateOf(selo, "v", TODAY), 0);
});

test("CPM efetivo de campanha no ar usa o investido até hoje, não o PI cheio", () => {
  // 3,5 mi imp × R$ 14,40 / 1000 = R$ 50.400 consumidos.
  const c = { ...selo, d_invested_to_date: 50400 };
  const t = aggregateSlices([sliceCampaign(c, "ALL", TODAY)]);
  assert.equal(t.invested, 200000);
  assert.equal(t.investedToDate, 50400);
  assert.ok(Math.abs(t.cpmDisplay - 14.4) < 1e-9);
  assert.ok(Math.abs(t.cpc - 50400 / 2450) < 1e-9);
  assert.equal(t.inFlight, true);
  const cpm = efficiencyTiles(t, (v) => v.toFixed(2)).find((x) => x.key === "cpm");
  assert.equal(cpm.sub, "display · até hoje");
});

test("encerrada: investido até hoje = faturável; sem rótulo 'até hoje'", () => {
  const ended = {
    start_date: "2026-08-01", end_date: "2026-08-31",
    v_client_budget: 30000, v_invested_to_date: 30000,
    video_impressions: 200000, completions: 150000, viewable_impressions: 200000,
    media: ["VIDEO"],
  };
  const t = aggregateSlices([sliceCampaign(ended, "ALL", TODAY)]);
  assert.equal(t.cpcvVideo, 0.2);
  assert.equal(t.inFlight, false);
  const cpcv = efficiencyTiles(t, String).find((x) => x.key === "cpcv");
  assert.equal(cpcv.sub, "vídeo");
});

test("agregado mistura no ar + encerrada por Σnum/Σdenom", () => {
  const a = { ...selo, d_invested_to_date: 50400 };
  const b = {
    start_date: "2026-08-01", end_date: "2026-08-31",
    d_client_budget: 100000, d_invested_to_date: 100000,
    display_impressions: 8_000_000, viewable_impressions: 8_000_000, media: ["DISPLAY"],
  };
  const t = aggregateSlices([a, b].map((c) => sliceCampaign(c, "DISPLAY", TODAY)));
  assert.ok(Math.abs(t.cpmDisplay - (150400 / 11_500_000) * 1000) < 1e-9);
});

test("sem investimento consumido (100% bonificada) → CPM '—', não R$ 0", () => {
  const bonif = { ...selo, d_client_budget: 0, d_invested_to_date: null };
  const t = aggregateSlices([sliceCampaign(bonif, "ALL", TODAY)]);
  assert.equal(t.cpmDisplay, null);
  assert.equal(t.cpc, null);
});

test("campanha sem entrega da mídia não infla o CPM (numerador pareado)", () => {
  const noDelivery = {
    start_date: "2026-09-20", end_date: "2026-10-20",
    d_client_budget: 100000, // sem d_invested_to_date → pró-rata > 0
    display_impressions: null, viewable_impressions: 0, media: ["DISPLAY"],
  };
  const a = { ...selo, d_invested_to_date: 50400 };
  const t = aggregateSlices([a, noDelivery].map((c) => sliceCampaign(c, "ALL", TODAY)));
  assert.ok(Math.abs(t.cpmDisplay - 14.4) < 1e-9);
});
