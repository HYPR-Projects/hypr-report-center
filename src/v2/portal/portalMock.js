// src/v2/portal/portalMock.js
//
// Mock do payload do Portal do Cliente (dashboard central client-facing).
//
// Espelha o formato que o backend vai devolver em `?action=client_portal_data`
// — SÓ campos client-safe (nada de custo real, margem, tech cost, rentabilidade,
// ECPM admin). A página agrega os big numbers a partir de `campaigns`, então a
// fiação com o backend depois é só trocar este import por um fetch.
//
// Campos por campanha = subconjunto seguro do mesmo shape de listCampaigns():
//   short_token, share_id, campaign_name, start_date, end_date,
//   d_client_budget (+ v_client_budget) → investido,
//   viewable_impressions, clicks, completions, ctr, vtr, media (tags)
//
// O logo vem como data-URL (base64) no payload real; aqui deixo null pra
// exercitar o fallback de monograma. Troque por uma data-URL pra ver co-branded.

// share_id reservado do protótipo: quando a rota /c/<id> usa este id, a página
// curto-circuita pro mock (sem backend, sem senha) — afordância de dev, igual
// ao DEMO token do report. Qualquer outro share_id faz o fluxo real (fetch +
// senha).
export const MOCK_SHARE_ID = "kQ8vN2mLpR4dXz0A";

export const PORTAL_MOCK = {
  client: {
    slug: "picpay",
    share_id: MOCK_SHARE_ID,
    display_name: "PicPay",
    // data-URL do logo do cliente (PNG/SVG base64). null → monograma.
    logo_base64: null,
    // cor de marca do cliente — re-tematiza acentos da página inteira.
    accent_color: "#21C25E", // verde PicPay
  },
  campaigns: [
    {
      short_token: "PPAY01",
      share_id: "kQ8vN2mLpR4dXz0A",
      campaign_name: "PicPay · Always On Maio — Conversão",
      start_date: "2026-05-01",
      end_date: "2026-05-31",
      d_client_budget: 180000,
      v_client_budget: 120000,
      viewable_impressions: 24_850_000,
      clicks: 196_300,
      completions: 4_120_000,
      ctr: 0.79,
      vtr: 88.4,
      media: ["DISPLAY", "VIDEO"],
      tactics: ["O2O", "GROUNDFLOW"],
      display_pacing: 102,
      video_pacing: 95,
    },
    {
      short_token: "PPAY02",
      share_id: "8sLm0pQ2vNkR4dXa",
      campaign_name: "PicPay · Cashback Day — Awareness",
      start_date: "2026-05-08",
      end_date: "2026-05-22",
      d_client_budget: 95000,
      v_client_budget: 0,
      viewable_impressions: 11_200_000,
      clicks: 74_500,
      completions: 0,
      ctr: 0.66,
      vtr: null,
      media: ["DISPLAY"],
      tactics: ["O2O"],
      display_pacing: 88,
      video_pacing: null,
    },
    {
      short_token: "PPAY03",
      share_id: "mLpR4dXz0AkQ8vN2",
      campaign_name: "PicPay · Crédito Pessoal — Performance",
      start_date: "2026-05-15",
      end_date: "2026-06-15",
      d_client_budget: 140000,
      v_client_budget: 60000,
      viewable_impressions: 18_900_000,
      clicks: 151_200,
      completions: 1_980_000,
      ctr: 0.80,
      vtr: 84.1,
      media: ["DISPLAY", "VIDEO"],
      tactics: ["O2O"],
      display_pacing: 110,
      video_pacing: 92,
    },
    {
      short_token: "PPAY04",
      share_id: "vNkR4dXa8sLm0pQ2",
      campaign_name: "PicPay · Lançamento Cartão — Branding",
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      d_client_budget: 220000,
      v_client_budget: 280000,
      viewable_impressions: 31_400_000,
      clicks: 188_900,
      completions: 6_750_000,
      ctr: 0.60,
      vtr: 91.2,
      media: ["DISPLAY", "VIDEO"],
      tactics: ["O2O", "OOH", "GROUNDFLOW"],
      display_pacing: 97,
      video_pacing: 99,
    },
    {
      short_token: "PPAY05",
      share_id: "dXz0AkQ8vN2mLpR4",
      campaign_name: "PicPay · Seguro Celular — Conversão",
      start_date: "2026-06-05",
      end_date: "2026-06-25",
      d_client_budget: 70000,
      v_client_budget: 0,
      viewable_impressions: 8_650_000,
      clicks: 62_100,
      completions: 0,
      ctr: 0.72,
      vtr: null,
      media: ["DISPLAY"],
      tactics: ["O2O"],
      display_pacing: 75,
      video_pacing: null,
    },
    {
      short_token: "PPAY06",
      share_id: "pQ2vNkR4dXa8sLm0",
      campaign_name: "PicPay · Black Friday Teaser — Awareness",
      start_date: "2026-04-10",
      end_date: "2026-04-30",
      d_client_budget: 60000,
      v_client_budget: 90000,
      viewable_impressions: 14_300_000,
      clicks: 71_500,
      completions: 2_410_000,
      ctr: 0.50,
      vtr: 86.7,
      media: ["DISPLAY", "VIDEO"],
      tactics: ["OOH", "GROUNDFLOW"],
      display_pacing: 120,
      video_pacing: 84,
    },
    {
      short_token: "PPAY07",
      share_id: "R4dXa8sLm0pQ2vNk",
      campaign_name: "PicPay · Invista no PicPay — Performance",
      start_date: "2026-04-01",
      end_date: "2026-04-28",
      d_client_budget: 110000,
      v_client_budget: 40000,
      viewable_impressions: 16_750_000,
      clicks: 142_300,
      completions: 1_320_000,
      ctr: 0.85,
      vtr: 82.5,
      media: ["DISPLAY", "VIDEO"],
      tactics: ["O2O", "GROUNDFLOW"],
      display_pacing: 93,
      video_pacing: 101,
    },
  ],
  // Brand lift mensal agregado (mock). Em produção vem do endpoint lazy
  // ?action=client_portal_brand_lift. Shape: {month, liftRel(%), liftAbs(pp),
  // surveyTypes[], surveyCount}. NUNCA expõe contagem de respostas.
  brandLift: {
    has_survey: true,
    months: [
      { month: "2026-04", liftRel: 9.3, liftAbs: 6.1, surveyTypes: ["Awareness", "Intenção"], surveyCount: 2 },
      { month: "2026-05", liftRel: 12.7, liftAbs: 8.4, surveyTypes: ["Consideração", "Ad Recall"], surveyCount: 3 },
      { month: "2026-06", liftRel: 15.2, liftAbs: 10.3, surveyTypes: ["Awareness", "Intenção", "Ad Recall"], surveyCount: 3 },
    ],
  },
};
