// src/v2/lib/motion.js
//
// Motion do report no lado JS. O CSS (v2.css, bloco "Motion do report")
// cobre o que é keyframe; aqui fica o que o CSS não alcança:
//
//   - `prefers-reduced-motion` pra animações em JS (Recharts, contagem de
//     número, View Transition). A regra global do global-reset.css só zera
//     animação CSS; Recharts anima por requestAnimationFrame e ignora.
//   - `useAnimationWindow`: janela curta em que o gráfico PODE animar.
//     Recharts reanima sempre que a referência dos pontos muda, e isso
//     acontece também em resize e em re-render com array novo. Fora da
//     janela a animação fica desligada, então só anima montagem e troca
//     de verdade (métrica, período, filtro, view).
//   - `useTweenedText`: contagem do valor antigo pro novo num texto já
//     formatado ("17.052.551", "1,84%", "R$ 0,55", "11,8M").
//   - `withViewTransition`: document.startViewTransition com fallback.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { useMediaQuery } from "../hooks/useMediaQuery.js";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

export const CHART_ANIMATION_MS = 520;

export function prefersReducedMotion() {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.(REDUCED_QUERY).matches;
  } catch {
    return false;
  }
}

export function usePrefersReducedMotion() {
  return useMediaQuery(REDUCED_QUERY);
}

// Export PNG em andamento. O export estreita o card e o Recharts redesenha;
// se a animação estivesse ligada, a captura pegava a curva no meio do
// caminho (foi por isso que os gráficos nasceram com animação desligada).
// Enquanto isso for true, nenhum gráfico anima.
let exportingCount = 0;
const exportListeners = new Set();
export function setExporting(on) {
  exportingCount = Math.max(0, exportingCount + (on ? 1 : -1));
  exportListeners.forEach((l) => l());
}
function subscribeExporting(l) {
  exportListeners.add(l);
  return () => exportListeners.delete(l);
}
export function useIsExporting() {
  return useSyncExternalStore(subscribeExporting, () => exportingCount > 0, () => false);
}

/**
 * true na montagem e por `duration` ms depois de cada troca de `signature`.
 * A assinatura deve mudar só quando o dado muda de verdade (ver
 * `seriesSignature`), não a cada render.
 */
export function useAnimationWindow(signature, duration = CHART_ANIMATION_MS + 380) {
  const reduced = usePrefersReducedMotion();
  const exporting = useIsExporting();
  const [settled, setSettled] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => setSettled(signature), duration);
    return () => clearTimeout(t);
  }, [signature, duration]);
  return !reduced && !exporting && settled !== signature;
}

/** Assinatura barata de uma série diária: tamanho, pontas e soma da métrica. */
export function seriesSignature(data, keys) {
  if (!Array.isArray(data) || !data.length) return "empty";
  const list = Array.isArray(keys) ? keys : [keys];
  let sum = 0;
  for (const row of data) {
    for (const k of list) {
      const v = Number(row?.[k]);
      if (Number.isFinite(v)) sum += v;
    }
  }
  const first = data[0]?.date ?? "";
  const last = data[data.length - 1]?.date ?? "";
  return `${list.join(",")}|${data.length}|${first}|${last}|${sum.toFixed(6)}`;
}

// ─── Contagem de número em texto formatado ─────────────────────────────

// Primeiro número do texto, no formato pt-BR (milhar com ponto, decimal
// com vírgula). O resto (prefixo "R$ ", sufixo "%", "M", "k") é mantido.
const NUM_RE = /-?\d+(?:\.\d{3})*(?:,\d+)?/;

export function parseFormatted(text) {
  if (typeof text !== "string") return null;
  const m = NUM_RE.exec(text);
  if (!m) return null;
  const raw = m[0];
  const decimals = raw.includes(",") ? raw.split(",")[1].length : 0;
  const value = Number(raw.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(value)) return null;
  return {
    value,
    decimals,
    prefix: text.slice(0, m.index),
    suffix: text.slice(m.index + raw.length),
  };
}

export function formatLike(shape, value) {
  const n = value.toLocaleString("pt-BR", {
    minimumFractionDigits: shape.decimals,
    maximumFractionDigits: shape.decimals,
  });
  return `${shape.prefix}${n}${shape.suffix}`;
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Devolve `{ text, changed }`. Quando `text` muda depois da montagem e os
 * dois valores têm a mesma forma (mesmo prefixo, sufixo e casas), conta do
 * antigo pro novo em `duration` ms. Forma diferente ("980k" → "1,2M"),
 * valor não numérico ou reduced-motion: troca direto. `changed` incrementa
 * a cada troca (serve de `key` pro flash de cor).
 */
export function useTweenedText(text, duration = 450) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(text);
  const [changed, setChanged] = useState(0);
  const prevRef = useRef(text);
  const rafRef = useRef(0);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = text;
    if (prev === text) return undefined;
    cancelAnimationFrame(rafRef.current);

    const a = parseFormatted(prev);
    const b = parseFormatted(text);
    const sameShape =
      a && b && a.prefix === b.prefix && a.suffix === b.suffix && a.decimals === b.decimals;

    if (reduced || !sameShape || typeof requestAnimationFrame === "undefined") {
      rafRef.current = requestAnimationFrame(() => {
        setShown(text);
        setChanged((c) => c + 1);
      });
      return () => cancelAnimationFrame(rafRef.current);
    }

    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      if (t >= 1) {
        setShown(text);
        return;
      }
      setShown(formatLike(b, a.value + (b.value - a.value) * easeOutCubic(t)));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame((now) => {
      setChanged((c) => c + 1);
      tick(now);
    });
    return () => cancelAnimationFrame(rafRef.current);
  }, [text, duration, reduced]);

  // Valor que não é string (ReactNode) passa direto, sem contagem.
  if (typeof text !== "string") return { text, changed: 0 };
  return { text: shown, changed };
}

// ─── View Transition ───────────────────────────────────────────────────

/**
 * Roda `update` (setState) dentro de uma View Transition quando o browser
 * suporta e o usuário não pediu movimento reduzido. `flushSync` garante
 * que o DOM novo existe quando o browser tira o snapshot "depois".
 */
export function viewTransitionsEnabled() {
  return typeof document !== "undefined" && !!document.startViewTransition && !prefersReducedMotion();
}

export function withViewTransition(update) {
  if (!viewTransitionsEnabled()) {
    update();
    return null;
  }
  try {
    return document.startViewTransition(() => {
      flushSync(update);
    });
  } catch {
    update();
    return null;
  }
}
