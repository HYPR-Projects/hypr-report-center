// N checklists por line: o que estes testes travam é a leitura tolerante
// (backend novo com linked_* vs. antigo só com short_token) e as operações
// da lista — o 1º token é o principal e vai pro `code` da line no Xandr, então
// ordem NÃO é detalhe.

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeToken, isValidToken, dedupeTokens, lineTokens, primaryToken,
  extraTokenCount, tokensLabel, lineChecklists, commandPiTotal,
  matchedChecklistCount, missingTokens, withToken, withoutToken, asPrimary, sameTokens,
} from "./pmpTokens.js";

test("normalizeToken / isValidToken", () => {
  assert.equal(normalizeToken("  no2015 "), "NO2015");
  assert.equal(normalizeToken(null), "");
  assert.ok(isValidToken("no2015"));
  assert.ok(isValidToken("I4U4HR"));
  assert.ok(isValidToken("ab-1_x"));
  assert.ok(!isValidToken("X"));
  assert.ok(!isValidToken("NO 2015"));
  assert.ok(!isValidToken("A".repeat(41)));
});

test("dedupeTokens preserva ordem e ignora vazios", () => {
  assert.deepEqual(dedupeTokens([" b1 ", "A1", "b1", "", null, "a1"]), ["B1", "A1"]);
});

test("lineTokens prefere linked_tokens (backend novo)", () => {
  const line = { short_token: "NO2015", extra_short_tokens: ["NO2016"], linked_tokens: ["NO2015", "NO2016", "NO2017"] };
  assert.deepEqual(lineTokens(line), ["NO2015", "NO2016", "NO2017"]);
  assert.equal(primaryToken(line), "NO2015");
  assert.equal(extraTokenCount(line), 2);
  assert.equal(tokensLabel(line), "NO2015 + NO2016 + NO2017");
});

test("lineTokens cai pra short_token + extras (backend antigo / otimista)", () => {
  assert.deepEqual(lineTokens({ short_token: "no2015", extra_short_tokens: ["NO2016", "no2015"] }), ["NO2015", "NO2016"]);
  assert.deepEqual(lineTokens({ short_token: "NO2015" }), ["NO2015"]);
  assert.deepEqual(lineTokens({}), []);
  assert.deepEqual(lineTokens(null), []);
  assert.equal(primaryToken({}), null);
  assert.equal(extraTokenCount({ short_token: "A1" }), 0);
});

test("lineChecklists alinha com os tokens e marca principal/found", () => {
  const line = {
    linked_tokens: ["NO2015", "NO2016", "ZZ9999"],
    linked_checklists: [
      { short_token: "NO2015", found: true, client: "Amazon", campaign_name: "Copa", investment: "250000" },
      { short_token: "NO2016", found: true, client: "Amazon", campaign_name: "Saldão", investment: 80000.5 },
      { short_token: "ZZ9999", found: false },
    ],
  };
  const cks = lineChecklists(line);
  assert.equal(cks.length, 3);
  assert.equal(cks[0].primary, true);
  assert.equal(cks[1].primary, false);
  assert.equal(cks[0].investment, 250000);     // NUMERIC vem como string do BQ
  assert.equal(cks[1].investment, 80000.5);
  assert.equal(cks[2].found, false);
  assert.equal(cks[2].investment, null);
  assert.deepEqual(missingTokens(line), ["ZZ9999"]);
  assert.equal(matchedChecklistCount(line), 2);
});

test("lineChecklists sintetiza a partir dos campos planos (backend antigo)", () => {
  const line = {
    short_token: "NO2015", checklist_id: 77, customer: "Amazon", campaign_name: "Copa",
    agency: "ALMAP", pi_brl: "250000", pi_overridden: false,
  };
  const cks = lineChecklists(line);
  assert.equal(cks.length, 1);
  assert.equal(cks[0].found, true);
  assert.equal(cks[0].client, "Amazon");
  assert.equal(cks[0].investment, 250000);
  // Sem checklist casado: found desconhecido, sem valor.
  const loose = lineChecklists({ short_token: "ZZ1", extra_short_tokens: ["ZZ2"] });
  assert.equal(loose[0].found, null);
  assert.equal(loose[1].found, null);
  assert.equal(loose[1].investment, null);
});

test("commandPiTotal: campo direto > soma dos checklists > pi_brl sem override", () => {
  assert.equal(commandPiTotal({ command_pi_total: "330000" }), 330000);
  assert.equal(commandPiTotal({
    linked_tokens: ["A1", "B2"],
    linked_checklists: [{ short_token: "A1", found: true, investment: 100 }, { short_token: "B2", found: true, investment: "50.5" }],
  }), 150.5);
  assert.equal(commandPiTotal({ short_token: "A1", checklist_id: 1, pi_brl: "1000", pi_overridden: false }), 1000);
  assert.equal(commandPiTotal({ short_token: "A1", pi_brl: "1000", pi_overridden: true }), null);
  assert.equal(commandPiTotal(null), null);
});

test("operações da lista: add / remove / tornar principal", () => {
  const base = ["NO2015", "NO2016"];
  assert.deepEqual(withToken(base, " no2017 "), ["NO2015", "NO2016", "NO2017"]);
  assert.deepEqual(withToken(base, "no2016"), base);         // já existe → sem duplicar
  assert.deepEqual(withToken(base, ""), base);
  assert.deepEqual(withoutToken(base, "NO2015"), ["NO2016"]); // remove o principal → o próximo vira principal
  assert.deepEqual(withoutToken(base, "XX"), base);
  assert.deepEqual(asPrimary(base, "NO2016"), ["NO2016", "NO2015"]);
  assert.deepEqual(asPrimary(base, "NO2017"), ["NO2017", "NO2015", "NO2016"]);
  assert.deepEqual(asPrimary(base, ""), base);
  // Imutabilidade
  assert.deepEqual(base, ["NO2015", "NO2016"]);
});

test("sameTokens leva ordem em conta (principal importa)", () => {
  assert.ok(sameTokens(["A1", "B2"], ["a1", " b2 "]));
  assert.ok(!sameTokens(["A1", "B2"], ["B2", "A1"]));
  assert.ok(!sameTokens(["A1"], ["A1", "B2"]));
  assert.ok(sameTokens([], null));
});
