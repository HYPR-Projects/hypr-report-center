import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommentThreads, threadForTab, parseCommentTime, countUnread, mergeCommentSources } from "./commentThreads.js";

test("buildCommentThreads: Geral sempre, abas visíveis e histórico", () => {
  assert.deepEqual(
    buildCommentThreads({ visible: {}, comments: [] }).map((t) => t.value),
    ["GERAL"],
  );
  assert.deepEqual(
    buildCommentThreads({ visible: { RMND: true, SURVEY: true } }).map((t) => t.label),
    ["Geral", "RMND", "Brand Lift"],
  );
  // Aba escondida mas com conversa antiga: a conversa continua acessível.
  const withHistory = buildCommentThreads({
    visible: {},
    comments: [{ metric_name: "PDOOH" }, { metric_name: "CTR" }, { metric_name: "PDOOH" }],
  });
  assert.deepEqual(withHistory.map((t) => t.value), ["GERAL", "PDOOH", "CTR"]);
});

test("threadForTab", () => {
  assert.equal(threadForTab("rmnd"), "RMND");
  assert.equal(threadForTab("pdooh"), "PDOOH");
  assert.equal(threadForTab("survey"), "SURVEY");
  assert.equal(threadForTab("overview"), "GERAL");
  assert.equal(threadForTab("max-attention"), "GERAL");
});

test("parseCommentTime: formato do BigQuery, ISO e sem fuso", () => {
  const iso = Date.parse("2026-09-22T14:03:11.123Z");
  assert.equal(parseCommentTime("2026-09-22 14:03:11.123456+00:00"), iso);
  assert.equal(parseCommentTime("2026-09-22T14:03:11.123Z"), iso);
  assert.equal(parseCommentTime("2026-09-22 14:03:11.123"), iso);
  assert.equal(parseCommentTime("2026-09-22 11:03:11.123-03:00"), iso);
  assert.equal(parseCommentTime(""), null);
  assert.equal(parseCommentTime("ontem"), null);
});

test("countUnread: só mensagens da outra parte depois do último acesso", () => {
  const comments = [
    { author: "Cliente", created_at: "2026-09-20 10:00:00+00:00" },
    { author: "HYPR", created_at: "2026-09-20 11:00:00+00:00" },
    { author: "HYPR", created_at: "2026-09-21 09:00:00+00:00" },
    { author: "Cliente", created_at: "2026-09-21 12:00:00+00:00" },
  ];
  assert.equal(countUnread(comments, { viewer: "Cliente", seenAt: 0 }), 2);
  assert.equal(countUnread(comments, { viewer: "HYPR", seenAt: 0 }), 2);
  const seen = Date.parse("2026-09-21T00:00:00Z");
  assert.equal(countUnread(comments, { viewer: "Cliente", seenAt: seen }), 1);
  assert.equal(countUnread(comments, { viewer: "HYPR", seenAt: seen }), 1);
  assert.equal(countUnread(comments, { viewer: "Cliente", seenAt: Date.parse("2026-09-22T00:00:00Z") }), 0);
});

test("mergeCommentSources: SURVEY dos membros entra em ordem, sem duplicar", () => {
  const own = [
    { metric_name: "GERAL", author: "Cliente", comment: "oi", created_at: "2026-09-10 10:00:00+00:00" },
    { metric_name: "SURVEY", author: "HYPR", comment: "lift saiu", created_at: "2026-09-12 10:00:00+00:00" },
  ];
  const member = [
    { metric_name: "SURVEY", author: "Cliente", comment: "e agosto?", created_at: "2026-08-20 10:00:00+00:00" },
    { metric_name: "RMND", author: "Cliente", comment: "fora", created_at: "2026-08-21 10:00:00+00:00" },
    { metric_name: "SURVEY", author: "HYPR", comment: "lift saiu", created_at: "2026-09-12 10:00:00+00:00" },
  ];
  const out = mergeCommentSources(own, [member], { onlyThread: "SURVEY" });
  assert.deepEqual(out.map((c) => c.comment), ["e agosto?", "oi", "lift saiu"]);
  // Sem outros tokens, devolve a lista original intacta.
  assert.equal(mergeCommentSources(own, [], { onlyThread: "SURVEY" }).length, 2);
});
