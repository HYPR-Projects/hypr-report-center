// src/v2/hooks/useThemeColors.js
//
// Hook reativo que lê os tokens de cor do tema atual via getComputedStyle.
// Necessário pros componentes que passam cor como prop literal (recharts,
// SVG dinâmico) — eles não respondem a CSS vars sozinhos como utilitárias
// do Tailwind respondem.
//
// Por que não usa o tokens.js direto
//   tokens.js é estático (strings literais dark). Quando user troca tema,
//   strings continuam idênticas — chart fica com cores erradas. Este hook
//   re-computa as cores quando data-theme do <html> muda.
//
// Como detecta mudança de tema
//   MutationObserver no <html> escutando attribute "data-theme". Toggle
//   atualiza o atributo, observer dispara, hook re-renderiza com cores
//   novas. Mais robusto que listener de evento custom.
//
// Quem usa
//   - DualChartV2 (recharts: Bar fill, Line stroke, axis tick, grid)
//
// Sparklines, KpiCards, PacingBar etc usam Tailwind classes (`bg-signature`,
// `text-fg-muted`) ou CSS vars como string ("var(--color-signature)") —
// esses respondem ao tema sem precisar deste hook.

import { useEffect, useState, useMemo } from "react";

const COLOR_KEYS = [
  "canvas",
  "canvas-deeper",
  "canvas-elevated",
  "signature",
  "signature-hover",
  "signature-soft",
  "signature-light",
  "signature-glow",
  "warning",
  "warning-soft",
  "success",
  "success-soft",
  "danger",
  "danger-soft",
  "fg",
  "fg-muted",
  "fg-subtle",
  "fg-disabled",
  "border",
  "border-strong",
  "surface",
  "surface-strong",
  "surface-2",
  "surface-3",
];

function readColors() {
  if (typeof document === "undefined") return null;
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const k of COLOR_KEYS) {
    // Camel-case pro JS (canvas-deeper → canvasDeeper)
    const jsKey = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[jsKey] = cs.getPropertyValue(`--color-${k}`).trim();
  }
  return out;
}

export function useThemeColors() {
  const [tick, setTick] = useState(0);

  // Observa mudanças de data-theme no <html> e força re-leitura.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const obs = new MutationObserver(() => setTick((t) => t + 1));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  // useMemo amarrado em `tick` — recomputa quando observer dispara.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const colors = useMemo(() => readColors(), [tick]);
  return colors || {};
}

// Versão para chart neutrals (axis, grid, label) — extraída pra clareza
// no caller (DualChartV2 prefere passar `chartNeutral.grid` em vez de
// `colors.fgMuted` mesmo sendo o mesmo valor).
export function useChartNeutral() {
  const c = useThemeColors();
  return useMemo(
    () => ({
      grid: c.border || "rgba(245,247,250,0.12)",
      axis: c.fgSubtle || "rgba(245,247,250,0.45)",
      label: c.fgMuted || "rgba(245,247,250,0.7)",
    }),
    [c],
  );
}
