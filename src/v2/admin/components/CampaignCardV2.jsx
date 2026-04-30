// src/v2/admin/components/CampaignCardV2.jsx
//
// Card de campanha do menu admin V2. Substitui src/components/CampaignCard.jsx
// (legacy 257 linhas com inline styles).
//
// Diferenças do legacy:
//   - sem botões de ação (Loom, Survey, Logo, Owner, Link Cliente) — eles
//     agora vivem no Drawer que abre ao clicar no card.
//   - status dot na esquerda (saúde do pacing)
//   - métricas em pills compactas, tabular-nums
//   - Avatar pips em vez de chips coloridos preenchidos
//   - hover state suave (1px lift + glow signature)
//   - light/dark via tokens (sem props de tema)
//
// Click no card → abre o drawer (callback `onOpen`).
// Click em "Ver Report" → navega pro report (`onOpenReport`).
// Click em "Copiar link" → callback inline (`onCopyLink`).

import { cn } from "../../../ui/cn";
import { Card } from "../../../ui/Card";
import { Avatar } from "../../../ui/Avatar";
import {
  formatDateRange,
  formatPacingValue,
  formatPct,
  pacingColorClass,
  ctrColorClass,
  vtrColorClass,
  isCampaignEnded,
  localPartFromEmail,
} from "../lib/format";

// 4 níveis de health, cada um espelhando uma faixa da régua de pacing
// (definida em format.js). Verde e azul são ambos saudáveis — azul
// sinaliza over-delivery ≥125%. Cinza é fallback (sem dado pra classificar).
const HEALTH_DOT = {
  healthy:   "bg-success",       // 100–124%
  over:      "bg-signature",     // ≥125%
  attention: "bg-warning",       // 90–99%
  critical:  "bg-danger",        // <90%
  ended:     "bg-fg-subtle/60",  // campanha encerrada — neutralizada
};

const HEALTH_GLOW = {
  healthy:   "shadow-[var(--shadow-glow-success)]",
  over:      "shadow-[var(--shadow-glow-signature)]",
  attention: "shadow-[var(--shadow-glow-warning)]",
  critical:  "shadow-[var(--shadow-glow-danger)]",
  ended:     "",  // sem glow quando encerrada
};

/**
 * Classifica health a partir do PIOR pacing entre DSP e VID.
 *
 * Severidade descendente: critical > attention > healthy > over.
 * Ou seja: se uma métrica está crítica e a outra over, mostra crítico.
 * Se uma é "no alvo" (healthy 100–124) e a outra é over (≥125), mostra
 * a mais conservadora (healthy) — tratamos verde como o estado "neutro
 * positivo" e azul como destaque, então quando há mistura preferimos
 * a leitura conservadora.
 */
function classifyHealth(displayPacing, videoPacing) {
  const cands = [];
  if (displayPacing != null) cands.push(Number(displayPacing));
  if (videoPacing   != null) cands.push(Number(videoPacing));
  if (!cands.length) return null;

  const tierOf = (p) => {
    if (p < 90)  return "critical";
    if (p < 100) return "attention";
    if (p < 125) return "healthy";
    return "over";
  };
  // Ordem de prioridade: pior cor ganha
  const order = ["critical", "attention", "healthy", "over"];
  const tiers = cands.map(tierOf);
  for (const t of order) if (tiers.includes(t)) return t;
  return "healthy";
}

export function CampaignCardV2({
  campaign,
  onOpen,
  onOpenReport,
  teamMap = {},
}) {
  const {
    short_token,
    client_name,
    campaign_name,
    start_date,
    end_date,
    display_pacing,
    video_pacing,
    display_ctr,
    video_vtr,
    cp_email,
    cs_email,
  } = campaign;

  const ended  = isCampaignEnded(end_date);
  const health = ended ? "ended" : classifyHealth(display_pacing, video_pacing);
  const cpName = cp_email ? (teamMap[cp_email] || localPartFromEmail(cp_email)) : null;
  const csName = cs_email ? (teamMap[cs_email] || localPartFromEmail(cs_email)) : null;

  // Encerrada: neutraliza cor condicional dos números (texto cinza,
  // sem alarmar). Visualmente o card vira "histórico" — operação não
  // precisa mais agir.
  const dimColor = "text-fg-subtle";
  const colorPacing = (p) => (ended ? dimColor : pacingColorClass(p));
  const colorCtr    = (v) => (ended ? dimColor : ctrColorClass(v));
  const colorVtr    = (v) => (ended ? dimColor : vtrColorClass(v));

  return (
    <Card
      className={cn(
        "px-4 py-3.5 cursor-pointer group",
        "transition-all duration-150",
        "hover:border-signature/40 hover:bg-surface",
        ended && "opacity-65"
      )}
      onClick={() => onOpen?.(campaign)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(campaign);
        }
      }}
    >
      <div className="flex items-center gap-4">
        {/* Status dot + cliente/campanha */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
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
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-fg tracking-tight truncate">
                {client_name}
              </h3>
              <span className="font-mono text-[10px] text-fg-subtle tracking-wider px-1.5 py-0.5 rounded bg-surface border border-border">
                {short_token}
              </span>
            </div>
            <p className="text-[12px] text-fg-muted mt-0.5 truncate">
              {campaign_name}
            </p>
            <p className="text-[10.5px] text-fg-subtle mt-1 tabular-nums">
              {formatDateRange(start_date, end_date)}
            </p>
          </div>
        </div>

        {/* Métricas em pills */}
        <div className="hidden md:flex items-center gap-1.5 shrink-0">
          {display_pacing != null && (
            <MetricPill label="DSP PAC" value={formatPacingValue(display_pacing)} colorClass={colorPacing(display_pacing)} />
          )}
          {video_pacing != null && (
            <MetricPill label="VID PAC" value={formatPacingValue(video_pacing)} colorClass={colorPacing(video_pacing)} />
          )}
          {display_ctr != null && (
            <MetricPill label="CTR" value={formatPct(display_ctr, 2)} colorClass={colorCtr(display_ctr)} />
          )}
          {video_vtr != null && (
            <MetricPill label="VTR" value={formatPct(video_vtr, 1)} colorClass={colorVtr(video_vtr)} />
          )}
        </div>

        {/* Owners + ação primária */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden sm:inline-flex">
            {cpName && <Avatar name={cpName} role="cp" size="sm" title={`CP: ${cpName}`} />}
            {csName && <Avatar name={csName} role="cs" size="sm" className={cpName ? "-ml-1.5" : ""} title={`CS: ${csName}`} />}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenReport?.(short_token);
            }}
            className={cn(
              "inline-flex items-center gap-1 h-8 px-3 rounded-md",
              "bg-signature text-white text-xs font-semibold",
              "hover:bg-signature-hover transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            )}
          >
            Ver Report
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>
      </div>
    </Card>
  );
}

function MetricPill({ label, value, colorClass }) {
  return (
    <div className="flex flex-col items-center px-2.5 py-1 rounded-md bg-surface border border-border min-w-[58px]">
      <span className="text-[8.5px] uppercase tracking-widest font-bold text-fg-subtle">
        {label}
      </span>
      <span className={cn("text-[12px] font-bold tabular-nums leading-tight mt-0.5", colorClass)}>
        {value}
      </span>
    </div>
  );
}
