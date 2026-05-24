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

// Watchdog: se uma task ficar mais de MAX_TASK_MS, força decremento e
// loga warning com a stack que criou. Sintoma a tratar é a barrinha
// global travada eternamente quando algum callsite esquece de mudar
// `isLoading` pra false (ex: fetch hang, cleanup que não roda,
// componente desmontado antes de finalizar).
const MAX_TASK_MS = 30_000;

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
 *
 * Watchdog de 30s: se a task não terminar nesse prazo, decrementa
 * forçado + emite. Mantém a barra honesta sem precisar caçar quem
 * esqueceu de mudar o estado.
 */
export function useLoadingTask(isLoading) {
  useEffect(() => {
    if (!isLoading) return;
    _count += 1;
    emit();
    let released = false;
    const release = (forced) => {
      if (released) return;
      released = true;
      _count = Math.max(0, _count - 1);
      emit();
      if (forced) {
        // Stack ajuda a identificar de onde veio a task vazada.
        // eslint-disable-next-line no-console
        console.warn(
          `[useLoadingTask] watchdog liberou task após ${MAX_TASK_MS}ms — provavelmente uma flag isLoading ficou true sem ser resetada.\n` +
          new Error().stack,
        );
      }
    };
    const watchdog = setTimeout(() => release(true), MAX_TASK_MS);
    return () => {
      clearTimeout(watchdog);
      release(false);
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
