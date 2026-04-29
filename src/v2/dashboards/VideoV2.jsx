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
// QUIRK PRESERVADA: filtro de detail por tactic via substring no
//   line_name (convenção HYPR documentada no DisplayV2).

import { useMemo } from "react";
import {
  buildLineOptions,
  computeVideoKpis,
  groupByDate,
  groupBySize,
  groupByAudience,
} from "../../shared/aggregations";
import { fmt, fmtP, fmtP2, fmtR } from "../../shared/format";

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
  lines,
  setLines,
}) {
  const camp = data.campaign;

  const view = useMemo(() => {
    const totals = aggregates.totals.filter(
      (r) => r.media_type === "VIDEO" && r.tactic_type === tactic,
    );
    const detailAll = aggregates.detail.filter(
      (r) =>
        r.media_type === "VIDEO" &&
        r.line_name?.toLowerCase().includes(tactic.toLowerCase()),
    );
    const lineOptions = buildLineOptions(detailAll).filter((l) => l !== "ALL");
    const detailFiltered =
      lines.length === 0
        ? detailAll
        : detailAll.filter((r) => lines.includes(r.line_name));

    const kpis = computeVideoKpis({
      rows: totals,
      detail: detailFiltered,
      tactic,
    });

    const daily = groupByDate(detailFiltered, "video_view_100", "viewable_impressions", "vtr");
    const bySize = groupBySize(detailFiltered, "video_view_100", "viewable_impressions", "vtr");
    const byAudience = groupByAudience(detailAll, "video_view_100", "viewable_impressions", "vtr");

    return { totals, detailAll, detailFiltered, lineOptions, kpis, daily, bySize, byAudience };
  }, [aggregates, tactic, lines]);

  const { totals, detailFiltered, lineOptions, kpis, daily, bySize, byAudience } = view;

  if (totals.length === 0 && view.detailAll.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <p className="text-sm text-fg-muted">
          Não há entrega Video {tactic} nesta campanha.
        </p>
      </div>
    );
  }

  // Views contratadas e bonus por tactic (vêm do row[0] em totals)
  const row0 = totals[0] || {};
  const contractedViews =
    tactic === "O2O"
      ? row0.contracted_o2o_video_completions || 0
      : row0.contracted_ooh_video_completions || 0;
  const bonusViews =
    tactic === "O2O"
      ? row0.bonus_o2o_video_completions || 0
      : row0.bonus_ooh_video_completions || 0;

  // Marker "esperado hoje" — % do tempo decorrido linear.
  const expectedToday = computeExpectedTodayPct(camp);

  return (
    <div className="space-y-6">
      {/* ─── 1. Toolbar interna ──────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <SegmentedControlV2
          label="Tática Video"
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
        title={`CPCV Video ${tactic} · Negociado vs Efetivo`}
        negociado={kpis.cpcvNeg}
        efetivo={kpis.cpcvEf}
        formatValue={(v) => `R$ ${(v || 0).toFixed(3).replace(".", ",")}`}
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
            label="Views Contratadas"
            value={fmt(contractedViews)}
            hint="Volume de completions (views 100%) contratadas para a tática."
          />
          <KpiCardV2
            label="Views Bonus"
            value={fmt(bonusViews)}
            hint="Bonus negociado adicional ao contratado."
          />
          <KpiCardV2
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
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
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
            label="CPCV Efetivo"
            value={fmtCpcv(kpis.cpcvEf)}
            accent
            hint="Custo Efetivo / Views 100%. Quando filtrado, recalculado proporcionalmente ao período."
          />
          <KpiCardV2
            label="Rentabilidade"
            value={fmtP(kpis.rentab)}
            accent
            hint="(CPCV Negociado − CPCV Efetivo) / CPCV Negociado. Positivo = a HYPR entregou mais que o contratado."
          />
        </div>
      </section>

      {/* ─── 5. Pacing (com marker "esperado hoje") ──────────────────── */}
      {!aggregates.isFiltered && (
        <PacingBarV2
          label={`Pacing Video ${tactic}`}
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
              Views 100% × VTR Diário
            </div>
            <DualChartV2
              data={daily}
              xKey="date"
              y1Key="video_view_100"
              y2Key="vtr"
              label1="Views 100%"
              label2="VTR %"
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
          numeratorKey="video_view_100"
          numeratorLabel="Views 100%"
          rateKey="vtr"
          rateLabel="VTR"
          rateFormatter={fmtP2}
          extraRows={detailFiltered}
          mediaType="VIDEO"
        />
      )}

      {/* ─── 8. Chart de Audiência (mantido como gráfico) ────────────── */}
      {byAudience.length > 0 && (
        <section>
          <div className="rounded-xl border border-border bg-surface p-5">
            <div className="text-[11px] font-bold uppercase tracking-widest text-signature mb-3">
              Views 100% × VTR por Audiência
            </div>
            <DualChartV2
              data={byAudience}
              xKey="audience"
              y1Key="video_view_100"
              y2Key="vtr"
              label1="Views 100%"
              label2="VTR %"
            />
          </div>
        </section>
      )}

      {/* ─── 9. Tabela "Por Dia" agregada ────────────────────────────── */}
      {detailFiltered.length > 0 && (
        <CollapsibleSectionV2 title="Entrega Agregada por Dia" defaultOpen>
          <DailyAggregateTableV2
            daily={detailFiltered}
            campaignName={`${camp.campaign_name || "campanha"}_video_${tactic}`}
            mediaFilter="VIDEO"
          />
        </CollapsibleSectionV2>
      )}

    </div>
  );
}

// ─── Helper local: % esperada hoje (linear) ───────────────────────────
//
// Duplica computeExpectedTodayPct da OverviewV2/DisplayV2. TODO refactor:
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
