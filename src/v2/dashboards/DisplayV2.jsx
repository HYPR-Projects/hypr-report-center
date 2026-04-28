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
// QUIRK PRESERVADA: filtro de detail por tactic usa substring no
//   line_name (`includes(tactic.toLowerCase())`) — convenção HYPR onde
//   line_name carrega o token "O2O" ou "OOH" como substring.

import { useMemo } from "react";
import {
  buildLineOptions,
  computeDisplayKpis,
  groupByDate,
  groupBySize,
  groupByAudience,
} from "../../shared/aggregations";
import { fmt, fmtP, fmtP2, fmtR } from "../../shared/format";

import { Button } from "../../ui/Button";

import { AudienceFilterV2 } from "../components/AudienceFilterV2";
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

export default function DisplayV2({
  data,
  aggregates,
  tactic,
  setTactic,
  lines,
  setLines,
}) {
  const camp = data.campaign;

  // Derivações por tactic + filtro de audiência. Mesma quirk Legacy.
  const view = useMemo(() => {
    const totals = aggregates.totals.filter(
      (r) => r.media_type === "DISPLAY" && r.tactic_type === tactic,
    );
    const detailAll = aggregates.detail.filter(
      (r) =>
        r.media_type === "DISPLAY" &&
        r.line_name?.toLowerCase().includes(tactic.toLowerCase()),
    );
    const lineOptions = buildLineOptions(detailAll).filter((l) => l !== "ALL");
    const detailFiltered =
      lines.length === 0
        ? detailAll
        : detailAll.filter((r) => lines.includes(r.line_name));

    const kpis = computeDisplayKpis({
      rows: totals,
      detail: detailFiltered,
      detailAll,
      tactic,
      camp,
    });

    const daily = groupByDate(detailFiltered, "clicks", "viewable_impressions", "ctr");
    const bySize = groupBySize(detailFiltered, "clicks", "viewable_impressions", "ctr");
    const byAudience = groupByAudience(detailAll, "clicks", "viewable_impressions", "ctr");

    return { totals, detailAll, detailFiltered, lineOptions, kpis, daily, bySize, byAudience };
  }, [aggregates, tactic, lines, camp]);

  const { totals, detailFiltered, lineOptions, kpis, daily, bySize, byAudience } = view;

  // Sem dados de Display — render mínimo informativo
  if (totals.length === 0 && view.detailAll.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <p className="text-sm text-fg-muted">
          Não há entrega Display nesta campanha.
        </p>
      </div>
    );
  }

  // Imp. contratadas e bonus por tactic (vêm do row[0] em totals)
  const row0 = totals[0] || {};
  const contractedImps =
    tactic === "O2O"
      ? row0.contracted_o2o_display_impressions || 0
      : row0.contracted_ooh_display_impressions || 0;
  const bonusImps =
    tactic === "O2O"
      ? row0.bonus_o2o_display_impressions || 0
      : row0.bonus_ooh_display_impressions || 0;

  // Marker "esperado hoje" — % do tempo decorrido linear pra mostrar
  // onde o pacing deveria estar agora.
  const expectedToday = computeExpectedTodayPct(camp);

  return (
    <div className="space-y-6">
      {/* ─── 1. Toolbar interna ──────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <SegmentedControlV2
          label="Tática Display"
          options={TACTIC_OPTIONS}
          value={tactic}
          onChange={(t) => {
            setTactic(t);
            setLines([]);
          }}
        />
        <AudienceFilterV2
          lines={lineOptions}
          selected={lines}
          onChange={setLines}
        />
      </div>

      {/* ─── 2. Hero ComparisonCard ──────────────────────────────────── */}
      <ComparisonCardV2
        title={`CPM Display ${tactic} · Negociado vs Efetivo`}
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
            label="Budget Contratado"
            value={fmtR(kpis.budget)}
            hint="Budget alocado à tática selecionada (O2O ou OOH)."
          />
          <KpiCardV2
            label="Imp. Contratadas"
            value={fmt(contractedImps)}
            hint="Volume de impressões contratadas para a tática."
          />
          <KpiCardV2
            label="Imp. Bonus"
            value={fmt(bonusImps)}
            hint="Bonus negociado adicional ao contratado."
          />
          <KpiCardV2
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
        </div>
      </section>

      {/* ─── 5. Pacing (com marker "esperado hoje") ──────────────────── */}
      {!aggregates.isFiltered && (
        <PacingBarV2
          label={`Pacing Display ${tactic}`}
          pacing={kpis.pac}
          budget={kpis.budget}
          cost={kpis.cost}
          expectedPct={expectedToday}
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

      {/* ─── 9. Tabela "Por Dia" agregada ────────────────────────────── */}
      {detailFiltered.length > 0 && (
        <CollapsibleSectionV2 title="Entrega Agregada por Dia" defaultOpen>
          <DailyAggregateTableV2
            daily={detailFiltered}
            campaignName={`${camp.campaign_name || "campanha"}_display_${tactic}`}
            mediaFilter="DISPLAY"
          />
        </CollapsibleSectionV2>
      )}
    </div>
  );
}

// ─── Helper local: % esperada hoje (linear) ───────────────────────────
//
// Duplica computeExpectedTodayPct da OverviewV2. TODO refactor:
// extrair pra src/shared/pacing.js (fora do escopo da PR-14).

function computeExpectedTodayPct(camp) {
  if (!camp.start_date || !camp.end_date) return 0;
  const [sy, sm, sd] = camp.start_date.split("-").map(Number);
  const [ey, em, ed] = camp.end_date.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const now = new Date();
  if (now < start) return 0;
  if (now > end) return 100;
  const total = (end - start) / 864e5 + 1;
  const elapsed = (now - start) / 864e5 + 1;
  return (elapsed / total) * 100;
}
