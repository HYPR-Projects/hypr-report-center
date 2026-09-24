import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalMaFormat,
  foldFormatSeries,
  dspDeliveryByPiece,
  pieceMedia,
  sumMedia,
  buildFunnel,
  funnelConversions,
  keyMetric,
  formatBreakdowns,
  videoFunnel,
  widgetBlocks,
  engagedByDayAndFormat,
  formatColorSlots,
  groupByFormat,
  isWaiting,
  relativeUpdated,
  formatLabel,
} from "./maMetrics.js";

const mapPiece = {
  creative_id: "a",
  format: "tap-to-map",
  totals: {
    impressionServed: 1000, impression: 950, viewable: 600, uniqueSessions: 800,
    engagedSessions: 40, ctaClick: 12, pinClick: 20, clickSessions: 18,
  },
  steps: {
    impression: 780, viewable: 590, engaged: 39, click: 18, cta_click: 11, cta_location: 10,
    cta_directions: 6, cta_whatsapp: 3, cta_website: 0,
    overlay_dismissed: 25, map_interaction: 22, pin_click: 15, overlay_click: 2,
  },
  cta_by_button: { directions: 7, whatsapp: 4, website: 1 },
  cta_by_surface: { pin_card: 8, nearest_card: 3, header: 0, overlay: 1, split_creative: 0 },
  daily: [
    { date: "2026-09-01", engaged_sessions: 10 },
    { date: "2026-09-02", engaged_sessions: 30 },
  ],
};

test("entrega da DSP casa por nome do criativo, sem diferenciar caixa, e respeita o período", () => {
  const links = [{ creative_id: "a", dsp_creative_names: ["HYPR_MA_Lojas_300x250"] }, { creative_id: "b", dsp_creative_names: [] }];
  const detail = [
    { date: "2026-09-01", creative_name: "hypr_ma_lojas_300x250", impressions: 500, viewable_impressions: 300, clicks: 2 },
    { date: "2026-09-02", creative_name: "HYPR_MA_Lojas_300x250 ", impressions: 700, viewable_impressions: 400, clicks: 3 },
    { date: "2026-09-02", creative_name: "Outro", impressions: 999 },
  ];
  const all = dspDeliveryByPiece(links, detail);
  assert.deepEqual(all.get("a"), { impressions: 1200, viewable: 700, clicks: 5 });
  assert.equal(all.has("b"), false);
  const one = dspDeliveryByPiece(links, detail, { from: "2026-09-02", to: "2026-09-02" });
  assert.equal(one.get("a").impressions, 700);
});

test("impressão principal: DSP quando vinculada, senão servida, senão medida", () => {
  assert.equal(pieceMedia(mapPiece, { impressions: 1200 }).impressionsSource, "dsp");
  assert.equal(pieceMedia(mapPiece, { impressions: 1200 }).impressions, 1200);
  assert.equal(pieceMedia(mapPiece).impressionsSource, "served");
  assert.equal(pieceMedia(mapPiece).impressions, 1000);
  const semBeacon = { totals: { ...mapPiece.totals, impressionServed: 0 } };
  assert.equal(pieceMedia(semBeacon).impressionsSource, "measured");
  // taxas sempre sobre a base medida
  const m = pieceMedia(mapPiece, { impressions: 1200 });
  assert.equal(m.viewability, (600 / 950) * 100);
  assert.equal(m.ctr, (12 / 950) * 100);
  // pessoas exatas do sessionSteps; sem ele, os totais (teto)
  assert.equal(m.sessions, 780);
  assert.equal(m.engagement, 5);
  assert.equal(m.exactPeople, true);
  const semSteps = pieceMedia({ ...mapPiece, steps: null });
  assert.equal(semSteps.sessions, 800);
  assert.equal(semSteps.engaged, 40);
  assert.equal(semSteps.exactPeople, false);
});

test("soma da camada mídia recalcula taxas e sinaliza fontes misturadas", () => {
  const a = pieceMedia(mapPiece, { impressions: 1200 });
  const b = pieceMedia(mapPiece);
  const s = sumMedia([a, b]);
  assert.equal(s.impressions, 2200);
  assert.equal(s.engagement, 5);
  assert.equal(s.sessions, 1560);
  assert.equal(s.impressionsSource, "mixed");
  assert.equal(sumMedia([a]).impressionsSource, "dsp");
});

test("funil do Tap to Map em pessoas, aninhado e com CTA por botão como sub-etapa", () => {
  const f = buildFunnel(mapPiece);
  assert.equal(f.source, "steps");
  assert.deepEqual(f.steps.map((s) => s.value), [590, 39, 18, 10]);
  assert.equal(f.steps[3].label, "Clicou em CTA da loja");
  assert.deepEqual(f.subs.map((s) => s.label), ["Como chegar", "WhatsApp"]);
  const { rows, biggestDrop } = funnelConversions(f.steps);
  assert.equal(rows[1].conversion, (39 / 590) * 100);
  // maior perda DEPOIS da visualização: engajou → clicou (22) > clicou → CTA (8)
  assert.equal(biggestDrop.from, "Interagiu");
  assert.equal(biggestDrop.to, "Clicou em pin ou CTA");
});

test("sem sessionSteps o funil fica indisponível (totais contam a mesma pessoa mais de uma vez)", () => {
  const f = buildFunnel({ ...mapPiece, steps: null });
  assert.equal(f.source, "unavailable");
  assert.deepEqual(f.steps, []);
});

test("etapa fora de ordem não ganha conversão nem vira a maior perda", () => {
  const { rows, biggestDrop } = funnelConversions([
    { label: "Viu", value: 100 }, { label: "A", value: 10 }, { label: "B", value: 12 },
  ]);
  assert.equal(rows[2].conversion, null);
  assert.equal(biggestDrop, null);
});

test("Reveal com Inclinar usa a ativação como segunda etapa; clique na capa sai do funil", () => {
  const p = {
    format: "scratch", mechanic: "tilt",
    steps: { viewable: 500, tilt_activated: 50, scratch_started: 0, scratch_completed: 40, scratch_reveal_click: 9, scratch_cover_click: 30 },
    scratch: { ctaCover: 31, ctaImage: 8, ctaButton: 1 },
  };
  const f = buildFunnel(p);
  assert.deepEqual(f.steps.map((s) => s.key), ["viewable", "tilt_activated", "scratch_completed", "scratch_reveal_click"]);
  assert.equal(f.steps.some((s) => s.key === "scratch_cover_click"), false);
  const km = keyMetric(p);
  assert.equal(km.value, 80);
  const surf = formatBreakdowns(p)[0];
  assert.deepEqual(surf.parts.map((x) => x.label), ["Capa (antes de revelar)", "Imagem revelada", "Botão"]);
});

test("Tap to Choose em modo enquete termina em Concluiu", () => {
  const f = buildFunnel({ format: "survey", survey_mode: "poll", steps: { viewable: 100, survey_answer: 30, survey_complete: 20 } });
  assert.deepEqual(f.steps.map((s) => s.label), ["Viu a peça", "Respondeu", "Concluiu a pesquisa"]);
  const ads = buildFunnel({ format: "survey", survey_mode: "ads", steps: { viewable: 100, survey_answer: 30, click: 5 } });
  assert.equal(ads.steps[2].label, "Clicou");
});

test("métrica-chave por formato", () => {
  assert.deepEqual(keyMetric(mapPiece), { label: "Clicaram em pin", value: 15, kind: "count", pct: (15 / 590) * 100 });
  assert.equal(keyMetric({ format: "carrossel", steps: { viewable: 200, nav: 50 } }).value, 25);
  const ffVideo = keyMetric({ format: "freeform", freeform: { videoStart: 100, videoComplete: 40 }, totals: {} });
  assert.equal(ffVideo.label, "Viram o vídeo até o fim");
  assert.equal(ffVideo.value, 40);
});

test("quebras do Tap to Map escondem superfícies zeradas", () => {
  const b = formatBreakdowns(mapPiece);
  assert.deepEqual(b.map((x) => x.key), ["cta_button", "cta_surface", "interactions"]);
  assert.deepEqual(b[1].parts.map((x) => x.label), ["Card do pin", "Loja mais próxima", "Capa"]);
});

test("funil de vídeo só aparece quando houve play", () => {
  assert.equal(videoFunnel({ freeform: { videoStart: 0 } }), null);
  const v = videoFunnel({ freeform: { videoStart: 100, videoFirstQuartile: 80, videoMidpoint: 60, videoThirdQuartile: 50, videoComplete: 40, videoUnmute: 5 } });
  assert.deepEqual(v.steps.map((s) => s.value), [100, 80, 60, 50, 40]);
  assert.equal(v.unmute, 5);
});

test("Close To avisa quando metade ou mais das identificações vêm do IP", () => {
  const piece = {
    format: "freeform",
    totals: { viewable: 1000, impression: 1800 },
    steps: { viewable: 1000, close_to_view: 900, close_to_locate: 60, close_to_found: 50, close_to_redirect: 12 },
    widgets: [
      { id: "w1", type: "close_to", views: 950, taps: 70, tap_sessions: 60, conversions: 12 },
      { id: "w2", type: "countdown", views: 900, taps: 0, tap_sessions: 0, conversions: 0 },
    ],
    close_to: {
      foundPrecise: 20, foundApprox: 30, redirectMap: 9, redirectUrl: 3,
      addresses: [
        { name: "Loja B", identified: 10, clicks: 2 },
        { name: "Loja A", identified: 25, clicks: 5 },
        { name: "Loja C", identified: 0, clicks: 0 },
      ],
    },
  };
  const [ct, cd] = widgetBlocks(piece);
  assert.equal(ct.kind, "close_to");
  assert.equal(ct.approxShare, 60);
  assert.equal(ct.approxWarning, true);
  assert.deepEqual(ct.funnel.map((s) => s.value), [900, 60, 50, 12]);
  assert.deepEqual(ct.addresses.map((a) => a.name), ["Loja A", "Loja B"]);
  assert.equal(ct.addresses[0].conversion, 20);
  assert.equal(cd.kind, "display");
  assert.equal(cd.ofMeasured, 50);
});

test("empilhado por dia e formato preenche zeros e respeita a ordem de formato", () => {
  const car = { format: "carrossel", daily: [{ date: "2026-09-02", engaged_sessions: 5 }] };
  const { rows, formats } = engagedByDayAndFormat([car, mapPiece]);
  assert.deepEqual(formats, ["tap-to-map", "carrossel"]);
  assert.deepEqual(rows, [
    { date: "2026-09-01", "tap-to-map": 10, carrossel: 0 },
    { date: "2026-09-02", "tap-to-map": 30, carrossel: 5 },
  ]);
});

test("cor por formato em ordem fixa; do 5º em diante vira neutro", () => {
  const c = formatColorSlots(["play", "tap-to-map", "survey", "scratch", "freeform"]);
  assert.equal(c["tap-to-map"], "var(--color-chart-s1)");
  assert.equal(c.scratch, "var(--color-chart-s2)");
  assert.equal(c.play, "var(--color-fg-subtle)");
});

test("agrupa por formato na ordem canônica e detecta peça sem entrega", () => {
  const g = groupByFormat([{ format: "scratch" }, mapPiece, { format: "scratch" }]);
  assert.deepEqual(g.map((x) => [x.format, x.items.length]), [["tap-to-map", 1], ["scratch", 2]]);
  assert.equal(g[0].label, "Tap to Map");
  assert.equal(isWaiting({ totals: { impression: 0, impressionServed: 0 } }), true);
  assert.equal(isWaiting(mapPiece), false);
  assert.equal(formatLabel("desconhecido"), "desconhecido");
});

test("selo relativo do Max Attention", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  assert.equal(relativeUpdated("2026-09-23T11:56:00Z", now), "Atualizado há 4 min");
  assert.equal(relativeUpdated("2026-09-23T11:59:50Z", now), "Atualizado agora");
  assert.equal(relativeUpdated("2026-09-23T09:00:00Z", now), "Atualizado há 3 h");
  assert.equal(relativeUpdated(null, now), null);
});

test("slider legado é tratado como carrossel (label, cor e agrupamento)", () => {
  assert.equal(canonicalMaFormat("slider"), "carrossel");
  assert.equal(canonicalMaFormat(" scratch "), "scratch");
  assert.equal(canonicalMaFormat(null), "");
  assert.equal(formatLabel("slider"), "Tap to Carousel");
  assert.equal(formatLabel("formato-novo"), "formato-novo");
  const colors = formatColorSlots(["slider", "carrossel", "tap-to-map"]);
  assert.deepEqual(Object.keys(colors), ["tap-to-map", "carrossel"]);
  const groups = groupByFormat([{ format: "slider" }, { format: "carrossel" }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].format, "carrossel");
  assert.equal(groups[0].items.length, 2);
});

test("empilhado: do 2º formato cinza em diante vira 'Outros formatos'", () => {
  const formats = ["play", "tap-to-map", "survey", "scratch", "freeform", "carrossel"];
  const colors = formatColorSlots(formats);
  const rows = [{ date: "2026-09-01", "tap-to-map": 10, carrossel: 5, scratch: 4, freeform: 3, survey: 2, play: 1 }];
  const out = foldFormatSeries({ rows, formats }, colors);
  assert.deepEqual(out.formats, ["tap-to-map", "carrossel", "scratch", "freeform", "outros"]);
  assert.equal(out.rows[0].outros, 3);
  assert.equal(out.rows[0]["tap-to-map"], 10);
  assert.equal(formatLabel("outros"), "Outros formatos");
  // Um cinza só mantém o nome do formato.
  const five = ["tap-to-map", "carrossel", "scratch", "freeform", "survey"];
  const kept = foldFormatSeries({ rows, formats: five }, formatColorSlots(five));
  assert.deepEqual(kept.formats, five);
});
