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

export default function OverviewV2({ data, aggregates, token, isAdmin, adminJwt, mergeMeta = null, coreFilter = "ALL", isBonusOnly = false }) {
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
  const pacingDisplay = computeMediaPacing(display, camp, "DISPLAY", coreFilter);
  const pacingVideo   = computeMediaPacing(video,   camp, "VIDEO",   coreFilter);

  // Breakdown por tactic (O2O/OOH) sob cada barra principal. Só faz
  // sentido quando o filtro Core Product é "ALL" — caso contrário a barra
  // principal já é da tactic única e o breakdown seria redundante. Por
  // mídia, só renderiza quando ambas as tactics têm row (caso O2O-only
  // ou OOH-only mantém visual atual, sem ruído).
  const buildTacticSubBars = (rows, mediaType) => {
    if (coreFilter !== "ALL") return null;
    const o2oRows = rows.filter((r) => r.tactic_type === "O2O");
    const oohRows = rows.filter((r) => r.tactic_type === "OOH");
    if (o2oRows.length === 0 || oohRows.length === 0) return null;
    return [
      { label: "O2O", pacing: computeMediaPacing(o2oRows, camp, mediaType, "O2O") },
      { label: "OOH", pacing: computeMediaPacing(oohRows, camp, mediaType, "OOH") },
    ];
  };
  const displaySubBars = buildTacticSubBars(display, "DISPLAY");
  const videoSubBars   = buildTacticSubBars(video,   "VIDEO");

  // Pacing Geral % — média ponderada por budget de Display + Video,
  // usando a mesma fórmula calendar-camp acima.
  const pacingGeral = computePacingGeral(display, video, camp, coreFilter);

  // Budget exibido no card "Budget" precisa respeitar o filtro Core Product.
  // `aggregates.budgetTotal` vem do campo `budget_contracted` da campaign
  // (sempre inteiro) — pra filtro O2O/OOH, reconstrói somando os
  // o2o_<media>_budget ou ooh_<media>_budget das rows.
  const filteredBudgetTotal = coreFilter === "ALL"
    ? budgetTotal
    : pickBudget(display[0], "display", coreFilter)
    + pickBudget(video[0],   "video",   coreFilter);
  const filteredBudgetProRata = isFiltered && filteredBudgetTotal && budgetTotal
    ? Math.round(filteredBudgetTotal * (budgetProRata / budgetTotal) * 100) / 100
    : filteredBudgetTotal;

  // Custo formatado pra hero (separa centavos pra estilo do mockup).
  const { main: custoMain, cents: custoCents } = splitCents(totalCusto);
  // Em campanha bonificada, hero mostra o valor da cortesia (=`budgetTotal`,
  // que pelo contrato representa "quanto vale o que estamos bonificando").
  const { main: bonusMain, cents: bonusCents } = splitCents(budgetTotal);

  // "Custo + Over" só aparece quando há over-delivery real. Sem over,
  // o valor é idêntico ao Hero "Custo Efetivo · Total" — duplicar o
  // mesmo número polui o grid sem agregar info.
  const hasOverDelivery = totalCustoOver > totalCusto;
  const showCustoOver = !isBonusOnly && hasOverDelivery;
  const slot4Visible = hasVideo || showCustoOver;
  const slot5Visible = (!isFiltered && pacingGeral > 0) || showCustoOver;
  const gridColsClass = isBonusOnly
    ? (slot4Visible ? "xl:grid-cols-5" : "xl:grid-cols-4")
    : slot4Visible && slot5Visible
      ? "xl:grid-cols-6"
      : slot4Visible || slot5Visible
        ? "xl:grid-cols-5"
        : "xl:grid-cols-4";

  return (
    <div className="space-y-6">
      {/* ─── 1. Hero KPI + auxiliares ────────────────────────────────── */}
      {/* Em bonificada, Hero ocupa 3 cols (em vez de 2) e o grid total
          encurta pra 5 cols — Budget, Custo+Over e Pacing Geral somem
          (este último porque o cálculo usa budget contratado, que é 0 em
          campanha 100% bônus). Layout fica: Hero(3)+Imp(1)+Views(1)=5. */}
      <div className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 ${gridColsClass}`}>
        <div className={isBonusOnly ? "md:col-span-2 xl:col-span-3" : "md:col-span-2 xl:col-span-2"}>
          {isBonusOnly ? (
            <HeroKpiCardV2
              icon={<GiftIcon />}
              label="Valor Bonificado · Total"
              value={bonusMain}
              cents={bonusCents}
              caption="Volume entregue como cortesia HYPR — sem custo pro cliente."
              variant="bonus"
            />
          ) : (
            <HeroKpiCardV2
              icon={<DollarIcon />}
              label="Custo Efetivo · Total"
              value={custoMain}
              cents={custoCents}
              sparklineValues={costSparklineValues}
              // deltaPercent é null por enquanto — backend ainda não expõe
              // "vs período anterior". TODO Fase 4: query comparativa.
            />
          )}
        </div>

        {/* Card "Budget" some em bonificada — mesmo valor que o Hero,
            seria redundância visual. */}
        {!isBonusOnly && (
          <KpiCardV2
            label="Budget"
            value={fmtR(isFiltered ? filteredBudgetProRata : filteredBudgetTotal)}
            hint={
              isFiltered
                ? "Budget contratado proporcionalizado pelo período do filtro."
                : "Budget contratado total da campanha."
            }
          />
        )}

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
          /* Fallback "Custo + Over" não faz sentido em bonificada
             (custo é sempre 0) nem quando o valor é igual ao Hero
             (sem over-delivery). Em ambos os casos slot fica vazio
             e o grid reflowa pelo `gridColsClass`. */
          showCustoOver && (
            <KpiCardV2
              label="Custo + Over"
              value={fmtR(totalCustoOver)}
              accent
              hint="Inclui valor da over-delivery."
            />
          )
        )}

        {/* 5º card: Pacing Geral (só faz sentido quando sem filtro de
            período, porque pacing é cálculo do todo da campanha. Quando
            há filtro, ocupa esse slot com Custo+Over como fallback —
            exceto em bonificada, onde Custo+Over não faz sentido). */}
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
          showCustoOver && (
            <KpiCardV2
              label="Custo + Over"
              value={fmtR(totalCustoOver)}
              hint="Inclui valor da over-delivery."
            />
          )
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
              budget={pickBudget(display[0], "display", coreFilter)}
              cost={display.reduce((s, r) => s + (r.effective_total_cost || 0), 0)}
              subBars={displaySubBars}
              bonusFooter={
                isBonusOnly
                  ? {
                      delivered: display.reduce((s, r) => s + (r.viewable_impressions || 0), 0),
                      target: pickContracted(display[0], "display", coreFilter),
                      unit: "imp.",
                    }
                  : null
              }
            />
          )}
          {hasVideo && (
            <PacingBarV2
              label={`Pacing Video${pacingSuffix}`}
              pacing={pacingVideo}
              budget={pickBudget(video[0], "video", coreFilter)}
              cost={video.reduce((s, r) => s + (r.effective_total_cost || 0), 0)}
              subBars={videoSubBars}
              bonusFooter={
                isBonusOnly
                  ? {
                      delivered: video.reduce((s, r) => s + (r.completions || 0), 0),
                      target: pickContracted(video[0], "video", coreFilter),
                      unit: "views",
                    }
                  : null
              }
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
          contractedDisplay={pickContracted(display[0], "display", coreFilter)}
          contractedVideo={pickContracted(video[0], "video", coreFilter)}
          budgetDisplay={pickBudget(display[0], "display", coreFilter)}
          budgetVideo={pickBudget(video[0], "video", coreFilter)}
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
              <div className="rounded-xl border border-border bg-surface p-4 md:p-5">
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
              <div className="rounded-xl border border-border bg-surface p-4 md:p-5">
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
      {/* availableMedia restringe o toggle Display/Video às mídias que
          a campanha realmente tem (contrato OU entrega). Mesma lógica
          que oculta as tabs Display/Video em ClientDashboardV2 — assim
          campanha só-Display não mostra um toggle "Video" que ao ser
          clicado sempre vai dizer "Sem entregas de Video". */}
      {daily0 && daily0.length > 0 && (
        <CollapsibleSectionV2 title="Entrega Agregada por Dia" defaultOpen>
          <DailyAggregateTableV2
            daily={daily0}
            campaignName={camp.campaign_name}
            availableMedia={availableMediaFromData(data)}
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

// Quais mídias a campanha tem (Display, Video, ambas). Critério: contrato
// (incluindo bonus) OU entrega real em data.totals. Mesma lógica que
// ClientDashboardV2 usa pra esconder as tabs Display/Video — replicada
// aqui pra DailyAggregateTableV2 da Visão Geral aplicar o mesmo filtro
// no toggle Display/Video. Duplicação intencional pra evitar prop
// drilling de 3 níveis (ClientDashboard → Overview → DailyAggregate).
function availableMediaFromData(data) {
  const t0 = (data?.totals || [])[0] || {};
  const hasDisplayContract =
    (t0.contracted_o2o_display_impressions || 0) > 0 ||
    (t0.contracted_ooh_display_impressions || 0) > 0 ||
    (t0.bonus_o2o_display_impressions || 0) > 0 ||
    (t0.bonus_ooh_display_impressions || 0) > 0;
  const hasVideoContract =
    (t0.contracted_o2o_video_completions || 0) > 0 ||
    (t0.contracted_ooh_video_completions || 0) > 0 ||
    (t0.bonus_o2o_video_completions || 0) > 0 ||
    (t0.bonus_ooh_video_completions || 0) > 0;
  const hasDisplayDelivery = (data?.totals || []).some((r) => r.media_type === "DISPLAY");
  const hasVideoDelivery = (data?.totals || []).some((r) => r.media_type === "VIDEO");
  const out = [];
  if (hasDisplayContract || hasDisplayDelivery) out.push("DISPLAY");
  if (hasVideoContract || hasVideoDelivery) out.push("VIDEO");
  return out;
}

// Restringe budget/contracted ao tactic filtrado. Sem isso, o filtro
// Core Product deixaria os componentes de pacing comparando entrega de
// uma frente contra contrato/budget das duas — ratio errado.
function pickBudget(row, media, tactic) {
  if (!row) return 0;
  const o2o = media === "video" ? (row.o2o_video_budget || 0) : (row.o2o_display_budget || 0);
  const ooh = media === "video" ? (row.ooh_video_budget || 0) : (row.ooh_display_budget || 0);
  if (tactic === "O2O") return o2o;
  if (tactic === "OOH") return ooh;
  return o2o + ooh;
}

function pickContracted(row, media, tactic) {
  if (!row) return 0;
  const o2o = media === "video"
    ? (row.contracted_o2o_video_completions   || 0) + (row.bonus_o2o_video_completions   || 0)
    : (row.contracted_o2o_display_impressions || 0) + (row.bonus_o2o_display_impressions || 0);
  const ooh = media === "video"
    ? (row.contracted_ooh_video_completions   || 0) + (row.bonus_ooh_video_completions   || 0)
    : (row.contracted_ooh_display_impressions || 0) + (row.bonus_ooh_display_impressions || 0);
  if (tactic === "O2O") return o2o;
  if (tactic === "OOH") return ooh;
  return o2o + ooh;
}

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
//
// `tactic` ("ALL"|"O2O"|"OOH") restringe os pesos (budget) às frentes
// correspondentes. Sem isso, com filtro Core Product ativo, dpacing já
// considera só a frente filtrada mas o budget continuaria O2O+OOH —
// distorcendo a média ponderada.
function computePacingGeral(display, video, camp, tactic = "ALL") {
  const dpacing = computeMediaPacing(display, camp, "DISPLAY", tactic);
  const vpacing = computeMediaPacing(video,   camp, "VIDEO",   tactic);

  // Campos *_budget são denormalizados: cada row carrega o2o E ooh da
  // campanha inteira. Pegar de rows[0] evita duplicação quando há 2
  // tactics (O2O+OOH).
  const includeO2O = tactic === "ALL" || tactic === "O2O";
  const includeOOH = tactic === "ALL" || tactic === "OOH";
  const dbudget = (includeO2O ? (display[0]?.o2o_display_budget || 0) : 0)
                + (includeOOH ? (display[0]?.ooh_display_budget || 0) : 0);
  const vbudget = (includeO2O ? (video[0]?.o2o_video_budget   || 0) : 0)
                + (includeOOH ? (video[0]?.ooh_video_budget   || 0) : 0);
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

function GiftIcon() {
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
      <polyline points="20 12 20 22 4 22 4 12" />
      <rect x="2" y="7" width="20" height="5" />
      <line x1="12" y1="22" x2="12" y2="7" />
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
      <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
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
