// Régua do "Estado das bases" com a hora congelada.
//
// O caso que dá nome ao arquivo é o de 18/09/2026: Amazon parada desde 13/09
// (domingo) e o cabeçalho do painel amarelo, porque a severidade era contada
// em FONTES e não em DIAS. `serverNow` é parâmetro justamente pra esses
// horários serem fixos — a régua tem três estados que dependem da hora BRT.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveStatus, deriveUnifiedStatus, toneForDays, daysBehindBr, brHour,
  worstTone, SOURCE_DOWN_DAYS, STALE_DAYS,
} from "./dspFreshness.js";

// Instantes em BRT (UTC-3) expressos em UTC. Date.UTC rola o dia sozinho
// quando hora+3 passa de 23.
const brt = (day, hour, minute = 0) =>
  new Date(Date.UTC(2026, 8, day, hour + 3, minute)).toISOString();

const src = (source, max_date) => ({ source, max_date });

// Estado real do print de 18/09/2026 09h08: 3 fontes em D-1, Amazon em D-5,
// consolidado em D-1 (o build rodou sem ela).
function incidente18Set(overrides = {}) {
  return {
    sources: [
      src("Amazon", "2026-09-13"),
      src("DV360", "2026-09-17"),
      src("StackAdapt", "2026-09-17"),
      src("Yahoo", "2026-09-17"),
    ],
    unifiedMax: "2026-09-17",
    unifiedBySource: [
      { source: "amazon", max_date: "2026-09-13" },
      { source: "dv360", max_date: "2026-09-17" },
      { source: "stackadapt", max_date: "2026-09-17" },
      { source: "yahoo", max_date: "2026-09-17" },
    ],
    serverNow: brt(18, 9, 8),
    ...overrides,
  };
}

test("brHour devolve a hora de Brasília, não UTC", () => {
  assert.equal(brHour(brt(18, 9, 8)), 9);
  assert.equal(brHour(brt(18, 23, 59)), 23);
  assert.equal(brHour(brt(18, 0, 5)), 0);
});

test("daysBehindBr conta dias de calendário BR", () => {
  assert.equal(daysBehindBr("2026-09-17", brt(18, 9)), 1);
  assert.equal(daysBehindBr("2026-09-13", brt(18, 9)), 5);
  assert.equal(daysBehindBr(null, brt(18, 9)), null);
});

test("toneForDays: D-1 ok, 2 dias warn, 3+ parada", () => {
  assert.equal(toneForDays(0), "ok");
  assert.equal(toneForDays(STALE_DAYS), "ok");
  assert.equal(toneForDays(2), "warn");
  assert.equal(toneForDays(SOURCE_DOWN_DAYS), "error");
  assert.equal(toneForDays(30), "error");
  assert.equal(toneForDays(null), "neutral");
});

test("worstTone prioriza alerta sobre ok", () => {
  assert.equal(worstTone(["ok", "warn", "error"]), "error");
  assert.equal(worstTone(["ok", "neutral"]), "neutral");
  assert.equal(worstTone(["ok", "ok"]), "ok");
});

// ── o bug de 18/09 ──────────────────────────────────────────────────────────

test("REGRESSÃO 18/09: uma fonte parada há 5 dias é VERMELHO, não amarelo", () => {
  const s = deriveStatus(incidente18Set());
  assert.equal(s.tone, "error");           // era "warn" — blockers.length >= 2 ? error : warn
  assert.equal(s.blockers.length, 1);
  assert.equal(s.blockers[0].source, "Amazon");
  assert.equal(s.blockers[0].days, 5);
});

test("REGRESSÃO 18/09: o resumo diz há quantos dias, não só 'não entregou D-1'", () => {
  const s = deriveStatus(incidente18Set());
  assert.match(s.summary, /Amazon/);
  assert.match(s.summary, /5 dias/);
});

test("REGRESSÃO 18/09: cabeçalho e linha nunca mais discordam de tom", () => {
  const s = deriveStatus(incidente18Set());
  // A linha da Amazon usa toneForDays direto; o cabeçalho agora também.
  assert.equal(s.tone, toneForDays(5));
});

test("REGRESSÃO 18/09: consolidado com fonte faltando dentro não é verde", () => {
  const u = deriveStatus(incidente18Set()).unified;
  assert.equal(u.days, 1);                 // fresco na DATA…
  assert.notEqual(u.tone, "ok");           // …e incompleto no CONTEÚDO
  assert.equal(u.missing.length, 1);
  assert.equal(u.missing[0].source, "Amazon");
  assert.match(u.label, /parcial — sem Amazon/);
});

// ── severidade ──────────────────────────────────────────────────────────────

test("uma fonte 2 dias atrás é amarelo (export lento ainda cabe)", () => {
  const s = deriveStatus(incidente18Set({
    sources: [src("Amazon", "2026-09-16"), src("DV360", "2026-09-17")],
    unifiedBySource: [
      { source: "amazon", max_date: "2026-09-16" },
      { source: "dv360", max_date: "2026-09-17" },
    ],
  }));
  assert.equal(s.tone, "warn");
  assert.match(s.summary, /2 dias/);
});

test("duas fontes atrasadas escalam pra vermelho mesmo com 2 dias cada", () => {
  const s = deriveStatus(incidente18Set({
    sources: [src("Amazon", "2026-09-16"), src("DV360", "2026-09-16"), src("Yahoo", "2026-09-17")],
    unifiedBySource: [
      { source: "amazon", max_date: "2026-09-16" },
      { source: "dv360", max_date: "2026-09-16" },
      { source: "yahoo", max_date: "2026-09-17" },
    ],
  }));
  assert.equal(s.tone, "error");
  assert.equal(s.blockers.length, 2);
  assert.match(s.summary, /Amazon \(2d\)/);
});

test("fonte parada ordena primeiro no resumo", () => {
  const s = deriveStatus(incidente18Set({
    sources: [src("DV360", "2026-09-16"), src("Amazon", "2026-09-10"), src("Yahoo", "2026-09-17")],
    unifiedBySource: [{ source: "yahoo", max_date: "2026-09-17" }],
  }));
  assert.equal(s.blockers[0].source, "Amazon");
  assert.match(s.summary, /^Amazon \(8d\)/);
});

// ── cutoff das 07h ──────────────────────────────────────────────────────────

test("antes das 07h, atraso de 1 dia não se julga (rollup pode estar rodando)", () => {
  const s = deriveStatus(incidente18Set({
    sources: [src("Amazon", "2026-09-16"), src("DV360", "2026-09-17")],
    unifiedMax: "2026-09-16",
    unifiedBySource: [
      { source: "amazon", max_date: "2026-09-16" },
      { source: "dv360", max_date: "2026-09-17" },
    ],
    serverNow: brt(18, 6, 30),
  }));
  assert.equal(s.tone, "neutral");
  assert.equal(s.summary, "Aguardando rollup 06h");
});

test("antes das 07h, fonte PARADA há 5 dias alarma assim mesmo", () => {
  const s = deriveStatus(incidente18Set({ serverNow: brt(18, 6, 30) }));
  assert.equal(s.tone, "error");
  assert.match(s.summary, /Amazon/);
  assert.equal(s.blockers.length, 1);
});

test("antes das 07h, fonte parada aparece sem arrastar a atrasada de 1 dia junto", () => {
  const s = deriveStatus(incidente18Set({
    sources: [src("Amazon", "2026-09-13"), src("DV360", "2026-09-16"), src("Yahoo", "2026-09-17")],
    serverNow: brt(18, 6, 30),
  }));
  assert.equal(s.blockers.length, 1);
  assert.equal(s.blockers[0].source, "Amazon");
});

// ── gate do botão Reconstruir ───────────────────────────────────────────────

test("fonte parada: reconstruir NÃO ajuda", () => {
  assert.equal(deriveStatus(incidente18Set()).rebuildHelps, false);
});

test("fontes prontas e unified atrasado: reconstruir ajuda", () => {
  const s = deriveStatus(incidente18Set({
    sources: [src("Amazon", "2026-09-17"), src("DV360", "2026-09-17")],
    unifiedMax: "2026-09-15",
    unifiedBySource: [
      { source: "amazon", max_date: "2026-09-15" },
      { source: "dv360", max_date: "2026-09-15" },
    ],
  }));
  assert.equal(s.rebuildHelps, true);
  assert.match(s.summary, /Consolidação atrasada/);
});

test("fonte entregou e o build não pegou: reconstruir ajuda, e o texto diz isso", () => {
  const s = deriveStatus(incidente18Set({
    sources: [src("Amazon", "2026-09-17"), src("DV360", "2026-09-17")],
    unifiedMax: "2026-09-17",
    unifiedBySource: [
      { source: "amazon", max_date: "2026-09-13" },
      { source: "dv360", max_date: "2026-09-17" },
    ],
  }));
  assert.equal(s.rebuildHelps, true);
  assert.equal(s.tone, "error");
  assert.match(s.summary, /Consolidado sem Amazon/);
});

// ── casos de borda ──────────────────────────────────────────────────────────

test("tudo em dia é verde", () => {
  const s = deriveStatus(incidente18Set({
    sources: [src("Amazon", "2026-09-17"), src("DV360", "2026-09-17")],
    unifiedBySource: [
      { source: "amazon", max_date: "2026-09-17" },
      { source: "dv360", max_date: "2026-09-17" },
    ],
  }));
  assert.equal(s.tone, "ok");
  assert.equal(s.summary, "Bases atualizadas");
  assert.equal(s.unified.missing.length, 0);
  assert.equal(s.unified.label, null);
});

test("fonte fora da janela de 7d do unified conta como faltando, não como sem dado", () => {
  const u = deriveUnifiedStatus({
    expected: [src("Amazon", "2026-08-01"), src("DV360", "2026-09-17")],
    unifiedBySource: [{ source: "dv360", max_date: "2026-09-17" }],
    unifiedMax: "2026-09-17",
    serverNow: brt(18, 9),
  });
  assert.equal(u.missing.length, 1);
  assert.equal(u.missing[0].absent, true);
  assert.equal(u.tone, "error");
});

test("backend antigo sem unified_by_source não inventa fonte faltando", () => {
  const s = deriveStatus({
    sources: [src("Amazon", "2026-09-17"), src("DV360", "2026-09-17")],
    unifiedMax: "2026-09-17",
    unifiedBySource: undefined,
    serverNow: brt(18, 9),
  });
  assert.equal(s.tone, "ok");
  assert.equal(s.unified.missing.length, 0);
});

test("sem fontes: neutro, sem afirmar nada", () => {
  const s = deriveStatus({ sources: [], unifiedMax: null, serverNow: brt(18, 9) });
  assert.equal(s.tone, "neutral");
  assert.equal(s.summary, "Sem dados de frescor");
});

test("fonte sem max_date não vira blocker nem esconde as outras", () => {
  const s = deriveStatus(incidente18Set({
    sources: [src("Amazon", null), src("DV360", "2026-09-17")],
    unifiedBySource: [{ source: "dv360", max_date: "2026-09-17" }],
  }));
  assert.equal(s.blockers.length, 0);
  // A Amazon segue faltando no consolidado — o alerta continua de pé por lá.
  assert.equal(s.unified.missing.length, 1);
});
