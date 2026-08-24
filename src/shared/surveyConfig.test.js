// Compatibilidade do blob de survey. Cada formato já salvo no BigQuery
// precisa continuar sendo lido — não há migração, e config de campanha
// encerrada não pode parar de renderizar porque o schema evoluiu.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSurveyConfig,
  serializeSurveyConfig,
  getSideParts,
  getSideSource,
  hasSideData,
  partHasData,
} from "./surveyConfig.js";

test("v1 (array puro de Typeform) continua sendo lido", () => {
  const cfg = parseSurveyConfig(
    JSON.stringify([{ nome: "Ad Recall", ctrlUrl: "https://form.typeform.com/to/AAA", expUrl: "https://form.typeform.com/to/BBB" }]),
  );
  assert.equal(cfg.questions.length, 1);
  assert.equal(cfg.clientRange, null);
  const parts = getSideParts(cfg.questions[0], "ctrl");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].source, "typeform");
  assert.equal(parts[0].url, "https://form.typeform.com/to/AAA");
});

test("v2 (clientRange) continua sendo lido", () => {
  const cfg = parseSurveyConfig(
    JSON.stringify({ version: 2, questions: [{ nome: "Q", expUrl: "https://form.typeform.com/to/B" }], clientRange: { from: "2026-04-01", to: "2026-04-30" } }),
  );
  assert.deepEqual(cfg.clientRange, { from: "2026-04-01", to: "2026-04-30" });
  assert.equal(hasSideData(cfg.questions[0], "ctrl"), false);
  assert.equal(hasSideData(cfg.questions[0], "exp"), true);
});

test("v3 (VideoAsk com counts embutidos) continua sendo lido", () => {
  const q = { nome: "Q", ctrlSource: "videoask", ctrlCounts: { Avon: 10, Eudora: 5 }, ctrlFileName: "ctrl.xlsx" };
  const parts = getSideParts(q, "ctrl");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].source, "videoask");
  assert.equal(parts[0].total, 15);
  assert.equal(getSideSource(q, "ctrl"), "videoask");
});

test("v4: um lado soma Typeform + Max Attention", () => {
  const q = {
    nome: "Ad Recall",
    ctrlSource: "typeform",
    ctrlUrl: "https://form.typeform.com/to/AAA",
    ctrlFormId: "AAA",
    ctrlParts: [
      { source: "typeform", url: "https://form.typeform.com/to/AAA", formId: "AAA" },
      { source: "maxattention", creativeId: "90aef590", creativeName: "ID-FXR5US_..._CONTROLE", question: "Ad Recall" },
    ],
  };
  const parts = getSideParts(q, "ctrl");
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.source), ["typeform", "maxattention"]);
  // O espelho de fonte única aponta pra primeira parte — é o que um leitor
  // anterior a v4 enxerga, e ele precisa ver a base principal, não a extra.
  assert.equal(getSideSource(q, "ctrl"), "typeform");
});

test("v4: lado só com Max Attention é válido", () => {
  const q = { nome: "Q", expParts: [{ source: "maxattention", creativeId: "abc" }] };
  assert.equal(hasSideData(q, "exp"), true);
  assert.equal(getSideParts(q, "exp")[0].source, "maxattention");
  assert.equal(hasSideData(q, "ctrl"), false);
});

test("parts vence os campos de fonte única quando os dois existem", () => {
  const q = {
    ctrlSource: "typeform",
    ctrlUrl: "https://form.typeform.com/to/VELHO",
    ctrlParts: [{ source: "typeform", url: "https://form.typeform.com/to/NOVO", formId: "NOVO" }],
  };
  assert.equal(getSideParts(q, "ctrl")[0].formId, "NOVO");
});

test("parte sem identificador nem contagem é descartada", () => {
  assert.equal(partHasData({ source: "typeform" }), false);
  assert.equal(partHasData({ source: "maxattention" }), false);
  assert.equal(partHasData({ source: "maxattention", creativeId: "x" }), true);
  assert.equal(partHasData({ source: "videoask", counts: {} }), false);
  assert.equal(partHasData(null), false);
  // Uma parte quebrada não leva o lado inteiro junto.
  const q = { ctrlParts: [{ source: "typeform" }, { source: "maxattention", creativeId: "ok" }] };
  assert.equal(getSideParts(q, "ctrl").length, 1);
});

test("legacy CSV continua identificado como tal", () => {
  const cfg = parseSurveyConfig(JSON.stringify({ nome: "S", control_total: 5, exposed_total: 6, questions: [{ label: "x", control: 1, exposed: 2 }] }));
  assert.equal(cfg.isLegacyCsv, true);
  assert.equal(cfg.questions, null);
});

test("JSON inválido ou vazio devolve null em vez de explodir", () => {
  assert.equal(parseSurveyConfig("{nao é json"), null);
  assert.equal(parseSurveyConfig(""), null);
  assert.equal(parseSurveyConfig(null), null);
});

test("serialize preserva o round-trip de v4", () => {
  const questions = [{ nome: "Q", ctrlParts: [{ source: "maxattention", creativeId: "c1" }] }];
  const back = parseSurveyConfig(serializeSurveyConfig(questions, { from: "2026-08-01", to: "2026-08-31" }));
  assert.deepEqual(back.questions, questions);
  assert.deepEqual(back.clientRange, { from: "2026-08-01", to: "2026-08-31" });
});
