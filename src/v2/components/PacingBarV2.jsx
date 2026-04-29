// src/v2/components/PacingBarV2.jsx
//
// Barra de pacing horizontal.
//
// A métrica `pacing` vinda do backend é `delivered / expected_today × 100`,
// que é matematicamente equivalente ao forecast de entrega final como %
// do contrato. Ou seja:
//   100% = projetado pra bater a meta exata
//   >100% = vai over-deliver (mostrado como pill "OVER X%" + segmento
//            signature blue além do limite verde)
//   <100% = vai sub-entregar (cor da barra reflete severidade)
//
// Como o eixo da barra já é normalizado em relação ao esperado, NÃO faz
// sentido sobrepor um marker de "tempo decorrido" — o esperado-hoje é,
// por definição, sempre 100% nessa escala. A transição de cor + pill
// "OVER" já comunica visualmente o status. (PR-13 introduziu um marker
// linear que confundia mais que ajudava; removido em PR-22.)
//
// Comportamento de cor:
//   <70%   → vermelho (atrasado)
//   70-99% → amarelo (alerta)
//   ≥100%  → verde (no alvo / over)
//   Over-delivery → segmento extra signature além dos 100%
//
// A barra é capada visualmente em 150% (50% de over) pra não estourar
// o layout. Número exato continua no label.
//
// Renderiza null quando pacing é null/undefined.

import { fmt, fmtR } from "../../shared/format";

const palette = {
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
  signature: "var(--color-signature)",
  signatureLight: "var(--color-signature-light)",
};

function pickColor(pct) {
  if (pct >= 100) return palette.success;
  if (pct >= 70) return palette.warning;
  return palette.danger;
}

export function PacingBarV2({
  pacing,
  budget,
  cost,
  label = "Pacing",
  variant = "default", // "default" (card completo) | "compact" (sem card, só barra+label)
}) {
  if (pacing == null) return null;

  const realPct = Number(pacing) || 0;
  const visiblePct = Math.min(realPct, 150);
  const overPct = visiblePct > 100 ? visiblePct - 100 : 0;
  const baseWidth = Math.min(visiblePct, 100);
  const barColor = pickColor(visiblePct);
  const labelColor = realPct > 100 ? palette.signature : barColor;

  const wrapperClass =
    variant === "compact"
      ? "flex flex-col gap-2"
      : "rounded-xl border border-border bg-surface px-5 py-5";

  return (
    <div className={wrapperClass}>
      {/* Header: label + valor */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          <span
            className="size-2 rounded-full"
            style={{ background: barColor }}
            aria-hidden
          />
          {label}
        </span>
        <span
          className="text-sm font-bold tabular-nums whitespace-nowrap inline-flex items-center gap-2"
          style={{ color: labelColor }}
        >
          {fmt(realPct, 1)}%
          {realPct > 100 && (
            <span
              className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md inline-flex items-center gap-1"
              style={{
                color: palette.warning,
                background: "var(--color-warning-soft)",
              }}
            >
              <BoltIcon className="size-2.5" />
              Over {fmt(realPct - 100, 1)}%
            </span>
          )}
        </span>
      </div>

      {/* Bar */}
      <div className="relative h-2.5 rounded-full bg-canvas-deeper overflow-visible mt-4">
        <div className="absolute inset-0 rounded-full bg-canvas-deeper overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${baseWidth}%`, background: barColor }}
          />
          {overPct > 0 && (
            <div
              className="absolute inset-y-0 rounded-r-full transition-[width] duration-500 ease-out"
              style={{
                left: `${baseWidth}%`,
                width: `${Math.min(overPct, 50)}%`,
                background: palette.signature,
              }}
            />
          )}
        </div>
      </div>

      {/* Footer: investido / budget */}
      <div className="flex justify-between mt-3 text-[11px] text-fg-muted tabular-nums">
        <span>
          Investido: <span className="text-fg font-semibold">{fmtR(cost)}</span>
        </span>
        <span>
          Budget: <span className="text-fg font-semibold">{fmtR(budget)}</span>
        </span>
      </div>
    </div>
  );
}

function BoltIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
