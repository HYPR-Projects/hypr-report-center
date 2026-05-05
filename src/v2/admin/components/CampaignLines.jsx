// src/v2/admin/components/CampaignLines.jsx
//
// Sub-seção dentro do CampaignCard do PerformerDrawer. Mostra as 3 piores
// line items de uma campanha — onde o CS deveria focar pra recuperar pts.
//
// Critério "pior" (híbrido):
//   1. Floor: impressions >= 5_000 (filtra LIs sem volume — gap de uma
//      LI com 1 click não é representativo).
//   2. Ranking por número de violações ponderado pelo share de impressões
//      da LI no token. Líder = LI grande com mais métricas fora do
//      threshold; campanha grande mas saudável fica fora.
//
// Métricas exibidas (não pontuam no score atual — só sinalizam):
//   - CTR Display: ABS-aware
//   - eCPM Display: ABS-aware
//   - Viewability: industry standard MRC (70% / 60%)
//   - VTR Video: 80% / 70%
//
// Lazy fetch on mount — só roda quando admin expande o card.

import { useEffect, useState } from "react";
import { cn } from "../../../ui/cn";
import { getCampaignLines } from "../../../lib/api";

const MIN_IMPRESSIONS = 5000;
const TOP_N = 3;

// Thresholds por métrica · mídia · ABS. Apenas pra colorir badges —
// score real do Top Performers é em aggregation.js.
const TH = {
  ctrDisplay:    { good: 0.7, ok: 0.5 },
  ctrDisplayABS: { good: 0.5, ok: 0.3 },
  ctrVideo:      { good: 0.3, ok: 0.2 },
  ctrVideoABS:   { good: 0.2, ok: 0.1 },
  ecpmDisplay:    { good: 0.70, ok: 1.00 }, // <= é melhor
  ecpmDisplayABS: { good: 1.50, ok: 2.00 },
  ecpmVideo:      { good: 2.00, ok: 3.00 },
  ecpmVideoABS:   { good: 4.00, ok: 5.00 },
  view:  { good: 70, ok: 60 },
  vtr:   { good: 80, ok: 70 },
};

function tone(value, { good, ok }, higherIsBetter = true) {
  if (value == null || isNaN(value)) return "neutral";
  if (higherIsBetter) {
    if (value >= good) return "success";
    if (value >= ok) return "warning";
    return "danger";
  }
  if (value <= good) return "success";
  if (value <= ok) return "warning";
  return "danger";
}

const TONE_CLASS = {
  success: "text-success bg-success-soft",
  warning: "text-warning bg-warning-soft",
  danger:  "text-danger  bg-danger-soft",
  neutral: "text-fg-subtle bg-surface",
};

function computeMetrics(line, hasAbs) {
  const imps = Number(line.impressions) || 0;
  const view = Number(line.viewable_impressions) || 0;
  const clicks = Number(line.clicks) || 0;
  const starts = Number(line.video_starts) || 0;
  const v100 = Number(line.video_view_100) || 0;
  const cost = Number(line.total_cost) || 0;
  const isVideo = line.media_type === "VIDEO";

  const ctr      = view > 0   ? (clicks / view) * 100 : null;
  const viewPct  = imps > 0   ? (view / imps) * 100   : null;
  const vtr      = isVideo && starts > 0 ? (v100 / starts) * 100 : null;
  const ecpm     = imps > 0   ? (cost / imps) * 1000  : null;

  const ctrTh  = isVideo
    ? (hasAbs ? TH.ctrVideoABS  : TH.ctrVideo)
    : (hasAbs ? TH.ctrDisplayABS : TH.ctrDisplay);
  const ecpmTh = isVideo
    ? (hasAbs ? TH.ecpmVideoABS  : TH.ecpmVideo)
    : (hasAbs ? TH.ecpmDisplayABS : TH.ecpmDisplay);

  const tones = {
    ctr:  tone(ctr,     ctrTh,    true),
    view: tone(viewPct, TH.view,  true),
    vtr:  tone(vtr,     TH.vtr,   true),
    ecpm: tone(ecpm,    ecpmTh,   false),
  };

  // Conta violações: amarelo = 0.5, vermelho = 1. Neutral (sem dado, ex:
  // VTR em LI Display) não conta.
  const score = (t) => (t === "danger" ? 1 : t === "warning" ? 0.5 : 0);
  const violations = score(tones.ctr) + score(tones.view) + score(tones.vtr) + score(tones.ecpm);

  return { ctr, viewPct, vtr, ecpm, tones, violations, isVideo, imps };
}

function rankWorst(lines, totalImpressions, hasAbs) {
  const filtered = lines.filter((l) => Number(l.impressions) >= MIN_IMPRESSIONS);
  const enriched = filtered.map((line) => {
    const m = computeMetrics(line, hasAbs);
    const weight = totalImpressions > 0 ? m.imps / totalImpressions : 0;
    return { line, ...m, weighted: m.violations * weight };
  });
  // Sort desc por violações ponderadas. Tiebreaker: mais impressões primeiro.
  enriched.sort((a, b) => b.weighted - a.weighted || b.imps - a.imps);
  return enriched.slice(0, TOP_N);
}

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export function CampaignLines({ shortToken, hasAbs }) {
  const [loading, setLoading] = useState(true);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCampaignLines({ short_token: shortToken })
      .then((data) => {
        if (cancelled) return;
        setLines(data);
        setError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [shortToken]);

  if (loading) {
    return (
      <div className="space-y-1.5 pt-1">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-9 rounded bg-surface-strong/60 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-[10.5px] text-fg-subtle italic pt-1">
        Não foi possível carregar line items.
      </p>
    );
  }

  const totalImps = lines.reduce((s, l) => s + (Number(l.impressions) || 0), 0);
  const worst = rankWorst(lines, totalImps, hasAbs);

  if (!worst.length) {
    return (
      <p className="text-[10.5px] text-fg-subtle italic pt-1">
        Nenhuma line com volume suficiente ({formatCount(MIN_IMPRESSIONS)}+ impr).
      </p>
    );
  }

  return (
    <div className="space-y-2 pt-2">
      {worst.map(({ line, ctr, viewPct, vtr, ecpm, tones, isVideo, imps }, idx) => (
        <div
          key={`${line.line_name}::${line.media_type}::${idx}`}
          className="rounded-md bg-canvas-deeper border border-border/60 p-2.5 space-y-2"
        >
          {/* Linha 1: nome completo da line — quebra em qualquer caractere
              pra IDs longos sem espaço (ID-XXX_HYPR_CLIENT_FORMAT_...). Até
              2 linhas; tooltip mostra completo se ultrapassar. */}
          <div
            className="text-[11px] text-fg leading-snug font-medium break-all line-clamp-2"
            title={line.line_name}
          >
            {line.line_name || "—"}
          </div>

          {/* Linha 2: chip mídia + impressões */}
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className={cn(
              "inline-flex items-center px-1.5 py-0.5 rounded font-bold uppercase tracking-wider",
              isVideo ? "bg-signature/15 text-signature" : "bg-surface-strong text-fg-muted"
            )}>
              {isVideo ? "VIDEO" : "DISPLAY"}
            </span>
            <span className="text-fg-subtle tabular-nums">{formatCount(imps)} impressões</span>
          </div>

          {/* Linha 3: 4 pílulas com mais respiro */}
          <div className="grid grid-cols-4 gap-1.5">
            <Pill label="CTR"  value={ctr     != null ? `${ctr.toFixed(2)}%`     : "—"} t={tones.ctr} />
            <Pill label="View" value={viewPct != null ? `${viewPct.toFixed(0)}%` : "—"} t={tones.view} />
            <Pill label="VTR"  value={vtr     != null ? `${vtr.toFixed(0)}%`     : "—"} t={isVideo ? tones.vtr : "neutral"} />
            <Pill label="eCPM" value={ecpm    != null ? `R$ ${ecpm.toFixed(2)}`  : "—"} t={tones.ecpm} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Pill({ label, value, t }) {
  return (
    <div className={cn("rounded px-2 py-1 leading-tight text-center", TONE_CLASS[t] || TONE_CLASS.neutral)}>
      <div className="text-[9px] uppercase tracking-wider opacity-70 font-semibold">{label}</div>
      <div className="text-[11px] tabular-nums font-bold mt-0.5">{value}</div>
    </div>
  );
}
