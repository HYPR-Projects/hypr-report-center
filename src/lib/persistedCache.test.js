import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { readCache, readStaleCache, writeCache } = await import("./persistedCache.js");

const DAY = 24 * 60 * 60 * 1000;

function seed(key, { ts = Date.now(), bid = "unknown", v = 2 } = {}) {
  store.set(`hypr.cache.${key}`, JSON.stringify({ v, bid, ts, data: ["x"] }));
}

beforeEach(() => store.clear());

test("readStaleCache aceita entrada de outro deploy", () => {
  seed("menu.campaigns", { bid: "deploy-antigo" });
  assert.equal(readCache("menu.campaigns"), null);
  assert.deepEqual(readStaleCache("menu.campaigns", DAY).data, ["x"]);
});

test("readStaleCache aceita além do TTL padrão, até maxAge", () => {
  seed("menu.campaigns", { ts: Date.now() - 2 * 60 * 60 * 1000 });
  assert.equal(readCache("menu.campaigns"), null);
  assert.ok(readStaleCache("menu.campaigns", DAY));
  seed("menu.campaigns", { ts: Date.now() - DAY - 1 });
  assert.equal(readStaleCache("menu.campaigns", DAY), null);
});

test("readStaleCache recusa schema antigo e JSON quebrado", () => {
  seed("menu.campaigns", { v: 1 });
  assert.equal(readStaleCache("menu.campaigns", DAY), null);
  store.set("hypr.cache.menu.team", "{quebrado");
  assert.equal(readStaleCache("menu.team", DAY), null);
});

test("o que writeCache grava é lido pelos dois", () => {
  writeCache("menu.team", { cps: [], css: [] });
  assert.ok(readCache("menu.team"));
  assert.ok(readStaleCache("menu.team", DAY));
});
