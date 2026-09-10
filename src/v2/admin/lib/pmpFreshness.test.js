// Régua do painel "Sync das fontes" com a hora congelada.
//
// Cada linha aqui é um estado que já foi lido errado em produção em ago/set de
// 2026: sync quebrado que parecia deal encerrado (19–21/08), job verde com base
// 2 dias atrás (24/08), fonte parada em D-3 (01–03/09) e, por fim, o amarelo das
// 08h da manhã quando a PubMatic simplesmente ainda não tinha fechado ontem
// (04–07/09). `now` é parâmetro justamente pra esses horários serem fixos.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveDataLag, deriveStatus, brHour, worstTone,
  SOURCE_CLOSE_HOUR_BRT, DATA_LAG_WARN_DAYS,
} from "./pmpFreshness.js";

// Instantes em BRT (UTC-3) expressos em UTC.
// Date.UTC rola o dia sozinho quando hora+3 passa de 23 (23h BRT = 02h UTC do dia seguinte).
const brt = (day, hour, minute = 0) => new Date(Date.UTC(2026, 8, day, hour + 3, minute));

// Fonte PubMatic saudável: rodou hoje (scheduler), ledger com frescor medido.
function pubmatic(overrides = {}) {
  return {
    key: "pubmatic",
    lastRunAt: brt(7, 8).toISOString(),
    lastOkAt: brt(7, 8).toISOString(),
    lastRunStatus: "ok",
    hasFreshness: true,
    expectsDelivery: true,
    apiLastDay: "2026-09-06",
    lagDays: 0,
    latestDeliveryDay: "2026-09-06",
    ...overrides,
  };
}

test("brHour devolve a hora de Brasília, não UTC", () => {
  assert.equal(brHour(brt(7, 8, 22)), 8);
  assert.equal(brHour(brt(7, 23, 59)), 23);
  assert.equal(brHour(brt(7, 0, 5)), 0);
});

test("dado em dia → verde com 'dado em dia'", () => {
  const s = deriveStatus(pubmatic(), brt(7, 9));
  assert.equal(s.tone, "ok");
  assert.match(s.summary, /dado em dia/);
});

test("08h BRT, dado até anteontem, PubMatic → cinza 'aguardando a fonte fechar ontem'", () => {
  // O estado das 04h–08h de todo dia (a fonte libera entre 08h e 10h).
  const s = deriveStatus(pubmatic({ apiLastDay: "2026-09-05", lagDays: 1 }), brt(7, 8, 10));
  assert.equal(s.tone, "neutral");
  assert.equal(s.waitingSourceClose, true);
  assert.match(s.summary, /aguardando a fonte fechar ontem/);
  assert.match(s.summary, /entre 08h e 10h/);
});

test("10:59 BRT ainda é 'aguardando'; 11:00 vira amarelo", () => {
  const src = pubmatic({ apiLastDay: "2026-09-05", lagDays: 1 });
  assert.equal(deriveStatus(src, brt(7, 10, 59)).tone, "neutral");
  const late = deriveStatus(src, brt(7, 11, 0));
  assert.equal(late.tone, "warn");
  assert.match(late.summary, /a API da PubMatic só tem dado até 05\/09 \(1 dia atrás\)/);
  assert.equal(late.waitingSourceClose, undefined);
});

test("D-3 ou pior é vermelho em qualquer hora — o caso de 01–03/09", () => {
  const src = pubmatic({ apiLastDay: "2026-08-31", lagDays: 2 });
  for (const now of [brt(3, 8), brt(3, 18)]) {
    const s = deriveStatus(src, now);
    assert.equal(s.tone, "error");
    assert.match(s.summary, /só tem dado até 31\/08 \(2 dias atrás\)/);
  }
});

test("a tolerância da manhã é só pra fonte com horário medido", () => {
  // Xandr não tem entrada em SOURCE_CLOSE_HOUR_BRT: 1 dia atrás às 08h é amarelo.
  assert.equal(SOURCE_CLOSE_HOUR_BRT.xandr, undefined);
  const s = deriveStatus(pubmatic({ key: "xandr", apiLastDay: "2026-09-05", lagDays: 1 }), brt(7, 8));
  assert.equal(s.tone, "warn");
});

test("a tolerância da manhã exige atraso MEDIDO contra a API (não o fallback das lines)", () => {
  // Backend sem frescor no ledger: latestDeliveryDay = anteontem às 08h → amarelo,
  // porque não dá pra saber se a fonte não fechou ou se o deal parou.
  const s = deriveStatus(pubmatic({
    hasFreshness: false, apiLastDay: null, lagDays: null, latestDeliveryDay: "2026-09-05",
  }), brt(7, 8));
  assert.equal(s.tone, "warn");
  assert.match(s.summary, /o dado para em 05\/09/);
});

test("fonte sem deal que deveria entregar não alarma (fim de campanha ≠ atraso)", () => {
  const s = deriveStatus(pubmatic({ expectsDelivery: false, apiLastDay: "2026-08-20", lagDays: 16 }), brt(7, 15));
  assert.equal(s.tone, "ok");
  assert.equal(deriveDataLag(pubmatic({ expectsDelivery: false }), brt(7, 15)), null);
});

test("depois das 11h, dias que faltam vieram como ZERO explícito → verde 'entrega zero em …'", () => {
  // 10/09/2026 12h: api_last_day 07/09, lag 2, trailing_zero_days 2 — a API
  // devolveu 08 e 09/09 com 0 em tudo (sonda crua). Fonte em dia; o deal é
  // que não entregou.
  const ran10 = { lastRunAt: brt(10, 11).toISOString(), lastOkAt: brt(10, 11).toISOString() };
  const s = deriveStatus(pubmatic({
    ...ran10, apiLastDay: "2026-09-07", lagDays: 2, trailingZeroDays: 2,
  }), brt(10, 12));
  assert.equal(s.tone, "ok");
  assert.equal(s.closedZero, true);
  assert.deepEqual(s.zeroDays, ["2026-09-08", "2026-09-09"]);
  assert.match(s.summary, /entrega zero em 08\/09 e 09\/09/);
});

test("zero explícito ANTES das 11h continua 'aguardando a fonte fechar' (a API pré-preenche D-1 com zero)", () => {
  const s = deriveStatus(pubmatic({
    apiLastDay: "2026-09-05", lagDays: 1, trailingZeroDays: 1,
  }), brt(7, 8, 10));
  assert.equal(s.tone, "neutral");
  assert.equal(s.waitingSourceClose, true);
});

test("dia que faltou e a API NEM devolveu (trailing_zero < lag) → amarelo/vermelho como antes", () => {
  const ran10 = { lastRunAt: brt(10, 11).toISOString(), lastOkAt: brt(10, 11).toISOString() };
  const s = deriveStatus(pubmatic({
    ...ran10, apiLastDay: "2026-09-07", lagDays: 2, trailingZeroDays: 0,
  }), brt(10, 12));
  assert.equal(s.tone, "error");
  assert.match(s.summary, /a API da PubMatic só tem dado até 07\/09/);
  // Backend antigo, sem a coluna: mesma régua de antes.
  const legacy = deriveStatus(pubmatic({ ...ran10, apiLastDay: "2026-09-08", lagDays: 1 }), brt(10, 12));
  assert.equal(legacy.tone, "warn");
});

test("3+ dias de zero explícito em deal com flight aberto → cinza informativo, não verde", () => {
  const s = deriveStatus(pubmatic({
    lastRunAt: brt(10, 11).toISOString(), lastOkAt: brt(10, 11).toISOString(),
    apiLastDay: "2026-09-06", lagDays: 3, trailingZeroDays: 3,
  }), brt(10, 12));
  assert.equal(s.tone, "neutral");
  assert.match(s.summary, /entrega zero há 3 dias \(07\/09, 08\/09, 09\/09\)/);
  assert.match(s.summary, /confirmar com o comprador/);
});

test("ledger com frescor e nenhum dia com dado → nada a afirmar sobre atraso", () => {
  assert.equal(deriveDataLag(pubmatic({ apiLastDay: null, lagDays: null }), brt(7, 15)), null);
});

test("último run com erro domina qualquer régua de data", () => {
  const s = deriveStatus(pubmatic({
    lastRunStatus: "error", lastOkAt: brt(4, 8).toISOString(),
  }), brt(7, 9));
  assert.equal(s.tone, "error");
  assert.match(s.summary, /Sync falhando há 3 dias/);
});

test("timeout isolado com a sondagem anterior OK há 30 min → amarelo, não 'Sync falhando'", () => {
  // 10/09/2026 11:00: "The read operation timed out"; 10:31 rodou OK com dado
  // até 07/09 (2 dias atrás de D-1 → a régua de dado já é vermelha). O tom vem
  // da régua de dado calculada sobre a última OK; o erro não some do texto.
  const s = deriveStatus(pubmatic({
    lastRunStatus: "error", lastRunAt: brt(10, 11).toISOString(),
    lastOkAt: brt(10, 10, 31).toISOString(), apiLastDay: "2026-09-07", lagDays: 2,
  }), brt(10, 11, 5));
  assert.equal(s.tone, "error");                 // pelo DADO (D-3), não pelo timeout
  assert.equal(s.transientError, true);
  assert.match(s.summary, /só tem dado até 07\/09 \(2 dias atrás\)/);
  assert.match(s.summary, /última sondagem falhou/);

  // Mesma falha com o dado em dia: amarelo, com o texto do dado em dia.
  const fresh = deriveStatus(pubmatic({
    lastRunStatus: "error", lastRunAt: brt(10, 11).toISOString(),
    lastOkAt: brt(10, 10, 31).toISOString(), apiLastDay: "2026-09-09", lagDays: 0,
  }), brt(10, 11, 5));
  assert.equal(fresh.tone, "warn");
  assert.match(fresh.summary, /dado em dia · última sondagem falhou/);
});

test("três sondagens seguidas falhando (última OK há 3h+) → vermelho 'Sync falhando'", () => {
  const s = deriveStatus(pubmatic({
    lastRunStatus: "error", lastRunAt: brt(10, 13).toISOString(),
    lastOkAt: brt(10, 9, 50).toISOString(),
  }), brt(10, 13, 5));
  assert.equal(s.tone, "error");
  assert.match(s.summary, /Sync falhando há 0 dias/);
  assert.equal(s.transientError, undefined);
});

test("'skipped' (sem credencial) é vermelho, não silêncio", () => {
  assert.equal(deriveStatus(pubmatic({ lastRunStatus: "skipped" }), brt(7, 9)).tone, "error");
});

test("job que não rodou hoje: cinza antes das 05h, amarelo depois (ontem), vermelho (≥2 dias)", () => {
  const yesterday = pubmatic({ lastRunAt: brt(6, 23).toISOString(), lastOkAt: brt(6, 23).toISOString() });
  assert.equal(deriveStatus(yesterday, brt(7, 4, 30)).tone, "neutral");
  assert.equal(deriveStatus(yesterday, brt(7, 6)).tone, "warn");
  const old = pubmatic({ lastRunAt: brt(4, 23).toISOString(), lastOkAt: brt(4, 23).toISOString() });
  assert.equal(deriveStatus(old, brt(7, 6)).tone, "error");
});

test("fallback sem ledger usa lastSyncedAt e conta lag pelo last_delivery_day", () => {
  const legacy = {
    key: "pubmatic", lastRunAt: null, lastOkAt: null, lastRunStatus: null, hasFreshness: false,
    lastSyncedAt: brt(7, 4).toISOString(), expectsDelivery: true, latestDeliveryDay: "2026-09-04",
  };
  const s = deriveStatus(legacy, brt(7, 12));
  assert.equal(s.tone, "error");             // 04/09 está 2 dias atrás de D-1 (06/09)
  assert.match(s.summary, /o dado para em 04\/09 \(2 dias atrás\)/);
});

test("dot agregado pega o pior tom; 'aguardando' fica acima de 'ok'", () => {
  assert.equal(worstTone(["ok", "neutral"]), "neutral");
  assert.equal(worstTone(["ok", "warn", "neutral"]), "warn");
  assert.equal(worstTone(["error", "ok"]), "error");
  assert.equal(worstTone([]), "neutral");
  assert.equal(DATA_LAG_WARN_DAYS, 1);
});
