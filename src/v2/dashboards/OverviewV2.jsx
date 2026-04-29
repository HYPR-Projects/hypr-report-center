// src/v2/dashboards/OverviewV2.jsx
//
// Visão Geral V2 — redesenhada em PR-13 pra implementar fielmente o
// mockup definido na auditoria visual ("hypr_report_redesign_v2.html").
//
// LAYOUT, NA ORDEM (top → bottom)
//   1. Hero KPI (Custo Efetivo) + grid de 4 KPIs auxiliares com sparklines
//   2. Pacing Display + Pacing Video lado a lado, com marker "esperado hoje"
//   3. Sumário por mídia (DISPLAY + VIDEO) — 2 cards lado a lado, layout
//      inline compacto após PR-16 (label+valor numa linha só)
//   4. Charts diários (Display Imp×CTR + Video Views×VTR)
//   5. DailyAggregateTableV2 — tabela "Entrega Agregada por Dia" (collapsible, aberto)
//   6. AlcanceFrequenciaV2 — admin edita, cliente vê read-only
//
// ComparisonRow (CPM Display + CPCV Video) saiu na PR-16 — era redundante
// com o MediaSummaryV2 abaixo, que já carrega Efetivo + Delta. Continua
// existindo como hero principal nas tabs Display e Video.
//
// Detalhamento por Linha (DataTableV2) também saiu na PR-16 — virou tab
// dedicada (DetalhamentoV2). Visão Geral fica como executive summary
// puro, sem raw data competindo por foco.
//
// InsightBanners (callouts auto-gerados de pacing/economia) também saíram
// na PR-16 — competiam por foco com o Hero KPI sem agregar info que o
// próprio MediaSummary/Pacing já carregam (over-delivery, on-target).
//
// Quando há filtro de período ativo, Pacing some (não faz sentido em
// janela parcial). Insights podem se ajustar no texto (verbo passado vs
// presente) — TODO Fase 4.

import { fmt, fmtR } from "../../shared/format";

import { KpiCardV2 } from "../components/KpiCardV2";
import { HeroKpiCardV2 } from "../components/HeroKpiCardV2";
import { SparklineV2 } from "../components/SparklineV2";
import { PacingBarV2 } from "../components/PacingBarV2";
import { MediaSummaryV2 } from "../components/MediaSummaryV2";
import { DualChartV2 } from "../components/DualChartV2";
import { CollapsibleSectionV2 } from "../components/CollapsibleSectionV2";
import { DailyAggregateTableV2 } from "../components/DailyAggregateTableV2";
import { AlcanceFrequenciaV2 } from "../components/AlcanceFrequenciaV2";

export default function OverviewV2({ data, aggregates, token, isAdmin, adminJwt }) {
  const camp = data.campaign;
  const {
    totalImpressions, totalCusto, totalCustoOver,
    display, video, totals,
    isFiltered, budgetProRata, budgetTotal,
    chartDisplay, chartVideo, daily0,
  } = aggregates;

  const hasDisplay = display.length > 0;
  const hasVideo = video.length > 0;
  const totalViews100 = totals.reduce((s, t) => s + (t.completions || 0), 0);

  // Sparklines: pegamos os últimos N pontos da série diária.
  const impSparklineValues = chartDisplay
    .slice(-14)
    .map((d) => d.viewable_impressions || 0);
  const viewsSparklineValues = chartVideo
    .slice(-14)
    .map((d) => d.video_view_100 || 0);
  const costSparklineValues = (chartDisplay.length || chartVideo.length)
    ? mergeCostSeries(chartDisplay, chartVideo).slice(-14).map((d) => d.cost)
    : [];

  // Pacing helpers.
  const pacingDisplay = computeDisplayPacing(display, camp);
  const pacingVideo = video[0]?.pacing || 0;

  // Pacing Geral % — média ponderada por budget de Display + Video.
  const pacingGeral = computePacingGeral(display, video, camp);

  // Custo formatado pra hero (separa centavos pra estilo do mockup).
  const { main: custoMain, cents: custoCents } = splitCents(totalCusto);

  return (
    <div className="space-y-6">
      {/* ─── 1. Hero KPI + auxiliares ────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {/* Hero ocupa 2 colunas em xl (resto fica 4 cards de 1 col cada) */}
        <div className="md:col-span-2 xl:col-span-2">
          <HeroKpiCardV2
            icon={<DollarIcon />}
            label="Custo Efetivo · Total"
            value={custoMain}
            cents={custoCents}
            sparklineValues={costSparklineValues}
            // deltaPercent é null por enquanto — backend ainda não expõe
            // "vs período anterior". TODO Fase 4: query comparativa.
          />
        </div>

        <KpiCardV2
          label="Budget"
          value={fmtR(isFiltered ? budgetProRata : budgetTotal)}
          hint={
            isFiltered
              ? "Budget contratado proporcionalizado pelo período do filtro."
              : "Budget contratado total da campanha."
          }
        />

        <KpiCardV2
          label="Imp. Visíveis"
          value={fmt(totalImpressions)}
          hint="Soma de viewable impressions no período."
          sparkline={
            impSparklineValues.length >= 2 ? (
              <SparklineV2
                values={impSparklineValues}
                stroke="var(--color-signature-light)"
                strokeWidth={1.5}
                width={100}
                height={20}
                className="opacity-70"
              />
            ) : null
          }
        />

        {hasVideo ? (
          <KpiCardV2
            label="Views 100%"
            value={fmt(totalViews100)}
            hint="Completions de vídeo (visualizações até 100%)."
            sparkline={
              viewsSparklineValues.length >= 2 ? (
                <SparklineV2
                  values={viewsSparklineValues}
                  stroke="var(--color-signature-light)"
                  strokeWidth={1.5}
                  width={100}
                  height={20}
                  className="opacity-70"
                />
              ) : null
            }
          />
        ) : (
          <KpiCardV2
            label="Custo + Over"
            value={fmtR(totalCustoOver)}
            accent
            hint="Inclui valor da over-delivery."
          />
        )}

        {/* 5º card: Pacing Geral (só faz sentido quando sem filtro de
            período, porque pacing é cálculo do todo da campanha. Quando
            há filtro, ocupa esse slot com Custo+Over como fallback). */}
        {!isFiltered && pacingGeral > 0 ? (
          <KpiCardV2
            label="Pacing Geral"
            value={`${fmt(pacingGeral, 1)}%`}
            accent={pacingGeral >= 90 && pacingGeral <= 110}
            hint="Média ponderada de pacing Display + Video pelo budget contratado."
          />
        ) : (
          <KpiCardV2
            label="Custo + Over"
            value={fmtR(totalCustoOver)}
            hint="Inclui valor da over-delivery."
          />
        )}
      </div>

      {/* Pacing Geral pill abaixo do grid foi removido — agora é o 5º
          card do hero grid pra bater com o mockup. */}

      {/* ─── 2. Pacing Display + Video ───────────────────────────────── */}
      {!isFiltered && (hasDisplay || hasVideo) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {hasDisplay && (
            <PacingBarV2
              label="Pacing Display"
              pacing={pacingDisplay}
              budget={display.reduce(
                (s, r) => s + (r.o2o_display_budget || 0) + (r.ooh_display_budget || 0),
                0,
              )}
              cost={display.reduce((s, r) => s + (r.effective_total_cost || 0), 0)}
            />
          )}
          {hasVideo && (
            <PacingBarV2
              label="Pacing Video"
              pacing={pacingVideo}
              budget={video.reduce(
                (s, r) => s + (r.o2o_video_budget || 0) + (r.ooh_video_budget || 0),
                0,
              )}
              cost={video.reduce((s, r) => s + (r.effective_total_cost || 0), 0)}
            />
          )}
        </div>
      )}

      {/* ─── 3. Resumo por mídia ─────────────────────────────────────── */}
      {(hasDisplay || hasVideo) && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
            Resumo por mídia
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {hasDisplay && <MediaSummaryV2 type="DISPLAY" rows={display} />}
            {hasVideo && <MediaSummaryV2 type="VIDEO" rows={video} />}
          </div>
        </section>
      )}

      {/* ─── 4. Charts diários ───────────────────────────────────────── */}
      {(chartDisplay.length > 0 || chartVideo.length > 0) && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
            Performance diária
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {chartDisplay.length > 0 && (
              <div className="rounded-xl border border-border bg-surface p-5">
                <div className="text-[11px] font-bold uppercase tracking-widest text-signature mb-3">
                  Display — Imp. Visíveis × CTR
                </div>
                <DualChartV2
                  data={chartDisplay}
                  xKey="date"
                  y1Key="viewable_impressions"
                  y2Key="ctr"
                  label1="Imp. Visíveis"
                  label2="CTR %"
                />
              </div>
            )}
            {chartVideo.length > 0 && (
              <div className="rounded-xl border border-border bg-surface p-5">
                <div className="text-[11px] font-bold uppercase tracking-widest text-signature mb-3">
                  Video — Views 100% × VTR
                </div>
                <DualChartV2
                  data={chartVideo}
                  xKey="date"
                  y1Key="video_view_100"
                  y2Key="vtr"
                  label1="Views 100%"
                  label2="VTR %"
                />
              </div>
            )}
          </div>
        </section>
      )}

      {/* ─── 5. Tabela Entrega Agregada por Dia ─────────────────────── */}
      {daily0 && daily0.length > 0 && (
        <CollapsibleSectionV2 title="Entrega Agregada por Dia" defaultOpen>
          <DailyAggregateTableV2
            daily={daily0}
            campaignName={camp.campaign_name}
          />
        </CollapsibleSectionV2>
      )}

      {/* ─── 6. Alcance & Frequência ────────────────────────────────── */}
      <AlcanceFrequenciaV2
        token={token}
        isAdmin={isAdmin}
        adminJwt={adminJwt}
        initialAlcance={data.alcance}
        initialFrequencia={data.frequencia}
      />
    </div>
  );
}

// ─── Helpers locais ───────────────────────────────────────────────────

function splitCents(value) {
  // R$ 184220.40 → { main: "R$ 184.220", cents: ",40" }
  if (value == null || Number.isNaN(value)) return { main: "—", cents: "" };
  const formatted = fmtR(value);
  // fmtR retorna algo como "R$ 184.220,40"
  const idx = formatted.lastIndexOf(",");
  if (idx < 0) return { main: formatted, cents: "" };
  return {
    main: formatted.slice(0, idx),
    cents: formatted.slice(idx),
  };
}

// Pacing display lógica idêntica à OverviewV2 anterior.
function computeDisplayPacing(displayRows, camp) {
  if (!displayRows.length || !camp.start_date || !camp.end_date) return 0;

  const contracted = displayRows.reduce(
    (s, r) =>
      s +
      (r.contracted_o2o_display_impressions || 0) +
      (r.contracted_ooh_display_impressions || 0),
    0,
  );
  const bonus = displayRows.reduce(
    (s, r) =>
      s +
      (r.bonus_o2o_display_impressions || 0) +
      (r.bonus_ooh_display_impressions || 0),
    0,
  );
  const totalNeg = contracted + bonus;
  if (!totalNeg) return 0;

  const delivered = displayRows.reduce(
    (s, r) => s + (r.viewable_impressions || 0),
    0,
  );

  const [sy, sm, sd] = camp.start_date.split("-").map(Number);
  const [ey, em, ed] = camp.end_date.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const now = new Date();

  if (now > end) return (delivered / totalNeg) * 100;

  const total = (end - start) / 864e5 + 1;
  const elapsed = now < start ? 0 : Math.floor((now - start) / 864e5);
  const expected = totalNeg * (elapsed / total);
  return expected > 0 ? (delivered / expected) * 100 : 0;
}

// Pacing geral % = média ponderada por budget contratado de Display + Video.
function computePacingGeral(display, video, camp) {
  const dpacing = computeDisplayPacing(display, camp);
  const vpacing = video[0]?.pacing || 0;

  const dbudget = display.reduce(
    (s, r) => s + (r.o2o_display_budget || 0) + (r.ooh_display_budget || 0),
    0,
  );
  const vbudget = video.reduce(
    (s, r) => s + (r.o2o_video_budget || 0) + (r.ooh_video_budget || 0),
    0,
  );
  const total = dbudget + vbudget;
  if (!total) return 0;

  return (dpacing * dbudget + vpacing * vbudget) / total;
}

// Para a sparkline de custo do hero — combina display+video por data.
function mergeCostSeries(chartDisplay, chartVideo) {
  const map = {};
  for (const r of chartDisplay) {
    map[r.date] = (map[r.date] || 0) + (r.effective_total_cost || 0);
  }
  for (const r of chartVideo) {
    map[r.date] = (map[r.date] || 0) + (r.effective_total_cost || 0);
  }
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, cost]) => ({ date, cost }));
}

// ─── Ícones ──────────────────────────────────────────────────────────
function DollarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

function CheckIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
