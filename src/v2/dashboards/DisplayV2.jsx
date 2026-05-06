// src/v2/dashboards/DisplayV2.jsx
//
// Dashboard Display V2 — REDESIGN PR-14
//
// Reescrita pra alinhar com o padrão visual da OverviewV2 (PR-13):
// hero ComparisonCard no topo, KPI grids contratual+performance,
// Pacing com marker "esperado hoje", tabela "Por Formato" com share
// visual, charts diários e detalhamento em collapsible fechado.
//
// LAYOUT, NA ORDEM (top → bottom)
//   1. Toolbar interna       — SegmentedControlV2 (O2O/OOH) + AudienceFilterV2
//   2. Hero ComparisonCard   — CPM Negociado vs Efetivo + economia
//   3. KPI grid contratual   — Budget · Imp Contratadas · Bonus · CPM Neg
//   4. KPI grid performance  — Imp · Visíveis · CPM Ef · Rentab · Cliques · CTR · CPC
//   5. PacingBar             — com marker "esperado hoje" (escondido sob filtro)
//   6. Charts diários        — Entrega × CTR
//   7. FormatBreakdownTable  — distribuição por creative_size com share visual
//   8. Chart Audiência       — DualChart byAudience (mantido como gráfico)
//   9. DailyAggregateTable   — agregada por dia (mediaFilter="DISPLAY")
//  10. Detalhamento por linha — collapsible FECHADO
//
// FILTRO DE PERÍODO É GLOBAL (shell ClientDashboardV2).
// FILTRO DE TACTIC: deriva no frontend pra alinhar com o que totals já
//   faz no backend (`query_totals` tem fallback hardcoded `ELSE 'O2O'`,
//   `query_detail` tem `ELSE tactic_type` — fallbacks diferentes
//   geravam mismatch). Lógica:
//     1. line_name tem `_O2O_`/`_O2O$` (case insensitive) → "O2O"
//     2. line_name tem `_OOH_`/`_OOH$`                    → "OOH"
//     3. fallback                                          → "O2O"

import { useMemo } from "react";
import {
  buildLineOptions,
  computeDisplayKpis,
  extractAudience,
  groupByDate,
  groupBySize,
  groupByCreativeName,
  getCreativeLineKey,
  groupByAudience,
} from "../../shared/aggregations";
import { fmt, fmtP, fmtP2, fmtR } from "../../shared/format";

import { Button } from "../../ui/Button";

import { AudienceFilterV2 } from "../components/AudienceFilterV2";
import { CreativeLineFilterV2 } from "../components/CreativeLineFilterV2";
import { CollapsibleSectionV2 } from "../components/CollapsibleSectionV2";
import { ComparisonCardV2 } from "../components/ComparisonCardV2";
import { DailyAggregateTableV2 } from "../components/DailyAggregateTableV2";
import { DualChartV2 } from "../components/DualChartV2";
import { FormatBreakdownTableV2 } from "../components/FormatBreakdownTableV2";
import { KpiCardV2 } from "../components/KpiCardV2";
import { PacingBarV2 } from "../components/PacingBarV2";
import { SegmentedControlV2 } from "../components/SegmentedControlV2";

const TACTIC_OPTIONS = [
  { value: "O2O", label: "O2O" },
  { value: "OOH", label: "OOH" },
];

// Espelha o CASE do `query_totals` no backend: `_O2O_`/`_O2O$` → "O2O",
// `_OOH_`/`_OOH$` → "OOH", default → "O2O".
const O2O_RE = /(?:^|_)O2O(?:_|$)/i;
const OOH_RE = /(?:^|_)OOH(?:_|$)/i;
const deriveTactic = (lineName) => {
  const ln = lineName || "";
  if (O2O_RE.test(ln)) return "O2O";
  if (OOH_RE.test(ln)) return "OOH";
  return "O2O";
};

export default function DisplayV2({
  data,
  aggregates,
  tactic,
  setTactic,
  lines,
  setLines,
  creativeLines,
  setCreativeLines,
}) {
  const camp = data.campaign;

  // Tactics disponíveis: O2O e OOH só aparecem se houver contrato (incl.
  // bônus) OU entrega real pra essa frente. Evita mostrar segmento
  // sem dado nem possibilidade de dado. Quando só uma tactic está
  // disponível, escondemos o SegmentedControl inteiro (1 opção é UI ruim).
  // `effectiveTactic` cobre o caso do state apontar pra tactic sumida —
  // sem setState em effect (anti-padrão React 19).
  const t0Display = (data.totals || [])[0] || {};
  const hasDeliveryO2O = aggregates.totals.some(
    (r) => r.media_type === "DISPLAY" && r.tactic_type === "O2O",
  );
  const hasDeliveryOOH = aggregates.totals.some(
    (r) => r.media_type === "DISPLAY" && r.tactic_type === "OOH",
  );
  const hasContractO2O =
    (t0Display.contracted_o2o_display_impressions || 0) > 0 ||
    (t0Display.bonus_o2o_display_impressions || 0) > 0;
  const hasContractOOH =
    (t0Display.contracted_ooh_display_impressions || 0) > 0 ||
    (t0Display.bonus_ooh_display_impressions || 0) > 0;
  const showO2O = hasContractO2O || hasDeliveryO2O;
  const showOOH = hasContractOOH || hasDeliveryOOH;
  const availableTactics = TACTIC_OPTIONS.filter((opt) =>
    opt.value === "O2O" ? showO2O : showOOH,
  );
  const effectiveTactic =
    availableTactics.find((t) => t.value === tactic)?.value
    || availableTactics[0]?.value
    || tactic;

  // Derivações por tactic + filtros (audiência ∧ linha criativa). Combinam
  // como AND: row passa se line_name está em `lines` (ou `lines` vazio) E
  // a chave de linha criativa está em `creativeLines` (ou `creativeLines`
  // vazio). Opções dos dois filtros vêm de `detailAll` (independentes
  // entre si) — mesmo padrão do `lineOptions` original. byAudience
  // continua sobre detailAll cru pra preservar a visão de todas
  // audiências (mesma quirk Legacy do filtro original).
  const view = useMemo(() => {
    const totals = aggregates.totals.filter(
      (r) => r.media_type === "DISPLAY" && r.tactic_type === effectiveTactic,
    );
    const detailAll = aggregates.detail.filter(
      (r) => r.media_type === "DISPLAY" && deriveTactic(r.line_name) === effectiveTactic,
    );
    const lineOptions = buildLineOptions(detailAll).filter((l) => l !== "ALL");
    const creativeLineOptions = [
      ...new Set(detailAll.map(getCreativeLineKey).filter(Boolean)),
    ].sort();
    const detailFiltered = detailAll.filter((r) => {
      if (lines.length > 0 && !lines.includes(r.line_name)) return false;
      if (creativeLines.length > 0 && !creativeLines.includes(getCreativeLineKey(r))) return false;
      return true;
    });

    const kpis = computeDisplayKpis({
      rows: totals,
      detail: detailFiltered,
      detailAll,
      tactic: effectiveTactic,
      camp,
    });

    const daily = groupByDate(detailFiltered, "clicks", "viewable_impressions", "ctr");
    const bySize = groupBySize(detailFiltered, "clicks", "viewable_impressions", "ctr");
    const byCreative = groupByCreativeName(detailFiltered, "clicks", "viewable_impressions", "ctr");
    const byAudience = groupByAudience(detailAll, "clicks", "viewable_impressions", "ctr");

    return { totals, detailAll, detailFiltered, lineOptions, creativeLineOptions, kpis, daily, bySize, byCreative, byAudience };
  }, [aggregates, effectiveTactic, lines, creativeLines, camp]);

  const { totals, detailAll, detailFiltered, lineOptions, creativeLineOptions, kpis, daily, bySize, byCreative, byAudience } = view;

  // Empty state: a tactic atual não tem entregas. Antes a gente fazia
  // early return aqui sem renderizar a toolbar — o usuário ficava preso
  // sem conseguir voltar pra outra tactic. Agora a toolbar fica sempre
  // visível e só substituímos o conteúdo abaixo.
  const isEmpty = totals.length === 0 && view.detailAll.length === 0;

  // Imp. contratadas e bonus por tactic (vêm do row[0] em totals).
  // Quando isEmpty, row0 é {} e tudo fica em 0 — irrelevante porque o
  // ramo do JSX que usa esses valores não renderiza nesse caso.
  const row0 = totals[0] || {};
  const contractedImps =
    effectiveTactic === "O2O"
      ? row0.contracted_o2o_display_impressions || 0
      : row0.contracted_ooh_display_impressions || 0;
  const bonusImps =
    effectiveTactic === "O2O"
      ? row0.bonus_o2o_display_impressions || 0
      : row0.bonus_ooh_display_impressions || 0;

  return (
    <div className="space-y-6">
      {/* ─── 1. Toolbar interna ──────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        {/* Segmented O2O/OOH só renderiza se há mais de uma tactic com
            contrato ou entrega. Quando só uma frente existe, o toggle é
            ruído visual — escondemos e o conteúdo abaixo já reflete a
            tactic única via effectiveTactic. */}
        {availableTactics.length > 1 ? (
          <SegmentedControlV2
            label="Tática Display"
            options={availableTactics}
            value={effectiveTactic}
            onChange={(t) => {
              setTactic(t);
              setLines([]);
              setCreativeLines([]);
            }}
          />
        ) : (
          <div />
        )}
        {!isEmpty && (
          <div className="flex flex-wrap items-center gap-2">
            <CreativeLineFilterV2
              lines={creativeLineOptions}
              selected={creativeLines}
              onChange={setCreativeLines}
            />
            <AudienceFilterV2
              lines={lineOptions}
              selected={lines}
              onChange={setLines}
            />
          </div>
        )}
      </div>

      {isEmpty ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center">
          <p className="text-sm text-fg-muted">
            Não há entrega Display {effectiveTactic} nesta campanha.
          </p>
        </div>
      ) : (
        <DisplayContent
          camp={camp}
          tactic={effectiveTactic}
          aggregates={aggregates}
          detailAll={detailAll}
          detailFiltered={detailFiltered}
          kpis={kpis}
          daily={daily}
          bySize={bySize}
          byCreative={byCreative}
          byAudience={byAudience}
          contractedImps={contractedImps}
          bonusImps={bonusImps}
        />
      )}
    </div>
  );
}

// Conteúdo "pesado" do Display — extraído pra fora pra evitar render
// condicional gigante dentro do componente principal e simplificar o
// fluxo de empty state.
function DisplayContent({
  camp,
  tactic,
  aggregates,
  detailAll,
  detailFiltered,
  kpis,
  daily,
  bySize,
  byCreative,
  byAudience,
  contractedImps,
  bonusImps,
}) {
  return (
    <>
      {/* ─── 2. Hero ComparisonCard ──────────────────────────────────── */}
      <ComparisonCardV2
        title={`CPM Display · ${tactic}`}
        negociado={kpis.cpmNeg}
        efetivo={kpis.cpmEf}
        formatValue={(v) => fmtR(v)}
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
            label="Imp. Contratadas"
            value={fmt(contractedImps)}
            hint="Volume de impressões contratadas para a tática."
          />
          <KpiCardV2
            outlined
            label="Imp. Bonus"
            value={fmt(bonusImps)}
            hint="Bonus negociado adicional ao contratado."
          />
          <KpiCardV2
            outlined
            label="CPM Negociado"
            value={fmtR(kpis.cpmNeg)}
            hint="CPM acordado em contrato — base do cálculo de rentabilidade."
          />
        </div>
      </section>


      {/* ─── 4. KPI grid performance ─────────────────────────────────── */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
          Performance
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <KpiCardV2 label="Impressões" value={fmt(kpis.impr)} />
          <KpiCardV2
            label="Imp. Visíveis"
            value={fmt(kpis.vi)}
            hint="Soma de viewable impressions filtradas pelo período/audiência."
          />
          <KpiCardV2
            label="CPM Efetivo"
            value={fmtR(kpis.cpmEf)}
            accent
            hint="Custo entregue / Imp. Visíveis × 1000 — capado no negociado."
          />
          <KpiCardV2
            label="Rentabilidade"
            value={fmtP(kpis.rentab)}
            accent
            hint="(CPM Negociado − CPM Efetivo) / CPM Negociado. Positivo = a HYPR entregou mais que o contratado."
          />
          <KpiCardV2 label="Cliques" value={fmt(kpis.clks)} />
          <KpiCardV2
            label="CTR"
            value={fmtP2(kpis.ctr)}
            hint="Cliques / Imp. Visíveis."
          />
          <KpiCardV2
            label="CPC"
            value={fmtR(kpis.cpc)}
            hint="Custo Efetivo / Cliques."
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
          label={`Pacing Display ${tactic}`}
          pacing={kpis.pac}
          budget={kpis.budget}
          cost={kpis.cost}
        />
      )}

      {/* ─── 6. Chart diário (full-width) ────────────────────────────── */}
      {daily.length > 0 && (
        <section>
          <div className="rounded-xl border border-border bg-surface p-5">
            <div className="text-[11px] font-bold uppercase tracking-widest text-signature mb-3">
              Entrega × CTR Diário
            </div>
            <DualChartV2
              data={daily}
              xKey="date"
              y1Key="viewable_impressions"
              y2Key="ctr"
              label1="Imp. Visíveis"
              label2="CTR %"
            />
          </div>
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
          numeratorKey="clicks"
          numeratorLabel="Cliques"
          rateKey="ctr"
          rateLabel="CTR"
          rateFormatter={fmtP2}
          extraRows={detailFiltered}
          mediaType="DISPLAY"
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
          numeratorKey="clicks"
          numeratorLabel="Cliques"
          rateKey="ctr"
          rateLabel="CTR"
          rateFormatter={fmtP2}
          extraRows={detailFiltered}
          getDetailGroupKey={getCreativeLineKey}
          mediaType="DISPLAY"
        />
      )}

      {/* ─── 8. Chart de Audiência (mantido como gráfico) ────────────── */}
      {byAudience.length > 0 && (
        <section>
          <div className="rounded-xl border border-border bg-surface p-5">
            <div className="text-[11px] font-bold uppercase tracking-widest text-signature mb-3">
              Entrega × CTR por Audiência
            </div>
            <DualChartV2
              data={byAudience}
              xKey="audience"
              y1Key="viewable_impressions"
              y2Key="ctr"
              label1="Imp. Visíveis"
              label2="CTR %"
            />
          </div>
        </section>
      )}

      {/* ─── 8b. Tabela "Por Audiência" ──────────────────────────────────
          Mesmo estilo da tabela "Por Formato": share visual, métricas
          alinhadas, ordenação por share. Espelha a visão do gráfico
          acima — sempre mostra TODAS as audiências (detailAll), igual
          ao DualChart, ignorando o filtro de audience selecionada.
          extractAudience() resolve a chave de cada detail row pra
          casar com r.audience das rows agrupadas.
      */}
      {byAudience.length > 0 && (
        <FormatBreakdownTableV2
          rows={byAudience}
          groupKey="audience"
          groupLabel="Audiência"
          itemNoun="audiência"
          denomKey="viewable_impressions"
          denomLabel="Imp. Visíveis"
          numeratorKey="clicks"
          numeratorLabel="Cliques"
          rateKey="ctr"
          rateLabel="CTR"
          rateFormatter={fmtP2}
          extraRows={detailAll}
          getDetailGroupKey={(r) => extractAudience(r.line_name)}
          mediaType="DISPLAY"
        />
      )}

      {/* ─── 9. Tabela "Por Dia" agregada ────────────────────────────── */}
      {detailFiltered.length > 0 && (
        <CollapsibleSectionV2 title="Entrega Agregada por Dia" defaultOpen>
          <DailyAggregateTableV2
            daily={detailFiltered}
            campaignName={`${camp.campaign_name || "campanha"}_display_${tactic}`}
            lockedMedia="DISPLAY"
          />
        </CollapsibleSectionV2>
      )}
    </>
  );
}
