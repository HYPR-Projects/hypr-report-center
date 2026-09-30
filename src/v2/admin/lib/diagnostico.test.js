// Projeção do Diagnóstico com o relógio congelado em 30/09/2026 (fim de mês).
//
// Os números são os reais daquele dia (BigQuery, entrega até D-1 = 29/09):
//   • Mastercard U9TAW5 Display — voo 25–30/09, 14.527.778 negociados.
//   • Volkswagen LBDGLC Display — voo 18–30/09, 1.952.778 negociados.
// Os dois fechavam acima de 100%, e o card mostrava 99%/98% (Under) porque o
// pacing do último dia cobrava o contrato inteiro contra uma entrega sem o
// dia de hoje.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { deriveMediaMetrics, STATUS } from "./diagnostico.js";
import { enrichCampaign } from "./alerts/derive.js";
import { pacingRunway } from "../../../shared/aggregations.js";

// Meio-dia BRT de 30/09 (15h UTC) — mesma data em qualquer fuso do runner.
const NOW = Date.UTC(2026, 8, 30, 15, 0);

function withClock(fn) {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try { return fn(); } finally { mock.timers.reset(); }
}

const mastercard = {
  pacing:           98.8,
  delivered:        14_349_079,
  expectedToDate:   14_527_778,
  negotiatedTotal:  14_527_778,
  startDate:        "2026-09-25",
  actualStartDate:  "2026-09-25",
  endDate:          "2026-09-30",
  lastDayDelivered: 790_819,
  last7dDelivered:  14_349_079, // voo tem 5 dias fechados: a janela 7d cobre todos
};

test("último dia: Falta/Dia divide pelo único dia que resta (hoje)", () => {
  const m = withClock(() => deriveMediaMetrics(mastercard));
  // 14.527.778 − 14.349.079 = 178.699, tudo pra hoje. Antes dividia por 2.
  assert.equal(Math.round(m.minDiariaContratada), 178_699);
});

test("último dia: projeção soma um dia de ritmo e fica Ok", () => {
  const m = withClock(() => deriveMediaMetrics(mastercard));
  assert.equal(m.status, STATUS.OK);
  assert.equal(Math.round(m.projetadaPct * 10) / 10, 118.5);
  assert.equal(Math.round(m.totalEntreguePct * 10) / 10, 98.8);
});

test("Volkswagen: média 7d maior que o D-1 segue sendo o ritmo", () => {
  const m = withClock(() => deriveMediaMetrics({
    pacing:           97.5,
    delivered:        1_904_724,
    negotiatedTotal:  1_952_778,
    startDate:        "2026-09-18",
    actualStartDate:  "2026-09-18",
    endDate:          "2026-09-30",
    lastDayDelivered: 119_152,
    last7dDelivered:  826_885,
  }));
  assert.equal(m.status, STATUS.OK);
  assert.equal(Math.round(m.projetadaPct * 10) / 10, 103.6);
});

test("campanha que acelerou ontem não fica presa em Under pela média 7d", () => {
  // Voo de 30 dias (01–30/09), 29 dias fechados, falta 1. Semana lenta
  // (80/dia) e ontem 190: pela média 7d fecharia em 97,7%; pelo D-1, 101,3%.
  const base = {
    delivered:        2_850,
    negotiatedTotal:  3_000,
    startDate:        "2026-09-01",
    actualStartDate:  "2026-09-01",
    endDate:          "2026-09-30",
    last7dDelivered:  560,
  };
  const lenta = withClock(() => deriveMediaMetrics({ ...base, lastDayDelivered: 70 }));
  assert.equal(lenta.status, STATUS.UNDER);
  const acelerou = withClock(() => deriveMediaMetrics({ ...base, lastDayDelivered: 190 }));
  assert.equal(acelerou.status, STATUS.OK);
});

test("pacingRunway: último dia conta só os dias fechados; depois do fim, o voo todo", () => {
  const ultimoDia = pacingRunway("2026-09-25", "2026-09-25", "2026-09-30", new Date(2026, 8, 30, 12));
  assert.equal(ultimoDia.tDays, 6);
  assert.equal(ultimoDia.eDays, 5);
  const depois = pacingRunway("2026-09-25", "2026-09-25", "2026-09-30", new Date(2026, 9, 1, 12));
  assert.equal(depois.eDays, 6);
  const antes = pacingRunway("2026-09-25", "2026-09-25", "2026-09-30", new Date(2026, 8, 24, 12));
  assert.equal(antes.eDays, 0);
});

test("alertas/drawer projetam o mesmo número da coluna Projetada", () => {
  const camp = {
    short_token:                  "U9TAW5",
    start_date:                   "2026-09-25",
    end_date:                     "2026-09-30",
    display_pacing:               98.8,
    display_viewable_impressions: 14_349_079,
    display_expected_impressions: 14_527_778,
    display_negotiated:           14_527_778,
    display_actual_start_date:    "2026-09-25",
    display_yesterday_viewable:   790_819,
    display_last7d_viewable:      14_349_079,
  };
  const e = withClock(() => enrichCampaign(camp, () => "in_flight"));
  const m = withClock(() => deriveMediaMetrics(mastercard));
  assert.equal(e.display.days_remaining, 1);
  assert.equal(e.display.projected_pacing.toFixed(3), m.projetadaPct.toFixed(3));
});
