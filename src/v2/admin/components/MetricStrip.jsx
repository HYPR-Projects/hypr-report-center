// src/v2/admin/components/MetricStrip.jsx
//
// Faixa de KPIs no topo do menu admin — substitui os 4 cards de Worklist
// (action-oriented) por 6 cards de performance (KPIs) das campanhas ativas.
//
// Layout: grid responsivo 2/3/6 colunas, cards bordados leves pra dar
// estrutura sem peso. eCPM tem delta vs cohort que encerrou nos últimos
// 30 dias (verde se caiu = mais eficiente, vermelho se subiu).
//
// Alertas operacionais (críticas, sem owner, encerram em 7d) descem pra
// uma linha discreta de pills via SecondaryAlerts — preserva a função
// de filtro do worklist sem competir com os números.

import { cn } from "../../../ui/cn";
import { formatBRL } from "../lib/format";

function formatPct(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}

function formatPctTwo(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(Math.round(value * 100) / 100).toFixed(2)}%`;
}

function tonePacing(value) {
  if (value == null) return "muted";
  if (value < 90)  return "danger";
  if (value < 100) return "warning";
  if (value < 125) return "success";
  return "signature";
}

function toneCtr(value) {
  if (value == null)  return "muted";
  if (value >= 0.6)   return "success";
  if (value >= 0.5)   return "warning";
  return "danger";
}

function toneVtr(value) {
  if (value == null) return "muted";
  return value >= 80 ? "success" : "danger";
}

const TONE_CLASS = {
  muted:     "text-fg-subtle",
  danger:    "text-danger",
  warning:   "text-warning",
  success:   "text-success",
  signature: "text-signature",
  fg:        "text-fg",
};

function MetricCard({ label, value, tone = "fg", footer }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-5 flex flex-col gap-2 min-w-0">
      <span className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle whitespace-nowrap">
        {label}
      </span>
      <span className={cn(
        "text-2xl font-bold tracking-tight tabular-nums leading-none whitespace-nowrap",
        TONE_CLASS[tone] || TONE_CLASS.fg
      )}>
        {value}
      </span>
      {footer && (
        <div className="text-[11px] text-fg-subtle whitespace-nowrap leading-none">
          {footer}
        </div>
      )}
    </div>
  );
}

function EcpmDelta({ current, previous }) {
  if (current == null || previous == null || previous <= 0) {
    return (
      <span className="text-[11px] text-fg-subtle whitespace-nowrap">
        sem comparativo
      </span>
    );
  }
  const deltaPct = ((current - previous) / previous) * 100;
  const rounded = Math.round(deltaPct * 10) / 10;

  // Para eCPM: queda = bom (mais eficiente), alta = ruim.
  const isFlat = Math.abs(rounded) < 0.1;
  const isDown = rounded < 0;
  const colorClass = isFlat
    ? "text-fg-subtle"
    : isDown
    ? "text-success"
    : "text-danger";
  const arrow = isFlat ? "•" : isDown ? "▼" : "▲";

  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", colorClass)}>
      <span className="text-[10px] leading-none">{arrow}</span>
      <span className="tabular-nums">{Math.abs(rounded).toFixed(1)}%</span>
      <span className="text-fg-subtle font-normal">vs últimas 30d</span>
    </span>
  );
}

export function MetricStrip({ summary, className }) {
  if (!summary) return null;

  const {
    active_count,
    dsp_pacing,
    vid_pacing,
    ctr,
    vtr,
    ecpm,
    ecpm_prev,
  } = summary;

  return (
    <div
      className={cn(
        "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3",
        className
      )}
      role="region"
      aria-label="Performance das campanhas ativas"
    >
      <MetricCard label="Ativas" value={active_count} />
      <MetricCard
        label="Pacing DSP"
        value={formatPct(dsp_pacing)}
        tone={tonePacing(dsp_pacing)}
      />
      <MetricCard
        label="Pacing VID"
        value={formatPct(vid_pacing)}
        tone={tonePacing(vid_pacing)}
      />
      <MetricCard label="CTR" value={formatPctTwo(ctr)} tone={toneCtr(ctr)} />
      <MetricCard label="VTR" value={formatPctTwo(vtr)} tone={toneVtr(vtr)} />
      <MetricCard
        label="eCPM"
        value={formatBRL(ecpm)}
        footer={<EcpmDelta current={ecpm} previous={ecpm_prev} />}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SecondaryAlerts — pills discretos abaixo da grid de KPIs. Mantém a
// função de filtro do worklist (críticas, sem owner, encerram em 7d) sem
// competir com os números agregados acima.
// ─────────────────────────────────────────────────────────────────────────────
const SECONDARY = [
  { key: "pacing_critical", label: "críticas",         dotClass: "bg-danger",  glow: "shadow-[var(--shadow-glow-danger)]" },
  { key: "no_owner",        label: "sem owner",        dotClass: "bg-warning", glow: "" },
  { key: "ending_soon",     label: "encerram em 7d",   dotClass: "bg-success", glow: "" },
];

export function SecondaryAlerts({ worklist, activeKey, onSelect, className }) {
  if (!worklist) return null;
  const items = SECONDARY
    .map((s) => ({ ...s, count: worklist[s.key]?.count || 0 }))
    .filter((s) => s.count > 0);
  if (!items.length) return null;

  return (
    <div className={cn("flex items-center flex-wrap gap-x-4 gap-y-2 text-xs", className)}>
      {items.map((s, i) => {
        const isActive = activeKey === s.key;
        return (
          <span key={s.key} className="flex items-center gap-4">
            {i > 0 && <span aria-hidden className="w-0.5 h-0.5 rounded-full bg-fg-subtle" />}
            <button
              type="button"
              onClick={() => onSelect?.(isActive ? null : s.key)}
              aria-pressed={isActive}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
                "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature/40",
                isActive
                  ? "bg-surface-strong text-fg border border-border"
                  : "text-fg-subtle hover:text-fg"
              )}
            >
              <span className={cn("w-1.5 h-1.5 rounded-full", s.dotClass, s.glow)} />
              <span className="tabular-nums font-bold text-fg-muted">{s.count}</span>
              <span>{s.label}</span>
            </button>
          </span>
        );
      })}
    </div>
  );
}
