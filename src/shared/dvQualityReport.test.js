import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeQuality, rankDvCampaigns } from "./dvQualityReport.js";

const payload = {
  columns: ["monitored_ads", "measured_impressions", "viewable_impressions"],
  campaigns_found: ["Gatorade_F1_2026", "Gatorade_UEFA_2026"],
  rows: [
    [0, "2026-09-20", 100, 100, 90],
    [1, "2026-09-20", 300, 100, 10],
    [0, "2026-09-21", 100, 100, 50],
  ],
};

test("taxa do recorte é razão das somas e campanhas vêm por volume", () => {
  const s = summarizeQuality(payload);
  assert.equal(s.totals.monitored_ads, 500);
  assert.equal(s.rates.viewable, 150 / 300);
  assert.equal(s.dayCount, 2);
  assert.deepEqual(s.campaigns.map((c) => c.name), ["Gatorade_UEFA_2026", "Gatorade_F1_2026"]);
  assert.equal(s.campaigns[1].rates.viewable, 140 / 200);
});

test("payload vazio não quebra", () => {
  const s = summarizeQuality({ columns: [], rows: [] });
  assert.equal(s.campaigns.length, 0);
  assert.equal(s.rates.viewable, null);
});

test("sugestão prioriza campanhas que dividem palavras com o nome", () => {
  const names = ["BR_Cheetos_Summer_2025", "Gatorade_F1_2026", "Pepsi_Meals Q3_2026", "Gatorade_UEFA_2026"];
  assert.deepEqual(
    rankDvCampaigns(names, "GATORADE · Fórmula 1 2026").slice(0, 2),
    ["Gatorade_F1_2026", "Gatorade_UEFA_2026"],
  );
  assert.deepEqual(rankDvCampaigns(names, ""), names);
});
