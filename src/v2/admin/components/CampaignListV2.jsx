// src/v2/admin/components/CampaignListV2.jsx
//
// List view densa estilo Linear/Vercel — uma linha por campanha com
// alinhamento tabular, hover state e click pra abrir drawer.
//
// Densidade ~3x maior que cards: ~25 campanhas visíveis numa tela
// padrão sem scroll. Pra o modo "operação em volume".
//
// Grid columns (px):
//   24px  status dot
//   1fr   cliente / campanha (multi-line)
//   140   datas
//   72    DSP PAC
//   72    VID PAC
//   62    CTR
//   62    VTR
//   80    owners (avatar stack)
//   24    chevron

import { cn } from "../../../ui/cn";
import { Avatar } from "../../../ui/Avatar";
import { TokenChip } from "./TokenChip";
import {
  formatPacingValue,
  formatPct,
  pacingColorClass,
  ctrColorClass,
  vtrColorClass,
  getCampaignStatus,
  getDateRangeParts,
  endUrgencyClass,
  isEarlyEnded,
  localPartFromEmail,
} from "../lib/format";
import { schedulePrefetch, cancelPrefetch } from "../../../lib/prefetchReport";

// 4 tiers de health (ver CampaignCardV2 pra discussão de design); aqui
// só precisamos dos dots — a Row é compacta e não usa glow.
// `awaiting` = campanha terminou mas falta fechamento manual (badge âmbar).
// `paused`   = pausa temporária (dot signature azul).
const HEALTH_DOT = {
  healthy:   "bg-success",
  over:      "bg-signature",
  attention: "bg-warning",
  critical:  "bg-danger",
  awaiting:  "bg-warning",
  paused:    "bg-signature",
  ended:     "bg-fg-subtle/60",
};

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
  const order = ["critical", "attention", "healthy", "over"];
  const tiers = cands.map(tierOf);
  for (const t of order) if (tiers.includes(t)) return t;
  return "healthy";
}

const GRID =
  "grid-cols-[20px_minmax(0,1.7fr)_minmax(0,1fr)_72px_72px_62px_62px_80px_20px]";

export function CampaignListV2({ campaigns, onOpen, onOpenReport, teamMap = {} }) {
  if (!campaigns?.length) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <p className="text-sm text-fg-muted">Nenhuma campanha encontrada com os filtros atuais.</p>
      </div>
    );
  }

  // Mobile: a lista densa tem 388px de larguras fixas + 2 colunas fr,
  // estourando viewport <430px. Em vez de redesenhar a lista pra mobile
  // (perderia a UX de scan rápido), envolvemos o grid num scroll horizontal.
  // O caller fica do lado de fora (border-radius preservado), e dentro do
  // wrapper o min-w-[720px] força o grid a ficar legível independente do
  // viewport — touch swipe horizontal é UX padrão pra tabelas densas em
  // mobile (Linear, Notion, Stripe Dashboard fazem assim).
  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="overflow-x-auto scrollbar-hidden">
        <div className="min-w-[720px]">
          {/* Header */}
          <div
            className={cn(
              "grid gap-2 px-4 py-2.5 bg-surface-strong border-b border-border",
              "text-[10px] uppercase tracking-widest font-bold text-fg-subtle",
              GRID
            )}
          >
            <span></span>
            <span>Cliente · Campanha</span>
            <span>Período</span>
            <span className="text-right">DSP Pac</span>
            <span className="text-right">Vid Pac</span>
            <span className="text-right">CTR</span>
            <span className="text-right">VTR</span>
            <span className="text-center">Owners</span>
            <span></span>
          </div>

          {/* Rows */}
          {campaigns.map((c) => (
            <Row
              key={c.short_token}
              campaign={c}
              onOpen={onOpen}
              onOpenReport={onOpenReport}
              teamMap={teamMap}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Célula de período da list view densa. Destaca "→ hoje" (danger) ou
 * "→ amanhã" (warning) quando aplicável, mesma régua do card.
 */
function DateRangeCell({ startISO, endISO }) {
  const parts = getDateRangeParts(startISO, endISO);
  if (!parts) {
    return <span className="font-mono text-[10.5px] text-fg-muted tabular-nums" />;
  }
  return (
    <span className="font-mono text-[10.5px] text-fg-muted tabular-nums">
      {parts.startStr} → <span className={endUrgencyClass(parts.endUrgency)}>{parts.endStr}</span>
    </span>
  );
}

function Row({ campaign, onOpen, onOpenReport, teamMap }) {
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
    merge_id,
    closed_at,
    paused_at,
    early_end_date,
  } = campaign;

  const effectiveEndDate = early_end_date || end_date;
  const earlyEnded = isEarlyEnded(early_end_date);
  const status   = getCampaignStatus(end_date, closed_at, paused_at, early_end_date);
  const ended    = status === "ended";
  const awaiting = status === "awaiting_closure";
  const paused   = status === "paused";
  const health   = ended    ? "ended"
                 : awaiting ? "awaiting"
                 : paused   ? "paused"
                 : classifyHealth(display_pacing, video_pacing);
  const cpName = cp_email ? (teamMap[cp_email] || localPartFromEmail(cp_email)) : null;
  const csName = cs_email ? (teamMap[cs_email] || localPartFromEmail(cs_email)) : null;

  const dimColor = "text-fg-subtle";
  const colorPacing = (p) => (ended ? dimColor : pacingColorClass(p));
  const colorCtr    = (v) => (ended ? dimColor : ctrColorClass(v));
  const colorVtr    = (v) => (ended ? dimColor : vtrColorClass(v));

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(campaign)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen?.(campaign);
        if (e.key === "ArrowRight") onOpenReport?.(short_token);
      }}
      onMouseEnter={() => schedulePrefetch(short_token)}
      onMouseLeave={() => cancelPrefetch(short_token)}
      onFocus={() => schedulePrefetch(short_token)}
      className={cn(
        "grid gap-2 items-center px-4 py-2.5 border-b border-border last:border-0",
        "text-[12px] cursor-pointer transition-colors",
        // hover/focus precisam ser visíveis em LIGHT (onde signature-soft
        // já tem alpha 0.12 — dividir mais virava ~0.05 invisível).
        // Usar signature-soft direto dá feedback claro em ambos os temas.
        "hover:bg-signature-soft focus-visible:outline-none focus-visible:bg-signature-soft",
        ended && "opacity-65",
        GRID
      )}
    >
      {/* Status dot */}
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          health ? HEALTH_DOT[health] : "bg-fg-subtle/30"
        )}
        title={
          health === "awaiting" ? "Aguardando fechamento"
          : health === "paused" ? "Pausada"
          : health ? `Status: ${health}`
          : "Sem dados"
        }
      />

      {/* Cliente · Campanha */}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-fg truncate">{client_name}</span>
          <TokenChip token={short_token} variant="compact" />
          {merge_id && (
            <span
              className="text-[8.5px] uppercase tracking-widest font-bold text-signature px-1 rounded bg-signature/10"
              title="Pertence a um grupo agrupado"
            >
              grupo
            </span>
          )}
          {paused && (
            <span
              className="text-[8.5px] uppercase tracking-widest font-bold text-signature px-1 rounded bg-signature/10 border border-signature/30"
              title="Pausada temporariamente — retomar no drawer"
            >
              pausada
            </span>
          )}
          {awaiting && (
            <span
              className="text-[8.5px] uppercase tracking-widest font-bold text-warning px-1 rounded bg-warning-soft border border-warning/30"
              title="Aguardando fechamento — marcar como encerrada no drawer"
            >
              fechar
            </span>
          )}
          {/* Chip "antecipada" só após early_end_date passar (status=ended).
              Antes disso, o admin vê o estado no drawer mas não polui a row. */}
          {ended && earlyEnded && (
            <span
              className="text-[8.5px] uppercase tracking-widest font-bold text-danger px-1 rounded bg-danger-soft border border-danger/30"
              title="Encerrada antes do previsto — motivo no drawer (admin)"
            >
              antecipada
            </span>
          )}
        </div>
        <p className="text-[11px] text-fg-muted truncate mt-0.5">{campaign_name}</p>
      </div>

      {/* Período — end com cor de urgência (hoje/amanhã) quando aplicável.
          Usa effective end (early_end_date quando setada). */}
      <DateRangeCell startISO={start_date} endISO={effectiveEndDate} />

      {/* DSP Pac */}
      <span className={cn("text-right tabular-nums font-semibold", colorPacing(display_pacing))}>
        {display_pacing != null ? formatPacingValue(display_pacing) : <span className="text-fg-disabled">—</span>}
      </span>

      {/* Vid Pac */}
      <span className={cn("text-right tabular-nums font-semibold", colorPacing(video_pacing))}>
        {video_pacing != null ? formatPacingValue(video_pacing) : <span className="text-fg-disabled">—</span>}
      </span>

      {/* CTR */}
      <span className={cn("text-right tabular-nums font-semibold", colorCtr(display_ctr))}>
        {display_ctr != null ? formatPct(display_ctr, 2) : <span className="text-fg-disabled">—</span>}
      </span>

      {/* VTR */}
      <span className={cn("text-right tabular-nums font-semibold", colorVtr(video_vtr))}>
        {video_vtr != null ? formatPct(video_vtr, 1) : <span className="text-fg-disabled">—</span>}
      </span>

      {/* Owners */}
      <div className="flex items-center justify-center">
        {cpName && <Avatar name={cpName} role="cp" size="xs" title={`CP: ${cpName}`} />}
        {csName && <Avatar name={csName} role="cs" size="xs" className={cpName ? "-ml-1" : ""} title={`CS: ${csName}`} />}
      </div>

      {/* Chevron */}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           className="text-fg-subtle">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </div>
  );
}
