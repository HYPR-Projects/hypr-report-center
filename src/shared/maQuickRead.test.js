import { test } from "node:test";
import assert from "node:assert/strict";
import { quickRead } from "./maQuickRead.js";

// Números da peça Niely Cor & Ton (set/26).
const corETon = {
  format: "tap-to-map",
  steps: {
    viewable: 33817, engaged: 3889, click: 169, cta_location: 2,
    overlay_dismissed: 3719, map_interaction: 1135, pin_click: 1, overlay_click: 167,
    cta_directions: 1, cta_whatsapp: 0, cta_website: 1,
  },
};

test("tap to map: capa dominante, mapa e passagem rara para a loja", () => {
  const t = quickRead(corETon, { engaged: 3889 });
  assert.match(t, /^Quase todo mundo que interagiu arrastou a capa \(96%\)\./);
  assert.match(t, /29% foi além e explorou o mapa\./);
  assert.match(t, /ainda é rara no período\.$/);
  assert.doesNotMatch(t, /baixo|ruim|fraco/i);
});

test("tap to map: ações de loja relevantes viram contagem", () => {
  const p = { ...corETon, steps: { ...corETon.steps, cta_location: 48, cta_directions: 40, cta_website: 12 } };
  assert.match(quickRead(p, { engaged: 3889 }), /48 pessoas abriram rota, WhatsApp ou site\./);
});

test("tap to map: capa sem maioria absoluta vira percentual", () => {
  const p = { ...corETon, steps: { ...corETon.steps, overlay_dismissed: 2300 } };
  assert.match(quickRead(p, { engaged: 3889 }), /^59% de quem interagiu arrastou a capa\./);
});

test("outros formatos: base de quem viu e maior perda do funil", () => {
  const p = { format: "carrossel", steps: { viewable: 1000, engaged: 200, click: 20 } };
  const t = quickRead(p, { engaged: 200 });
  assert.match(t, /^20% de quem viu a peça interagiu com ela\./);
  const low = quickRead({ format: "scratch", steps: { viewable: 1000, engaged: 6 } }, { engaged: 6 });
  assert.match(low, /^0,6% de quem viu/);
  assert.match(t, /“Interagiu → Clicou”/);
});

test("sem steps ou sem engajamento, nada", () => {
  assert.equal(quickRead({ format: "tap-to-map" }, { engaged: 10 }), null);
  assert.equal(quickRead(corETon, { engaged: 0 }), null);
});
