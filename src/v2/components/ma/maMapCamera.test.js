import { test } from "node:test";
import assert from "node:assert/strict";
import { FOCUS_ZOOM, haversineKm, planFocus, pointsSignature } from "./maMapCamera.js";

const pts = () => [
  { key: "a", lat: -22.9, lng: -47.06, name: "x" },
  { key: "b", lat: -30.03, lng: -51.23, name: "y" },
];

test("assinatura é estável entre arrays novos com o mesmo conteúdo", () => {
  assert.equal(pointsSignature(pts()), pointsSignature(pts()));
  const moved = pts();
  moved[1].lat = -30.04;
  assert.notEqual(pointsSignature(pts()), pointsSignature(moved));
  assert.equal(pointsSignature([]), "");
});

test("foco nunca baixa o zoom", () => {
  assert.equal(planFocus({ zoom: 4, inView: true }).zoom, FOCUS_ZOOM);
  assert.equal(planFocus({ zoom: 15.5, inView: true }).zoom, 15.5);
  assert.equal(planFocus({ zoom: 16, distanceKm: 900 }).zoom, 16);
});

test("ponto visível ou perto desliza; longe corta", () => {
  assert.equal(planFocus({ zoom: 13, inView: true, distanceKm: 900 }).mode, "ease");
  assert.equal(planFocus({ zoom: 13, inView: false, distanceKm: 12 }).mode, "ease");
  assert.equal(planFocus({ zoom: 13, inView: false, distanceKm: 900 }).mode, "jump");
});

test("movimento reduzido sempre corta", () => {
  assert.equal(planFocus({ zoom: 13, inView: true, reducedMotion: true }).mode, "jump");
});

test("haversine: Campinas → Porto Alegre ~ 850 km", () => {
  const d = haversineKm({ lat: -22.9, lng: -47.06 }, { lat: -30.03, lng: -51.23 });
  assert.ok(d > 800 && d < 950, String(d));
  assert.equal(haversineKm(null, { lat: 0, lng: 0 }), Infinity);
});
