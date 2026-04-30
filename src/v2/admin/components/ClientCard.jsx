// src/v2/admin/components/ClientCard.jsx
//
// Card de cliente na view "Por cliente". Inspiração: Linear issue
// summary card + Vercel project card.
//
// Layout:
//   ┌─────────────────────────────────────────────┐
//   │ ● Kenvue                          ↑ +12%   │
//   │ 12 campanhas · 3 ativas                     │
//   │                                             │
//   │ ╱╲╱╲___╱╱─── (sparkline 12 semanas)         │
//   │                                             │
//   │ ┌─────────┬─────────┬─────────┐             │
//   │ │ Pacing  │ CTR     │ VTR     │             │
//   │ │ 108%    │ 0.74%   │ 89.2%   │             │
//   │ └─────────┴─────────┴─────────┘             │
//   │                                             │
//   │ NB BM Nogueira · Beatriz       há 2h →     │
//   └─────────────────────────────────────────────┘
//
// Click → navega pra `/admin/client/{slug}`.

import { useMemo } from "react";
import { cn } from "../../../ui/cn";
import { Card } from "../../../ui/Card";
import { Avatar } from "../../../ui/Avatar";
import { SparklineV2 } from "../../components/SparklineV2";
import { TrendPill } from "./TrendPill";
import {
  formatTimeAgo,
  formatPacingValue,
  formatPct,
  pacingColorClass,
  ctrColorClass,
  vtrColorClass,
  localPartFromEmail,
  slugToDisplay,
} from "../lib/format";

// 4 níveis de health, espelhando a régua de pacing (ver format.js).
// Cliente só agrega campanhas ATIVAS, então não precisa de "ended" aqui.
const HEALTH_DOT = {
  healthy:   "bg-success",     // alguma campanha 100–124%
  over:      "bg-signature",   // todas as campanhas ≥125%
  attention: "bg-warning",     // alguma 90–99%
  critical:  "bg-danger",      // alguma <90%
};

const HEALTH_GLOW = {
  healthy:   "shadow-[var(--shadow-glow-success)]",
  over:      "shadow-[var(--shadow-glow-signature)]",
  attention: "shadow-[var(--shadow-glow-warning)]",
  critical:  "shadow-[var(--shadow-glow-danger)]",
};

const SPARK_STROKE = {
  up:   "var(--color-success)",
  down: "var(--color-danger)",
  flat: "var(--color-fg-subtle)",
};

export function ClientCard({ client, onOpen }) {
  const {
    slug,
    display_name,
    total_campaigns,
    active_campaigns,
    avg_pacing,
    avg_ctr,
    avg_vtr,
    top_cp_owners = [],
    top_cs_owners = [],
    last_updated,
    health,
    sparkline,
    trend,
  } = client || {};

  // Display name fallback se backend não mandou
  const displayName = display_name || slugToDisplay(slug);

  // Stroke do sparkline conforme trend (ou fallback para signature)
  const sparkStroke = trend?.direction
    ? SPARK_STROKE[trend.direction]
    : "var(--color-signature)";

  // Owners pra mostrar — top 1 CP + top 1 CS pra economizar espaço
  const primaryCp = top_cp_owners[0];
  const primaryCs = top_cs_owners[0];

  // Display de owners textual
  const ownersText = useMemo(() => {
    const parts = [];
    if (primaryCp?.email) parts.push(localPartFromEmail(primaryCp.email).split(".")[0]);
    if (primaryCs?.email) parts.push(localPartFromEmail(primaryCs.email).split(".")[0]);
    return parts.map(capitalizeFirst).join(" · ");
  }, [primaryCp, primaryCs]);

  return (
    <Card
      className={cn(
        "p-5 cursor-pointer group",
        "border-border hover:border-signature/40",
        "transition-all duration-150 hover:-translate-y-0.5",
        "hover:shadow-[0_4px_14px_rgba(0,0,0,0.06)]"
      )}
      onClick={() => onOpen?.(slug)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(slug);
        }
      }}
    >
      {/* Header: status dot + name + trend */}
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {health && (
              <span
                className={cn(
                  "w-1.5 h-1.5 rounded-full shrink-0",
                  HEALTH_DOT[health],
                  HEALTH_GLOW[health]
                )}
                title={`Status: ${health}`}
                aria-label={`Status: ${health}`}
              />
            )}
            <h3 className="text-[15px] font-bold text-fg tracking-tight leading-tight truncate">
              {displayName}
            </h3>
          </div>
          <p className="text-[12px] text-fg-muted mt-0.5">
            <span className="tabular-nums font-semibold text-fg">{total_campaigns}</span>{" "}
            campanha{total_campaigns === 1 ? "" : "s"}
            {active_campaigns > 0 && (
              <>
                {" · "}
                <span className="text-success font-semibold tabular-nums">
                  {active_campaigns} ativa{active_campaigns === 1 ? "" : "s"}
                </span>
              </>
            )}
          </p>
        </div>
        <TrendPill trend={trend} />
      </div>

      {/* Sparkline — só se backend mandou. Reserva altura mesmo sem dados pra
          evitar layout shift entre cards com/sem sparkline. */}
      <div className="my-3 h-[28px] -mx-1">
        {sparkline?.length > 1 ? (
          <SparklineV2
            values={sparkline}
            stroke={sparkStroke}
            strokeWidth={1.6}
            width={400}
            height={28}
            className="w-full"
            ariaLabel="Tendência de entrega nas últimas 12 semanas"
          />
        ) : (
          <div className="h-full w-full" aria-hidden="true" />
        )}
      </div>

      {/* Métricas em grid 3-col */}
      <div className="grid grid-cols-3 gap-0 py-2.5 border-y border-border">
        <Metric label="Pacing" value={formatPacingValue(avg_pacing)} colorClass={pacingColorClass(avg_pacing)} />
        <Metric label="CTR"    value={formatPct(avg_ctr, 2)} colorClass={ctrColorClass(avg_ctr)} border />
        <Metric label="VTR"    value={formatPct(avg_vtr, 1)} colorClass={vtrColorClass(avg_vtr)} border />
      </div>

      {/* Footer: owners + tempo */}
      <div className="flex items-center justify-between gap-2 mt-3">
        <div className="flex items-center gap-2 min-w-0">
          {(primaryCp || primaryCs) && (
            <div className="inline-flex">
              {primaryCp && (
                <Avatar
                  name={localPartFromEmail(primaryCp.email)}
                  role="cp"
                  size="sm"
                />
              )}
              {primaryCs && (
                <Avatar
                  name={localPartFromEmail(primaryCs.email)}
                  role="cs"
                  size="sm"
                  className={primaryCp ? "-ml-1.5" : ""}
                />
              )}
            </div>
          )}
          {ownersText && (
            <span className="text-[11px] text-fg-muted truncate">{ownersText}</span>
          )}
        </div>
        <span className="text-[10.5px] text-fg-subtle shrink-0 tabular-nums">
          {formatTimeAgo(last_updated)}
        </span>
      </div>
    </Card>
  );
}

function Metric({ label, value, colorClass, border }) {
  return (
    <div className={cn("px-2 first:pl-0 last:pr-0", border && "border-l border-border")}>
      <div className="text-[9.5px] uppercase tracking-widest font-bold text-fg-subtle">
        {label}
      </div>
      <div className={cn("text-[15px] font-bold tracking-tight tabular-nums mt-0.5", colorClass)}>
        {value}
      </div>
    </div>
  );
}

function capitalizeFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
