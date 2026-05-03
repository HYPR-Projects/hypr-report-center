// src/v2/admin/components/ClientCard.jsx
//
// Card de cliente na view "Por cliente". Inspiração: Linear issue
// summary card + Vercel project card.
//
// Layout:
//   ┌─────────────────────────────────────────────┐
//   │▌Kenvue                              ↑ +12% │  ← stripe + name + trend inline
//   │ 9 campanhas  · 4 ativas         há 10 h    │  ← timestamp no header (era footer)
//   │                                             │
//   │ ╱╲╱╲___╱╱─── (sparkline + área sutil)       │
//   │                                             │
//   │ DSP·VID 108%   CTR 0.74%   VTR 89.2%        │  ← métricas inline (sem boxes)
//   │                                             │
//   │ NB BM                                       │  ← só avatares (tooltip nos nomes)
//   └─────────────────────────────────────────────┘
//
// Decisões de harmonização com o CampaignCardV2:
//   • Stripe lateral 3px substitui o dot + glow (mesma "linguagem visual"
//     entre as 2 views do admin).
//   • TrendPill sem chip — agora inline (cor sólida + seta), pra não
//     virar "campo de alertas vermelhos" com 10+ cards na tela.
//   • Métricas em label tiny + valor bold colorido (mesmo padrão da
//     régua de cores condicional). Sem grid boxed/divisores verticais.
//   • Timestamp `há Xh` virou parte do header (subtle), não duplica
//     espaço no footer. Footer agora é só os pips de owners.
//   • SparklineV2 ganhou área de fill sutil (fillOpacity 0.10) — dá
//     corpo visual sem aumentar altura.
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
  formatBRL,
  pacingColorClass,
  ctrColorClass,
  vtrColorClass,
  ecpmBgClass,
  localPartFromEmail,
  slugToDisplay,
} from "../lib/format";

// Stripe lateral por health (mesma régua de pacing). Cliente só agrega
// campanhas ATIVAS, então não precisa de "ended".
const HEALTH_BAR = {
  healthy:   "bg-success",     // alguma campanha 100–124%
  over:      "bg-signature",   // todas ≥125%
  attention: "bg-warning",     // alguma 90–99%
  critical:  "bg-danger",      // alguma <90%
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
    // ADMIN-ONLY — custo cru / impressions × 1000. Backend só envia
    // este campo em endpoints admin-gated (action=list_clients), então
    // se chegou aqui é porque já passou auth. Mas: NÃO duplicar este
    // valor em props/contextos que descem pra componentes client-facing.
    admin_ecpm,
  } = client || {};

  const displayName = display_name || slugToDisplay(slug);

  // Stroke do sparkline conforme trend (fallback signature quando não há trend)
  const sparkStroke = trend?.direction
    ? SPARK_STROKE[trend.direction]
    : "var(--color-signature)";

  // Top 1 CP + top 1 CS
  const primaryCp = top_cp_owners[0];
  const primaryCs = top_cs_owners[0];

  // Pra tooltip dos avatares — nome capitalizado
  const cpName = useMemo(
    () => primaryCp?.email ? capitalizeFirst(localPartFromEmail(primaryCp.email).split(".")[0]) : null,
    [primaryCp]
  );
  const csName = useMemo(
    () => primaryCs?.email ? capitalizeFirst(localPartFromEmail(primaryCs.email).split(".")[0]) : null,
    [primaryCs]
  );

  return (
    <Card
      className={cn(
        "relative overflow-hidden p-5 cursor-pointer group",
        "border-border hover:border-signature/40 hover:bg-surface",
        "transition-[border-color,background-color,box-shadow] duration-150",
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
      {/* Stripe lateral de saúde — substitui o dot. Mesma "linguagem"
       *  visual do CampaignCardV2 (admin/Por mês). */}
      {health && (
        <span
          aria-hidden
          className={cn(
            "absolute left-0 top-0 bottom-0 w-[3px]",
            HEALTH_BAR[health]
          )}
          title={`Status: ${health}`}
        />
      )}

      {/* ── Header: nome + trend inline ────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 pb-3 border-b border-border">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-bold text-fg tracking-tight leading-tight truncate">
            {displayName}
          </h3>
          <div className="flex items-center gap-2 mt-1 text-[12px] text-fg-muted">
            <span>
              <span className="tabular-nums font-semibold text-fg">{total_campaigns}</span>{" "}
              campanha{total_campaigns === 1 ? "" : "s"}
            </span>
            {active_campaigns > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-success-soft text-success text-[10.5px] font-semibold tabular-nums leading-none">
                {active_campaigns} ativa{active_campaigns === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <TrendPill trend={trend} />
          <span className="text-[10.5px] text-fg-subtle tabular-nums">
            {formatTimeAgo(last_updated)}
          </span>
        </div>
      </div>

      {/* ── Sparkline com área de gradiente ────────────────────────── */}
      <div className="py-3 h-[60px] -mx-1 flex items-center">
        {sparkline?.length > 1 ? (
          <SparklineV2
            values={sparkline}
            stroke={sparkStroke}
            strokeWidth={1.6}
            fillOpacity={0.22}
            width={400}
            height={36}
            className="w-full"
            ariaLabel="Tendência de entrega nas últimas 12 semanas"
          />
        ) : (
          <div className="h-full w-full" aria-hidden="true" />
        )}
      </div>

      {/* ── Painel financeiro: eCPM (header tinted) + métricas ──────────
          Container rounded com 1 borda única isolando o bloco inteiro.
          eCPM band ocupa o topo do painel como "header" — bg-signature-soft
          + border-b serve de separador interno; bem mais limpo que ter
          border-y do wrapper externo COMPETINDO com border-t do grid. */}
      <div className="rounded-lg border border-border overflow-hidden">
        {admin_ecpm != null && (
          <div className={cn(
            "flex items-center justify-between gap-2 px-3 py-2.5 border-b border-border transition-colors",
            // Bg pastel pelo tier do eCPM (verde/amarelo/vermelho soft).
            // A cor do header é que comunica saúde — texto fica neutro.
            ecpmBgClass(admin_ecpm)
          )}>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.14em] font-bold text-fg-muted">
                eCPM real
              </span>
              <span
                className="text-[8.5px] uppercase tracking-widest font-semibold text-fg-subtle/70"
                title="Custo bruto do DSP / impressions × 1000 — não exibir para o cliente"
              >
                admin
              </span>
            </div>
            <span className="text-[18px] font-bold tabular-nums tracking-tight text-fg">
              {formatBRL(admin_ecpm)}
            </span>
          </div>
        )}
        <div className="grid grid-cols-3 py-3">
          <Metric
            label="DSP·VID"
            value={formatPacingValue(avg_pacing)}
            colorClass={pacingColorClass(avg_pacing)}
          />
          <Metric
            label="CTR"
            value={formatPct(avg_ctr, 2)}
            colorClass={ctrColorClass(avg_ctr)}
            divider
          />
          <Metric
            label="VTR"
            value={formatPct(avg_vtr, 1)}
            colorClass={vtrColorClass(avg_vtr)}
            divider
          />
        </div>
      </div>

      {/* ── Footer: só pips de owners (tooltip carrega o nome) ─────── */}
      <div className="flex items-center gap-2 pt-3">
        <div className="inline-flex">
          {primaryCp && cpName && (
            <Avatar name={cpName} role="cp" size="sm" title={`CP: ${cpName}`} />
          )}
          {primaryCs && csName && (
            <Avatar
              name={csName}
              role="cs"
              size="sm"
              className={primaryCp ? "-ml-1.5" : ""}
              title={`CS: ${csName}`}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

/** Métrica em formato label-acima / valor-abaixo, sem box.
 *  Centralizada na coluna do grid, com divisor à esquerda opcional
 *  (pra colunas 2 e 3 do bloco de métricas). */
function Metric({ label, value, colorClass, divider }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center text-center leading-tight",
        divider && "border-l border-border"
      )}
    >
      <span className="text-[9px] uppercase tracking-[0.14em] font-semibold text-fg-subtle">
        {label}
      </span>
      <span className={cn("text-[15px] font-bold tracking-tight tabular-nums mt-0.5", colorClass)}>
        {value}
      </span>
    </div>
  );
}

function capitalizeFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
