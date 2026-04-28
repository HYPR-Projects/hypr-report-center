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
//  10. Detalhamento por linha — collapsible FECHADO
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

  const downloadCSV = () => {
    const headers = [
      "Data",
      "Campanha",
      "Line",
      "Criativo",
      "Tamanho",
      "Tática",
      "Imp. Visíveis",
      "Video Start",
      "Views 25%",
      "Views 50%",
      "Views 75%",
      "Views 100%",
      "VTR",
      "Custo Ef.",
    ];
    const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = detailFiltered.map((r) => [
      r.date,
      r.campaign_name,
      r.line_name,
      r.creative_name,
      r.creative_size,
      r.tactic_type,
      r.viewable_impressions,
      r.video_starts,
      r.video_view_25,
      r.video_view_50,
      r.video_view_75,
      r.video_view_100,
      r.vtr ?? 0,
      r.effective_total_cost,
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map(escape).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `video_${tactic}_${camp.campaign_name || "campanha"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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

      {/* ─── 10. Detalhamento por linha (collapsible FECHADO) ────────── */}
      {detailFiltered.length > 0 && (
        <CollapsibleSectionV2 title="Detalhamento por Linha">
          <div className="flex justify-end mb-3">
            <Button variant="secondary" size="sm" onClick={downloadCSV}>
              ⬇ Download CSV
            </Button>
          </div>
          <VideoDetailTable rows={detailFiltered} />
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

// ─── Tabela detalhada inline ───────────────────────────────────────────

const DETAIL_COLUMNS = [
  { key: "date", label: "Data" },
  { key: "line_name", label: "Line" },
  { key: "creative_name", label: "Criativo" },
  { key: "creative_size", label: "Tamanho" },
  { key: "viewable_impressions", label: "Imp. Visíveis", numeric: true },
  { key: "video_starts", label: "Starts", numeric: true },
  { key: "video_view_25", label: "25%", numeric: true },
  { key: "video_view_50", label: "50%", numeric: true },
  { key: "video_view_75", label: "75%", numeric: true },
  { key: "video_view_100", label: "100%", numeric: true },
  { key: "vtr", label: "VTR", numeric: true, formatter: fmtP2 },
  {
    key: "effective_total_cost",
    label: "Custo Ef.",
    numeric: true,
    formatter: fmtR,
  },
];

const ROW_LIMIT = 200;

function VideoDetailTable({ rows }) {
  const visible = rows.slice(0, ROW_LIMIT);
  const truncated = rows.length > ROW_LIMIT;

  return (
    <div>
      <div className="text-[11px] text-fg-subtle mb-2 tabular-nums">
        Mostrando {fmt(visible.length)} de {fmt(rows.length)} linhas
        {truncated && " — exporte CSV para o conjunto completo"}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border max-h-[480px]">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-surface-strong border-b border-border">
            <tr>
              {DETAIL_COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={
                    c.numeric
                      ? "px-3 py-2 text-right font-semibold text-fg-muted whitespace-nowrap"
                      : "px-3 py-2 text-left font-semibold text-fg-muted whitespace-nowrap"
                  }
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr
                key={i}
                className="border-b border-border/40 last:border-b-0 hover:bg-surface transition-colors"
              >
                {DETAIL_COLUMNS.map((c) => {
                  const raw = r[c.key];
                  const display = c.formatter
                    ? c.formatter(raw)
                    : c.numeric
                      ? fmt(raw)
                      : raw ?? "—";
                  return (
                    <td
                      key={c.key}
                      className={
                        c.numeric
                          ? "px-3 py-2 text-right text-fg whitespace-nowrap"
                          : "px-3 py-2 text-left text-fg whitespace-nowrap"
                      }
                      title={typeof raw === "string" ? raw : undefined}
                    >
                      {display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
