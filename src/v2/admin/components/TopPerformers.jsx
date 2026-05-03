// src/v2/admin/components/TopPerformers.jsx
//
// Layout dedicado de leaderboard — usado pelo LayoutToggle quando
// `layout === "performers"`. Mostra ranking de CS ou CP (toggle interno)
// com métricas agregadas completas em cada linha.
//
// Score (0–100) vem de aggregation.js#computeTopPerformers e pondera:
//   eCPM < R$ 0,35 (40 pts) · Pacing 100–125 (30 pts) ·
//   VTR > 80 (15 pts) · CTR > 0,25 (15 pts).
//
// Cada linha exibe:
//   - rank · avatar (iniciais) · nome
//   - 4 micro-metrics: Pacing DSP / Pacing VID / CTR / VTR / eCPM
//   - score numérico + barra de progresso colorida por banda
//
// O componente recebe `campaigns` e o `teamMap` e calcula internamente
// os rankings de CS e CP — assim o caller só precisa passar dados crus.

import { useState, useMemo, useEffect } from "react";
import { cn } from "../../../ui/cn";
import { formatBRL } from "../lib/format";
import { computeTopPerformers } from "../lib/aggregation";
import { saveDailySnapshot, getScoreNDaysAgo, loadSnapshots } from "../lib/scoreSnapshots";

function localPartFromEmail(email) {
  if (!email) return "";
  return email.split("@")[0].replace(/[._-]+/g, " ").trim();
}

function initialsFor(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function scoreTone(score) {
  if (score >= 80) return "success";
  if (score >= 60) return "signature";
  if (score >= 40) return "warning";
  return "danger";
}

function tonePacing(value) {
  if (value == null) return "muted";
  if (value < 90)  return "danger";
  if (value < 100) return "warning";
  if (value < 125) return "success";
  return "signature";
}

function toneEcpm(value) {
  if (value == null) return "muted";
  if (value < 0.70) return "success";
  if (value < 0.80) return "warning";
  return "danger";
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

const BAR_BG = {
  success:   "bg-success",
  signature: "bg-signature",
  warning:   "bg-warning",
  danger:    "bg-danger",
};

const TEXT_TONE = {
  muted:     "text-fg-subtle",
  success:   "text-success",
  signature: "text-signature",
  warning:   "text-warning",
  danger:    "text-danger",
  fg:        "text-fg",
};

function formatPctInt(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}
function formatPctTwo(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(Math.round(value * 100) / 100).toFixed(2)}%`;
}

function MicroMetric({ label, value, tone = "fg" }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-[9px] uppercase tracking-widest font-bold text-fg-subtle whitespace-nowrap leading-none">
        {label}
      </span>
      <span className={cn(
        "text-sm font-semibold tabular-nums whitespace-nowrap leading-none",
        TEXT_TONE[tone] || TEXT_TONE.fg
      )}>
        {value}
      </span>
    </div>
  );
}

function ScoreDelta({ current, previous }) {
  if (current == null || previous == null) return null;
  const delta = current - previous;
  const rounded = Math.round(delta * 10) / 10;
  if (Math.abs(rounded) < 0.1) {
    return (
      <span className="text-[10px] text-fg-subtle font-medium tabular-nums whitespace-nowrap">
        ▬ vs 7d
      </span>
    );
  }
  const isUp = rounded > 0;
  return (
    <span className={cn(
      "text-[10px] font-semibold tabular-nums whitespace-nowrap",
      isUp ? "text-success" : "text-danger"
    )}>
      {isUp ? "▲" : "▼"} {Math.abs(rounded).toFixed(1)} <span className="text-fg-subtle font-normal">vs 7d</span>
    </span>
  );
}

function PerformerRow({ rank, performer, displayName, scorePrev }) {
  const {
    email, score, campaign_count, ideal_pacing_count,
    dsp_pacing, vid_pacing, ctr, vtr, ecpm_avg,
  } = performer;
  const name = displayName || localPartFromEmail(email);
  const tone = scoreTone(score);
  const initials = initialsFor(name);

  return (
    <div className="flex items-center gap-4 px-4 py-4 rounded-lg hover:bg-canvas-deeper transition-colors border-t border-border/40 first:border-t-0">
      <span className="text-[11px] font-bold text-fg-subtle tabular-nums w-5 text-center flex-shrink-0">
        {rank}
      </span>

      {/* Identidade (col 1) */}
      <div className="flex items-center gap-3 min-w-0 w-[220px] flex-shrink-0">
        <span className="w-9 h-9 rounded-full bg-signature-soft text-signature font-bold text-xs flex items-center justify-center flex-shrink-0">
          {initials}
        </span>
        <div className="min-w-0 flex flex-col">
          <span className="text-sm font-semibold text-fg truncate capitalize">
            {name}
          </span>
          <span className="text-[11px] text-fg-subtle tabular-nums">
            {campaign_count} ativa{campaign_count === 1 ? "" : "s"}
            {ideal_pacing_count > 0 && (
              <> · {ideal_pacing_count}/{campaign_count} ideal</>
            )}
          </span>
        </div>
      </div>

      {/* Métricas agregadas (col 2 — flex grow) */}
      <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-2 min-w-0">
        <MicroMetric label="Pacing DSP" value={formatPctInt(dsp_pacing)} tone={tonePacing(dsp_pacing)} />
        <MicroMetric label="Pacing VID" value={formatPctInt(vid_pacing)} tone={tonePacing(vid_pacing)} />
        <MicroMetric label="CTR"        value={formatPctTwo(ctr)}        tone={toneCtr(ctr)} />
        <MicroMetric label="VTR"        value={formatPctTwo(vtr)}        tone={toneVtr(vtr)} />
        <MicroMetric label="eCPM"       value={formatBRL(ecpm_avg)}      tone={toneEcpm(ecpm_avg)} />
      </div>

      {/* Score (col 3) */}
      <div className="flex items-center gap-3 w-[200px] flex-shrink-0">
        <div className="flex-1 h-1.5 rounded-full bg-surface-strong overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-300", BAR_BG[tone])}
            style={{ width: `${Math.max(2, score)}%` }}
          />
        </div>
        <div className="flex flex-col items-end gap-0.5 w-14">
          <span className={cn(
            "text-lg font-bold tabular-nums leading-none",
            TEXT_TONE[tone]
          )}>
            {Math.round(score)}
          </span>
          <ScoreDelta current={score} previous={scorePrev} />
        </div>
      </div>
    </div>
  );
}

export function PerformersLayout({ campaigns, teamMap = {} }) {
  const [role, setRole] = useState("cs");
  const [snapshots, setSnapshots] = useState(() => loadSnapshots());

  const performers = useMemo(
    () => computeTopPerformers(campaigns, role === "cs" ? "cs_email" : "cp_email"),
    [campaigns, role]
  );

  // Salva snapshot diário 1x por dia por role na primeira vez que os
  // performers desse role aparecem na sessão. saveDailySnapshot é
  // idempotente — chamadas extras no mesmo dia não sobrescrevem.
  useEffect(() => {
    if (!performers.length) return;
    const next = saveDailySnapshot(role, performers);
    setSnapshots(next);
  }, [role, performers]);

  if (!campaigns || !campaigns.length) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <p className="text-sm text-fg-muted">Nenhuma campanha pra ranquear.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header com toggle CS/CP + descrição */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-fg">
            Top Performers — {role === "cs" ? "CS" : "CP"}
          </h2>
          <p className="text-[11px] text-fg-subtle mt-0.5">
            Ranking entre {performers.length}{" "}
            {role === "cs" ? "Customer Success" : "Customer Planner"}{" "}
            com campanhas ativas
          </p>
        </div>
        <RoleToggle value={role} onChange={setRole} />
      </div>

      {/* Lista */}
      {performers.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center">
          <p className="text-sm text-fg-muted">
            Nenhum {role === "cs" ? "CS" : "CP"} com campanhas ativas no momento.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface overflow-hidden">
          {performers.map((p, i) => (
            <PerformerRow
              key={p.email}
              rank={i + 1}
              performer={p}
              displayName={teamMap[p.email]}
              scorePrev={getScoreNDaysAgo(snapshots, role, p.email, 7)}
            />
          ))}
        </div>
      )}

      {/* Legenda */}
      <p className="text-[11px] text-fg-subtle px-1 leading-relaxed">
        Score (0–100) · eCPM &lt; R$ 0,70 (35 pts) · Pacing 100–125% (30 pts)
        · CTR &gt; 0,25% (25 pts) · VTR &gt; 80% (10 pts) · ponderado por
        impressões e regredido à média do time via Empirical Bayes —
        CSs com poucas campanhas convergem pra média do time pra evitar
        viés de amostra pequena. Métricas (Pacing/CTR/VTR/eCPM) são
        agregadas via Σnumerador / Σdenominador sobre as campanhas ativas
        do owner.
      </p>
    </div>
  );
}

function RoleToggle({ value, onChange }) {
  return (
    <div
      role="tablist"
      aria-label="Tipo de owner"
      className="inline-flex gap-0.5 p-0.5 rounded-lg bg-canvas-deeper border border-border"
    >
      {[
        { value: "cs", label: "CS" },
        { value: "cp", label: "CP" },
      ].map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center px-3 h-7 rounded-md cursor-pointer",
              "text-xs font-medium",
              "transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
              active
                ? "bg-canvas-elevated text-fg shadow-sm"
                : "text-fg-muted hover:text-fg hover:bg-surface-strong"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
