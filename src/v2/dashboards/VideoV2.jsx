// src/v2/dashboards/VideoV2.jsx
//
// Dashboard Video V2 — REDESIGN PR-14
//
// Reescrita pra alinhar com o padrão visual da OverviewV2 (PR-13):
// hero ComparisonCard no topo, KPI grids contratual+performance,
// Pacing com marker "esperado hoje", tabela "Por Formato" com share
// visual, charts diários e detalhamento em collapsible fechado.
//
// LAYOUT, NA ORDEM (top → bottom)
//   1. Toolbar interna       — SegmentedControlV2 (O2O/OOH) + AudienceFilterV2
//   2. Hero ComparisonCard   — CPCV Negociado vs Efetivo + economia
//   3. KPI grid contratual   — Budget · Views Contratadas · Bonus · CPCV Neg
//   4. KPI grid performance  — Starts · Views 100% · VTR · CPCV Ef · Rentab
//   5. PacingBar             — com marker "esperado hoje" (escondido sob filtro)
//   6. Charts diários        — Views 100% × VTR
//   7. FormatBreakdownTable  — distribuição por creative_size com share visual
//   8. Chart Audiência       — DualChart byAudience (mantido como gráfico)
//   9. DailyAggregateTable   — agregada por dia (mediaFilter="VIDEO")
//
// FILTRO DE PERÍODO É GLOBAL (shell ClientDashboardV2).
// FILTRO DE TACTIC: deriva no frontend pra alinhar com o que totals já
//   faz no backend (`query_totals` tem fallback hardcoded `ELSE 'O2O'`,
//   `query_detail` tem `ELSE tactic_type` — fallbacks diferentes
//   geravam mismatch). Lógica:
//     1. line_name tem `_O2O_`/`_O2O$` (case insensitive) → "O2O"
//     2. line_name tem `_OOH_`/`_OOH$`                    → "OOH"
//     3. fallback                                          → "O2O"
//   Cobre o caso Diageo Johnnie Walker em que video O2O entregava mas
//   detail vinha sem tactic_type setado, deixando KPIs zerados.

import { useMemo } from "react";
import { useAudienceOverrides } from "../hooks/useAudienceOverrides";
import {
  computeVideoKpis,
  applyAudienceOverride,
  extractAudience,
  getCreativeLineKey,
  groupByDate,
  groupBySize,
  groupByCreativeName,
  groupByAudience,
} from "../../shared/aggregations";
import { fmt, fmtP, fmtP2, fmtR } from "../../shared/format";

import { useReportTrackingContext } from "../contexts/ReportTrackingContext";
import { CollapsibleSectionV2 } from "../components/CollapsibleSectionV2";
import { ComparisonCardV2 } from "../components/ComparisonCardV2";
import { DailyAggregateTableV2 } from "../components/DailyAggregateTableV2";
import { DualChartV2 } from "../components/DualChartV2";
import { ChartCardV2 } from "../components/ChartCardV2";
import { FormatBreakdownTableV2 } from "../components/FormatBreakdownTableV2";
import { KpiCardV2 } from "../components/KpiCardV2";
import { PacingBarV2 } from "../components/PacingBarV2";
import { SegmentedControlV2 } from "../components/SegmentedControlV2";

const TACTIC_OPTIONS = [
  { value: "O2O", label: "O2O" },
  { value: "OOH", label: "OOH" },
  { value: "GROUNDFLOW", label: "Groundflow" },
];

// Espelha o CASE do `query_totals` no backend. ORDEM IMPORTA: Groundflow
// (token RMNF ou GROUNDFLOW) vence O2O — lines vêm como `..._O2O_GROUNDFLOW_...`.
// Delimitador pode ser `_` ou `-` (naming mistura os dois).
// `gfOn` = a campanha tem contrato de groundflow (dark test sem contrato →
// conta como O2O/OOH; espelha o _GF_CONTRACT_GATE do backend).
const GROUNDFLOW_RE = /(?:^|[_-])(?:RMNF|GROUNDFLOW)(?:[_-]|$)/i;
const O2O_RE = /(?:^|[_-])O2O(?:[_-]|$)/i;
const OOH_RE = /(?:^|[_-])OOH(?:[_-]|$)/i;
const deriveTactic = (lineName, gfOn) => {
  const ln = lineName || "";
  if (gfOn && GROUNDFLOW_RE.test(ln)) return "GROUNDFLOW";
  if (O2O_RE.test(ln)) return "O2O";
  if (OOH_RE.test(ln)) return "OOH";
  return "O2O";
};

// Formatter pra CPCV (3 casas decimais — valores tipicamente < R$ 0,50).
const fmtCpcv = (v) =>
  typeof v === "number" && v > 0
    ? `R$ ${v.toFixed(3).replace(".", ",")}`
    : "—";

export default function VideoV2({
  data,
  aggregates,
  tactic,
  setTactic,
  isAdmin = false,
}) {
  const camp = data.campaign;
  const { trackCta } = useReportTrackingContext();

  // Override de nome de audiência (Report Center, por anunciante) — igual ao
  // DisplayV2. Aplicado na quebra "Por Audiência"; editável inline só admin.
  const aud = useAudienceOverrides({
    initialMap: data.audience_overrides,
    clientName: camp.client_name,
    shortToken: camp.short_token,
    isAdmin,
  });

  // Tactics disponíveis: ver comentário equivalente em DisplayV2.
  const t0Video = (data.totals || [])[0] || {};
  const hasDelivery = (tac) => aggregates.totals.some(
    (r) => r.media_type === "VIDEO" && r.tactic_type === tac,
  );
  const hasContract = (frente) =>
    (t0Video[`contracted_${frente}_video_completions`] || 0) > 0 ||
    (t0Video[`bonus_${frente}_video_completions`] || 0) > 0;
  // Gate do Groundflow (espelha backend): sem contrato, line é dark test → O2O.
  const hasGfContract = hasContract("groundflow");
  // Override de core products (curadoria admin): esconde frentes fora do set
  // mesmo com entrega. Backend já zerou o contrato delas; isto gateia a entrega.
  const activeCP = camp.active_core_products;
  const isActiveCP = (frente) => !activeCP || activeCP.includes(frente);
  const showByTactic = {
    O2O:        isActiveCP("O2O")        && (hasContract("o2o")        || hasDelivery("O2O")),
    OOH:        isActiveCP("OOH")        && (hasContract("ooh")        || hasDelivery("OOH")),
    GROUNDFLOW: isActiveCP("GROUNDFLOW") && hasGfContract,  // contract-only (≠ O2O/OOH): dark test não vira frente
  };
  const availableTactics = TACTIC_OPTIONS.filter((opt) => showByTactic[opt.value]);
  const effectiveTactic =
    availableTactics.find((t) => t.value === tactic)?.value
    || availableTactics[0]?.value
    || tactic;

  // Filtros multi-select (audience/line/creative/size/formato) ficam no
  // GlobalDataFilterBarV2 do dashboard pai — já aplicados upstream em
  // computeAggregates. Aqui só fatiamos por mídia e tactic.
  const view = useMemo(() => {
    const totals = aggregates.totals.filter(
      (r) => r.media_type === "VIDEO" && r.tactic_type === effectiveTactic,
    );
    const detailAll = aggregates.detail.filter(
      (r) => r.media_type === "VIDEO" && deriveTactic(r.line_name, hasGfContract) === effectiveTactic,
    );

    const kpis = computeVideoKpis({
      rows: totals,
      detail: detailAll,
      tactic: effectiveTactic,
      checklist: t0Video,
    });

    // Normaliza creative_size pra Video: backend retorna "0x0" quando o
    // DSP não preenche dimensões em criativos de video, mas operacionalmente
    // é o mesmo formato 16:9 standard. Unifica antes do groupBySize pra
    // evitar 2 linhas separadas pra mesma coisa na Distribuição por Tamanho.
    const detailNormalized = detailAll.map((r) =>
      r.creative_size === "0x0" ? { ...r, creative_size: "16x9" } : r,
    );

    const daily = groupByDate(detailAll, "video_view_100", "viewable_impressions", "vtr");
    const bySize = groupBySize(detailNormalized, "video_view_100", "viewable_impressions", "vtr");
    const byCreative = groupByCreativeName(detailAll, "video_view_100", "viewable_impressions", "vtr");
    const byAudience = groupByAudience(detailAll, "video_view_100", "viewable_impressions", "vtr", aud.overrideMap);

    return { totals, detailAll, detailNormalized, kpis, daily, bySize, byCreative, byAudience };
  }, [aggregates, effectiveTactic, t0Video, hasGfContract, aud.overrideMap]);

  const { totals, detailAll, detailNormalized, kpis, daily, bySize, byCreative, byAudience } = view;
  // Alias mantido pelos consumers internos (`detailFiltered`). Pós-refactor
  // filtered === all dentro do VideoV2 (filtro real é upstream em
  // computeAggregates).
  const detailFiltered = detailAll;

  // Empty state vs notStarted (mesma lógica do DisplayV2):
  //  - notStarted: há contrato sem delivery — mostra contratual + disclaimer
  //  - isEmpty: zero contrato E zero delivery (defensivo)
  const isEmpty = totals.length === 0 && view.detailAll.length === 0 && !kpis.notStarted;

  // Views contratadas e bonus — fallback pro checklist (t0Video) quando
  // a tactic ainda não entregou (caso "notStarted").
  const row0 = totals[0] || t0Video || {};
  const _frente = (effectiveTactic || "O2O").toLowerCase();
  const contractedViews = row0[`contracted_${_frente}_video_completions`] || 0;
  const bonusViews       = row0[`bonus_${_frente}_video_completions`]      || 0;

  // CPCV "com bonus": equivalente ao cpmNegBonus do Display. Mesmo budget
  // dividido pela entrega total prometida (contracted + bonus completions).
  // Reflete o que o cliente paga POR view 100% entregue de fato (incluindo
  // bonus). Só calcula quando bonus > 0 — sem bonus, manter o cpcv contratual
  // já cobre.
  const cpcvNegBonus = bonusViews > 0 && contractedViews > 0 && kpis.cpcvNeg > 0
    ? (kpis.cpcvNeg * contractedViews) / (contractedViews + bonusViews)
    : null;

  // CPCV Efetivo PROJETADO — ver doc equivalente em DisplayV2 (cpmEfProjected).
  // Aqui a unidade é views 100% (completions) em vez de impressões visíveis.
  const cpcvEfProjected = (() => {
    if (!bonusViews || bonusViews <= 0) return null;
    if (!contractedViews || !kpis.cpcvNeg || !(kpis.pac > 0)) return null;
    const totalPromise = contractedViews + bonusViews;
    const budget = kpis.cpcvNeg * contractedViews;
    const pacingRatio = Math.min(kpis.pac / 100, 1);
    const projectedViews = pacingRatio * totalPromise;
    if (projectedViews <= 0) return null;
    const projectedCost = projectedViews > contractedViews
      ? budget
      : kpis.cpcvNeg * projectedViews;
    return projectedCost / projectedViews;
  })();
  // A projeção só vale enquanto a entrega factual ainda NÃO realizou a
  // economia. Assim que a entrega real (completions) ultrapassa
  // contratadas+bonus, o cpcvEf factual (= budget / completions) já caiu
  // ABAIXO da projeção — que fica travada em budget/(contratadas+bonus)
  // pelo cap de pacing em 100%. Nesse ponto o factual É a verdade
  // entregue, não estimativa, então mostramos ele. Ex.: pacing 401,3% →
  // factual R$0,05 vence a projeção capada em R$0,200.
  const useProjection =
    cpcvEfProjected !== null &&
    !(kpis.cpcvEf != null && kpis.cpcvEf < cpcvEfProjected);
  const cpcvEfDisplay = useProjection ? cpcvEfProjected : kpis.cpcvEf;
  const rentabDisplay = useProjection && kpis.cpcvNeg > 0
    ? ((kpis.cpcvNeg - cpcvEfProjected) / kpis.cpcvNeg) * 100
    : kpis.rentab;

  return (
    <div className="space-y-6">
      {/* ─── 1. Toolbar interna ──────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        {/* Segmented O2O/OOH só renderiza se há mais de uma tactic com
            contrato ou entrega (mesma lógica do DisplayV2). */}
        {availableTactics.length > 1 ? (
          <SegmentedControlV2
            label="Tática Video"
            options={availableTactics}
            value={effectiveTactic}
            onChange={(t) => {
              trackCta("tactic_change_video");
              setTactic(t);
              // Filtros movidos pro GlobalDataFilterBarV2 — não resetam aqui.
            }}
          />
        ) : (
          <div />
        )}
      </div>
      {/* Filtros multi-select (audience/line/creative line/tamanho/formato)
          movidos pro GlobalDataFilterBarV2 do dashboard pai em PR-22 —
          agora ficam abaixo da tab bar, compartilhados entre Overview/
          Display/Video. */}

      {isEmpty ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center">
          <p className="text-sm text-fg-muted">
            Não há entrega Video {effectiveTactic} nesta campanha.
          </p>
        </div>
      ) : (
        <VideoContent
          camp={camp}
          tactic={effectiveTactic}
          aggregates={aggregates}
          detailAll={detailAll}
          detailFiltered={detailFiltered}
          detailNormalized={detailNormalized}
          kpis={kpis}
          daily={daily}
          bySize={bySize}
          byCreative={byCreative}
          byAudience={byAudience}
          contractedViews={contractedViews}
          bonusViews={bonusViews}
          cpcvNegBonus={cpcvNegBonus}
          cpcvEfDisplay={cpcvEfDisplay}
          rentabDisplay={rentabDisplay}
          useProjection={useProjection}
          notStarted={kpis.notStarted}
          isAdmin={isAdmin}
          aud={aud}
        />
      )}
    </div>
  );
}

// Conteúdo "pesado" do Video — extraído pra fora pra simplificar o
// fluxo de empty state e não duplicar o JSX da toolbar.
function VideoContent({
  camp,
  tactic,
  aggregates,
  detailAll,
  detailFiltered,
  detailNormalized,
  kpis,
  daily,
  bySize,
  byCreative,
  byAudience,
  contractedViews,
  bonusViews,
  cpcvNegBonus,
  cpcvEfDisplay,
  rentabDisplay,
  useProjection,
  notStarted,
  isAdmin = false,
  aud,
}) {
  const campName = camp.campaign_name || "campanha";
  return (
    <>
      {notStarted && (
        <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 flex items-start gap-3">
          <span className="size-2 rounded-full bg-warning mt-1.5 shrink-0" aria-hidden />
          <div className="text-sm">
            <div className="font-medium text-fg">Entrega {tactic} ainda não iniciada</div>
            <div className="text-fg-muted mt-0.5">
              Exibindo apenas os valores negociados. Verifique pendências com o cliente.
            </div>
          </div>
        </div>
      )}

      {/* ─── 2. Hero ComparisonCard ──────────────────────────────────── */}
      <ComparisonCardV2
        title={`CPCV Video · ${tactic}`}
        negociado={kpis.cpcvNeg}
        efetivo={cpcvEfDisplay}
        negociadoComBonus={cpcvNegBonus}
        efetivoIsProjection={useProjection}
        formatValue={(v) => `R$ ${(v || 0).toFixed(3).replace(".", ",")}`}
      />

      {/* ─── 3. KPI grid contratual ──────────────────────────────────── */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
          Contratual
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCardV2
            outlined
            label="Budget Contratado"
            value={fmtR(kpis.budget)}
            hint="Budget alocado à tática selecionada (O2O ou OOH)."
          />
          <KpiCardV2
            outlined
            label="Views Contratadas"
            value={fmt(contractedViews)}
            hint="Volume de completions (views 100%) contratadas para a tática."
          />
          <KpiCardV2
            outlined
            label="Views Bonus"
            value={fmt(bonusViews)}
            hint="Bonus negociado adicional ao contratado."
          />
          <KpiCardV2
            outlined
            label="CPCV Negociado"
            value={fmtCpcv(kpis.cpcvNeg)}
            hint="CPCV (Custo Por Completion View) acordado em contrato."
          />
        </div>
      </section>

      {/* ─── 4. KPI grid performance ─────────────────────────────────── */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
          Performance
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <KpiCardV2
            label="Views Start"
            value={fmt(kpis.starts)}
            hint="Total de video starts (impressões com início de reprodução)."
          />
          <KpiCardV2
            label="Views 100%"
            value={fmt(kpis.views100)}
            hint="Completions — vídeos vistos até o final."
          />
          <KpiCardV2
            label="VTR"
            value={fmtP2(kpis.vtr)}
            hint="View-Through Rate: Views 100% / Imp. Visíveis."
          />
          <KpiCardV2
            label={useProjection ? "CPCV Efetivo *" : "CPCV Efetivo"}
            value={fmtCpcv(cpcvEfDisplay)}
            accent
            hint={useProjection
              ? "Projeção mantendo o ritmo atual de entrega até o fim da campanha. Considera o bonus de views contratado: se o pacing levar a entrega total além das views contratadas, o custo capa no budget e o CPCV cai. Converge para o Negociado Ajustado em 100% de pacing."
              : "Custo Efetivo / Views 100%. Quando filtrado, recalculado proporcionalmente ao período."}
          />
          <KpiCardV2
            label="Rentabilidade"
            value={fmtP(rentabDisplay)}
            accent
            hint={useProjection
              ? "(CPCV Tabela HYPR − CPCV Efetivo projetado) / CPCV Tabela HYPR. Positivo = projeção indica entrega abaixo do CPCV contratual graças ao bonus."
              : "(CPCV Negociado − CPCV Efetivo) / CPCV Negociado. Positivo = a HYPR entregou mais que o contratado."}
          />
          <KpiCardV2
            label="Custo Efetivo Total"
            value={fmtR(kpis.cost)}
            hint="Valor investido até o momento na tática selecionada — base do pacing."
          />
        </div>
      </section>

      {/* ─── 5. Pacing ───────────────────────────────────────────────── */}
      {!aggregates.isFiltered && (
        <PacingBarV2
          label={`Pacing Video ${tactic}`}
          pacing={kpis.pac}
          budget={kpis.budget}
          cost={kpis.cost}
        />
      )}

      {/* ─── 6. Chart diário (full-width) ────────────────────────────── */}
      {daily.length > 0 && (
        <section>
          <ChartCardV2
            title="Views 100% × VTR Diário"
            downloadable={isAdmin}
            filename={`${campName} - Video ${tactic} - Views 100 x VTR Diario`}
          >
            <DualChartV2
              data={daily}
              xKey="date"
              y1Key="video_view_100"
              y2Key="vtr"
              label1="Views 100%"
              label2="VTR %"
            />
          </ChartCardV2>
        </section>
      )}

      {/* ─── 7. Tabela "Por Formato" (creative_size) ─────────────────── */}
      {bySize.length > 0 && (
        <FormatBreakdownTableV2
          rows={bySize}
          groupKey="size"
          groupLabel="Tamanho"
          denomKey="viewable_impressions"
          denomLabel="Imp. Visíveis"
          numeratorKey="video_view_100"
          numeratorLabel="Views 100%"
          rateKey="vtr"
          rateLabel="VTR"
          rateFormatter={fmtP2}
          extraRows={detailNormalized}
          mediaType="VIDEO"
          downloadable={isAdmin}
          filename={`${campName} - Video ${tactic} - Por Tamanho`}
        />
      )}

      {/* ─── 7b. Tabela "Por Linha Criativa" (creative_name menos o size) ─ */}
      {byCreative.length > 0 && (
        <FormatBreakdownTableV2
          rows={byCreative}
          groupKey="creative_name"
          groupLabel="Linha Criativa"
          itemNoun="linha criativa"
          itemNounPlural="linhas criativas"
          denomKey="viewable_impressions"
          denomLabel="Imp. Visíveis"
          numeratorKey="video_view_100"
          numeratorLabel="Views 100%"
          rateKey="vtr"
          rateLabel="VTR"
          rateFormatter={fmtP2}
          extraRows={detailFiltered}
          getDetailGroupKey={getCreativeLineKey}
          mediaType="VIDEO"
          downloadable={isAdmin}
          filename={`${campName} - Video ${tactic} - Por Linha Criativa`}
        />
      )}

      {/* ─── 8. Chart de Audiência (mantido como gráfico) ────────────── */}
      {byAudience.length > 0 && (
        <section>
          <ChartCardV2
            title="Views 100% × VTR por Audiência"
            downloadable={isAdmin}
            filename={`${campName} - Video ${tactic} - Views 100 x VTR por Audiencia`}
          >
            <DualChartV2
              data={byAudience}
              xKey="audience"
              y1Key="video_view_100"
              y2Key="vtr"
              label1="Views 100%"
              label2="VTR %"
            />
          </ChartCardV2>
        </section>
      )}

      {/* ─── 8b. Tabela "Por Audiência" ──────────────────────────────────
          Espelha a visão do gráfico (todas as audiências, ignorando o
          filtro de audience selecionada). Última coluna pra Video é
          CTR + Custo Ef. (mediaType="VIDEO").
      */}
      {byAudience.length > 0 && (
        <FormatBreakdownTableV2
          rows={byAudience}
          groupKey="audience"
          groupLabel="Audiência"
          itemNoun="audiência"
          denomKey="viewable_impressions"
          denomLabel="Imp. Visíveis"
          numeratorKey="video_view_100"
          numeratorLabel="Views 100%"
          rateKey="vtr"
          rateLabel="VTR"
          rateFormatter={fmtP2}
          extraRows={detailAll}
          getDetailGroupKey={(r) => applyAudienceOverride(extractAudience(r.line_name), aud?.overrideMap)}
          mediaType="VIDEO"
          downloadable={isAdmin}
          filename={`${campName} - Video ${tactic} - Por Audiencia`}
          editable={isAdmin}
          busyAudience={aud?.busyAudience}
          isRowOverridden={(row) => aud?.isOverridden?.(row._rawLabels)}
          onRenameGroup={(row, name) => aud?.renameAudience(row._rawLabels, name, row.audience)}
          onResetGroup={(row) => aud?.resetAudience(row._rawLabels, row.audience)}
        />
      )}

      {/* ─── 9. Tabela "Por Dia" agregada ────────────────────────────── */}
      {detailFiltered.length > 0 && (
        <CollapsibleSectionV2 title="Entrega Agregada por Dia" defaultOpen>
          <DailyAggregateTableV2
            daily={detailFiltered}
            campaignName={`${camp.campaign_name || "campanha"}_video_${tactic}`}
            lockedMedia="VIDEO"
            downloadable={isAdmin}
          />
        </CollapsibleSectionV2>
      )}
    </>
  );
}
