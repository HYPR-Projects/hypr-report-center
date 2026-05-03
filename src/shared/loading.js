// src/shared/loading.js
//
// Loading state global, leve, sem provider. Componentes registram que
// estão carregando algo via `useLoadingTask(boolean)`; o `<GlobalProgressBar />`
// no root da app mostra a barra no topo enquanto há ≥1 task ativa.
//
// Por que não usar Context
// ────────────────────────
// Context dispara re-render em todo consumidor mesmo quando o valor não
// muda — ou pior, força memoização cuidadosa em todo lugar. Aqui basta
// um contador + listeners pub/sub. O re-render fica isolado no único
// consumidor (a barra).
//
// Filosofia: animação deve mascarar latência, não criá-la
// ────────────────────────────────────────────────────────
// A barra só aparece se a task durar > 200ms. Fetches resolvidos pelo
// SWR/cache (a maioria neste app) terminam antes disso e o usuário não
// vê flash nenhum. Isso evita transformar uma transição de 0ms em uma
// de 350ms percebidos.
//
// API
// ───
//   // Em qualquer componente:
//   useLoadingTask(isLoading);
//
//   // Componente raiz:
//   <GlobalProgressBar />

import { useEffect, useSyncExternalStore } from "react";

let _count = 0;
const _listeners = new Set();

function emit() {
  _listeners.forEach((fn) => fn());
}

function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function getSnapshot() {
  return _count;
}

/**
 * Registra/desregistra a presença de uma task ativa quando `isLoading`
 * muda. Chamada de um componente React.
 */
export function useLoadingTask(isLoading) {
  useEffect(() => {
    if (!isLoading) return;
    _count += 1;
    emit();
    return () => {
      _count = Math.max(0, _count - 1);
      emit();
    };
  }, [isLoading]);
}

/**
 * Lê o contador global de tasks ativas — usado pelo GlobalProgressBar.
 * Externo do React em propósito (counter compartilhado entre módulos).
 */
export function useActiveTaskCount() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
