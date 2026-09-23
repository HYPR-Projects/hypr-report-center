// src/shared/lazyWithPreload.js
//
// `React.lazy` com `.preload()` — pra tirar modal pesado do caminho crítico
// da página SEM deixar o 1º clique esperando download.
//
// Uso:
//   const SurveyModal = lazyWithPreload(() => import("./SurveyModal"));
//   useEffect(() => preloadWhenIdle(SurveyModal), []);
//   {open && (
//     <LazyModalBoundary onFail={fechar}>
//       <Suspense fallback={null}><SurveyModal ... /></Suspense>
//     </LazyModalBoundary>
//   )}
//
// A página pinta sem o JS do modal; assim que o navegador fica ocioso o chunk
// é baixado em background, e quando a pessoa clica o componente já está
// pronto.
//
// Falha de download (rede, deploy novo): o navegador guarda a falha do
// módulo naquela página, então tentar de novo sem recarregar não adianta.
// Preload em idle que falha não faz nada visível; quem decide é o render —
// o LazyModalBoundary faz o reload único de deploy (chunkReload) ou, se ele
// já aconteceu, só fecha o modal sem derrubar a página.

import { lazy } from "react";

export function lazyWithPreload(factory) {
  let pending = null;
  const load = () => {
    if (!pending) pending = factory();
    return pending;
  };
  const Component = lazy(load);
  Component.preload = load;
  return Component;
}

/**
 * Agenda o preload pra quando o main thread estiver livre. Devolve cleanup
 * pra usar direto como retorno de useEffect.
 */
export function preloadWhenIdle(...components) {
  if (typeof window === "undefined") return () => {};
  const run = () => {
    for (const c of components) {
      c?.preload?.().catch(() => { /* o render tenta de novo */ });
    }
  };
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 4000 });
    return () => window.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(run, 1500);
  return () => window.clearTimeout(id);
}
