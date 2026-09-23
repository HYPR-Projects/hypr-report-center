// src/shared/lazyWithPreload.js
//
// `React.lazy` com `.preload()` — pra tirar modal pesado do caminho crítico
// da página SEM deixar o 1º clique esperando download.
//
// Uso:
//   const SurveyModal = lazyWithPreload(() => import("./SurveyModal"));
//   useEffect(() => preloadWhenIdle(SurveyModal), []);
//   {open && <Suspense fallback={null}><SurveyModal ... /></Suspense>}
//
// A página pinta sem o JS do modal; assim que o navegador fica ocioso o chunk
// é baixado em background, e quando a pessoa clica o componente já está
// pronto. Se o preload falhar (rede, deploy novo), a promise é descartada e o
// render tenta de novo — e o `vite:preloadError` de src/shared/chunkReload.js
// cobre o caso de deploy.

import { lazy } from "react";

export function lazyWithPreload(factory) {
  let pending = null;
  const load = () => {
    if (!pending) {
      pending = factory().catch((err) => {
        pending = null;
        throw err;
      });
    }
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
      c?.preload?.().catch(() => { /* render tenta de novo */ });
    }
  };
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 4000 });
    return () => window.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(run, 1500);
  return () => window.clearTimeout(id);
}
