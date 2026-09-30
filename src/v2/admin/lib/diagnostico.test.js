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
import { deriveMediaMetrics, classifyProjectedStatus, buildVerdict, countByStatus, STATUS } from "./diagnostico.js";
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

test("régua por horizonte: 90–100% com mais de 7 dias vira Atenção, não Under", () => {
  assert.equal(classifyProjectedStatus(95, 8), STATUS.WATCH);
  assert.equal(classifyProjectedStatus(90, 20), STATUS.WATCH);
  assert.equal(classifyProjectedStatus(89.9, 20), STATUS.UNDER);
  // Na última semana do voo a faixa volta a ser Under.
  assert.equal(classifyProjectedStatus(95, 7), STATUS.UNDER);
  assert.equal(classifyProjectedStatus(99.9, 1), STATUS.UNDER);
  // Sem horizonte conhecido, régua simples.
  assert.equal(classifyProjectedStatus(95, null), STATUS.UNDER);
  // Faixas de cima não mudam.
  assert.equal(classifyProjectedStatus(110, 20), STATUS.OK);
  assert.equal(classifyProjectedStatus(130, 20), STATUS.OVER);
  assert.equal(classifyProjectedStatus(160, 20), STATUS.SUPER_OVER);
  assert.equal(classifyProjectedStatus(null, 20), null);
});

test("deriveMediaMetrics aplica a régua com os dias restantes do voo", () => {
  // Voo 16/09–15/10 visto em 30/09: 14 dias fechados, 16 restantes.
  const base = {
    negotiatedTotal:  30_000,
    startDate:        "2026-09-16",
    actualStartDate:  "2026-09-16",
    endDate:          "2026-10-15",
    delivered:        12_000,  // 14 dias fechados
    lastDayDelivered: 800,
  };
  // 12.000 + 16 × 1.000 = 28.000 → 93,3% com 16 dias pela frente → Atenção
  const atencao = withClock(() => deriveMediaMetrics({ ...base, last7dDelivered: 7_000 }));
  assert.equal(atencao.diasRestantes, 16);
  assert.equal(atencao.status, STATUS.WATCH);
  // 12.000 + 16 × 800 = 24.800 → 82,7% → Under mesmo longe do fim
  const under = withClock(() => deriveMediaMetrics({ ...base, last7dDelivered: 5_000 }));
  assert.equal(under.status, STATUS.UNDER);
});

test("Atenção entra na contagem e ganha o modificador de recuperação", () => {
  const counts = countByStatus([{ status: STATUS.WATCH }, { status: STATUS.WATCH }, { status: STATUS.UNDER }]);
  assert.equal(counts[STATUS.WATCH], 2);
  assert.equal(counts[STATUS.UNDER], 1);
  const v = buildVerdict({ status: STATUS.WATCH, deliveredD1: 1_200, minDiariaContratada: 1_100, mediaDiariaAtual: 900 });
  assert.equal(v.label, "Atenção");
  assert.equal(v.trendLabel, "↗ recuperando");
});
