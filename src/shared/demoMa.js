// src/shared/demoMa.js
//
// Max Attention do report DEMO (/report/DEMO): gera, no cliente, a mesma
// resposta que o backend devolve em `action=ma_report`, já normalizada.
//
// As peças ligadas a criativos da DSP partem da entrega desses criativos no
// detail do demo (a impressão medida pela peça fica um pouco abaixo da DSP,
// como na vida real); as outras partem de um volume diário fixo. O resto sai
// de proporções por formato, montadas para os funis descerem em ordem.
// Determinístico: mesmo período → mesmos números.

import { buildDemoPayload, DEMO_MA_LINKS } from "./demoData.js";

function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function jitter(key, low = 0.85, high = 1.15) {
  let t = hash(key) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return low + r * (high - low);
}

const R = Math.round;

// Volume diário das peças sem criativo da DSP no demo.
const BASE_SERVED = { "d30a0a7e-0000-4000-8000-000000000002": 9800, "d30a0a7e-0000-4000-8000-000000000004": 16500 };

// Proporções por formato (sobre impressões medidas / sessões).
const PROFILE = {
  "tap-to-map": { view: 0.62, eng: 0.0139 },
  carrossel: { view: 0.63, eng: 0.025 },
  scratch: { view: 0.53, eng: 0.0041 },
  freeform: { view: 0.535, eng: 0.0058 },
};

const MAP_PINS = [
  ["Loja Pinheiros", -23.5664, -46.6912, 1920, 214, 88],
  ["Loja Moema", -23.6008, -46.6655, 1640, 176, 71],
  ["Loja Vila Mariana", -23.5891, -46.6343, 1310, 152, 60],
  ["Loja Tatuapé", -23.5406, -46.5762, 1180, 121, 52],
  ["Loja Santana", -23.5021, -46.6252, 990, 108, 44],
  ["Loja Morumbi", -23.6226, -46.7005, 870, 97, 37],
  ["Loja Lapa", -23.5235, -46.7031, 760, 84, 31],
  ["Loja Ipiranga", -23.5925, -46.6061, 610, 70, 19],
];

const CLOSE_TO_ADDRESSES = [
  ["Loja Moema", "Av. Ibirapuera, 2.400", -23.6008, -46.6655, 248, 51, 40, 11],
  ["Loja Pinheiros", "R. dos Pinheiros, 1.200", -23.5664, -46.6912, 221, 44, 36, 8],
  ["Loja Vila Mariana", "R. Domingos de Morais, 900", -23.5891, -46.6343, 187, 37, 30, 7],
  ["Loja Tatuapé", "R. Tuiuti, 1.500", -23.5406, -46.5762, 160, 31, 25, 6],
  ["Loja Santana", "Av. Cruzeiro do Sul, 3.100", -23.5021, -46.6252, 151, 27, 21, 6],
  ["Loja Lapa", "R. Doze de Outubro, 400", -23.5235, -46.7031, 138, 22, 16, 6],
];

const SLIDES = ["Protetor FPS 50", "Hidratante pós-sol", "Sérum Vitamina C", "Loção corporal", "Kit Verão"];

function inRange(d, from, to) {
  return (!from || d >= from) && (!to || d <= to);
}

/** Série diária de impressões medidas de uma peça, no período. */
function dailyMeasured(link, detail, dates) {
  const names = new Set((link.dsp_creative_names || []).map((n) => n.toLowerCase()));
  if (names.size) {
    const byDate = new Map();
    for (const r of detail) {
      if (!names.has(String(r.creative_name || "").toLowerCase())) continue;
      byDate.set(r.date, (byDate.get(r.date) || 0) + (r.impressions || 0));
    }
    return dates.map((d) => {
      const dsp = byDate.get(d) || 0;
      return { date: d, dsp, served: R(dsp * 0.994), measured: R(dsp * 0.965) };
    });
  }
  const base = BASE_SERVED[link.creative_id] || 8000;
  return dates.map((d) => {
    const served = R(base * jitter(`${link.creative_id}|${d}`, 0.86, 1.12));
    return { date: d, dsp: 0, served, measured: R(served * 0.962) };
  });
}

function buildPiece(link, days) {
  const p = PROFILE[link.format] || PROFILE.freeform;
  const measured = days.reduce((s, d) => s + d.measured, 0);
  const served = days.reduce((s, d) => s + d.served, 0);
  const viewable = R(measured * p.view);
  const sessions = R(measured * 0.79);
  const engaged = R(sessions * p.eng);
  const vSess = R(viewable * 0.985);
  const [w, h] = String(link.size).split("x").map(Number);

  const piece = {
    creative_id: link.creative_id,
    name: link.name,
    format: link.format,
    size: link.size,
    width: w || null,
    height: h || null,
    status: "published",
    client_name: "Cliente Demo",
    cta_text: "",
    mechanic: null,
    survey_mode: null,
    game_type: null,
    has_overlay: false,
    updated_at: null,
    preview_url: null,
    dsp_creative_names: link.dsp_creative_names || [],
    totals: null,
    steps: null,
    cta_by_button: { directions: 0, whatsapp: 0, website: 0 },
    cta_by_surface: { pin_card: 0, nearest_card: 0, header: 0, overlay: 0, split_creative: 0 },
    top_pins: [],
    scratch: null,
    carousel: null,
    freeform: null,
    survey: null,
    game: null,
    calendar: null,
    widgets: [],
    close_to: null,
    daily: [],
  };

  const steps = { viewable: vSess, engaged, impression: sessions };
  let ctaClick = 0;
  let pinClick = 0;
  let clickSessions = 0;
  let dailyPinRate = 0;

  if (link.format === "tap-to-map") {
    piece.has_overlay = true;
    piece.cta_text = "Ver lojas";
    const click = R(engaged * 0.42);
    const cta = R(click * 0.49);
    const ctaLocSess = R(cta * 0.93);
    Object.assign(steps, {
      click,
      cta_click: cta,
      cta_location: ctaLocSess,
      cta_header: R(ctaLocSess * 0.12),
      cta_directions: R(ctaLocSess * 0.66),
      cta_whatsapp: R(ctaLocSess * 0.215),
      cta_website: R(ctaLocSess * 0.126),
      overlay_dismissed: R(engaged * 0.575),
      map_interaction: R(engaged * 0.45),
      pin_click: R(engaged * 0.296),
      overlay_click: R(engaged * 0.06),
      split_creative_click: 0,
    });
    pinClick = R(steps.pin_click * 1.9);
    const overlayClick = R(steps.overlay_click * 1.05);
    const ctaLoc = R(cta * 1.25);
    ctaClick = ctaLoc + overlayClick;
    clickSessions = click;
    dailyPinRate = pinClick / Math.max(1, measured);
    piece.cta_by_button = { directions: R(ctaLoc * 0.66), whatsapp: R(ctaLoc * 0.215), website: R(ctaLoc * 0.125) };
    piece.cta_by_surface = { pin_card: R(ctaLoc * 0.675), nearest_card: R(ctaLoc * 0.19), header: R(ctaLoc * 0.135), overlay: overlayClick, split_creative: 0 };
    const pinScale = measured / 398120;
    piece.top_pins = MAP_PINS.map(([name, lat, lng, views, pins, ctas]) => ({
      name,
      lat,
      lng,
      views: R(views * pinScale),
      pin_clicks: R(pins * pinScale),
      cta_clicks: R(ctas * pinScale),
      by_button: { directions: R(ctas * pinScale * 0.62), whatsapp: R(ctas * pinScale * 0.25), website: R(ctas * pinScale * 0.13) },
    }));
    piece.totals_extra = { mapInteraction: R(steps.map_interaction * 2.1), overlayDismissed: steps.overlay_dismissed, overlayClick };
  } else if (link.format === "carrossel") {
    piece.cta_text = "Comprar agora";
    const nav = R(engaged * 0.9);
    const click = R(engaged * 0.178);
    Object.assign(steps, { nav, click, cta_click: click });
    ctaClick = R(click * 1.12);
    clickSessions = click;
    const slideChanges = R(nav * 3.1);
    piece.carousel = {
      slideChanges,
      swipes: R(slideChanges * 0.76),
      navSessions: nav,
      ctaSlide: R(ctaClick * 0.676),
      ctaBackground: R(ctaClick * 0.078),
      ctaButton: R(ctaClick * 0.246),
      nav_by_surface: { swipe: R(slideChanges * 0.71), arrow: R(slideChanges * 0.21), dot: R(slideChanges * 0.08) },
      top_slides: SLIDES.map((label, i) => ({
        index: i,
        label,
        views: i === 0 ? R(nav * 0.42) : R(nav * [1, 0.76, 0.58, 0.43][i - 1]),
        clicks: R(ctaClick * 0.676 * [0.34, 0.24, 0.19, 0.14, 0.09][i]),
      })),
    };
    piece.widgets = [{ id: "demo-countdown", type: "countdown", views: R(measured * 0.97), taps: 0, tap_sessions: 0, conversions: 0 }];
  } else if (link.format === "scratch") {
    piece.mechanic = "burn";
    piece.cta_text = "Usar cupom";
    const started = R(engaged * 0.855);
    const completed = R(started * 0.845);
    const revealClick = R(completed * 0.21);
    const coverClick = R(engaged * 0.18);
    const click = R(revealClick + coverClick * 0.94);
    Object.assign(steps, {
      scratch_started: started,
      scratch_completed: completed,
      scratch_reveal_click: revealClick,
      scratch_cover_click: coverClick,
      tilt_activated: 0,
      click,
      cta_click: click,
    });
    piece.scratch = {
      scratchedSessions: started,
      revealedSessions: completed,
      avgTimeToCompleteMs: 3800,
      ctaImage: R(revealClick * 0.94),
      ctaButton: R(revealClick * 0.06),
      ctaCover: R(coverClick * 1.02),
      tiltActivatedSessions: 0,
    };
    ctaClick = piece.scratch.ctaImage + piece.scratch.ctaButton + piece.scratch.ctaCover;
    clickSessions = click;
  } else {
    piece.cta_text = "Comprar agora";
    const click = R(engaged * 0.62);
    const locate = R(sessions * 0.0032);
    const found = R(locate * 0.89);
    const redirect = R(found * 0.19);
    Object.assign(steps, {
      click,
      cta_click: click,
      widget_view: R(vSess * 0.99),
      close_to_view: R(vSess * 0.99),
      close_to_locate: locate,
      close_to_found: found,
      close_to_redirect: redirect,
    });
    ctaClick = R(click * 1.08);
    clickSessions = click;
    piece.freeform = {
      ctaMedia: R(ctaClick * 0.94),
      ctaButton: ctaClick - R(ctaClick * 0.94),
      videoStart: 0, videoFirstQuartile: 0, videoMidpoint: 0, videoThirdQuartile: 0, videoComplete: 0, videoUnmute: 0,
    };
    const precise = R(found * 0.38);
    const scale = found / 1105;
    piece.widgets = [{
      id: "demo-close-to",
      type: "close_to",
      views: R(measured * 0.96),
      taps: R(locate * 1.05),
      tap_sessions: locate,
      conversions: R(redirect * 1.02),
    }];
    piece.close_to = {
      views: R(measured * 0.96),
      locate: R(locate * 1.05),
      locateSessions: locate,
      gpsGranted: R(locate * 0.36),
      gpsDenied: R(locate * 0.31),
      foundPrecise: precise,
      foundApprox: found - precise,
      foundSessions: found,
      redirects: R(redirect * 1.02),
      redirectMap: R(redirect * 0.79),
      redirectUrl: R(redirect * 0.23),
      redirectSessions: redirect,
      unresolvedIdentified: 0,
      unresolvedClicks: 0,
      addresses: CLOSE_TO_ADDRESSES.map(([name, address, lat, lng, identified, clicks, route, site]) => ({
        name,
        address,
        lat,
        lng,
        identified: R(identified * scale),
        clicks: R(clicks * scale),
        directions: R(route * scale),
        website: R(site * scale),
      })),
    };
  }

  const extra = piece.totals_extra || {};
  delete piece.totals_extra;
  piece.steps = steps;
  piece.totals = {
    impressionServed: served,
    impression: measured,
    viewable,
    uniqueSessions: sessions,
    engagedSessions: engaged,
    ctaClick,
    pinClick,
    mapInteraction: extra.mapInteraction || 0,
    overlayDismissed: extra.overlayDismissed || 0,
    overlayClick: extra.overlayClick || 0,
    splitCreativeClick: 0,
    clicksTotal: ctaClick + pinClick,
    clickSessions,
  };
  const engPerImp = engaged / Math.max(1, measured);
  const ctaPerImp = ctaClick / Math.max(1, measured);
  piece.daily = days.map((d) => ({
    date: d.date,
    impressions: d.measured,
    viewable: R(d.measured * p.view),
    pin_clicks: R(d.measured * dailyPinRate),
    cta_clicks: R(d.measured * ctaPerImp * jitter(`${link.creative_id}|cta|${d.date}`, 0.8, 1.2)),
    engaged_sessions: R(d.measured * engPerImp * jitter(`${link.creative_id}|eng|${d.date}`, 0.8, 1.2)),
  }));
  return piece;
}

/**
 * Resposta de `ma_report` para o DEMO. `from`/`to` em YYYY-MM-DD (opcionais).
 */
export function buildDemoMaReport({ from = null, to = null, today = new Date() } = {}) {
  const payload = buildDemoPayload(today);
  const detail = payload.detail || [];
  const dates = [...new Set((payload.daily || []).map((r) => r.date))]
    .filter((d) => inRange(d, from, to))
    .sort();
  const pieces = DEMO_MA_LINKS.map((link) => buildPiece(link, dailyMeasured(link, detail, dates)));
  return {
    configured: true,
    links: DEMO_MA_LINKS,
    pieces,
    errors: [],
    fetched_at: new Date(today.getTime() - 4 * 60000).toISOString(),
  };
}
