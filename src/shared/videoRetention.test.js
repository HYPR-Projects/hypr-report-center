import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRetention } from "./videoRetention.js";

test("soma views iniciadas e quartis do recorte", () => {
  const r = buildRetention([
    { video_starts: 100, video_view_25: 80, video_view_50: 60, video_view_75: 50, video_view_100: 40 },
    { video_starts: 50, video_view_25: 40, video_view_50: 30, video_view_75: 25, video_view_100: 20 },
  ]);
  assert.equal(r.starts, 150);
  assert.deepEqual(r.points.map((p) => p.value), [150, 120, 90, 75, 60]);
  assert.equal(r.hasQuartiles, true);
});

test("sem quartis intermediários não monta curva", () => {
  const r = buildRetention([{ video_starts: 100, video_view_100: 40 }]);
  assert.equal(r.hasQuartiles, false);
});
