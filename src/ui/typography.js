// src/ui/typography.js
//
// Tipografia compartilhada Legacy ↔ V2.
//
// Carrega a Urbanist via @fontsource (self-hosted, sem CDN externo) em
// quatro pesos: 400 (regular), 500 (medium), 600 (semibold), 700 (bold).
//
// Cada arquivo CSS importado abaixo registra um @font-face com
// `font-display: swap` e `unicode-range` por subset — o browser só baixa
// os arquivos .woff2 dos subsets que realmente aparecem no conteúdo da
// página. Para PT-BR isso significa que apenas o subset "latin"
// (~12 KB por peso) é baixado em runtime.
//
// ──────────────────────────────────────────────────────────────────────
// COMPORTAMENTO ATUAL (Fase 1, PR-04 em diante)
// ──────────────────────────────────────────────────────────────────────
// Este módulo é importado pelo src/v2/dashboards/ClientDashboardV2.jsx
// como side-effect (`import "../../ui/typography"`). O Vite resolve os
// @import de @fontsource/urbanist/{peso}.css e empacota os arquivos
// .woff2/.woff no bundle, com URLs hashadas e cacheáveis pelo CDN.
//
// O Legacy NÃO importa este módulo — continua usando suas fontes
// system-ui via shared/theme.js. Quando o Legacy for removido (futuro
// pós-Fase 7), este módulo passa a ser o único caminho de carregamento
// de fontes do app.
//
// ──────────────────────────────────────────────────────────────────────
// USO
// ──────────────────────────────────────────────────────────────────────
//   // Side-effect (registra @font-face no documento):
//   import "../../ui/typography";
//
//   // Stack como string (ex: para style inline ou recharts label):
//   import { FONT_FAMILY } from "../../ui/typography";
//   <text fontFamily={FONT_FAMILY} />
//
//   // Em CSS via Tailwind: a classe `font-sans` usa a Urbanist
//   // automaticamente (definida em src/ui/theme.css via --font-sans).
//
// ──────────────────────────────────────────────────────────────────────
// POR QUE FONTSOURCE E NÃO GOOGLE FONTS CDN
// ──────────────────────────────────────────────────────────────────────
// • Self-hosted: sem dependência de fonts.gstatic.com em runtime
// • Cacheável pelo CDN do Vercel (cache-control: immutable, far-future)
// • Privacidade: zero round-trip pra Google a cada page load
// • Build determinístico: versão da fonte fica congelada no package.json
// • Tree-shaking: peso não importado = peso não baixado pelo cliente

import "@fontsource/urbanist/400.css";  // regular
import "@fontsource/urbanist/500.css";  // medium
import "@fontsource/urbanist/600.css";  // semibold
import "@fontsource/urbanist/700.css";  // bold
import "@fontsource/urbanist/800.css";  // extrabold (modais admin + KpiCard + heroes)

// Stack completo com fallbacks. Ordem dos fallbacks (em caso da Urbanist
// falhar em carregar):
//   1. system-ui            — fonte de sistema do OS (San Francisco / Segoe UI / Roboto)
//   2. -apple-system        — fallback explícito pra Safari iOS antigo
//   3. BlinkMacSystemFont   — fallback explícito pra Chrome no macOS
//   4. "Segoe UI"           — Windows
//   5. Roboto               — Android
//   6. sans-serif           — fallback genérico universal
//
// Os dois primeiros (system-ui e -apple-system) cobrem ~95% dos casos
// em runtime moderno. O resto é defesa em profundidade.
export const FONT_FAMILY =
  "'Urbanist', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// Pesos disponíveis. Exportados como constantes nomeadas para uso
// type-safe em estilos (e como referência rápida pra dev novo no projeto).
export const FONT_WEIGHTS = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
};
