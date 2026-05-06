// src/v2/hooks/useIsMobile.js
//
// Atalhos pros breakpoints do Tailwind v4 default (sm 640, md 768, lg 1024).
// Padronizamos `isMobile = max-width: 767px` (= abaixo de `md`) — bate com
// o ponto onde grids 2-col começam a sofrer e tabs precisam scroll.
//
// Tablet (768-1023) é tratado como desktop pra layout: cabe grids 2-3 col,
// tabs inline, drawers laterais. Menor que isso, mobile-mode.

import { useMediaQuery } from "./useMediaQuery";

// Limiar único — abaixo disso é "mobile" pra fins de comportamento.
// Mantém em sync com Tailwind `md:` (768px).
export function useIsMobile() {
  return useMediaQuery("(max-width: 767px)");
}

// Tablet ou maior — atalho semântico.
export function useIsTabletUp() {
  return useMediaQuery("(min-width: 768px)");
}

// Pra coisas que só fazem sentido em desktop full (gráficos densos com
// muitos pontos, tooltips hover-only, etc).
export function useIsDesktop() {
  return useMediaQuery("(min-width: 1024px)");
}
