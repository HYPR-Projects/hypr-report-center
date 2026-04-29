// src/v2/legacyThemeBridge.js
//
// Ponte entre o tema V2 (data-theme="dark"|"light") e os componentes
// Legacy que recebem objeto theme com schema próprio (bg/bg2/bg3/bdr/
// text/muted) — SurveyTab e TabChat principalmente.
//
// Por que existir
//   Os Legacy usam paletas hardcoded (C/CL de src/shared/theme.js) que
//   são INDEPENDENTES dos tokens V2. Não dá pra mapear V2 vars → Legacy
//   strings em runtime sem reescrever o Legacy. Então passamos os
//   valores literais pré-definidos pelo Legacy quando o tema é light.
//
// Quando o tema é dark, retornamos undefined — Legacy cai no default
// dark deles (C.dark, etc), que era o comportamento ANTES da PR-18 e
// continua correto.
//
// O objeto retornado bate exatamente com o schema esperado por
// SurveyTab.jsx (linhas 82-86) e TabChat.jsx (linhas 63-68):
//   { bg, bg2, bg3, bdr, text, muted }

const LIGHT_LEGACY = {
  bg:    "#F4F6FA",   // canvas
  bg2:   "#FFFFFF",   // card
  bg3:   "#EEF1F7",   // input/well
  bdr:   "#DDE2EC",   // border
  text:  "#1C262F",   // texto primário
  muted: "#6B7A8D",   // texto secundário
};

export function legacyThemeObj(themeMode) {
  if (themeMode !== "light") return undefined;
  return LIGHT_LEGACY;
}
