// A unit_key é o target_id da integração no backend: se divergir do
// unit_key_for de backend/pmp_client_sheet.py, o card procura uma planilha que
// não existe (ou conecta uma segunda pro mesmo deal).

import test from "node:test";
import assert from "node:assert/strict";
import { unitKeyFor, defaultSeatId } from "./pmpClientSheet.js";

test("unitKeyFor: grupo ganha da line", () => {
  assert.equal(unitKeyFor({ group_id: "ab12CD_-", source: "pubmatic", line_id: 1 }), "group:ab12CD_-");
});

test("unitKeyFor: line solta usa o par source:line_id", () => {
  assert.equal(unitKeyFor({ source: "pubmatic", line_id: 735537 }), "line:pubmatic:735537");
  assert.equal(unitKeyFor({ line_id: "31345266" }), "line:xandr:31345266");
  assert.equal(unitKeyFor(null), null);
  assert.equal(unitKeyFor({ source: "xandr" }), null);
});

test("defaultSeatId: PubMatic usa o deal id textual, Xandr os deal_ids", () => {
  assert.equal(defaultSeatId({ external_deal_id: " PM-ZZCX-5733 ", deal_ids: [1] }), "PM-ZZCX-5733");
  assert.equal(defaultSeatId({ deal_ids: [111, 222] }), "111, 222");
  assert.equal(defaultSeatId({ deal_ids: "[111,222]" }), "111, 222");
  assert.equal(defaultSeatId({ deal_ids: null }), "");
  assert.equal(defaultSeatId(null), "");
});
