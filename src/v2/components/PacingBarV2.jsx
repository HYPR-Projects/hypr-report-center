// src/v2/components/PacingBarV2.jsx
//
// Barra de pacing horizontal — redesenhada em PR-13 pra incluir o
// marker "esperado hoje" do mockup. O marker é um traço vertical
// posicionado em `expectedPct` que indica onde a campanha deveria
// estar AGORA (linear pro tempo decorrido).
//
// Comportamento:
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
import { cn } from "../../ui/cn";

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
  expectedPct, // % esperada hoje (campanha-progresso linear). Null = não mostra marker.
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

  // Posição do marker como % do total visível (que é capado em 150%).
  // Convertemos pra % do width relativo do bar container (0-150% → 0-100%).
  const markerLeft =
    typeof expectedPct === "number" && expectedPct > 0
      ? `${Math.min((expectedPct / 150) * 100, 100)}%`
      : null;

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

      {/* Bar com marker "esperado hoje" sobreposto.
          mt-7 quando há marker (label flutuante a -top-5 precisa de ~24px
          de respiro pra não colidir com o header acima). */}
      <div
        className={cn(
          "relative h-2.5 rounded-full bg-canvas-deeper overflow-visible",
          markerLeft ? "mt-7" : "mt-4",
        )}
      >
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

        {/* Marker "esperado hoje" — traço vertical com label flutuante */}
        {markerLeft && (
          <>
            <div
              className="absolute -top-1 -bottom-1 w-px bg-warning z-10"
              style={{ left: markerLeft }}
              aria-hidden
            />
            <span
              className="absolute -top-5 -translate-x-1/2 text-[9px] font-bold uppercase tracking-wider text-warning whitespace-nowrap"
              style={{ left: markerLeft }}
            >
              esperado hoje
            </span>
          </>
        )}
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
