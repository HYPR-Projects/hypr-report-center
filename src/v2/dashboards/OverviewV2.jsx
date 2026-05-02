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
import { computeMediaPacing } from "../../shared/aggregations";

import { KpiCardV2 } from "../components/KpiCardV2";
import { HeroKpiCardV2 } from "../components/HeroKpiCardV2";
import { SparklineV2 } from "../components/SparklineV2";
import { PacingBarV2 } from "../components/PacingBarV2";
import { PacingOverPillV2 } from "../components/PacingOverPillV2";
import { CumulativePacingChartV2 } from "../components/CumulativePacingChartV2";
import { MediaSummaryV2 } from "../components/MediaSummaryV2";
import { DualChartV2 } from "../components/DualChartV2";
import { CollapsibleSectionV2 } from "../components/CollapsibleSectionV2";
import { DailyAggregateTableV2 } from "../components/DailyAggregateTableV2";
import { AlcanceFrequenciaV2 } from "../components/AlcanceFrequenciaV2";

export default function OverviewV2({ data, aggregates, token, isAdmin, adminJwt, mergeMeta = null }) {
  const camp = data.campaign;
  const {
    totalImpressions, totalCusto, totalCustoOver,
    display, video, totals,
    isFiltered, budgetProRata, budgetTotal,
    chartDisplay, chartVideo, daily0,
  } = aggregates;

  // Quando o report é merged em visão agregada, o pacing/over reflete
  // SOMENTE o token ativo (regra de negócio). Anexamos o sufixo " · Mês"
  // nos labels pra deixar claro qual mês está sendo medido — evita o
  // usuário ler "PACING DISPLAY 386%" e achar que é da campanha inteira.
  const activeMemberMonth = (() => {
    if (!mergeMeta) return null;
    const active = (mergeMeta.members || []).find((m) => m.is_active);
    if (!active?.start_date) return null;
    return formatMonthShortPT(active.start_date);
  })();
  const pacingSuffix = activeMemberMonth ? ` · ${activeMemberMonth}` : "";

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

  // Pacing helpers — usa a régua da campanha inteira (não actual_start
  // por frente), agregando O2O+OOH no numerador e denominador. Mantém
  // todas as frentes na conta inclusive as que ainda não começaram a
  // entregar — o objetivo da Visão Geral é responder "estamos no ritmo
  // do contrato?", não "cada frente está performando?". Cálculo por
  // tática (com actual_start_date) continua nas abas Display e Video.
  const pacingDisplay = computeMediaPacing(display, camp, "DISPLAY");
  const pacingVideo   = computeMediaPacing(video,   camp, "VIDEO");

  // Pacing Geral % — média ponderada por budget de Display + Video,
  // usando a mesma fórmula calendar-camp acima.
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
            label={`Pacing Geral${pacingSuffix}`}
            value={
              <span className="inline-flex items-center gap-2 flex-wrap">
                <span>{fmt(pacingGeral, 1)}%</span>
                <PacingOverPillV2 pacing={pacingGeral} size="md" />
              </span>
            }
            accent={pacingGeral >= 90 && pacingGeral <= 110}
            hint={
              activeMemberMonth
                ? `Pacing do token ativo (${activeMemberMonth}). Investimentos e entregas somam todos os meses; pacing reflete só o mês corrente.`
                : "Média ponderada de pacing Display + Video pelo budget contratado."
            }
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
        <div className={`grid grid-cols-1 gap-3 ${hasDisplay && hasVideo ? "md:grid-cols-2" : ""}`}>
          {hasDisplay && (
            <PacingBarV2
              label={`Pacing Display${pacingSuffix}`}
              pacing={pacingDisplay}
              budget={(display[0]?.o2o_display_budget || 0) + (display[0]?.ooh_display_budget || 0)}
              cost={display.reduce((s, r) => s + (r.effective_total_cost || 0), 0)}
            />
          )}
          {hasVideo && (
            <PacingBarV2
              label={`Pacing Video${pacingSuffix}`}
              pacing={pacingVideo}
              budget={(video[0]?.o2o_video_budget || 0) + (video[0]?.ooh_video_budget || 0)}
              cost={video.reduce((s, r) => s + (r.effective_total_cost || 0), 0)}
            />
          )}
        </div>
      )}

      {/* ─── 2.5 Curva de pacing acumulado (real × 100% no alvo) ───────
          Complementar às barras de pacing acima: enquanto a barra é um
          snapshot do ritmo atual, este chart mostra a curva de pacing
          ao longo do tempo. No último tick (hoje), o valor real bate
          com o KPI Pacing Geral. Só renderiza quando sem filtro de
          período (faz sentido olhar a campanha inteira). */}
      {!isFiltered && daily0 && daily0.length > 0 && (
        <CumulativePacingChartV2
          daily={daily0}
          contractedDisplay={
            (display[0]?.contracted_o2o_display_impressions || 0) + (display[0]?.bonus_o2o_display_impressions || 0)
          + (display[0]?.contracted_ooh_display_impressions || 0) + (display[0]?.bonus_ooh_display_impressions || 0)
          }
          contractedVideo={
            (video[0]?.contracted_o2o_video_completions || 0) + (video[0]?.bonus_o2o_video_completions || 0)
          + (video[0]?.contracted_ooh_video_completions || 0) + (video[0]?.bonus_ooh_video_completions || 0)
          }
          budgetDisplay={(display[0]?.o2o_display_budget || 0) + (display[0]?.ooh_display_budget || 0)}
          budgetVideo={(video[0]?.o2o_video_budget || 0) + (video[0]?.ooh_video_budget || 0)}
          startDate={camp.start_date}
          endDate={camp.end_date}
        />
      )}

      {/* ─── 3. Resumo por mídia ─────────────────────────────────────── */}
      {(hasDisplay || hasVideo) && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
            Resumo por mídia
          </h2>
          <div className={`grid grid-cols-1 gap-3 ${hasDisplay && hasVideo ? "md:grid-cols-2" : ""}`}>
            {hasDisplay && <MediaSummaryV2 type="DISPLAY" rows={display} compact={hasDisplay && hasVideo} />}
            {hasVideo && <MediaSummaryV2 type="VIDEO" rows={video} compact={hasDisplay && hasVideo} />}
          </div>
        </section>
      )}

      {/* ─── 4. Charts diários ───────────────────────────────────────── */}
      {(chartDisplay.length > 0 || chartVideo.length > 0) && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
            Performance diária
          </h2>
          <div className={`grid grid-cols-1 gap-3 ${chartDisplay.length > 0 && chartVideo.length > 0 ? "lg:grid-cols-2" : ""}`}>
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

// Pacing geral % = média ponderada por budget contratado de Display + Video.
// Budget exclui bônus (bonificação não fatura), mesmo padrão do backend.
function computePacingGeral(display, video, camp) {
  const dpacing = computeMediaPacing(display, camp, "DISPLAY");
  const vpacing = computeMediaPacing(video,   camp, "VIDEO");

  // Campos *_budget são denormalizados: cada row carrega o2o E ooh da
  // campanha inteira. Pegar de rows[0] evita duplicação quando há 2
  // tactics (O2O+OOH).
  const dbudget = (display[0]?.o2o_display_budget || 0) + (display[0]?.ooh_display_budget || 0);
  const vbudget = (video[0]?.o2o_video_budget || 0) + (video[0]?.ooh_video_budget || 0);
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

// "2026-02-01" → "Fev 26". Usado no sufixo dos labels de pacing quando
// o report é mesclado em visão agregada — deixa explícito qual mês o
// pacing está medindo (token ativo).
function formatMonthShortPT(ymd) {
  if (!ymd || typeof ymd !== "string") return null;
  const [yStr, mStr] = ymd.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!y || !m) return null;
  const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  return `${MESES[m - 1]} ${String(y).slice(-2)}`;
}
