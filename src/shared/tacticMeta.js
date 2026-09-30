// src/shared/tacticMeta.js
//
// Táticas das lines (taxonomia de nomenclatura da HYPR). A classificação
// mora no backend (backend/dsp_analytics.py, TACTICS) pra que série, período
// anterior e lines saiam com a MESMA tática; aqui ficam só rótulo, ordem e cor.
//
// Cor: categórica em ordem fixa (paleta validada para daltonismo nos dois
// temas, ΔE CVD ≥ 8,4 entre vizinhas). Mais de 7 séries não ganham matiz
// gerado: Max Views, Premium e "sem tática" dobram em "Outras" no gráfico.
// Cor segue a tática, nunca a posição, então filtrar não repinta.

export const TACTIC_ORDER = [
  "tp_high", "tp_low", "tp", "premium_list", "max_viewable",
  "boost_cpm", "standard", "max_views", "premium", "none",
];

export const TACTIC_LABELS = {
  tp_high: "Top Performance High",
  tp_low: "Top Performance Low",
  tp: "Top Performance",
  premium_list: "Premium List",
  max_viewable: "Max Viewable",
  boost_cpm: "Boost CPM",
  standard: "Standard",
  max_views: "Max Views",
  premium: "Premium",
  none: "Sem tática",
};

// Bucket "Outras" do gráfico (8ª série, neutra).
export const TACTIC_OTHER = "other";
const CHART_OWN = new Set(["tp_high", "tp_low", "tp", "premium_list", "max_viewable", "boost_cpm", "standard"]);
export const chartTacticKey = (t) => (CHART_OWN.has(t) ? t : TACTIC_OTHER);

export const TACTIC_COLORS = {
  tp_high: "#3987e5",
  tp_low: "#d95926",
  tp: "#199e70",
  premium_list: "#c98500",
  max_viewable: "#d55181",
  boost_cpm: "#008300",
  standard: "#9085e9",
  [TACTIC_OTHER]: "#8a8f98",
};

export const TACTIC_DASH = {
  tp_high: undefined,
  tp_low: "7 4",
  tp: "2 3",
  premium_list: "10 3 2 3",
  max_viewable: "4 4",
  boost_cpm: "1 3",
  standard: "12 4",
  [TACTIC_OTHER]: "3 3",
};

// Rótulo curto pro fim da linha do gráfico (o completo fica na legenda e
// no tooltip).
const SHORT = {
  tp_high: "TP High", tp_low: "TP Low", tp: "Top Perf.", premium_list: "Premium List",
  max_viewable: "Max Viewable", boost_cpm: "Boost CPM", standard: "Standard", [TACTIC_OTHER]: "Outras",
};
export const tacticShortLabel = (t) => SHORT[t] || tacticLabel(t);

export const tacticLabel = (t) =>
  t === TACTIC_OTHER ? "Outras / sem tática" : TACTIC_LABELS[t] || t;
export const tacticColor = (t) => TACTIC_COLORS[t] || TACTIC_COLORS[TACTIC_OTHER];
export const tacticDash = (t) => TACTIC_DASH[t];

export function sortTactics(list) {
  const rank = (t) => {
    if (t === TACTIC_OTHER) return TACTIC_ORDER.length + 1;
    const i = TACTIC_ORDER.indexOf(t);
    return i === -1 ? TACTIC_ORDER.length : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}
