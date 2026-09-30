// src/shared/dspMeta.js
//
// Identidade visual das DSPs, fonte única. Antes a mesma tabela de cor/rótulo
// vivia copiada no DspHealthV2 (aba DSPs do report) e no DspHealthPanel (popover
// do rail); o Analytics › Saúde das DSPs é o terceiro consumidor.
//
// Cor segue a DSP, nunca a posição: filtrar uma fonte não repinta as outras.
// Literais porque recharts/SVG não leem CSS var em prop.
//
// DV360 e Yahoo ficam próximos pra quem tem protanopia (ΔE 6,2 no validador),
// então o gráfico de linhas usa também um traço próprio por DSP (DSP_DASH) e
// rótulo direto no fim da linha — a cor nunca carrega a identidade sozinha.

export const DSP_COLORS = {
  DV360: "#4285F4",
  XANDR: "#8B5CF6",
  AMAZON: "#FF9900",
  STACKADAPT: "#14B8A6",
  YAHOO: "#D946EF",
};

export const DSP_LABELS = {
  DV360: "DV360",
  XANDR: "Xandr",
  AMAZON: "Amazon",
  STACKADAPT: "StackAdapt",
  YAHOO: "Yahoo",
};

// Traço por DSP (strokeDasharray) — codificação secundária da identidade.
export const DSP_DASH = {
  DV360: undefined,
  YAHOO: "7 4",
  AMAZON: "2 3",
  STACKADAPT: "10 3 2 3",
  XANDR: "4 4",
};

// Ordem de exibição: as DSPs de maior investimento primeiro.
export const DSP_ORDER = ["DV360", "YAHOO", "AMAZON", "STACKADAPT", "XANDR"];

export const dspColor = (source) =>
  DSP_COLORS[String(source || "").toUpperCase()] || "#3397B9";

export const dspLabel = (source) =>
  DSP_LABELS[String(source || "").toUpperCase()] || source;

export const dspDash = (source) => DSP_DASH[String(source || "").toUpperCase()];

export function sortSources(sources) {
  const rank = (s) => {
    const i = DSP_ORDER.indexOf(String(s || "").toUpperCase());
    return i === -1 ? DSP_ORDER.length : i;
  };
  return [...sources].sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)));
}
