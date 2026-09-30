// Régua de tempo do FATURAMENTO na aba Display (computeDisplayKpis).
//
// Mesmo cenário de backend/tests/test_billing_today_brt.py: voo 01–31/07
// (31 dias), 3,1M imps contratadas a CPM R$10 (budget R$31.000), 3,2M
// visíveis entregues (over). O CPM efetivo tem que bater com o do backend:
//   • último dia (qualquer hora em BRT) → pró-rata 30/31 → R$9,375
//   • dia seguinte ao fim               → budget cheio   → R$9,6875
// Antes o front usava `today > end` (agora com horário × fim à meia-noite) e
// já faturava o budget cheio no último dia inteiro.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { computeDisplayKpis, billingWindow, todayBrtYmd } from "./aggregations.js";

function at(isoUtc, fn) {
  mock.timers.enable({ apis: ["Date"], now: Date.parse(isoUtc) });
  try { return fn(); } finally { mock.timers.reset(); }
}

const row = {
  media_type: "DISPLAY",
  tactic_type: "O2O",
  actual_start_date: "2026-07-01",
  effective_total_cost: 0,
  o2o_display_budget: 31000,
  deal_cpm_amount: 10,
  contracted_o2o_display_impressions: 3_100_000,
  bonus_o2o_display_impressions: 0,
};
const detail = [{ viewable_impressions: 3_200_000, impressions: 3_300_000, clicks: 1000 }];

const kpis = (camp) => computeDisplayKpis({
  rows: [row], detail, detailAll: detail, tactic: "O2O",
  camp: { start_date: "2026-07-01", end_date: "2026-07-31", ...camp },
});

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("todayBrtYmd vira o dia à meia-noite de Brasília", () => {
  assert.equal(todayBrtYmd(new Date("2026-08-01T01:00:00Z")), "2026-07-31"); // 22h BRT
  assert.equal(todayBrtYmd(new Date("2026-08-01T03:00:00Z")), "2026-08-01"); // 00h BRT
});

test("último dia do voo: CPM efetivo pró-rata (30/31), igual ao backend", () => {
  at("2026-07-31T15:00:00Z", () => {           // 12h BRT
    const k = kpis();
    close(k.cpmEf, 30000 / 3_200_000 * 1000);    // 9,375
    close(k.rentab, (10 - 9.375) / 10 * 100);
  });
});

test("noite do último dia (já 1/ago em UTC) segue pró-rata", () => {
  at("2026-08-01T02:30:00Z", () => {           // 31/07 23h30 BRT
    close(kpis().cpmEf, 9.375);
  });
});

test("dia seguinte ao fim: budget cheio", () => {
  at("2026-08-01T03:30:00Z", () => {           // 01/08 00h30 BRT
    close(kpis().cpmEf, 31000 / 3_200_000 * 1000); // 9,6875
  });
});

test("meio do voo: dias inteiros antes de hoje (14 em 15/07)", () => {
  at("2026-07-16T01:00:00Z", () => {           // 15/07 22h BRT
    close(kpis().cpmEf, (31000 / 31 * 14) / 3_200_000 * 1000);
  });
});

test("encerramento antecipado antecipa o budget cheio", () => {
  at("2026-07-25T15:00:00Z", () => {
    close(kpis({ early_end_date: "2026-07-20" }).cpmEf, 9.6875);
    // no próprio dia do encerramento ainda é pró-rata (estrito)
    const w = billingWindow("2026-07-01", "2026-07-31", "2026-07-25", new Date(2026, 6, 1), 31);
    assert.equal(w.ended, false);
    assert.equal(w.eDays, 24);
  });
});
