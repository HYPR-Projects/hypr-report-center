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
import {
  formatDateRange,
  formatPacingValue,
  formatPct,
  pacingColorClass,
  localPartFromEmail,
} from "../lib/format";

const HEALTH_DOT = {
  healthy:   "bg-success",
  attention: "bg-warning",
  critical:  "bg-danger",
};

function classifyHealth(displayPacing, videoPacing) {
  const cands = [];
  if (displayPacing != null) cands.push(Number(displayPacing));
  if (videoPacing   != null) cands.push(Number(videoPacing));
  if (!cands.length) return null;
  const worst = cands.reduce((a, b) => (Math.abs(a - 100) > Math.abs(b - 100) ? a : b));
  if (worst > 140 || worst < 75) return "critical";
  if (worst > 115 || worst < 85) return "attention";
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

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
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
  } = campaign;

  const health = classifyHealth(display_pacing, video_pacing);
  const cpName = cp_email ? (teamMap[cp_email] || localPartFromEmail(cp_email)) : null;
  const csName = cs_email ? (teamMap[cs_email] || localPartFromEmail(cs_email)) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(campaign)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen?.(campaign);
        if (e.key === "ArrowRight") onOpenReport?.(short_token);
      }}
      className={cn(
        "grid gap-2 items-center px-4 py-2.5 border-b border-border last:border-0",
        "text-[12px] cursor-pointer transition-colors",
        "hover:bg-signature-soft/40 focus-visible:outline-none focus-visible:bg-signature-soft/60",
        GRID
      )}
    >
      {/* Status dot */}
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          health ? HEALTH_DOT[health] : "bg-fg-subtle/30"
        )}
        title={health ? `Status: ${health}` : "Sem dados"}
      />

      {/* Cliente · Campanha */}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-fg truncate">{client_name}</span>
          <span className="font-mono text-[9.5px] text-fg-subtle tracking-wider px-1 rounded bg-canvas-elevated">
            {short_token}
          </span>
        </div>
        <p className="text-[11px] text-fg-muted truncate mt-0.5">{campaign_name}</p>
      </div>

      {/* Período */}
      <span className="font-mono text-[10.5px] text-fg-muted tabular-nums">
        {formatDateRange(start_date, end_date)}
      </span>

      {/* DSP Pac */}
      <span className={cn("text-right tabular-nums font-semibold", pacingColorClass(display_pacing))}>
        {display_pacing != null ? formatPacingValue(display_pacing) : <span className="text-fg-disabled">—</span>}
      </span>

      {/* Vid Pac */}
      <span className={cn("text-right tabular-nums font-semibold", pacingColorClass(video_pacing))}>
        {video_pacing != null ? formatPacingValue(video_pacing) : <span className="text-fg-disabled">—</span>}
      </span>

      {/* CTR */}
      <span className="text-right tabular-nums font-semibold text-success">
        {display_ctr != null ? formatPct(display_ctr, 2) : <span className="text-fg-disabled">—</span>}
      </span>

      {/* VTR */}
      <span className="text-right tabular-nums font-semibold text-success">
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
