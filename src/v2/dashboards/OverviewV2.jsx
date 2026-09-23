// src/v2/dashboards/OverviewV2.jsx
//
// Visão Geral — Report 2.0.
//
// LAYOUT, NA ORDEM (top → bottom)
//   0. Aviso admin de volumetria incoerente (só operador HYPR)
//   1. Linha de KPIs: herói Custo efetivo (com a barra do budget, o % do
//      período decorrido, o refaturamento de encerramento antecipado e o
//      "custo + over" quando existe) · Imp. visíveis (viewability na nota)
//      · Views 100% (VTR na nota) · Alcance único (frequência na nota; o
//      admin edita no próprio card) · Pacing geral
//   2. Ritmo de entrega: Hoje (barras de pacing por mídia, sub-barras por
//      frente, contrato × bônus) / Evolução (curva acumulada), com a frase
//      de ritmo e o aviso de pacing sobre o contrato original
//   3. Resumo por mídia: Display, Vídeo (e Max Attention), cada card com
//      atalho para a aba
//   4. Tendência diária: uma métrica por vez, sem eixo duplo
//   5. Entrega por dia: 7 dias mais recentes, expande para todos, CSV
//
// Com filtro de período ativo o módulo de ritmo some (pacing é conta da
// campanha inteira) e o budget do herói vira o pro-rata do período.

import { fmt, fmtR } from "../../shared/format";
import { computeMediaPacing } from "../../shared/aggregations";
import { computeDataUntil } from "../../shared/freshness";
import { buildDailySeries, lastValues, periodElapsedPct } from "../../shared/overviewSeries";

import { KpiCardV2 } from "../components/KpiCardV2";
import { HeroKpiCardV2 } from "../components/HeroKpiCardV2";
import { SparklineV2 } from "../components/SparklineV2";
import { PacingOverPillV2 } from "../components/PacingOverPillV2";
import { MediaSummaryV2 } from "../components/MediaSummaryV2";
import { DailyAggregateTableV2 } from "../components/DailyAggregateTableV2";
import { AlcanceKpiCardV2 } from "../components/AlcanceFrequenciaV2";
import { DeliveryRhythmCardV2 } from "../components/DeliveryRhythmCardV2";
import { DailyTrendCardV2 } from "../components/DailyTrendCardV2";
import { MaxAttentionSummaryCardV2 } from "../components/MaxAttentionSummaryCardV2";

// xl: herói ocupa 2 colunas + N cards de 1 coluna. Classes estáticas por
// causa do scanner do Tailwind.
const XL_COLS = { 1: "xl:grid-cols-3", 2: "xl:grid-cols-4", 3: "xl:grid-cols-5", 4: "xl:grid-cols-6" };

export default function OverviewV2({
  data,
  aggregates,
  token,
  view = null,
  isAdmin,
  adminJwt,
  mergeMeta = null,
  coreFilter = "ALL",
  isBonusOnly = false,
  // Navegação para as abas a partir dos atalhos do Resumo por mídia.
  onNavigate = null,
  showDisplayTab = true,
  showVideoTab = true,
  showMaxAttentionTab = false,
  // Período ativo (para o card de Max Attention buscar o mesmo recorte).
  range = null,
}) {
  const camp = data.campaign;
  const {
    totalImpressions, totalCusto, totalCustoOver,
    display, video,
    isFiltered, budgetProRata, budgetTotal,
    daily0, detail,
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
  // Views 100% da MESMA fonte CR que a aba Video (via `video`, já
  // sobrescrito com detail em computeAggregates).
  const totalViews100 = video.reduce((s, t) => s + (t.completions || 0), 0);
  const videoViewable = video.reduce((s, t) => s + (t.viewable_impressions || 0), 0);
  const vtrTotal = videoViewable > 0 ? (totalViews100 / videoViewable) * 100 : null;

  // Série diária a partir do detail (CR, custo rateado): alimenta a
  // tendência, as sparklines (a de custo deixa de sair plana) e a
  // viewability da nota de Imp. visíveis.
  const series = buildDailySeries(detail);
  const crImpressions = series.reduce((s, d) => s + d.impressions, 0);
  const crViewable = series.reduce((s, d) => s + d.viewable_impressions, 0);
  const viewability = crImpressions > 0 ? (crViewable / crImpressions) * 100 : null;
  const impSparklineValues = lastValues(series, "viewable_impressions");
  const viewsSparklineValues = lastValues(series, "video_view_100");
  const costSparklineValues = lastValues(series, "cost");

  // Pacing helpers — usa a régua da campanha inteira (não actual_start
  // por frente), agregando O2O+OOH no numerador e denominador. Mantém
  // todas as frentes na conta inclusive as que ainda não começaram a
  // entregar — o objetivo da Visão Geral é responder "estamos no ritmo
  // do contrato?", não "cada frente está performando?". Cálculo por
  // tática (com actual_start_date) continua nas abas Display e Video.
  const pacingDisplay = computeMediaPacing(display, camp, "DISPLAY", coreFilter);
  const pacingVideo   = computeMediaPacing(video,   camp, "VIDEO",   coreFilter);

  // Breakdown por tactic (O2O/OOH/GF) sob cada barra principal. Só faz
  // sentido quando o filtro Core Product é "ALL" — caso contrário a barra
  // principal já é da tactic única e o breakdown seria redundante.
  //
  // Render quando 2+ tactics têm CONTRATO (não exige delivery em todas).
  // Frente vendida mas ainda não iniciada aparece como 0%, sinalizando
  // pro CS que tem entrega pendente.
  const buildTacticSubBars = (rows, mediaType) => {
    if (coreFilter !== "ALL") return null;
    const r0 = rows[0] || {};
    const isVideo = mediaType === "VIDEO";
    const neg = (frente) => isVideo
      ? (r0[`contracted_${frente}_video_completions`]   || 0) + (r0[`bonus_${frente}_video_completions`]   || 0)
      : (r0[`contracted_${frente}_display_impressions`] || 0) + (r0[`bonus_${frente}_display_impressions`] || 0);
    const fronts = [
      { label: "O2O", tactic: "O2O",        neg: neg("o2o") },
      { label: "OOH", tactic: "OOH",        neg: neg("ooh") },
      { label: "GF",  tactic: "GROUNDFLOW", neg: neg("groundflow") },
    ].filter((f) => f.neg > 0);
    if (fronts.length < 2) return null;
    return fronts.map((f) => ({
      label:  f.label,
      pacing: computeMediaPacing(rows, camp, mediaType, f.tactic),
    }));
  };
  const displaySubBars = buildTacticSubBars(display, "DISPLAY");
  const videoSubBars   = buildTacticSubBars(video,   "VIDEO");

  // Pacing Geral % — média ponderada por budget de Display + Video,
  // usando a mesma fórmula calendar-camp acima.
  const pacingGeral = computePacingGeral(display, video, camp, coreFilter);

  // Budget respeita o filtro Core Product. `aggregates.budgetTotal` vem do
  // campo `budget_contracted` da campaign (sempre inteiro) — pra filtro
  // O2O/OOH, reconstrói somando os <frente>_<media>_budget das rows.
  const filteredBudgetTotal = coreFilter === "ALL"
    ? budgetTotal
    : pickBudget(display[0], "display", coreFilter)
    + pickBudget(video[0],   "video",   coreFilter);
  const filteredBudgetProRata = isFiltered && filteredBudgetTotal && budgetTotal
    ? Math.round(filteredBudgetTotal * (budgetProRata / budgetTotal) * 100) / 100
    : filteredBudgetTotal;

  // Encerramento antes do previsto (cliente cancelou o PI): o report passa
  // a faturar pelo volume EFETIVAMENTE entregue. O budget faturável colapsa
  // pro Custo Efetivo (= novo faturável), e o contratado original vira só
  // referência. Pacing NÃO muda — continua vs contrato original (backend
  // Opção B); um aviso explica isso no módulo de ritmo. Só aplica na visão
  // cheia: com filtro de período o budget é um recorte analítico pro-rata.
  //
  // Guard de redução real: campanha encerrada cedo mas em OVER fatura o
  // contrato CHEIO — aí não há refaturamento. Tolerância de R$1 engole
  // ruído de arredondamento por frente.
  const earlyEnded = !!camp.early_end_date;
  const billedEffective =
    earlyEnded && !isFiltered && totalCusto < filteredBudgetTotal - 1
      ? totalCusto
      : null;

  // Custo formatado pra hero (separa centavos pra estilo do mockup).
  const { main: custoMain, cents: custoCents } = splitCents(totalCusto);
  // Em campanha bonificada, hero mostra o valor da cortesia (=`budgetTotal`,
  // que pelo contrato representa "quanto vale o que estamos bonificando").
  const { main: bonusMain, cents: bonusCents } = splitCents(budgetTotal);

  // "Custo + over" só aparece quando há over-delivery real (sem over o
  // valor é idêntico ao custo efetivo).
  const hasOverDelivery = totalCustoOver > totalCusto;
  const showCustoOver = !isBonusOnly && hasOverDelivery;

  // Régua do herói: custo × budget (pro-rata com filtro de período) e o
  // quanto do período já passou, contado até a data do dado.
  const heroBudget = isFiltered ? filteredBudgetProRata : filteredBudgetTotal;
  const budgetPct = heroBudget > 0 ? (totalCusto / heroBudget) * 100 : null;
  const elapsedPct = isFiltered
    ? null
    : periodElapsedPct(camp.start_date, camp.early_end_date || camp.end_date, computeDataUntil(data));

  const heroFooter = [];
  if (billedEffective != null) {
    heroFooter.push(
      <div key="refat">
        Campanha encerrada antes do previsto: budget refaturado para o volume
        entregue. Contratado{" "}
        <span className="line-through decoration-fg-subtle/60 tabular-nums">
          {fmtR(filteredBudgetTotal)}
        </span>
      </div>,
    );
  } else if (budgetPct != null) {
    heroFooter.push(
      <div key="budget">
        <span className="font-semibold text-fg tabular-nums">{fmt(budgetPct, 1)}%</span>{" "}
        {isFiltered ? (
          <>do budget proporcional ao período ({fmtR(heroBudget)})</>
        ) : (
          <>
            do budget de <span className="tabular-nums">{fmtR(heroBudget)}</span>
            {elapsedPct != null && (
              <> · {fmt(elapsedPct, 0)}% do período decorrido</>
            )}
          </>
        )}
      </div>,
    );
  }
  if (showCustoOver) {
    heroFooter.push(
      <div key="over" title="Inclui o valor da entrega acima do contratado (over-delivery).">
        Custo + over{" "}
        <span className="font-semibold text-fg tabular-nums">{fmtR(totalCustoOver)}</span>
      </div>,
    );
  }

  // ─── Linha de KPIs ────────────────────────────────────────────────
  // Escopo do alcance (target_type/target_id):
  //   - Visão agregada de merge group → escopo "merge" com merge_id.
  //   - Caso contrário (single token OU drill-down de membro) → "token".
  // Impressões usam data.totals (campanha cheia, sem filtro de período) —
  // alcance é um valor de campanha, não de janela parcial.
  const isAggregatedView = !!mergeMeta && (view === "aggregated" || view === "all");
  const alcanceTargetType = isAggregatedView ? "merge" : "token";
  const alcanceTargetId = isAggregatedView
    ? mergeMeta.merge_id
    : (view || data.campaign?.short_token || token);
  const alcanceImpressions = (data.totals || []).reduce((s, r) => s + (r.impressions || 0), 0);

  const showPacingGeral = !isFiltered && pacingGeral > 0;

  const kpiDefs = [
    {
      key: "vi",
      render: () => (
        <KpiCardV2
          label="Imp. visíveis"
          value={fmt(totalImpressions)}
          hint="Impressões visíveis (viewable) no período. Viewability = imp. visíveis ÷ impressões medidas."
          note={viewability != null ? <KpiNote label="Viewability" value={`${fmt(viewability, 1)}%`} /> : null}
          sparkline={kpiSparkline(impSparklineValues)}
        />
      ),
    },
    hasVideo && {
      key: "v100",
      render: () => (
        <KpiCardV2
          label="Views 100%"
          value={fmt(totalViews100)}
          hint="Visualizações de vídeo até o fim. VTR = views 100% ÷ imp. visíveis de vídeo."
          note={vtrTotal != null ? <KpiNote label="VTR" value={`${fmt(vtrTotal, 1)}%`} /> : null}
          sparkline={kpiSparkline(viewsSparklineValues)}
        />
      ),
    },
    {
      key: "alcance",
      render: () => (
        <AlcanceKpiCardV2
          key={`${alcanceTargetType}:${alcanceTargetId}`}
          targetType={alcanceTargetType}
          targetId={alcanceTargetId}
          isAdmin={isAdmin}
          adminJwt={adminJwt}
          initialAlcance={data.alcance}
          initialFrequencia={data.frequencia}
          initialAutoAlcance={data.auto_alcance}
          initialUpdatedAt={data.alcance_updated_at}
          totalImpressions={alcanceImpressions}
        />
      ),
    },
    showPacingGeral && {
      key: "pacing",
      render: () => (
        <KpiCardV2
          label={`Pacing geral${pacingSuffix}`}
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
              : "Média ponderada de pacing Display + Vídeo pelo budget contratado."
          }
          note={hasDisplay && hasVideo ? (
            <span className="text-[11px] text-fg-subtle">Display + Vídeo, ponderado pelo budget</span>
          ) : null}
        />
      ),
    },
  ].filter(Boolean);
  // Abaixo de xl a grade tem 2 colunas (celular incluso) e o herói ocupa a
  // linha inteira; com contagem ímpar o último card estica pra não sobrar
  // meia linha.
  const kpiCount = kpiDefs.length;
  const tailClass = (i) =>
    kpiCount % 2 === 1 && i === kpiCount - 1 ? "col-span-2 xl:col-span-1" : undefined;

  // ─── Ritmo de entrega ─────────────────────────────────────────────
  const showRhythm = !isFiltered && (hasDisplay || hasVideo);
  const displayBar = showRhythm && hasDisplay ? {
    label: `Display${pacingSuffix}`,
    pacing: pacingDisplay,
    budget: pickBudget(display[0], "display", coreFilter),
    cost: display.reduce((s, r) => s + (r.effective_total_cost || 0), 0),
    subBars: displaySubBars,
    bonusFooter: isBonusOnly
      ? {
          delivered: display.reduce((s, r) => s + (r.viewable_impressions || 0), 0),
          target: pickContracted(display[0], "display", coreFilter),
          unit: "imp.",
        }
      : null,
    contracted: pickContracted(display[0], "display", coreFilter) - pickBonus(display[0], "display", coreFilter),
    bonus: pickBonus(display[0], "display", coreFilter),
    delivered: display.reduce((s, r) => s + (r.viewable_impressions || 0), 0),
  } : null;
  const videoBar = showRhythm && hasVideo ? {
    label: `Vídeo${pacingSuffix}`,
    pacing: pacingVideo,
    budget: pickBudget(video[0], "video", coreFilter),
    cost: video.reduce((s, r) => s + (r.effective_total_cost || 0), 0),
    subBars: videoSubBars,
    bonusFooter: isBonusOnly
      ? {
          delivered: video.reduce((s, r) => s + (r.completions || 0), 0),
          target: pickContracted(video[0], "video", coreFilter),
          unit: "views",
        }
      : null,
    contracted: pickContracted(video[0], "video", coreFilter) - pickBonus(video[0], "video", coreFilter),
    bonus: pickBonus(video[0], "video", coreFilter),
    delivered: video.reduce((s, r) => s + (r.completions || 0), 0),
  } : null;

  // Curva acumulada (visão Evolução): mesma régua de contrato das barras.
  const curveContractedDisplay = pickContracted(display[0], "display", coreFilter);
  const curveContractedVideo = pickContracted(video[0], "video", coreFilter);
  const curve =
    showRhythm && daily0?.length > 0 && camp.start_date && camp.end_date
    && (curveContractedDisplay > 0 || curveContractedVideo > 0)
      ? {
          daily: daily0,
          contractedDisplay: curveContractedDisplay,
          contractedVideo: curveContractedVideo,
          startDate: camp.start_date,
          endDate: camp.end_date,
          downloadable: isAdmin,
          filename: `${camp.campaign_name} - Curva de Pacing`,
        }
      : null;

  const rhythmSentence = showRhythm
    ? buildRhythmSentence({
        isBonusOnly,
        billed: billedEffective != null,
        budgetPct,
        elapsedPct,
        media: [
          hasDisplay && { name: "Display", pacing: pacingDisplay },
          hasVideo && { name: "Vídeo", pacing: pacingVideo },
        ].filter(Boolean),
      })
    : null;

  // Aviso de pacing pós-encerramento antecipado — o pacing continua medido
  // contra o CONTRATO ORIGINAL (não contra o budget refaturado).
  const rhythmNotice = earlyEnded && showRhythm ? (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[12px] leading-snug text-fg-muted">
      <InfoIcon className="size-4 text-warning mt-px shrink-0" />
      <span>
        <span className="font-semibold text-fg">
          Pacing calculado sobre o contrato original.
        </span>{" "}
        A campanha foi encerrada antes do previsto — as barras mostram o
        quanto foi entregue em relação ao volume inicialmente contratado, não
        ao valor refaturado.
      </span>
    </div>
  ) : null;

  // ─── Resumo por mídia ─────────────────────────────────────────────
  const maLinks = data.max_attention?.links || [];
  const showMaCard = showMaxAttentionTab && maLinks.length > 0;
  const mediaCount = (hasDisplay ? 1 : 0) + (hasVideo ? 1 : 0) + (showMaCard ? 1 : 0);
  const mediaLayout = mediaCount >= 2 ? "stacked" : "strip";
  const mediaGridClass =
    mediaCount >= 3 ? "md:grid-cols-2 xl:grid-cols-3" : mediaCount === 2 ? "md:grid-cols-2" : "";

  return (
    <div className="space-y-6">
      {/* ─── 0. Guardrail: volumetria contratada incoerente (ADMIN-ONLY) ──
          O contrato de entrega registrado (Σ volume × tarifa, base da aba
          Display) supera o investimento da campanha (base da Visão Geral) →
          volumetria stale no checklist do Command. NUNCA mostrar pro cliente.
          Backend: campaign.contract_inconsistency (_emit_contract_consistency). */}
      {isAdmin && camp?.contract_inconsistency && (
        <div className="flex items-start gap-2.5 rounded-lg border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-[12px] leading-snug text-fg-muted">
          <InfoIcon className="size-4 text-danger mt-px shrink-0" />
          <span>
            <span className="font-semibold text-fg">
              Volumetria contratada incoerente com o investimento.
            </span>{" "}
            O contrato de entrega registrado ({fmtR(camp.contract_inconsistency.implied_budget)})
            supera o investimento da campanha ({fmtR(camp.contract_inconsistency.declared_budget)})
            em {fmt(camp.contract_inconsistency.pct, 0)}% — sinal de volumetria
            desatualizada no <span className="font-semibold text-fg">Command</span>.
            A aba Display está exibindo o volume antigo; corrija a volumetria no
            checklist do Command para os números baterem. (Aviso interno — o
            cliente não vê esta mensagem.)
          </span>
        </div>
      )}

      {/* ─── 1. KPIs ─────────────────────────────────────────────────── */}
      <div className={`grid grid-cols-2 gap-3 ${XL_COLS[kpiCount] || "xl:grid-cols-6"}`}>
        <div className="col-span-2 grid min-w-0">
          {isBonusOnly ? (
            <HeroKpiCardV2
              icon={<GiftIcon />}
              label="Valor bonificado · total"
              value={bonusMain}
              cents={bonusCents}
              caption="Volume entregue como cortesia HYPR — sem custo pro cliente."
              variant="bonus"
            />
          ) : (
            <HeroKpiCardV2
              icon={<DollarIcon />}
              label={isFiltered ? "Custo efetivo · período" : "Custo efetivo · total"}
              value={custoMain}
              cents={custoCents}
              sparklineValues={costSparklineValues}
              meter={
                billedEffective == null && budgetPct != null
                  ? { pct: budgetPct, label: `${fmt(budgetPct, 1)}% do budget investido` }
                  : null
              }
              footer={heroFooter.length ? heroFooter : null}
            />
          )}
        </div>
        {kpiDefs.map((d, i) => (
          <div key={d.key} className={`grid min-w-0 ${tailClass(i) || ""}`}>
            {d.render()}
          </div>
        ))}
      </div>

      {/* ─── 2. Ritmo de entrega ─────────────────────────────────────── */}
      {showRhythm && (
        <DeliveryRhythmCardV2
          displayBar={displayBar}
          videoBar={videoBar}
          curve={curve}
          sentence={rhythmSentence}
          notice={rhythmNotice}
        />
      )}

      {/* ─── 3. Resumo por mídia ─────────────────────────────────────── */}
      {mediaCount > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
            Resumo por mídia
          </h2>
          <div className={`grid grid-cols-1 gap-3 ${mediaGridClass}`}>
            {hasDisplay && (
              <MediaSummaryV2
                type="DISPLAY"
                rows={display}
                layout={mediaLayout}
                compact={mediaCount >= 2}
                onNavigate={showDisplayTab ? onNavigate : null}
              />
            )}
            {hasVideo && (
              <MediaSummaryV2
                type="VIDEO"
                rows={video}
                layout={mediaLayout}
                compact={mediaCount >= 2}
                onNavigate={showVideoTab ? onNavigate : null}
              />
            )}
            {showMaCard && (
              <MaxAttentionSummaryCardV2
                className={mediaCount >= 3 ? "md:col-span-2 xl:col-span-1" : undefined}
                token={token}
                view={view}
                range={range}
                links={maLinks}
                layout={mediaLayout}
                onNavigate={onNavigate}
              />
            )}
          </div>
        </section>
      )}

      {/* ─── 4. Tendência diária ─────────────────────────────────────── */}
      {series.length > 0 && (
        <DailyTrendCardV2
          series={series}
          downloadable={isAdmin}
          filename={camp.campaign_name}
        />
      )}

      {/* ─── 5. Entrega por dia ──────────────────────────────────────── */}
      {/* Usa `detail` (enriched) em vez de `daily0` porque o backend
          retorna effective_total_cost em query_daily como MAX (cumulativo)
          — somar valores diários distorce. enrichDetailCosts apportiona o
          custo total proporcionalmente, então somar detail por dia bate
          com o total da campanha. availableMedia restringe o toggle às
          mídias que a campanha realmente tem. */}
      {detail && detail.length > 0 && (
        <DailyAggregateTableV2
          daily={detail}
          campaignName={camp.campaign_name}
          availableMedia={availableMediaFromData(data)}
          downloadable={isAdmin}
          title="Entrega por dia"
          initialRows={7}
        />
      )}
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
    (t0.contracted_groundflow_display_impressions || 0) > 0 ||
    (t0.bonus_o2o_display_impressions || 0) > 0 ||
    (t0.bonus_ooh_display_impressions || 0) > 0 ||
    (t0.bonus_groundflow_display_impressions || 0) > 0;
  const hasVideoContract =
    (t0.contracted_o2o_video_completions || 0) > 0 ||
    (t0.contracted_ooh_video_completions || 0) > 0 ||
    (t0.contracted_groundflow_video_completions || 0) > 0 ||
    (t0.bonus_o2o_video_completions || 0) > 0 ||
    (t0.bonus_ooh_video_completions || 0) > 0 ||
    (t0.bonus_groundflow_video_completions || 0) > 0;
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
  const gf  = media === "video" ? (row.groundflow_video_budget || 0) : (row.groundflow_display_budget || 0);
  if (tactic === "O2O") return o2o;
  if (tactic === "OOH") return ooh;
  if (tactic === "GROUNDFLOW") return gf;
  return o2o + ooh + gf;
}

function pickContracted(row, media, tactic) {
  if (!row) return 0;
  const o2o = media === "video"
    ? (row.contracted_o2o_video_completions   || 0) + (row.bonus_o2o_video_completions   || 0)
    : (row.contracted_o2o_display_impressions || 0) + (row.bonus_o2o_display_impressions || 0);
  const ooh = media === "video"
    ? (row.contracted_ooh_video_completions   || 0) + (row.bonus_ooh_video_completions   || 0)
    : (row.contracted_ooh_display_impressions || 0) + (row.bonus_ooh_display_impressions || 0);
  const gf = media === "video"
    ? (row.contracted_groundflow_video_completions   || 0) + (row.bonus_groundflow_video_completions   || 0)
    : (row.contracted_groundflow_display_impressions || 0) + (row.bonus_groundflow_display_impressions || 0);
  if (tactic === "O2O") return o2o;
  if (tactic === "OOH") return ooh;
  if (tactic === "GROUNDFLOW") return gf;
  return o2o + ooh + gf;
}

// Bônus (cortesia) somado por mídia×tactic — espelha pickContracted mas SÓ os
// campos bonus_*. Usado pra posicionar o divisor contrato/bônus na PacingBarV2:
// contratado_pago = pickContracted (que é contr+bônus) − pickBonus.
function pickBonus(row, media, tactic) {
  if (!row) return 0;
  const o2o = media === "video"
    ? (row.bonus_o2o_video_completions   || 0)
    : (row.bonus_o2o_display_impressions || 0);
  const ooh = media === "video"
    ? (row.bonus_ooh_video_completions   || 0)
    : (row.bonus_ooh_display_impressions || 0);
  const gf = media === "video"
    ? (row.bonus_groundflow_video_completions   || 0)
    : (row.bonus_groundflow_display_impressions || 0);
  if (tactic === "O2O") return o2o;
  if (tactic === "OOH") return ooh;
  if (tactic === "GROUNDFLOW") return gf;
  return o2o + ooh + gf;
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

// Nota discreta de KPI: "Viewability 80,0%".
function KpiNote({ label, value }) {
  return (
    <span className="text-[11px] text-fg-subtle">
      {label} <span className="font-semibold text-fg tabular-nums">{value}</span>
    </span>
  );
}

function kpiSparkline(values) {
  if (!values || values.length < 2) return null;
  return (
    <SparklineV2
      values={values}
      stroke="var(--color-signature-light)"
      strokeWidth={1.5}
      width={100}
      height={20}
      className="opacity-70"
    />
  );
}

// Frase de ritmo do módulo "Ritmo de entrega": o quanto do budget foi
// investido contra o quanto do período passou, e quem está fora do ritmo.
// Limiar de 95%: abaixo disso a mídia é citada como atrasada.
function buildRhythmSentence({ isBonusOnly, billed, budgetPct, elapsedPct, media }) {
  if (elapsedPct === 0) return "A campanha ainda não começou a entregar.";
  if (isBonusOnly || billed || budgetPct == null) {
    return elapsedPct != null ? `${fmt(elapsedPct, 0)}% do período decorrido.` : null;
  }
  const behind = media.filter((m) => (Number(m.pacing) || 0) < 95).map((m) => m.name);
  const allOnTrack = media.length > 0 && media.every((m) => (Number(m.pacing) || 0) >= 100);
  const status = behind.length
    ? ` ${behind.join(" e ")} ${behind.length > 1 ? "estão" : "está"} abaixo do ritmo contratado.`
    : allOnTrack
      ? " Entrega no ritmo contratado ou acima."
      : " Entrega próxima do ritmo contratado.";
  return (
    <>
      <span className="font-semibold text-fg">
        {fmt(budgetPct, 1)}% do budget investido
        {elapsedPct != null ? ` em ${fmt(elapsedPct, 0)}% do período.` : "."}
      </span>
      {status}
    </>
  );
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
  const includeGF  = tactic === "ALL" || tactic === "GROUNDFLOW";
  const dbudget = (includeO2O ? (display[0]?.o2o_display_budget || 0) : 0)
                + (includeOOH ? (display[0]?.ooh_display_budget || 0) : 0)
                + (includeGF  ? (display[0]?.groundflow_display_budget || 0) : 0);
  const vbudget = (includeO2O ? (video[0]?.o2o_video_budget   || 0) : 0)
                + (includeOOH ? (video[0]?.ooh_video_budget   || 0) : 0)
                + (includeGF  ? (video[0]?.groundflow_video_budget || 0) : 0);
  const total = dbudget + vbudget;
  if (!total) return 0;

  return (dpacing * dbudget + vpacing * vbudget) / total;
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

function InfoIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
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
