// src/v2/components/ComparisonCardV2.jsx
//
// Card "Negociado vs Efetivo" — destaque do diferencial HYPR.
// Mostrado no Visão Geral (CPM Display + CPCV Video) e no header de
// cada tab Display/Video.
//
// Layout do mockup:
//   ┌──────────────────────────────────────────────────┐
//   │ CPM Display · Negociado vs Efetivo               │ header
//   ├──────────────────────────────────────────────────┤
//   │  Negociado    →    Efetivo    │   Economia      │
//   │  R$ 25,00          R$ 18,82   │   −24.7%        │
//   │                                │                  │
//   └──────────────────────────────────────────────────┘
//                                    ↑
//                        bloco direito com bg success-soft
//
// API:
//   <ComparisonCardV2
//     title="CPM Display · Negociado vs Efetivo"
//     negociado={25.00}
//     efetivo={18.82}
//     formatValue={(v) => fmtR(v)}
//     decimalsForDelta={1}
//   />

import { Card } from "../../ui/Card";
import { cn } from "../../ui/cn";

export function ComparisonCardV2({
  title,
  negociado,
  efetivo,
  formatValue,
  decimalsForDelta = 1,
  className,
}) {
  const hasValues =
    typeof negociado === "number" &&
    typeof efetivo === "number" &&
    negociado > 0;

  // Economia = (negociado - efetivo) / negociado.
  // Positiva = HYPR entregou mais barato (CPM efetivo < negociado).
  // Negativa = saiu mais caro (raríssimo, sinaliza problema).
  // Zero (negociado=efetivo) = caso degenerado, não mostra delta — mostra "—".
  const economyPct = hasValues
    ? ((negociado - efetivo) / negociado) * 100
    : null;

  // Threshold pra considerar "diferença significativa" — abaixo de 0.05%
  // tratamos como neutro (provavelmente o backend ainda não tem CPCV
  // efetivo separado do negociado, ou os dois são iguais por contrato).
  const isSignificant = economyPct !== null && Math.abs(economyPct) >= 0.05;
  const isEconomy = isSignificant && economyPct > 0;
  const isLoss = isSignificant && economyPct < 0;

  return (
    <Card
      className={cn(
        "bg-surface-2 border-border-strong overflow-hidden",
        className,
      )}
    >
      <div className="px-5 pt-4 pb-3 border-b border-border">
        <div className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">
          {title}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr_auto_1.2fr] items-center gap-3 px-5 py-5">
        {/* Negociado */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
            Negociado
          </span>
          <span className="text-2xl font-bold text-fg-muted leading-none tabular-nums">
            {hasValues ? formatValue(negociado) : "—"}
          </span>
        </div>

        {/* Seta separadora */}
        <ArrowRightIcon className="size-5 text-fg-subtle" />

        {/* Efetivo */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
            Efetivo
          </span>
          <span className="text-2xl font-bold text-signature leading-none tabular-nums">
            {hasValues ? formatValue(efetivo) : "—"}
          </span>
        </div>

        {/* Divisor vertical */}
        <div className="w-px h-12 bg-border" />

        {/* Economia/Loss block */}
        <div
          className={cn(
            "flex flex-col gap-1 rounded-lg px-4 py-3 border",
            isEconomy && "bg-success-soft border-success/30",
            isLoss && "bg-danger-soft border-danger/30",
            !isEconomy && !isLoss && "bg-surface border-border",
          )}
        >
          <span
            className={cn(
              "text-[10px] font-bold uppercase tracking-wider",
              isEconomy && "text-success",
              isLoss && "text-danger",
              !isEconomy && !isLoss && "text-fg-subtle",
            )}
          >
            {isEconomy ? "Economia" : isLoss ? "Variação" : "Sem variação"}
          </span>
          <span
            className={cn(
              "text-2xl font-bold leading-none tabular-nums",
              isEconomy && "text-success",
              isLoss && "text-danger",
              !isEconomy && !isLoss && "text-fg-muted",
            )}
          >
            {!isSignificant
              ? "—"
              : `${economyPct > 0 ? "−" : "+"}${Math.abs(economyPct).toFixed(decimalsForDelta)}%`}
          </span>
        </div>
      </div>
    </Card>
  );
}

function ArrowRightIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}
