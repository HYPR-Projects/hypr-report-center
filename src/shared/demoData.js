// src/shared/demoData.js
//
// Payload sintético para o report demo (`/report/DEMO`) usado em
// apresentações comerciais. Roda 100% no browser — não toca BigQuery,
// não cria registros no backend, não consome Typeform.
//
// Estratégia
// ----------
// `getCampaign("DEMO")` em `lib/api.js` faz short-circuit antes do
// fetch e devolve `buildDemoPayload()` direto. O dashboard renderiza
// como se fosse uma campanha de verdade — todas as abas (Visão Geral,
// Display, Video, Base, RMND, PDOOH, Survey, Loom) ficam preenchidas.
//
// Cenário do demo
// ---------------
// Cliente fictício "Cliente Demo" com campanha "Lançamento Verão 2026
// — Always On". Mid-flight: 30 dias rodados de 60 totais. Pacing
// levemente positivo (105-110%) pra mostrar rentabilidade > 0 sem
// parecer absurdo. Quatro frentes contratadas (Display+Video, O2O+OOH).
//
// Determinismo
// ------------
// Todas as datas são derivadas a partir de `today()` no momento da
// chamada — assim o demo "envelhece" junto com o calendário e nunca
// fica preso em datas antigas. Distribuição diária usa um RNG seedado
// pelo dia do ano, então o número de impressões/dia varia de forma
// realista mas estável dentro do mesmo dia (cliente vê o mesmo número
// se recarregar a página).

export const DEMO_TOKEN = "DEMO";

export function isDemoToken(token) {
  return typeof token === "string" && token.toUpperCase() === DEMO_TOKEN;
}

// ─── Helpers de data ───────────────────────────────────────────────────

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function dateRange(startStr, endStr) {
  const out = [];
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) out.push(ymd(d));
  return out;
}

// PRNG mulberry32 — seedado pelo `date|key` pra ter ruído determinístico
// (mesmo input → mesmo output) sem repetição visível ao olho.
function seededRand(seed) {
  let t = seed + 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function noise(date, key, low = 0.85, high = 1.15) {
  const r = seededRand(hashStr(`${date}|${key}`));
  return low + r * (high - low);
}

// ─── Configuração da campanha demo ─────────────────────────────────────
//
// Datas relativas a "hoje" — campanha fica sempre mid-flight. Hoje
// está no dia 31 de 60 → 50% do tempo decorrido, entrega ~108%.
function buildCampaignDates(today = new Date()) {
  const start = addDays(today, -30);
  const end = addDays(today, 29);
  return { start: ymd(start), end: ymd(end) };
}

// Plano contratado por frente. Budget total = 250k.
//   Display O2O:  4.0M imp + 400k bonus  · CPM 25.00 · R$ 100.000
//   Display OOH:  1.5M imp + 150k bonus  · CPM 30.00 · R$  45.000
//   Video O2O:    500k cmp +  50k bonus  · CPCV 0.12 · R$  60.000
//   Video OOH:    250k cmp +  25k bonus  · CPCV 0.18 · R$  45.000
const PLAN = {
  o2o_display: {
    contracted: 4_000_000,
    bonus:        400_000,
    cpm:               25,
  },
  ooh_display: {
    contracted: 1_500_000,
    bonus:        150_000,
    cpm:               30,
  },
  o2o_video: {
    contracted:   500_000,
    bonus:         50_000,
    cpcv:            0.12,
  },
  ooh_video: {
    contracted:   250_000,
    bonus:         25_000,
    cpcv:            0.18,
  },
};

// Multiplicador de entrega vs esperado linear — controla o pacing por
// frente. Um pouco acima de 1 → over-delivery → rentabilidade > 0.
const DELIVERY_MULT = {
  o2o_display: 1.08,
  ooh_display: 1.05,
  o2o_video:   1.10,
  ooh_video:   1.06,
};

// Audiências por frente — geram os line_names (extractAudience pega o
// segundo-último token do split por "_"). Distribuído pra dar variedade
// no chart "Por Audiência".
const AUDIENCES = {
  o2o_display: ["Premium", "Lifestyle", "Bargain"],
  ooh_display: ["Cobertura", "Awareness"],
  o2o_video:   ["Lookalike", "Interesse"],
  ooh_video:   ["Cobertura"],
};

// Creative sizes/names — cada line tem 1-2 creatives.
const CREATIVES_DISPLAY = [
  { size: "300x250", name: "300x250_Verao_v1" },
  { size: "728x90",  name: "728x90_Verao_v1"  },
  { size: "320x50",  name: "320x50_Verao_v1"  },
];
const CREATIVES_VIDEO = [
  { size: "1920x1080", name: "InStream_15s_v1" },
  { size: "1920x1080", name: "InStream_30s_v1" },
];
const CREATIVES_DOOH = [
  { size: "1080x1920", name: "DOOH_Vertical_15s" },
];

// ─── Builders por frente ───────────────────────────────────────────────

function buildTotalsForFront({ tactic, media, totalDays, elapsedDays }) {
  const isVideo = media === "VIDEO";
  const isO2O = tactic === "O2O";
  const planKey = `${tactic.toLowerCase()}_${isVideo ? "video" : "display"}`;
  const plan = PLAN[planKey];
  const mult = DELIVERY_MULT[planKey];

  const negotiated = plan.contracted + plan.bonus;
  const budgetTotal = isVideo
    ? plan.contracted * plan.cpcv
    : plan.contracted * plan.cpm / 1000;

  // Entregue até hoje: linear * mult
  const elapsedRatio = totalDays > 0 ? elapsedDays / totalDays : 0;
  const denom = Math.round(negotiated * elapsedRatio * mult);

  // Display: o "negociado" é em viewable_impressions, então `denom` = viewable.
  //   impressions = viewable / viewability (80%).
  // Vídeo:   o "negociado" é em completions (views_100% viewable), então
  //   `denom` = completions. viewable_impressions é o universo viável; VTR
  //   = completions/viewable ~78%, ou seja viewable = completions / 0.78.
  //   impressions = viewable / 0.80 (viewability).
  const viewability = 0.80;
  const VTR = 0.78; // completions/viewable_impressions para video
  let impressions, viewable, completions;
  if (isVideo) {
    completions = denom;
    viewable    = Math.round(completions / VTR);
    impressions = Math.round(viewable / viewability);
  } else {
    viewable    = denom;
    impressions = Math.round(viewable / viewability);
    completions = 0;
  }

  const clicks = isVideo ? 0 : Math.round(viewable * (isO2O ? 0.0061 : 0.0048));
  // video_starts ≈ completions / 0.92 (taxa de conclusão saudável)
  const videoStarts = isVideo ? Math.round(completions / 0.92) : 0;

  // Budget proporcional ao período decorrido.
  const budgetProp = budgetTotal * elapsedRatio;
  const expectedDelivered = negotiated * elapsedRatio;

  // CPM/CPCV efetivo: trava no negociado se entregou MENOS que esperado;
  // cai abaixo (rentab > 0) se entregou MAIS. Mesma lógica do backend.
  const denomCmp = isVideo ? completions : viewable;
  const over = denomCmp > expectedDelivered;
  let cpmEf = 0;
  let cpcvEf = 0;
  let rentab = 0;
  if (isVideo) {
    if (over && completions > 0) {
      cpcvEf = budgetProp / completions;
      rentab = (plan.cpcv - cpcvEf) / plan.cpcv * 100;
    } else {
      cpcvEf = plan.cpcv;
    }
  } else {
    if (over && viewable > 0) {
      cpmEf = (budgetProp / viewable) * 1000;
      rentab = (plan.cpm - cpmEf) / plan.cpm * 100;
    } else {
      cpmEf = plan.cpm;
    }
  }

  // Custo efetivo: quanto realmente custou pelo CPM/CPCV efetivo.
  const effectiveTotalCost = isVideo
    ? cpcvEf * completions
    : cpmEf * viewable / 1000;

  // Custo "com over" = valor a faturar no CPM/CPCV negociado (limita
  // pelo contrato). Aqui usamos o negociado vezes a entrega total.
  const costWithOver = isVideo
    ? completions * plan.cpcv
    : viewable / 1000 * plan.cpm;

  // Pacing canônico HYPR: entregue / esperado * 100
  const pacing = expectedDelivered > 0 ? (denomCmp / expectedDelivered) * 100 : 0;

  // Compõe os campos contratados/bonus em todas as frentes (denormalizado
  // — o frontend lê de rows[0] independente da frente).
  const contractFields = {
    o2o_display_budget:                 PLAN.o2o_display.contracted * PLAN.o2o_display.cpm / 1000,
    ooh_display_budget:                 PLAN.ooh_display.contracted * PLAN.ooh_display.cpm / 1000,
    o2o_video_budget:                   PLAN.o2o_video.contracted   * PLAN.o2o_video.cpcv,
    ooh_video_budget:                   PLAN.ooh_video.contracted   * PLAN.ooh_video.cpcv,
    contracted_o2o_display_impressions: PLAN.o2o_display.contracted,
    contracted_ooh_display_impressions: PLAN.ooh_display.contracted,
    contracted_o2o_video_completions:   PLAN.o2o_video.contracted,
    contracted_ooh_video_completions:   PLAN.ooh_video.contracted,
    bonus_o2o_display_impressions:      PLAN.o2o_display.bonus,
    bonus_ooh_display_impressions:      PLAN.ooh_display.bonus,
    bonus_o2o_video_completions:        PLAN.o2o_video.bonus,
    bonus_ooh_video_completions:        PLAN.ooh_video.bonus,
  };

  const ctr = viewable > 0 ? (clicks / viewable) * 100 : 0;
  const cpc = clicks > 0 ? effectiveTotalCost / clicks : 0;
  const vtr = viewable > 0 ? (completions / viewable) * 100 : 0;

  return {
    tactic_type: tactic,
    media_type: media,
    total_invested: budgetTotal,
    deal_cpm_amount: isVideo ? 0 : plan.cpm,
    deal_cpcv_amount: isVideo ? plan.cpcv : 0,
    effective_cpm_amount: round4(cpmEf),
    effective_cpcv_amount: round4(cpcvEf),
    impressions,
    viewable_impressions: viewable,
    clicks,
    completions,
    effective_total_cost: round2(effectiveTotalCost),
    effective_cost_with_over: round2(costWithOver),
    ctr: round4(ctr),
    cpc: round4(cpc),
    vtr: round4(vtr),
    pacing: round4(pacing),
    rentabilidade: round4(rentab),
    actual_start_date: null, // preenchido no master loop com a data real
    days_with_delivery: 0,   // idem
    viewable_video_view_100_complete: completions,
    video_starts: videoStarts,
    ...contractFields,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ─── Daily / Detail ────────────────────────────────────────────────────
//
// Distribui o agregado da frente por dia + creative com ruído determinístico.
// A soma dos diários = total da frente (com tolerância de arredondamento).

function buildDailyAndDetail({ totals, dates, today }) {
  const daily = [];
  const detail = [];
  const todayStr = ymd(today);

  for (const t of totals) {
    const tactic = t.tactic_type;
    const media = t.media_type;
    const isVideo = media === "VIDEO";
    const planKey = `${tactic.toLowerCase()}_${isVideo ? "video" : "display"}`;
    const audiences = AUDIENCES[planKey];
    const creatives = isVideo
      ? (tactic === "OOH" ? CREATIVES_DOOH : CREATIVES_VIDEO)
      : CREATIVES_DISPLAY;

    // Só conta dias até hoje (inclusive). Dias futuros não têm entrega.
    const deliveryDates = dates.filter((d) => d <= todayStr);

    // Pesos por dia: base 1.0 + ruído + leve queda fim-de-semana.
    const weights = deliveryDates.map((d) => {
      const dt = new Date(d + "T00:00:00");
      const dow = dt.getDay(); // 0=dom 6=sab
      const wkndPenalty = (dow === 0 || dow === 6) ? 0.85 : 1.0;
      return noise(d, `${planKey}-day`, 0.92, 1.08) * wkndPenalty;
    });
    const wSum = weights.reduce((a, b) => a + b, 0) || 1;

    // Distribui cada métrica
    const metrics = [
      ["impressions",          t.impressions],
      ["viewable_impressions", t.viewable_impressions],
      ["clicks",               t.clicks],
      ["video_starts",         t.video_starts],
      ["video_view_100",       t.completions],
    ];

    deliveryDates.forEach((date, i) => {
      const ratio = weights[i] / wSum;
      const dayRow = {
        date,
        media_type: media,
        tactic_type: tactic,
        impressions:          0,
        viewable_impressions: 0,
        clicks:               0,
        video_starts:         0,
        video_view_100:       0,
        effective_total_cost: 0,
      };
      for (const [k, total] of metrics) {
        dayRow[k] = Math.max(0, Math.round(total * ratio));
      }
      // Custo diário aproximado: proporcional à entrega (viewable ou completions)
      const denomDay = isVideo ? dayRow.video_view_100 : dayRow.viewable_impressions;
      const denomTotal = isVideo ? t.completions : t.viewable_impressions;
      dayRow.effective_total_cost = denomTotal > 0
        ? round2(t.effective_total_cost * denomDay / denomTotal)
        : 0;
      dayRow.ctr = dayRow.viewable_impressions > 0
        ? round4(dayRow.clicks / dayRow.viewable_impressions * 100)
        : 0;
      dayRow.vtr = dayRow.viewable_impressions > 0
        ? round4(dayRow.video_view_100 / dayRow.viewable_impressions * 100)
        : 0;
      daily.push(dayRow);
    });

    // ─── Detail rows: por (date, line_name, creative) ─────────────────
    // Pesos por audiência (line) × creative.
    const lineWeights = audiences.map((aud) =>
      noise(aud, `${planKey}-aud`, 0.6, 1.4),
    );
    const lwSum = lineWeights.reduce((a, b) => a + b, 0) || 1;

    audiences.forEach((aud, ai) => {
      const lineShare = lineWeights[ai] / lwSum;
      const lineName = `DEMO_${tactic}_${aud}_${isVideo ? "VIDEO" : "DISPLAY"}`;

      // Subdivide entre creatives
      const usedCreatives = creatives.slice(0, audiences.length === 1 ? creatives.length : Math.min(creatives.length, 2));
      const cWeights = usedCreatives.map((c) =>
        noise(c.name, `${planKey}-${aud}-cre`, 0.7, 1.3),
      );
      const cwSum = cWeights.reduce((a, b) => a + b, 0) || 1;

      usedCreatives.forEach((cre, ci) => {
        const credShare = (cWeights[ci] / cwSum) * lineShare;

        deliveryDates.forEach((date, di) => {
          const dayRatio = weights[di] / wSum;
          const overall = dayRatio * credShare;
          const impressions          = Math.max(0, Math.round(t.impressions          * overall));
          const viewable             = Math.max(0, Math.round(t.viewable_impressions * overall));
          const clicks               = Math.max(0, Math.round(t.clicks               * overall));
          const completions          = Math.max(0, Math.round(t.completions          * overall));
          const videoStarts          = Math.max(0, Math.round(t.video_starts         * overall));

          // Funil de video: 25/50/75/100 com retenção decrescente realista.
          const v25 = isVideo ? Math.round(completions * 1.45) : 0;
          const v50 = isVideo ? Math.round(completions * 1.25) : 0;
          const v75 = isVideo ? Math.round(completions * 1.10) : 0;

          const denomTotal = isVideo ? t.completions : t.viewable_impressions;
          const denomCre   = isVideo ? completions   : viewable;
          const cost = denomTotal > 0
            ? round2(t.effective_total_cost * denomCre / denomTotal)
            : 0;

          if (impressions === 0 && viewable === 0 && completions === 0) return;

          detail.push({
            date,
            campaign_name: "Lançamento Verão 2026 — Always On",
            line_name: lineName,
            creative_name: cre.name,
            creative_size: cre.size,
            media_type: media,
            tactic_type: tactic,
            impressions,
            viewable_impressions: viewable,
            clicks,
            video_starts: videoStarts,
            video_view_25: v25,
            video_view_50: v50,
            video_view_75: v75,
            video_view_100: completions,
            effective_cpm_amount: viewable > 0 ? round2(cost / viewable * 1000) : 0,
            effective_total_cost: cost,
            ctr: viewable > 0 ? round4(clicks / viewable * 100) : 0,
          });
        });
      });
    });

    // Atualiza actual_start_date / days_with_delivery do total
    t.actual_start_date = deliveryDates[0] || null;
    t.days_with_delivery = deliveryDates.length;
  }

  daily.sort((a, b) => a.date.localeCompare(b.date));
  detail.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.media_type.localeCompare(b.media_type) ||
    a.creative_name.localeCompare(b.creative_name),
  );

  return { daily, detail };
}

// ─── RMND (Amazon Ads · formato amazon-ads-2026 V2) ────────────────────
// Schema espelhado do RmndUploadModal — admin sobe relatório do Amazon
// Ads Console e o front filtra/persiste no shape canônico { date,
// adProduct, campaign, adGroup, asin, sku, productName, purchases,
// sales, units, atc, ctSales, vtSales }. NÃO contém impressões/spend/
// cliques (decisão de produto).
function buildRmnd(today) {
  const start = addDays(today, -30);
  const dates = dateRange(ymd(start), ymd(today));
  // 2 grupos Sponsored Products + 1 grupo DSP — combinação realista
  // que o relatório Amazon entrega numa campanha mid-funnel.
  const adGroups = [
    {
      adProduct: "Sponsored Products",
      campaign:  "DEMO_Lancamento_Verao_2026",
      adGroup:   "DEMO_Lancamento_Verao_Hero",
      ctShare:   0.96, // SP é quase tudo CT
      products: [
        { asin: "B07ZRY5Q16", productName: "Demo Solar Protetor Antioxidante FPS 50, 60ml" },
        { asin: "B0954R6FNH", productName: "Demo Hidratante Facial Antiidade, 30ml" },
        { asin: "B085CZ2F4J", productName: "Demo Sérum Vitamina C 10% Concentrado, 30ml" },
      ],
      ticketBase: 95,
      atcBase: 28,
      purchasesBase: 12,
    },
    {
      adProduct: "Sponsored Products",
      campaign:  "DEMO_Lancamento_Verao_2026",
      adGroup:   "DEMO_Lancamento_Verao_Crossell",
      ctShare:   0.95,
      products: [
        { asin: "B0CMW43F8H", productName: "Demo Pós-sol Hidratante Calmante, 200ml" },
        { asin: "B09D8X2QYZ", productName: "Demo Loção Corporal Reparadora Pós-Sol, 400ml" },
      ],
      ticketBase: 70,
      atcBase: 18,
      purchasesBase: 7,
    },
    {
      adProduct: "Amazon DSP",
      campaign:  "DEMO_Lancamento_Verao_2026_DSP",
      adGroup:   "DEMO_Display_Audience_Awareness",
      ctShare:   0.42, // DSP costuma ter mais venda view-through
      products: [
        { asin: "B07ZRY5Q16", productName: "Demo Solar Protetor Antioxidante FPS 50, 60ml" },
        { asin: "B0954R6FNH", productName: "Demo Hidratante Facial Antiidade, 30ml" },
      ],
      ticketBase: 110,
      atcBase: 22,
      purchasesBase: 4,
    },
  ];

  const rows = [];
  for (const date of dates) {
    for (const g of adGroups) {
      // Distribui as compras do dia entre os produtos do grupo de forma
      // estável (PRNG seedado pela data+grupo+asin)
      const dayPurchases = Math.max(0, Math.round(g.purchasesBase * noise(`${date}|${g.adGroup}`, "buy", 0.6, 1.45)));
      const dayAtc       = Math.max(dayPurchases, Math.round(g.atcBase * noise(`${date}|${g.adGroup}`, "atc", 0.7, 1.35)));
      // Reparte por produto
      const weights = g.products.map((p, i) => noise(`${date}|${g.adGroup}|${p.asin}`, `w${i}`, 0.6, 1.4));
      const wSum = weights.reduce((s, x) => s + x, 0);
      g.products.forEach((p, i) => {
        const share = weights[i] / wSum;
        const purchases = Math.round(dayPurchases * share);
        const atc       = Math.round(dayAtc * share);
        const units     = Math.max(purchases, Math.round(purchases * noise(`${date}|${p.asin}`, "u", 1.0, 1.6)));
        const ticket    = g.ticketBase * noise(`${date}|${p.asin}`, "t", 0.85, 1.18);
        const sales     = round2(purchases * ticket);
        const ctSales   = round2(sales * g.ctShare);
        const vtSales   = round2(sales - ctSales);
        // Pula linhas zeradas pra deixar o dataset mais realista
        if (purchases === 0 && atc === 0 && sales === 0) return;
        rows.push({
          date,
          adProduct: g.adProduct,
          campaign: g.campaign,
          adGroup: g.adGroup,
          asin: p.asin,
          sku: p.asin,
          productName: p.productName,
          purchases,
          sales,
          units,
          atc,
          ctSales,
          vtSales,
        });
      });
    }
  }

  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];

  return {
    version: 2,
    type: "RMND",
    format: "amazon-ads-2026",
    uploadedAt: new Date().toISOString(),
    sourceFileName: "DEMO_AmazonAds_Report.csv",
    filters: {
      adGroups: adGroups.map((g) => g.adGroup),
      dateRange: { from: minDate, to: maxDate },
    },
    rows,
  };
}

// ─── PDOOH ─────────────────────────────────────────────────────────────
function buildPdooh(today) {
  const start = addDays(today, -30);
  const dates = dateRange(ymd(start), ymd(today));
  // 8 capitais com lat/lng aproximadas
  const cities = [
    { city: "São Paulo",      lat: -23.5505, lng: -46.6333, weight: 3.0 },
    { city: "Rio de Janeiro", lat: -22.9068, lng: -43.1729, weight: 2.0 },
    { city: "Belo Horizonte", lat: -19.9167, lng: -43.9345, weight: 1.4 },
    { city: "Brasília",       lat: -15.7939, lng: -47.8828, weight: 1.2 },
    { city: "Curitiba",       lat: -25.4284, lng: -49.2733, weight: 1.0 },
    { city: "Porto Alegre",   lat: -30.0346, lng: -51.2177, weight: 1.0 },
    { city: "Salvador",       lat: -12.9777, lng: -38.5016, weight: 1.1 },
    { city: "Fortaleza",      lat:  -3.7172, lng: -38.5433, weight: 0.9 },
  ];
  const owners = ["EletroMidia", "Clear Channel", "Otima"];
  const formats = ["DOOH Indoor", "DOOH Street", "DOOH Mall"];

  const rows = [];
  for (const date of dates) {
    for (const c of cities) {
      for (let oi = 0; oi < owners.length; oi++) {
        const seed = `pdooh|${date}|${c.city}|${owners[oi]}`;
        const r = noise(seed, "imp", 0.7, 1.3);
        const impressions = Math.round(8500 * c.weight * r);
        const plays = Math.round(impressions / noise(seed, "ratio", 18, 28));
        rows.push({
          DATE: date,
          CITY: c.city,
          MEDIA_OWNER: owners[oi],
          MEDIA_FORMAT: formats[oi % formats.length],
          IMPRESSIONS: impressions,
          PLAYS: plays,
          LATITUDE: c.lat + (seededRand(hashStr(seed)) - 0.5) * 0.04,
          LONGITUDE: c.lng + (seededRand(hashStr(seed + "x")) - 0.5) * 0.04,
        });
      }
    }
  }
  return {
    type: "PDOOH",
    rows,
    headers: ["DATE", "CITY", "MEDIA_OWNER", "MEDIA_FORMAT",
              "IMPRESSIONS", "PLAYS", "LATITUDE", "LONGITUDE"],
    uploadedAt: new Date().toISOString(),
  };
}

// ─── Survey (formato legacy — não precisa Typeform) ────────────────────
function buildSurvey() {
  // SurveyTab.jsx aceita formato legacy: { questions: [{label, control, exposed}] }
  // Lift positivo em todas as métricas pra mostrar bem em apresentação.
  const survey = {
    nome: "Brand Lift — Lançamento Verão 2026",
    control_total: 1850,
    exposed_total: 2120,
    questions: [
      {
        label: "Você já ouviu falar da marca Demo?",
        control: { "Sim": 740,  "Não": 1110 },
        exposed: { "Sim": 1166, "Não":  954 },
      },
      {
        label: "Você se lembra de ter visto algum anúncio da marca Demo nos últimos 30 dias?",
        control: { "Sim": 296,  "Não": 1554 },
        exposed: { "Sim": 805,  "Não": 1315 },
      },
      {
        label: "Qual a sua intenção de compra de produtos da linha Verão 2026?",
        control: { "Vou comprar": 185, "Considero comprar": 555, "Não pretendo": 1110 },
        exposed: { "Vou comprar": 339, "Considero comprar": 763, "Não pretendo": 1018 },
      },
    ],
  };
  return JSON.stringify(survey);
}

// ─── Logo (SVG inline base64) ──────────────────────────────────────────
// Glifo + wordmark "DEMO" — claro que é demonstração, sem se fazer passar
// por uma marca real. Glifo com gradiente nos tons do brand HYPR pra
// integrar visualmente ao Report Center. `currentColor` no texto garante
// legibilidade tanto no tema light quanto no dark do dashboard.
const DEMO_LOGO_BASE64 =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 96" fill="none">` +
      `<defs>` +
        `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
          `<stop offset="0%" stop-color="#3397B9"/>` +
          `<stop offset="100%" stop-color="#1F6F8C"/>` +
        `</linearGradient>` +
      `</defs>` +
      // Glifo: card arredondado + losango interno com ponto central
      `<g transform="translate(8 16)">` +
        `<rect x="0" y="0" width="64" height="64" rx="14" fill="url(#g)"/>` +
        `<path d="M32 14 L48 32 L32 50 L16 32 Z" fill="#fff" opacity="0.95"/>` +
        `<circle cx="32" cy="32" r="6" fill="#3397B9"/>` +
      `</g>` +
      // Wordmark "DEMO"
      `<text x="92" y="50" font-family="Inter,Arial,sans-serif" font-size="32" ` +
        `font-weight="800" fill="currentColor" letter-spacing="4">DEMO</text>` +
      // Tagline
      `<text x="92" y="74" font-family="Inter,Arial,sans-serif" font-size="10" ` +
        `font-weight="600" fill="currentColor" opacity="0.55" letter-spacing="3">SAMPLE BRAND</text>` +
    `</svg>`,
  );

// ─── Master builder ────────────────────────────────────────────────────
export function buildDemoPayload(today = new Date()) {
  const { start, end } = buildCampaignDates(today);
  const dates = dateRange(start, end);
  const totalDays = dates.length;
  const todayStr = ymd(today);

  const elapsedDays = Math.max(
    0,
    Math.min(totalDays, dates.indexOf(todayStr) + 1),
  );

  const totals = [
    buildTotalsForFront({ tactic: "O2O", media: "DISPLAY", totalDays, elapsedDays }),
    buildTotalsForFront({ tactic: "OOH", media: "DISPLAY", totalDays, elapsedDays }),
    buildTotalsForFront({ tactic: "O2O", media: "VIDEO",   totalDays, elapsedDays }),
    buildTotalsForFront({ tactic: "OOH", media: "VIDEO",   totalDays, elapsedDays }),
  ];

  const { daily, detail } = buildDailyAndDetail({ totals, dates, today });

  const budgetContracted =
    PLAN.o2o_display.contracted * PLAN.o2o_display.cpm  / 1000 +
    PLAN.ooh_display.contracted * PLAN.ooh_display.cpm  / 1000 +
    PLAN.o2o_video.contracted   * PLAN.o2o_video.cpcv          +
    PLAN.ooh_video.contracted   * PLAN.ooh_video.cpcv;

  return {
    campaign: {
      short_token:       DEMO_TOKEN,
      client_name:       "Cliente Demo",
      campaign_name:     "Lançamento Verão 2026 — Always On",
      start_date:        start,
      end_date:          end,
      budget_contracted: budgetContracted,
      cpm_negociado:     (PLAN.o2o_display.cpm + PLAN.ooh_display.cpm) / 2,
      cpcv_negociado:    (PLAN.o2o_video.cpcv  + PLAN.ooh_video.cpcv)  / 2,
      updated_at:        new Date().toISOString(),
    },
    totals,
    daily,
    detail,
    logo:  DEMO_LOGO_BASE64,
    // Loom fica null no demo — vendedor pode plugar a URL específica do
    // pitch dele em modo admin sem precisar deployar nada novo. Tab some
    // pro cliente quando loom é null (ver showLoom em ClientDashboardV2).
    loom:  null,
    rmnd:  buildRmnd(today),
    pdooh: buildPdooh(today),
    survey: buildSurvey(),
    sheets_integration: null,
    merge_meta: null,
    // Alcance & Frequência — frequência fica vazia pra demonstrar o cálculo
    // derivado (impressões totais / alcance) no front. `alcance_updated_at`
    // anchorado no `today` pra envelhecer junto com o demo.
    alcance:            "1.250.000",
    frequencia:         "",
    alcance_updated_at: new Date(today.getTime() - 2 * 86400000).toISOString(),
  };
}
