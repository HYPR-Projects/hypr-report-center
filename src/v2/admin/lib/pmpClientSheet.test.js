import test from "node:test";
import assert from "node:assert/strict";
import { defaultSeatId, dealSummaryLabel } from "./pmpClientSheet.js";

test("defaultSeatId: PubMatic usa o deal id textual, Xandr os deal_ids", () => {
  assert.equal(defaultSeatId({ external_deal_id: " PM-ZZCX-5733 ", deal_ids: [1] }), "PM-ZZCX-5733");
  assert.equal(defaultSeatId({ deal_ids: [111, 222] }), "111, 222");
  assert.equal(defaultSeatId({ deal_ids: "[111,222]" }), "111, 222");
  assert.equal(defaultSeatId({ deal_ids: null }), "");
  assert.equal(defaultSeatId(null), "");
});

test("dealSummaryLabel", () => {
  assert.equal(dealSummaryLabel({ lines: [{}], tokens: ["A1"] }), "1 line · token A1");
  assert.equal(dealSummaryLabel({ lines: [{}, {}, {}], tokens: ["1PIT7I", "B154D4"] }),
    "3 lines · tokens 1PIT7I, B154D4");
  assert.equal(dealSummaryLabel({ lines: [{}, {}], tokens: [] }), "2 lines");
  assert.equal(dealSummaryLabel(null), "0 lines");
});
