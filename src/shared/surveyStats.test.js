// A régua de significância. O que estes testes travam é o que separa "o
// número subiu" de "o número significa alguma coisa" — e, principalmente,
// os casos em que o certo é NÃO concluir.

import test from "node:test";
import assert from "node:assert/strict";
import { liftSignificance, significanceLabel, MIN_CELL } from "./surveyStats.js";

test("diferença grande com amostra grande é significante", () => {
  const r = liftSignificance({ ctrlN: 1000, ctrlPositive: 400, expN: 1000, expPositive: 500 });
  assert.equal(r.status, "ok");
  assert.equal(r.significant, true);
  assert.ok(r.confidence > 0.99);
});

test("diferença pequena com amostra grande NÃO é significante", () => {
  const r = liftSignificance({ ctrlN: 1000, ctrlPositive: 400, expN: 1000, expPositive: 410 });
  assert.equal(r.status, "ok");
  assert.equal(r.significant, false);
  assert.match(significanceLabel(r).text, /margem de erro/);
});

test("abaixo do piso não conclui — nem que deu, nem que não deu", () => {
  // z aqui passa de 1,96; ainda assim o piso de 60 manda. É a regra de
  // negócio da HYPR, não uma decisão estatística deste arquivo.
  const r = liftSignificance({ ctrlN: 40, ctrlPositive: 10, expN: 40, expPositive: 20 });
  assert.ok(Math.abs(r.z) > 1.96);
  assert.equal(r.status, "underpowered");
  assert.equal(r.significant, false);
  assert.equal(significanceLabel(r).tone, "muted");
});

test("o piso vale para as DUAS células", () => {
  assert.equal(liftSignificance({ ctrlN: MIN_CELL - 1, ctrlPositive: 10, expN: 5000, expPositive: 2000 }).status, "underpowered");
  assert.equal(liftSignificance({ ctrlN: 5000, ctrlPositive: 2000, expN: MIN_CELL - 1, expPositive: 10 }).status, "underpowered");
  assert.equal(liftSignificance({ ctrlN: MIN_CELL, ctrlPositive: 20, expN: MIN_CELL, expPositive: 21 }).status, "ok");
});

test("célula vazia não vira teste nem rótulo", () => {
  const r = liftSignificance({ ctrlN: 0, ctrlPositive: 0, expN: 900, expPositive: 300 });
  assert.equal(r.status, "insufficient");
  assert.equal(significanceLabel(r), null);
  assert.equal(significanceLabel(null), null);
});

test("margem de erro acompanha o tamanho da amostra", () => {
  const pequeno = liftSignificance({ ctrlN: 100, ctrlPositive: 50, expN: 100, expPositive: 55 });
  const grande = liftSignificance({ ctrlN: 10000, ctrlPositive: 5000, expN: 10000, expPositive: 5500 });
  assert.ok(grande.moePts < pequeno.moePts);
});

test("lift negativo também é testado (queda pode ser real)", () => {
  const r = liftSignificance({ ctrlN: 1000, ctrlPositive: 500, expN: 1000, expPositive: 400 });
  assert.equal(r.significant, true);
  assert.ok(r.z < 0);
});

test("dado inconsistente não produz NaN", () => {
  // positivos > total (blob corrompido, soma de bases com total declarado
  // menor que a soma das opções): satura no teto em vez de gerar variância
  // negativa e NaN descendo pra tela.
  const r = liftSignificance({ ctrlN: 100, ctrlPositive: 999, expN: 100, expPositive: 50 });
  assert.ok(Number.isFinite(r.z));
  assert.ok(Number.isFinite(r.moePts));
  assert.equal(liftSignificance({}).status, "insufficient");
  assert.equal(liftSignificance().status, "insufficient");
  const negativo = liftSignificance({ ctrlN: -5, ctrlPositive: -1, expN: 100, expPositive: 10 });
  assert.equal(negativo.status, "insufficient");
});

test("empate perfeito é não-significante, sem divisão por zero", () => {
  const r = liftSignificance({ ctrlN: 500, ctrlPositive: 0, expN: 500, expPositive: 0 });
  assert.equal(r.significant, false);
  assert.ok(!Number.isNaN(r.moePts));
});
