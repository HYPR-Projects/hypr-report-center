// src/v2/components/HeroKpiCardV2.jsx
//
// Card hero do KPI principal — usado no Visão Geral pro Custo Efetivo
// total. Diferente do KpiCardV2 normal: ocupa coluna dupla, valor
// gigante, sparkline embaixo, trend chip com delta vs período anterior.
//
// Pattern do mockup:
//   ┌──────────────────────────────────┐
//   │ $ Custo Efetivo · Total          │  label com ícone
//   │                                   │
//   │ R$ 184.220,40                    │  valor gigante (text-4xl)
//   │                                   │
//   │ [↗ +12.4% vs sem.ant.] ╱╱╱╱╱╱╱  │  trend chip + sparkline
//   └──────────────────────────────────┘
//
// API:
//   <HeroKpiCardV2
//     icon={<DollarIcon />}
//     label="Custo Efetivo · Total"
//     value="R$ 184.220,40"
//     deltaPercent={12.4}                  // null se sem comparação
//     deltaLabel="vs sem. ant."
//     sparklineValues={[100, 110, ..., 184]}
//   />

import { SparklineV2 } from "./SparklineV2";
import { Card, CardBody } from "../../ui/Card";
import { cn } from "../../ui/cn";

export function HeroKpiCardV2({
  icon,
  label,
  value,
  cents, // string opcional, renderizada menor (ex: ",40" no fim de "R$ 184.220")
  deltaPercent,
  deltaLabel = "vs período ant.",
  sparklineValues,
  sparklineColor = "var(--color-signature)",
  className,
}) {
  const hasDelta = typeof deltaPercent === "number" && !Number.isNaN(deltaPercent);
  const isPositiveDelta = hasDelta && deltaPercent > 0;
  const isNegativeDelta = hasDelta && deltaPercent < 0;

  return (
    <Card
      className={cn(
        "relative overflow-hidden",
        "bg-surface-2 border-border-strong",
        className,
      )}
    >
      {/* Glow radial sutil no canto superior direito (mockup hero pattern) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-1/2 -right-[10%] w-[60%] h-[200%]"
        style={{
          background:
            "radial-gradient(ellipse, var(--color-signature-glow) 0%, transparent 70%)",
        }}
      />
      <CardBody className="relative p-6 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-signature">
          {icon && <span className="size-3.5 shrink-0">{icon}</span>}
          {label}
        </div>

        <div className="font-bold text-fg leading-none tabular-nums text-4xl md:text-5xl">
          {value}
          {cents && (
            <span className="text-2xl md:text-3xl font-bold opacity-70">{cents}</span>
          )}
        </div>

        <div className="flex items-center gap-3 mt-1">
          {hasDelta && (
            <span
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold tabular-nums",
                isPositiveDelta && "bg-success-soft text-success",
                isNegativeDelta && "bg-danger-soft text-danger",
                !isPositiveDelta && !isNegativeDelta && "bg-surface text-fg-muted",
              )}
            >
              <ArrowIcon
                direction={isPositiveDelta ? "up-right" : isNegativeDelta ? "down-right" : "right"}
                className="size-2.5"
              />
              {deltaPercent > 0 ? "+" : ""}
              {deltaPercent.toFixed(1)}% {deltaLabel}
            </span>
          )}

          {sparklineValues && sparklineValues.length >= 2 && (
            <SparklineV2
              values={sparklineValues}
              stroke={sparklineColor}
              width={200}
              height={28}
              className="flex-1 max-w-[260px] opacity-80"
              ariaLabel={`Tendência ${label}`}
            />
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Ícone de seta inline (3 direções) ────────────────────────────────
function ArrowIcon({ direction, className }) {
  // up-right (alta), down-right (queda), right (flat)
  const path = {
    "up-right": (
      <>
        <polyline points="7 17 17 7" />
        <polyline points="7 7 17 7 17 17" />
      </>
    ),
    "down-right": (
      <>
        <polyline points="7 7 17 17" />
        <polyline points="17 7 17 17 7 17" />
      </>
    ),
    right: (
      <>
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="13 5 19 12 13 19" />
      </>
    ),
  }[direction];

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}
