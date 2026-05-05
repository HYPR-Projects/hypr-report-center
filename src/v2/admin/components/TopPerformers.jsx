// src/v2/admin/components/TopPerformers.jsx
//
// Layout dedicado de leaderboard — usado pelo LayoutToggle quando
// `layout === "performers"`. Mostra ranking de CS ou CP (toggle interno)
// com métricas agregadas completas em cada linha.
//
// Score vem de aggregation.js#computeTopPerformers. Só Display contribui
// pra eCPM/CTR; Video é avaliado apenas via Pacing + VTR. ABS torna os
// thresholds Display mais permissivos (inventário com pre-bid é mais caro):
//   eCPM    Display < R$ 0,70 / R$ 1,50 ABS  (30 pts × peso Display)
//   CTR     Display > 0,7% / 0,5% ABS        (25 pts × peso Display)
//   VTR     Video   > 80%                    (10 pts × peso Video)
//   Pacing  100–125% gradiente               (35 pts, ponderado entre mídias)
// Max teórico: 100% Display = 90 pts | 100% Video = 45 pts | 50/50 = 67.5.
// Score normalizado pelo max_total da composição, frame "X / max" justo.
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
import { saveDailySnapshot, getPreviousScore, loadSnapshots } from "../lib/scoreSnapshots";
import { PerformerDrawer } from "./PerformerDrawer";

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
    <div className="flex flex-col gap-1 min-w-0 lg:pl-3 lg:border-l lg:border-border/40 lg:first:border-l-0 lg:first:pl-0">
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
  if (current == null || !previous) return null;
  const delta = current - previous.score;
  const rounded = Math.round(delta * 10) / 10;
  // Label adapta ao gap: "vs ontem" se daysAgo=1, "vs Xd" se maior.
  const label = previous.daysAgo === 1 ? "vs ontem" : `vs ${previous.daysAgo}d`;
  if (Math.abs(rounded) < 0.1) {
    return (
      <span className="text-[10px] text-fg-subtle font-medium tabular-nums whitespace-nowrap">
        ▬ {label}
      </span>
    );
  }
  const isUp = rounded > 0;
  return (
    <span className={cn(
      "text-[10px] font-semibold tabular-nums whitespace-nowrap",
      isUp ? "text-success" : "text-danger"
    )}>
      {isUp ? "▲" : "▼"} {Math.abs(rounded).toFixed(1)} <span className="text-fg-subtle font-normal">{label}</span>
    </span>
  );
}

function PerformerRow({ rank, performer, displayName, scorePrev, onClick }) {
  const {
    email, score, breakdown: bd, campaign_count, ideal_pacing_count,
    dsp_pacing, vid_pacing, ctr, vtr, ecpm_display, ecpm_video, ecpm_avg,
  } = performer;
  // Fallback: payload antigo (sem split por mídia) cai no ecpm_avg como
  // se fosse Display — VideoecPM fica null e renderiza "—" sem cor.
  const ecpmDisplay = ecpm_display ?? ecpm_avg;
  const ecpmVideo   = ecpm_video ?? null;
  const name = displayName || localPartFromEmail(email);
  // max_total dinâmico: campanhas só-video têm max ~45, só-display ~90.
  // Score do CS é a média ponderada — então o max também é ponderado.
  // scoreTone consome % (0-100) pra manter thresholds absolutos.
  const maxTotal = bd ? (bd.max_pacing + bd.max_ecpm + bd.max_ctr + bd.max_vtr) : 100;
  const scorePct = maxTotal > 0 ? (score / maxTotal) * 100 : 0;
  const tone = scoreTone(scorePct);
  const initials = initialsFor(name);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(); } }}
      className="flex items-center gap-4 px-4 py-4 rounded-lg hover:bg-canvas-deeper transition-colors border-t border-border/40 first:border-t-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1"
    >
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

      {/* Métricas agregadas (col 2 — flex grow). 6 colunas em desktop com
          divisor vertical entre cada via border-l no MicroMetric. eCPM
          Video sem cor condicional — não pontua mais no score, então
          colorir confundiria. */}
      <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-3 gap-y-2 min-w-0">
        <MicroMetric label="Pacing DSP" value={formatPctInt(dsp_pacing)} tone={tonePacing(dsp_pacing)} />
        <MicroMetric label="Pacing VID" value={formatPctInt(vid_pacing)} tone={tonePacing(vid_pacing)} />
        <MicroMetric label="CTR"        value={formatPctTwo(ctr)}        tone={toneCtr(ctr)} />
        <MicroMetric label="VTR"        value={formatPctTwo(vtr)}        tone={toneVtr(vtr)} />
        <MicroMetric label="eCPM Disp"  value={formatBRL(ecpmDisplay)}   tone={toneEcpm(ecpmDisplay)} />
        <MicroMetric label="eCPM Vid"   value={formatBRL(ecpmVideo)}     tone="fg" />
      </div>

      {/* Score (col 3) */}
      <div className="flex items-center gap-3 w-[200px] flex-shrink-0">
        <div className="flex-1 h-1.5 rounded-full bg-surface-strong overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-300", BAR_BG[tone])}
            style={{ width: `${Math.max(2, scorePct)}%` }}
          />
        </div>
        <div className="flex flex-col items-end gap-0.5 w-14">
          <span className={cn(
            "text-lg font-bold tabular-nums leading-none",
            TEXT_TONE[tone]
          )}>
            {Math.round(score)}
            <span className="text-fg-subtle text-[10px] font-normal">/{Math.round(maxTotal)}</span>
          </span>
          <ScoreDelta current={score} previous={scorePrev} />
        </div>
      </div>
    </div>
  );
}

export function PerformersLayout({ campaigns, teamMap = {}, onOpenReport }) {
  const [role, setRole] = useState("cs");
  const [snapshots, setSnapshots] = useState(() => loadSnapshots());
  const [selected, setSelected] = useState(null); // performer email selecionado

  const performers = useMemo(
    () => computeTopPerformers(campaigns, role === "cs" ? "cs_email" : "cp_email"),
    [campaigns, role]
  );

  const selectedPerformer = useMemo(
    () => (selected ? performers.find((p) => p.email === selected) : null),
    [selected, performers]
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
              scorePrev={getPreviousScore(snapshots, role, p.email)}
              onClick={() => setSelected(p.email)}
            />
          ))}
        </div>
      )}

      <PerformerDrawer
        performer={selectedPerformer}
        displayName={selectedPerformer ? teamMap[selectedPerformer.email] : null}
        onOpenReport={onOpenReport}
        onClose={() => setSelected(null)}
      />

      {/* Legenda */}
      <p className="text-[11px] text-fg-subtle px-1 leading-relaxed">
        Pacing 100–125% (35 pts, ponderado entre mídias) · eCPM Display
        &lt; R$ 0,70 (ABS R$ 1,50) (30 pts × peso Display) · CTR Display
        &gt; 0,7% (ABS 0,5%) (25 pts × peso Display) · VTR Video &gt; 80%
        (10 pts × peso Video). Quando a campanha tem brand safety pre-bid
        (ABS) ativo — DoubleVerify no DV360, DV/IAS no Xandr ou marcado
        manualmente — os thresholds eCPM/CTR de Display ficam mais
        permissivos. Video só contribui via Pacing e VTR — eCPM/CTR de
        Video não pontuam. Max teórico varia por composição (100% Display
        = 90 · 100% Video = 45 · 50/50 = 67.5); score é normalizado pelo
        max da campanha. Score do CS é a média ponderada por impressões
        regredida à média do time via Empirical Bayes — CSs com poucas
        campanhas convergem pra média do time pra evitar viés de amostra
        pequena. Métricas exibidas (Pacing/CTR/VTR/eCPM) são agregadas via
        Σnumerador / Σdenominador sobre as campanhas ativas do owner.
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
