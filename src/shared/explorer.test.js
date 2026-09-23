import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByLine, distinctCount } from "./explorer.js";

test("agrupa por line e recalcula a taxa das somas", () => {
  const out = groupByLine([
    { line_name: "L1", clicks: 2, viewable_impressions: 100 },
    { line_name: "L1", clicks: 3, viewable_impressions: 400 },
    { line_name: "L2", clicks: 0, viewable_impressions: 0 },
    { clicks: 1, viewable_impressions: 10 },
  ], "clicks", "viewable_impressions", "ctr");
  const byKey = Object.fromEntries(out.map((r) => [r.line_name, r]));
  assert.equal(byKey.L1.clicks, 5);
  assert.equal(byKey.L1.viewable_impressions, 500);
  assert.equal(byKey.L1.ctr, 1);
  assert.equal(byKey.L2.ctr, 0);
  assert.equal(byKey["N/A"].ctr, 10);
});

test("conta valores distintos", () => {
  assert.equal(distinctCount([{ a: 1 }, { a: 1 }, { a: 2 }], (r) => r.a), 2);
  assert.equal(distinctCount(null, (r) => r), 0);
});
