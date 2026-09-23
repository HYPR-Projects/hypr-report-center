// src/shared/maMetrics.js
//
// Regras de leitura das peças Max Attention na aba do report. Puro (sem
// React), para testar com node --test.
//
// Três camadas, sempre separadas na tela:
//   Mídia  → entrega: impressões (DSP quando vinculada), medidas, viewability,
//            cliques em CTA. Mesma régua da aba Display.
//   Peça   → o que só o formato faz: funil em pessoas e quebras nativas.
//   Widget → componentes plugados na peça (Loja mais próxima, calendário...).
//
// Princípios que vêm da proposta aprovada:
//   • Funil sempre em PESSOAS (sessões distintas) e montado só com etapas
//     aninhadas, para descer sempre. Atalhos opcionais (clicar na capa antes
//     de raspar, clicar sem navegar) vão para os blocos de superfície.
//   • Impressão da DSP é o número principal quando a peça está ligada ao
//     criativo da DSP; as taxas usam a base medida pela peça.
//   • Nenhuma métrica se chama "atenção"; dwell fica de fora.

export const MA_FORMAT_ORDER = ["tap-to-map", "carrossel", "scratch", "freeform", "survey", "play", "adserver"];

export const MA_FORMATS = {
  "tap-to-map": { label: "Tap to Map", desc: "Mapa de lojas com pins, rota, WhatsApp e site" },
  carrossel: { label: "Tap to Carousel", desc: "Vitrine em slides, com swipe, setas e dots" },
  scratch: { label: "Tap to Reveal", desc: "Cobertura que a pessoa raspa, queima ou arrasta para revelar a oferta" },
  freeform: { label: "Free Form", desc: "Peça livre (imagem, HTML5 ou vídeo)" },
  survey: { label: "Tap to Choose", desc: "Pergunta com opções de resposta" },
  play: { label: "Tap to Game", desc: "Minijogo com o anúncio no fim da partida" },
  adserver: { label: "Creative Ad Server", desc: "Criativo padrão servido pela HYPR" },
};

export const MECHANIC_LABELS = {
  scratch: "Raspar",
  wipe: "Cortina",
  tilt: "Inclinar",
  burn: "Queimar",
  shoot: "Estilhaçar",
};

export const WIDGET_LABELS = {
  close_to: "Loja mais próxima",
  add_to_calendar: "Adicionar ao calendário",
  amazon_products: "Produtos Amazon",
  countdown: "Contagem regressiva",
  sports_score: "Placar esportivo",
  f1_race: "Fórmula 1",
};

/** Widgets só de exibição: não têm toque, só aparecem na peça. */
export const DISPLAY_ONLY_WIDGETS = new Set(["countdown", "sports_score", "f1_race"]);

export function formatLabel(slug) {
  return MA_FORMATS[slug]?.label || (slug ? String(slug) : "Formato");
}

export function widgetLabel(type) {
  return WIDGET_LABELS[type] || (type ? String(type).replace(/_/g, " ") : "Widget");
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ratio = (a, b) => (num(b) > 0 ? (num(a) / num(b)) * 100 : null);

// ─── Impressões da DSP por peça ─────────────────────────────────────────

const normName = (s) => String(s || "").trim().toLowerCase();

/**
 * Soma a entrega da DSP (detail do report) dos criativos ligados a cada
 * peça. `range` = { from, to } em YYYY-MM-DD (opcional; inclusivo).
 * Devolve Map creative_id → { impressions, viewable, clicks } só para as
 * peças com ao menos um nome de criativo da DSP casado.
 */
export function dspDeliveryByPiece(links, detail, range = null) {
  const out = new Map();
  if (!Array.isArray(links) || !Array.isArray(detail)) return out;
  const byName = new Map();
  for (const l of links) {
    for (const n of l?.dsp_creative_names || []) {
      const k = normName(n);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(l.creative_id);
    }
  }
  if (!byName.size) return out;
  const from = range?.from || null;
  const to = range?.to || null;
  for (const r of detail) {
    const ids = byName.get(normName(r?.creative_name));
    if (!ids) continue;
    const d = typeof r.date === "string" ? r.date.slice(0, 10) : null;
    if (from && d && d < from) continue;
    if (to && d && d > to) continue;
    for (const id of ids) {
      const e = out.get(id) || { impressions: 0, viewable: 0, clicks: 0 };
      e.impressions += num(r.impressions);
      e.viewable += num(r.viewable_impressions);
      e.clicks += num(r.clicks);
      out.set(id, e);
    }
  }
  return out;
}

// ─── Camada Mídia (comparável entre formatos) ───────────────────────────

/**
 * Métricas comparáveis de uma peça. `dsp` = entrega da DSP casada (ou null).
 * impressionsSource diz de onde veio o número principal:
 *   "dsp"      → entrega da DSP do criativo vinculado
 *   "served"   → carregamentos contados pela peça (≈ DSP)
 *   "measured" → impressões medidas (peça sem contagem de carregamento)
 */
export function pieceMedia(piece, dsp = null) {
  const t = piece?.totals || {};
  const measured = num(t.impression);
  const served = num(t.impressionServed);
  let impressions = measured;
  let impressionsSource = "measured";
  if (dsp && dsp.impressions > 0) {
    impressions = dsp.impressions;
    impressionsSource = "dsp";
  } else if (served > 0) {
    impressions = served;
    impressionsSource = "served";
  }
  return {
    impressions,
    impressionsSource,
    measured,
    viewable: num(t.viewable),
    viewability: ratio(t.viewable, measured),
    sessions: num(t.uniqueSessions),
    engaged: num(t.engagedSessions),
    engagement: ratio(t.engagedSessions, t.uniqueSessions),
    ctaClicks: num(t.ctaClick),
    ctr: ratio(t.ctaClick, measured),
    clickSessions: num(t.clickSessions),
  };
}

/** Soma da camada Mídia de várias peças (taxas recalculadas das somas). */
export function sumMedia(medias) {
  const acc = { impressions: 0, measured: 0, viewable: 0, sessions: 0, engaged: 0, ctaClicks: 0, clickSessions: 0 };
  const sources = new Set();
  for (const m of medias || []) {
    for (const k of Object.keys(acc)) acc[k] += num(m?.[k]);
    if (m?.impressionsSource) sources.add(m.impressionsSource);
  }
  return {
    ...acc,
    viewability: ratio(acc.viewable, acc.measured),
    engagement: ratio(acc.engaged, acc.sessions),
    ctr: ratio(acc.ctaClicks, acc.measured),
    impressionsSource: sources.size === 1 ? [...sources][0] : sources.size ? "mixed" : "measured",
  };
}

// ─── Camada Peça: funil em pessoas ──────────────────────────────────────

const step = (key, label, value, extra = {}) => ({ key, label, value: num(value), ...extra });

/**
 * Funil do formato em sessões distintas. Usa `piece.steps` (sessionSteps da
 * Platform); sem ele (lake indisponível), cai para as sessões dos totais
 * (engagedSessions, clickSessions), que também são pessoas.
 */
export function buildFunnel(piece) {
  const s = piece?.steps;
  const t = piece?.totals || {};
  if (!s) {
    return {
      source: "totals",
      steps: [
        step("viewable", "Viu a peça", t.viewable, { hint: "≥50% da peça na tela por 1 s" }),
        step("engaged", "Interagiu", t.engagedSessions),
        step("click", "Clicou", t.clickSessions),
      ],
      subs: [],
    };
  }
  const viewable = step("viewable", "Viu a peça", s.viewable, { hint: "≥50% da peça na tela por 1 s" });
  const fmt = piece?.format;
  let steps;
  let subs = [];
  if (fmt === "tap-to-map") {
    steps = [
      viewable,
      step("engaged", "Interagiu", s.engaged),
      step("click", "Clicou em pin ou CTA", s.click),
      step("cta_click", "Clicou em CTA", s.cta_click),
    ];
    subs = [
      step("cta_directions", "Como chegar", s.cta_directions),
      step("cta_whatsapp", "WhatsApp", s.cta_whatsapp),
      step("cta_website", "Site", s.cta_website),
    ].filter((x) => x.value > 0);
  } else if (fmt === "scratch") {
    const tilt = piece.mechanic === "tilt" && num(s.tilt_activated) > 0;
    steps = [
      viewable,
      tilt
        ? step("tilt_activated", "Ativou a inclinação", s.tilt_activated)
        : step("scratch_started", "Começou a revelar", s.scratch_started),
      step("scratch_completed", "Revelou", s.scratch_completed),
      step("scratch_reveal_click", "Clicou após revelar", s.scratch_reveal_click),
    ];
  } else if (fmt === "survey") {
    steps = [viewable, step("survey_answer", "Respondeu", s.survey_answer)];
    if (piece.survey_mode === "poll" || num(s.survey_complete) > 0) {
      steps.push(step("survey_complete", "Concluiu a pesquisa", s.survey_complete));
    } else {
      steps.push(step("click", "Clicou", s.click));
    }
  } else if (fmt === "play") {
    steps = [
      viewable,
      step("game_started", "Jogou", s.game_started),
      step("game_ended", "Terminou a partida", s.game_ended),
      step("brand_reveal_viewed", "Viu o anúncio", s.brand_reveal_viewed),
    ];
  } else if (fmt === "adserver") {
    steps = [viewable, step("click", "Clicou", s.click)];
  } else {
    // carrossel, freeform e formatos novos: Viu → Interagiu → Clicou. A
    // navegação do carrossel tem bloco próprio (dá pra clicar sem navegar).
    steps = [viewable, step("engaged", "Interagiu", s.engaged), step("click", "Clicou", s.click)];
  }
  return { source: "steps", steps, subs };
}

/**
 * Conversões etapa a etapa e a maior perda depois da visualização. Etapa
 * que não desce (dado fora de ordem) não recebe conversão nem vira "perda".
 */
export function funnelConversions(steps) {
  const rows = (steps || []).map((st, i) => {
    if (i === 0) return { ...st, conversion: null, ofBase: 100 };
    const prev = steps[i - 1].value;
    const conversion = prev > 0 && st.value <= prev ? (st.value / prev) * 100 : null;
    const ofBase = steps[0].value > 0 ? (st.value / steps[0].value) * 100 : null;
    return { ...st, conversion, ofBase };
  });
  let biggestDrop = null;
  for (let i = 2; i < rows.length; i++) {
    const prev = rows[i - 1].value;
    const drop = prev - rows[i].value;
    if (rows[i].conversion == null || prev <= 0) continue;
    if (!biggestDrop || drop > biggestDrop.drop) biggestDrop = { index: i, drop, from: rows[i - 1].label, to: rows[i].label };
  }
  return { rows, biggestDrop };
}

// ─── Métrica-chave do formato ───────────────────────────────────────────

/** Destaque de cada formato, para o comparativo e a galeria. */
export function keyMetric(piece) {
  const s = piece?.steps || {};
  const t = piece?.totals || {};
  const base = num(s.viewable) || num(t.viewable);
  switch (piece?.format) {
    case "tap-to-map": {
      const v = num(s.pin_click) || num(t.pinClick);
      return { label: "Clicaram em pin", value: v, kind: "count", pct: ratio(v, base) };
    }
    case "scratch": {
      const started = piece.mechanic === "tilt" && num(s.tilt_activated) > 0 ? s.tilt_activated : s.scratch_started;
      const started2 = num(started) || num(piece.scratch?.scratchedSessions);
      const done = num(s.scratch_completed) || num(piece.scratch?.revealedSessions);
      return { label: "Revelaram, de quem começou", value: ratio(done, started2), kind: "pct" };
    }
    case "carrossel": {
      const nav = num(s.nav) || num(piece.carousel?.navSessions);
      return { label: "Navegaram nos slides", value: ratio(nav, base), kind: "pct" };
    }
    case "survey":
      return { label: "Taxa de resposta", value: ratio(num(s.survey_answer) || num(piece.survey?.answeredSessions), base), kind: "pct" };
    case "play":
      return { label: "Taxa de jogo", value: ratio(num(s.game_started) || num(piece.game?.playedSessions), base), kind: "pct" };
    case "freeform": {
      const ff = piece.freeform || {};
      if (num(ff.videoStart) > 0) {
        return { label: "Viram o vídeo até o fim", value: ratio(ff.videoComplete, ff.videoStart), kind: "pct" };
      }
      const w = (piece.widgets || []).find((x) => !DISPLAY_ONLY_WIDGETS.has(x.type) && num(x.views) > 0);
      if (w) return { label: "Taxa de toque do widget", value: ratio(w.taps, w.views), kind: "pct" };
      return { label: "CTR da peça", value: ratio(t.ctaClick, t.impression), kind: "pct" };
    }
    default:
      return { label: "CTR da peça", value: ratio(t.ctaClick, t.impression), kind: "pct" };
  }
}

// ─── Quebras nativas por formato (camada Peça) ──────────────────────────

const part = (label, value) => ({ label, value: num(value) });
const nonZero = (arr) => arr.filter((x) => x.value > 0);

/** Blocos de superfície/controle do formato, prontos para barras 100%. */
export function formatBreakdowns(piece) {
  const out = [];
  const s = piece?.steps || {};
  switch (piece?.format) {
    case "tap-to-map": {
      const byButton = piece.cta_by_button || {};
      const bySurface = piece.cta_by_surface || {};
      out.push({
        key: "cta_button",
        title: "CTA por botão",
        subtitle: "Qual ação a pessoa escolheu",
        unit: "cliques",
        parts: nonZero([part("Como chegar", byButton.directions), part("WhatsApp", byButton.whatsapp), part("Site", byButton.website)]),
      });
      out.push({
        key: "cta_surface",
        title: "CTA por superfície",
        subtitle: "Onde na peça o clique aconteceu",
        unit: "cliques",
        parts: nonZero([
          part("Card do pin", bySurface.pin_card),
          part("Loja mais próxima", bySurface.nearest_card),
          part("CTA global", bySurface.header),
          part("Capa", bySurface.overlay),
          part("Arte da peça", bySurface.split_creative),
        ]),
      });
      if (piece.steps) {
        out.push({
          key: "interactions",
          title: "Como as pessoas interagiram",
          subtitle: "Pessoas por ação (uma pessoa pode fazer mais de uma)",
          unit: "pessoas",
          list: true,
          parts: nonZero([
            part("Arrastou a capa", s.overlay_dismissed),
            part("Mexeu no mapa", s.map_interaction),
            part("Clicou em pin", s.pin_click),
            part("Clicou na capa", s.overlay_click),
            part("Clicou na arte", s.split_creative_click),
          ]),
        });
      }
      break;
    }
    case "scratch": {
      const sc = piece.scratch || {};
      out.push({
        key: "surface",
        title: "Cliques por superfície",
        subtitle: "Antes e depois de revelar",
        unit: "cliques",
        parts: nonZero([part("Capa (antes de revelar)", sc.ctaCover), part("Imagem revelada", sc.ctaImage), part("Botão", sc.ctaButton)]),
      });
      break;
    }
    case "carrossel": {
      const c = piece.carousel || {};
      const nav = c.nav_by_surface || {};
      out.push({
        key: "nav",
        title: "Navegação por controle",
        subtitle: "Trocas de slide por tipo de controle",
        unit: "trocas",
        parts: nonZero([part("Swipe", nav.swipe), part("Setas", nav.arrow), part("Dots", nav.dot)]),
      });
      out.push({
        key: "surface",
        title: "Cliques por superfície",
        unit: "cliques",
        parts: nonZero([part("No produto", c.ctaSlide), part("No botão", c.ctaButton), part("No fundo", c.ctaBackground)]),
      });
      break;
    }
    case "freeform": {
      const ff = piece.freeform || {};
      out.push({
        key: "surface",
        title: "Cliques por superfície",
        unit: "cliques",
        parts: nonZero([part("Na mídia", ff.ctaMedia), part("No botão", ff.ctaButton)]),
      });
      break;
    }
    case "survey": {
      const sv = piece.survey || {};
      out.push({
        key: "surface",
        title: "Cliques por superfície",
        unit: "cliques",
        parts: nonZero([
          part("Na recompensa", sv.ctaPayoff),
          part("No botão", sv.ctaButton),
          part("Na pergunta", sv.ctaQuestion),
          part("Em resposta com link", sv.ctaOption),
        ]),
      });
      break;
    }
    case "play": {
      const g = piece.game || {};
      out.push({
        key: "surface",
        title: "Cliques por superfície",
        unit: "cliques",
        parts: nonZero([part("Após a partida", g.ctaPostGame), part("No botão", g.ctaButton)]),
      });
      break;
    }
    default:
      break;
  }
  return out.filter((b) => b.parts.length > 0);
}

/** Funil de vídeo (marcos VAST, contados por impressão) quando houver vídeo. */
export function videoFunnel(piece) {
  const ff = piece?.freeform || {};
  if (num(ff.videoStart) <= 0) return null;
  return {
    steps: [
      step("start", "Deu play", ff.videoStart),
      step("q1", "25%", ff.videoFirstQuartile),
      step("mid", "50%", ff.videoMidpoint),
      step("q3", "75%", ff.videoThirdQuartile),
      step("complete", "Até o fim", ff.videoComplete),
    ],
    unmute: num(ff.videoUnmute),
  };
}

// ─── Camada Widget ──────────────────────────────────────────────────────

/** Leitura client-safe de cada widget da peça. */
export function widgetBlocks(piece) {
  const s = piece?.steps || {};
  const viewable = num(s.viewable) || num(piece?.totals?.viewable);
  return (piece?.widgets || []).map((w) => {
    const base = { id: w.id, type: w.type, label: widgetLabel(w.type), views: num(w.views) };
    if (DISPLAY_ONLY_WIDGETS.has(w.type)) {
      return { ...base, kind: "display", ofViewable: ratio(w.views, viewable) };
    }
    if (w.type === "close_to") {
      const ct = piece.close_to || {};
      const found = num(ct.foundPrecise) + num(ct.foundApprox);
      const approxShare = found > 0 ? (num(ct.foundApprox) / found) * 100 : null;
      const hasSteps = !!piece.steps && (num(s.close_to_view) > 0 || num(s.close_to_locate) > 0);
      const funnel = hasSteps
        ? [
            step("view", "Viu o widget", s.close_to_view),
            step("locate", "Tocou em encontrar", s.close_to_locate),
            step("found", "Endereço identificado", s.close_to_found),
            step("redirect", "Abriu rota ou site", s.close_to_redirect),
          ]
        : [
            step("view", "Viu o widget", ct.views || w.views),
            step("locate", "Tocou em encontrar", ct.locateSessions),
            step("found", "Endereço identificado", ct.foundSessions),
            step("redirect", "Abriu rota ou site", ct.redirectSessions),
          ];
      const addresses = (ct.addresses || [])
        .filter((a) => num(a.identified) > 0 || num(a.clicks) > 0)
        .map((a) => ({ ...a, conversion: ratio(a.clicks, a.identified) }))
        .sort((a, b) => num(b.identified) - num(a.identified) || num(b.clicks) - num(a.clicks));
      return {
        ...base,
        kind: "close_to",
        taps: num(w.taps),
        tapSessions: num(w.tap_sessions),
        conversions: num(w.conversions),
        tapRate: ratio(w.taps, w.views),
        funnel,
        precise: num(ct.foundPrecise),
        approx: num(ct.foundApprox),
        approxShare,
        approxWarning: approxShare != null && approxShare >= 50,
        redirectMap: num(ct.redirectMap),
        redirectUrl: num(ct.redirectUrl),
        addresses,
      };
    }
    if (w.type === "add_to_calendar") {
      const cal = piece.calendar || {};
      return {
        ...base,
        kind: "calendar",
        taps: num(w.taps) || num(cal.adds),
        opens: num(cal.opens) || num(w.conversions),
        tapRate: ratio(num(w.taps) || num(cal.adds), w.views),
      };
    }
    return {
      ...base,
      kind: "interactive",
      taps: num(w.taps),
      tapSessions: num(w.tap_sessions),
      conversions: num(w.conversions),
      tapRate: ratio(w.taps, w.views),
    };
  });
}

// ─── Série diária ──────────────────────────────────────────────────────

/**
 * Sessões engajadas por dia, uma coluna por formato (para o empilhado).
 * Devolve { rows: [{date, [format]: n}], formats: [slug] }.
 */
export function engagedByDayAndFormat(pieces) {
  const byDate = new Map();
  const formats = [];
  for (const p of pieces || []) {
    const f = p.format || "outros";
    if (!formats.includes(f)) formats.push(f);
    for (const d of p.daily || []) {
      if (!d?.date) continue;
      const row = byDate.get(d.date) || { date: d.date };
      row[f] = (row[f] || 0) + num(d.engaged_sessions);
      byDate.set(d.date, row);
    }
  }
  formats.sort((a, b) => orderOf(a) - orderOf(b));
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const r of rows) for (const f of formats) r[f] = r[f] || 0;
  return { rows, formats };
}

function orderOf(slug) {
  const i = MA_FORMAT_ORDER.indexOf(slug);
  return i < 0 ? MA_FORMAT_ORDER.length : i;
}

/**
 * Cor categórica de cada formato presente na campanha, em ordem fixa de
 * formato (nunca por ranking). Do 5º formato em diante, "Outros" (neutro).
 */
export function formatColorSlots(formats) {
  const present = [...new Set(formats || [])].sort((a, b) => orderOf(a) - orderOf(b));
  const out = {};
  present.forEach((f, i) => {
    out[f] = i < 4 ? `var(--color-chart-s${i + 1})` : "var(--color-fg-subtle)";
  });
  return out;
}

/** Agrupa peças por formato na ordem canônica. */
export function groupByFormat(pieces) {
  const groups = new Map();
  for (const p of pieces || []) {
    const f = p.format || "outros";
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(p);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => orderOf(a) - orderOf(b))
    .map(([format, items]) => ({ format, label: formatLabel(format), items }));
}

/** Peça sem nenhuma impressão medida no período. */
export function isWaiting(piece) {
  const t = piece?.totals || {};
  return num(t.impression) === 0 && num(t.impressionServed) === 0;
}

/** "Atualizado há 4 min" a partir do fetched_at do backend. */
export function relativeUpdated(iso, now = new Date()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (min < 1) return "Atualizado agora";
  if (min < 60) return `Atualizado há ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `Atualizado há ${h} h` : "Atualizado há mais de um dia";
}
