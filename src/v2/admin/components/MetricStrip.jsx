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

import { useEffect, useRef, useState } from "react";
import { cn } from "../../../ui/cn";
import { formatBRL } from "../lib/format";

/**
 * Anima um valor numérico do anterior pro novo via requestAnimationFrame
 * com easing ease-out-cubic. Usado nos KPIs do topo pra dar sensação de
 * "atualizou" quando o refetch traz números novos — antes o valor pulava
 * sem aviso (admin não sabia que houve refresh).
 *
 * - Primeiro render: sem animação (prev === target inicial, retorna direto)
 * - target/prev null: sem animação (não dá pra animar de/para "—")
 * - Mesmo valor: sem animação (early return)
 */
function useAnimatedNumber(target, duration = 600) {
  const [value, setValue] = useState(target);
  const prevTarget = useRef(target);

  useEffect(() => {
    if (target === prevTarget.current) return;
    if (target == null || prevTarget.current == null) {
      setValue(target);
      prevTarget.current = target;
      return;
    }
    const start = prevTarget.current;
    const startTime = performance.now();
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out-cubic
      setValue(start + (target - start) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    prevTarget.current = target;
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}

/**
 * Wrapper que aplica useAnimatedNumber + passa o valor interpolado pro
 * formatter. Renderiza string formatada — MetricCard espera ReactNode.
 */
function AnimatedValue({ value, format }) {
  const animated = useAnimatedNumber(value);
  return format(animated);
}

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
  // Padding e tipografia mobile-first: cards em 2 colunas a 375px ficam
  // ~165px de largura — `text-2xl` (24px) ainda cabe pra valores curtos
  // ("165,1k", "R$ 14,40"), mas `whitespace-nowrap` no footer estoura
  // quando MetricDelta carrega "▼ 12.4% vs últimas 30d" (~150px).
  // Solução: footer permite quebrar linha em mobile (default), nowrap
  // só em md+ onde temos largura sobrando.
  return (
    <div className="rounded-xl border border-border bg-surface px-3.5 py-4 sm:px-4 sm:py-5 flex flex-col gap-2 min-w-0">
      <span className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle whitespace-nowrap">
        {label}
      </span>
      <span className={cn(
        "text-xl sm:text-2xl font-bold tracking-tight tabular-nums leading-none whitespace-nowrap",
        TONE_CLASS[tone] || TONE_CLASS.fg
      )}>
        {value}
      </span>
      {footer && (
        <div className="text-[11px] text-fg-subtle leading-snug md:leading-none md:whitespace-nowrap">
          {footer}
        </div>
      )}
    </div>
  );
}

// Delta vs cohort que encerrou nos últimos 30 dias.
//   goodDirection="down": queda é bom (eCPM — mais eficiente)
//   goodDirection="up":   alta é bom (CTR/VTR — performance maior)
function MetricDelta({ current, previous, goodDirection = "up" }) {
  if (current == null || previous == null || previous <= 0) {
    return (
      <span className="text-[11px] text-fg-subtle whitespace-nowrap">
        sem comparativo
      </span>
    );
  }
  const deltaPct = ((current - previous) / previous) * 100;
  const rounded = Math.round(deltaPct * 10) / 10;

  const isFlat = Math.abs(rounded) < 0.1;
  const isDown = rounded < 0;
  const isGood = isFlat ? false : goodDirection === "down" ? isDown : !isDown;
  const colorClass = isFlat
    ? "text-fg-subtle"
    : isGood
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
    ctr_prev,
    vtr,
    vtr_prev,
    ecpm,
    ecpm_prev,
    ecpm_display,
    ecpm_display_prev,
    ecpm_video,
    ecpm_video_prev,
  } = summary;

  // Fallback pra eCPM combinado quando o backend ainda não envia os splits
  // por mídia (d_admin_total_cost / v_admin_total_cost). Mantém o card único
  // de eCPM até o redeploy.
  const hasSplit = ecpm_display != null || ecpm_video != null;

  return (
    <div
      className={cn(
        "grid grid-cols-2 sm:grid-cols-3 gap-3",
        hasSplit ? "lg:grid-cols-7" : "lg:grid-cols-6",
        className
      )}
      role="region"
      aria-label="Performance das campanhas ativas"
    >
      <MetricCard
        label="Ativas"
        value={<AnimatedValue value={active_count} format={(n) => n == null ? "—" : Math.round(n)} />}
      />
      <MetricCard
        label="Pacing DSP"
        value={<AnimatedValue value={dsp_pacing} format={formatPct} />}
        tone={tonePacing(dsp_pacing)}
      />
      <MetricCard
        label="Pacing VID"
        value={<AnimatedValue value={vid_pacing} format={formatPct} />}
        tone={tonePacing(vid_pacing)}
      />
      <MetricCard
        label="CTR"
        value={<AnimatedValue value={ctr} format={formatPctTwo} />}
        tone={toneCtr(ctr)}
        footer={<MetricDelta current={ctr} previous={ctr_prev} goodDirection="up" />}
      />
      <MetricCard
        label="VTR"
        value={<AnimatedValue value={vtr} format={formatPctTwo} />}
        tone={toneVtr(vtr)}
        footer={<MetricDelta current={vtr} previous={vtr_prev} goodDirection="up" />}
      />
      {hasSplit ? (
        <>
          <MetricCard
            label="eCPM Display"
            value={<AnimatedValue value={ecpm_display} format={formatBRL} />}
            footer={<MetricDelta current={ecpm_display} previous={ecpm_display_prev} goodDirection="down" />}
          />
          <MetricCard
            label="eCPM Video"
            value={<AnimatedValue value={ecpm_video} format={formatBRL} />}
            footer={<MetricDelta current={ecpm_video} previous={ecpm_video_prev} goodDirection="down" />}
          />
        </>
      ) : (
        <MetricCard
          label="eCPM"
          value={<AnimatedValue value={ecpm} format={formatBRL} />}
          footer={<MetricDelta current={ecpm} previous={ecpm_prev} goodDirection="down" />}
        />
      )}
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
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 cursor-pointer",
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
