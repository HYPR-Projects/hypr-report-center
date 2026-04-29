// src/shared/tokens.js
//
// ──────────────────────────────────────────────────────────────────────
// Design tokens do HYPR Report Center V2 (espelho JS).
// ──────────────────────────────────────────────────────────────────────
//
// Single source of truth para CSS = src/ui/theme.css (bloco @theme do
// Tailwind v4). Este arquivo é o ESPELHO em JavaScript dos mesmos
// valores, necessário para:
//
//   • recharts: gráficos recebem cores via prop (ex: <Bar fill={...} />),
//     não via classe Tailwind. Precisam de string literal.
//   • SVG dinâmico: lógica condicional de cor (ex: cor da barra muda
//     se métrica está acima/abaixo do alvo).
//   • Componentes que recebem cor como prop em vez de variant.
//
// REGRA DE MANUTENÇÃO
// ──────────────────────────────────────────────────────────────────────
// Se alterar um valor aqui, alterar o equivalente em theme.css. Se
// alterar em theme.css, alterar aqui. O set é pequeno e raramente muda.
//
// Em fase futura, podemos gerar este arquivo automaticamente a partir
// do theme.css via script de build, eliminando a sincronização manual.
// Por agora, manutenção manual é aceitável e mais simples.

// ═══════════════ CORES OFICIAIS HYPR ═══════════════
export const colors = {
  // Canvas
  canvas: "#1C262F",
  canvasDeeper: "#0F1419",
  canvasElevated: "#232F39",

  // Signature
  signature: "#3397B9",
  signatureHover: "#246C84",
  signatureSoft: "rgba(51, 151, 185, 0.15)",

  // Semânticas
  warning: "#EDD900",
  warningSoft: "rgba(237, 217, 0, 0.15)",
  success: "#4CB050",
  successSoft: "rgba(76, 176, 80, 0.15)",
  danger: "#F5272B",
  dangerSoft: "rgba(245, 39, 43, 0.15)",

  // Foreground
  fg: "#F5F7FA",
  fgMuted: "rgba(245, 247, 250, 0.7)",
  fgSubtle: "rgba(245, 247, 250, 0.45)",
  fgDisabled: "rgba(245, 247, 250, 0.3)",

  // Borders e surfaces
  border: "rgba(245, 247, 250, 0.08)",
  borderStrong: "rgba(245, 247, 250, 0.16)",
  surface: "rgba(245, 247, 250, 0.04)",
  surfaceStrong: "rgba(245, 247, 250, 0.08)",
};

// ═══════════════ PALETAS PARA CHARTS ═══════════════
// Sequência de cores categóricas para series múltiplas em gráficos
// (ex: 5 linhas no gráfico de Display). Ordenada por contraste e
// distinguibilidade. Primeira cor é signature por convenção (linha
// principal). Demais são variações pensadas pra acessibilidade
// (passa em deficiência de cor verde-vermelho).
export const chartPalette = [
  "#3397B9", // signature (primária)
  "#EDD900", // warning yellow
  "#4CB050", // success green
  "#F5272B", // danger red
  "#A35EE8", // roxo (complemento — único valor fora da paleta oficial)
  "#FF8A4C", // laranja (complemento — único valor fora da paleta oficial)
];

// Cor neutra para axis, grid lines, labels secundários em charts
export const chartNeutral = {
  grid: "rgba(245, 247, 250, 0.08)",
  axis: "rgba(245, 247, 250, 0.45)",
  label: "rgba(245, 247, 250, 0.7)",
};

// ═══════════════ TIPOGRAFIA ═══════════════
export const typography = {
  fontSans:
    "'Urbanist', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontMono:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  weights: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
};

// ═══════════════ RAIOS ═══════════════
export const radii = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  "2xl": 20,
};

// ═══════════════ EXPORT AGREGADO ═══════════════
// Mantido para retrocompatibilidade com a estrutura placeholder da PR-01
// (que exportava um único objeto `tokens`).
export const tokens = {
  colors,
  chartPalette,
  chartNeutral,
  typography,
  radii,
};
