import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDataUntil, formatFreshness } from "./freshness.js";

test("computeDataUntil pega a maior data do daily", () => {
  const data = { daily: [{ date: "2026-09-20" }, { date: "2026-09-22" }, { date: "2026-09-21" }] };
  assert.equal(computeDataUntil(data), "2026-09-22");
});

test("computeDataUntil cai pro detail quando daily está vazio", () => {
  const data = { daily: [], detail: [{ date: "2026-09-10" }, { date: "2026-09-11" }] };
  assert.equal(computeDataUntil(data), "2026-09-11");
});

test("computeDataUntil devolve null sem entrega", () => {
  assert.equal(computeDataUntil({}), null);
  assert.equal(computeDataUntil(null), null);
  assert.equal(computeDataUntil({ daily: [{ date: "lixo" }] }), null);
});

test("selo com carga de hoje mostra só a hora", () => {
  // 23/09 10:00 BRT = 13:00 UTC; carga às 06:12 BRT = 09:12 UTC
  const now = new Date("2026-09-23T13:00:00Z");
  const r = formatFreshness({ dataUntil: "2026-09-22", updatedAt: Date.parse("2026-09-23T09:12:00Z"), campaignEnd: "2026-10-22", now });
  assert.equal(r.label, "Dados até 22/09 · atualizado às 06:12");
  assert.equal(r.shortLabel, "até 22/09");
  assert.match(r.title, /defasagem/);
});

test("selo com carga de outro dia mostra data e hora", () => {
  const now = new Date("2026-09-23T13:00:00Z");
  const r = formatFreshness({ dataUntil: "2026-09-21", updatedAt: "2026-09-22T09:05:00Z", campaignEnd: "2026-10-22", now });
  assert.equal(r.label, "Dados até 21/09 · atualizado em 22/09 às 06:05");
});

test("selo sem updatedAt mostra só a data do dado", () => {
  const now = new Date("2026-09-23T13:00:00Z");
  const r = formatFreshness({ dataUntil: "2026-09-22", updatedAt: null, campaignEnd: "2026-10-22", now });
  assert.equal(r.label, "Dados até 22/09");
});

test("campanha encerrada vira selo de números finais", () => {
  const now = new Date("2026-09-23T13:00:00Z");
  const r = formatFreshness({ dataUntil: "2026-08-31", updatedAt: Date.now(), campaignEnd: "2026-08-31", now });
  assert.equal(r.label, "Campanha encerrada · dados até 31/08");
});

test("fuso de Brasília: carga logo depois da meia-noite UTC ainda é o dia anterior em SP", () => {
  // 23/09 01:30 UTC = 22/09 22:30 BRT
  const now = new Date("2026-09-23T01:30:00Z");
  const r = formatFreshness({ dataUntil: "2026-09-21", updatedAt: "2026-09-23T01:00:00Z", campaignEnd: "2026-10-22", now });
  assert.equal(r.label, "Dados até 21/09 · atualizado às 22:00");
});

test("sem entrega", () => {
  const r = formatFreshness({ dataUntil: null });
  assert.equal(r.label, "Aguardando a primeira entrega");
});
