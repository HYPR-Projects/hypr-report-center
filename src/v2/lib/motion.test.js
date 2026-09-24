import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLike, parseFormatted, seriesSignature } from "./motion.js";

test("parseFormatted lê número pt-BR mantendo prefixo e sufixo", () => {
  assert.deepEqual(parseFormatted("17.052.551"), { value: 17052551, decimals: 0, prefix: "", suffix: "" });
  assert.deepEqual(parseFormatted("1,84%"), { value: 1.84, decimals: 2, prefix: "", suffix: "%" });
  assert.deepEqual(parseFormatted("R$ 118.568,86"), { value: 118568.86, decimals: 2, prefix: "R$ ", suffix: "" });
  assert.deepEqual(parseFormatted("11,8M"), { value: 11.8, decimals: 1, prefix: "", suffix: "M" });
  assert.deepEqual(parseFormatted("1234"), { value: 1234, decimals: 0, prefix: "", suffix: "" });
});

test("parseFormatted recusa o que não é número", () => {
  assert.equal(parseFormatted("—"), null);
  assert.equal(parseFormatted(null), null);
  assert.equal(parseFormatted(42), null);
});

test("formatLike reformata no mesmo formato do texto original", () => {
  assert.equal(formatLike(parseFormatted("R$ 0,55"), 0.5), "R$ 0,50");
  assert.equal(formatLike(parseFormatted("17.052.551"), 9876543.4), "9.876.543");
  assert.equal(formatLike(parseFormatted("69,0%"), 71.26), "71,3%");
});

test("seriesSignature muda com o dado e não com a referência do array", () => {
  const a = [{ date: "2026-09-18", v: 1 }, { date: "2026-09-19", v: 2 }];
  const b = a.map((r) => ({ ...r }));
  assert.equal(seriesSignature(a, "v"), seriesSignature(b, "v"));
  assert.notEqual(seriesSignature(a, "v"), seriesSignature([...a, { date: "2026-09-20", v: 3 }], "v"));
  assert.notEqual(seriesSignature(a, "v"), seriesSignature(a.map((r) => ({ ...r, v: r.v * 2 })), "v"));
  assert.equal(seriesSignature([], "v"), "empty");
});
