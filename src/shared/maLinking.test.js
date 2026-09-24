import { test } from "node:test";
import assert from "node:assert/strict";
import { lineCoverage, namesToLink, strongSuggestions, lineSearchQuery, takenNames } from "./maLinking.js";

const LINES = [
  { line: "HYPR_MOBLAND_PARAMOUNT_CAROUSEL", names: ["HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300x600", "HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300x250"], impressions: 10 },
  { line: "HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS", names: ["HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS_300x250"], impressions: 5 },
  { line: "P+_KA_SAFE_MOBLAND_S2_FF_BR_HERO", names: ["P+_KA_SAFE_MOBLAND_S2_FF_BR_HERO_300x250"], impressions: 1 },
];
const CAR = {
  creative_id: "a", name: "MobLand Carrossel", reasons: ["name", "campaign"],
  dsp_lines: ["HYPR_MOBLAND_PARAMOUNT_CAROUSEL"], dsp_creative_names: LINES[0].names,
};
const TIROS = {
  creative_id: "b", name: "MobLand Reveal Tiros", reasons: ["name"],
  dsp_lines: ["HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS"], dsp_creative_names: LINES[1].names,
};

test("lineCoverage: vinculada, sugerida e sem peça", () => {
  const links = [{ creative_id: "a", dsp_creative_names: ["hypr_mobland_paramount_carousel_300x600"] }];
  const cov = lineCoverage(LINES, links, [CAR, TIROS]);
  assert.equal(cov[0].linked.length, 1);
  assert.equal(cov[0].suggested.length, 0); // já vinculada não volta como sugestão
  assert.deepEqual(cov[1].suggested.map((s) => s.creative_id), ["b"]);
  assert.equal(cov[2].linked.length + cov[2].suggested.length, 0);
});

test("namesToLink: todos os tamanhos, menos o que outra peça já usa", () => {
  assert.equal(namesToLink(CAR, []).length, 2);
  const links = [{ creative_id: "z", dsp_creative_names: ["HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300x250"] }];
  assert.deepEqual(namesToLink(CAR, links), ["HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300x600"]);
  assert.deepEqual(namesToLink({ match_name: "X" }, []), ["X"]);
  assert.deepEqual(namesToLink({ creative_id: "m" }, []), []);
});

test("strongSuggestions: uma por linha livre + AdBolt/token", () => {
  const tok = { creative_id: "t", name: "ID-O3HI21_x", reasons: ["token"], dsp_lines: [] };
  const cov = lineCoverage(LINES, [], [CAR, TIROS, tok]);
  assert.deepEqual(strongSuggestions(cov, [CAR, TIROS, tok]).map((s) => s.creative_id).sort(), ["a", "b", "t"]);
});

test("lineSearchQuery: o que distingue a linha", () => {
  assert.equal(lineSearchQuery("HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS", ["mobland", "paramount"]), "reveal tiros");
  assert.equal(lineSearchQuery("HYPR_MOBLAND_PARAMOUNT", ["mobland", "paramount"]), "mobland");
});

test("takenNames ignora a própria peça", () => {
  const links = [{ creative_id: "a", dsp_creative_names: ["x"] }, { creative_id: "b", dsp_creative_names: ["y"] }];
  assert.deepEqual([...takenNames(links, "a")], ["Y"]);
});
