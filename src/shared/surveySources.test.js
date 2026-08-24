// Testes do reconciliador de fontes. Rodar: `npm test`.
//
// O que estes testes travam: o comportamento que separa "somar dados" de
// "somar coisas parecidas". Fusão silenciosa só quando é o mesmo rótulo;
// aproximação sempre registrada; divergência real nunca vira total.

import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalLabel,
  similarity,
  poolChoiceParts,
  poolMatrixParts,
  poolSideParts,
  reconciliationSummary,
} from "./surveySources.js";

test("canonicalLabel iguala variantes ortográficas do mesmo rótulo", () => {
  const same = ["Sim", "sim", " SIM ", "Sim!", "sim.", "a) Sim", "1. Sim"];
  for (const s of same) assert.equal(canonicalLabel(s), "sim", `falhou em "${s}"`);
  assert.equal(canonicalLabel("Não"), canonicalLabel("Nao"));
  assert.equal(canonicalLabel("Talvez 🤔"), "talvez");
});

test("canonicalLabel preserva faixas numéricas (não confunde com enumerador)", () => {
  assert.equal(canonicalLabel("9 - 10"), "9 - 10");
  assert.equal(canonicalLabel("3 ou mais"), "3 ou mais");
});

test("canonicalLabel não funde rótulos de sentido oposto", () => {
  assert.notEqual(canonicalLabel("Sim"), canonicalLabel("Não"));
  assert.ok(similarity("sim", "nao") < 0.86);
});

test("soma Typeform + Max Attention quando os rótulos batem", () => {
  const r = poolChoiceParts([
    { source: "typeform", counts: { Sim: 192, "Não": 125, Talvez: 66 }, total: 383 },
    { source: "maxattention", counts: { sim: 100, Nao: 50, "Talvez 🤔": 20 }, total: 170 },
  ]);
  assert.deepEqual(r.counts, { Sim: 292, "Não": 175, Talvez: 86 });
  assert.equal(r.total, 553);
  assert.equal(r.reconciliation.status, "ok");
  assert.equal(r.reconciliation.shared.length, 3);
  assert.deepEqual(r.sources, ["typeform", "maxattention"]);
});

test("rótulo de exibição é o da variante com mais respostas", () => {
  const r = poolChoiceParts([
    { source: "maxattention", counts: { sim: 10 }, total: 10 },
    { source: "typeform", counts: { Sim: 500 }, total: 500 },
  ]);
  assert.deepEqual(Object.keys(r.counts), ["Sim"]);
  assert.equal(r.counts.Sim, 510);
});

test("erro de digitação funde por aproximação, mas fica registrado", () => {
  const r = poolChoiceParts([
    { source: "typeform", counts: { Talvez: 10 }, total: 10 },
    { source: "maxattention", counts: { Talvezz: 5 }, total: 5 },
  ]);
  assert.equal(r.counts.Talvez, 15);
  assert.equal(r.reconciliation.status, "ok");
  assert.equal(r.reconciliation.fuzzy.length, 1);
  assert.equal(r.reconciliation.fuzzy[0].from, "Talvezz");
});

test("rótulo sem par vira bucket próprio e entra como órfão", () => {
  const r = poolChoiceParts([
    { source: "typeform", counts: { Sim: 10, "Não": 10 }, total: 20 },
    { source: "maxattention", counts: { Sim: 5, "Não": 4, "Não sei responder": 3 }, total: 12 },
  ]);
  assert.equal(r.counts["Não sei responder"], 3);
  assert.equal(r.counts["Não"], 14);
  assert.equal(r.reconciliation.status, "partial");
  assert.equal(r.reconciliation.orphans.length, 1);
  assert.equal(r.reconciliation.orphans[0].label, "Não sei responder");
});

test("candidato ambíguo não funde", () => {
  // "Marca AB" fica quase igual a "Marca AA" e a "Marca AC" — sem folga
  // entre 1º e 2º, o certo é não escolher.
  const r = poolChoiceParts([
    { source: "typeform", counts: { "Marca AA": 10, "Marca AC": 10 }, total: 20 },
    { source: "maxattention", counts: { "Marca AB": 7 }, total: 7 },
  ]);
  assert.equal(r.counts["Marca AB"], 7);
  assert.equal(r.reconciliation.ambiguous.length, 1);
});

test("bases que não são a mesma pergunta viram mismatch, não um total", () => {
  const r = poolChoiceParts([
    { source: "typeform", counts: { Sim: 100, "Não": 80 }, total: 180 },
    { source: "maxattention", counts: { Avon: 40, Eudora: 35, Natura: 25 }, total: 100 },
  ]);
  assert.equal(r.reconciliation.status, "mismatch");
  assert.equal(r.reconciliation.coverage, 0);
  assert.match(reconciliationSummary(r.reconciliation), /divergentes/);
});

test("uma fonte só passa reto, sem ruído de reconciliação", () => {
  const r = poolChoiceParts([
    { source: "typeform", counts: { Sim: 10 }, total: 10 },
  ]);
  assert.equal(r.reconciliation.status, "single");
  assert.equal(reconciliationSummary(r.reconciliation), "");
});

test("total respeita o declarado por fonte (Typeform conta resposta pulada)", () => {
  const r = poolChoiceParts([
    { source: "typeform", counts: { Sim: 5 }, total: 9 },
    { source: "maxattention", counts: { Sim: 5 }, total: 5 },
  ]);
  assert.equal(r.counts.Sim, 10);
  assert.equal(r.total, 14);
  assert.equal(r.bases[0].sum, 5);
});

test("matrix alinha marcas e notas nos dois eixos", () => {
  const r = poolMatrixParts([
    {
      source: "typeform",
      rows: {
        "La Roche-Posay": { counts: { "1": 10, "2": 20 }, total: 30 },
        "Vichy": { counts: { "1": 5 }, total: 5 },
      },
      total: 35,
    },
    {
      source: "maxattention",
      rows: {
        "la roche posay": { counts: { "1": 3, "2": 4 }, total: 7 },
        "Vichy ": { counts: { "1": 2 }, total: 2 },
      },
      total: 9,
    },
  ]);
  assert.deepEqual(r.rows["La Roche-Posay"].counts, { "1": 13, "2": 24 });
  assert.equal(r.rows["Vichy"].counts["1"], 7);
  assert.equal(r.total, 44);
});

test("choice e matrix na mesma pergunta não somam às cegas", () => {
  const r = poolSideParts([
    { source: "typeform", rows: { A: { counts: { "1": 3 }, total: 3 } }, total: 3 },
    { source: "maxattention", counts: { Sim: 9 }, total: 9 },
  ]);
  assert.equal(r.type, "matrix");
  assert.equal(r.reconciliation.status, "partial");
  assert.equal(r.reconciliation.dropped.length, 1);
});

test("entrada suja não derruba o pooling", () => {
  const r = poolChoiceParts([
    { source: "typeform", counts: { Sim: "10", "": 5, "  ": 2, "Não": null, Talvez: -3 }, total: 10 },
    { source: "maxattention", counts: { Sim: 4 }, total: 4 },
  ]);
  assert.equal(r.counts.Sim, 14);
  assert.equal(r.counts[""], undefined);
  assert.equal(poolChoiceParts([]), null);
  assert.equal(poolSideParts(null), null);
});
