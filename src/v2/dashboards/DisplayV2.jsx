// src/v2/dashboards/DisplayV2.jsx
//
// Dashboard Display V2 — equivalente refatorado do DisplayTab Legacy
// (src/components/dashboard-tabs/DisplayTab.jsx).
//
// LAYOUT, NA ORDEM
//   1. Toolbar interna — SegmentedControlV2 (O2O/OOH) à esquerda;
//      AudienceFilterV2 à direita
//   2. KPI grid 1 (contratual): Budget, Imp. Contratadas, Imp. Bonus,
//      CPM Negociado
//   3. KPI grid 2 (entrega): Impressões, Imp. Visíveis, CPM Efetivo,
//      Rentabilidade, Cliques, CTR, CPC
//   4. PacingBarV2 (escondido com filtro de período ativo)
//   5. DualChartV2 — Entrega × CTR Diário (full-width)
//   6. DualChartV2 grid (2-col em ≥md): Tamanho + Audiência
//   7. CollapsibleSectionV2 + DataTableV2 (filtrado p/ DISPLAY) com
//      download CSV
//
// FILTRO DE PERÍODO É GLOBAL
//   O DateRangeFilterV2 vive no ClientDashboardV2 (shell), acima das
//   tabs. mainRange é compartilhado entre Visão Geral e Display via
//   `aggregates` recebido como prop. Evita duplicação visual e deixa
//   explícito que trocar a janela afeta todas as tabs.
//
// CONTRATO COM ClientDashboardV2
//   Recebe `data` e `aggregates` (já calculado para o mainRange atual),
//   além de tactic/lines como state local da tab. Tactic é persistido
//   em URL (?tactic=) pelo shell pra deep-link; lines NÃO é persistido
//   (string ficaria gigante e UX é efêmero).
//
// REUSO
//   - computeAggregates / computeDisplayKpis: shared/aggregations.js
//   - groupByDate / groupBySize / groupByAudience / buildLineOptions:
//     shared/aggregations.js (mesmas funções que o Legacy DisplayTab)
//   - DualChartV2, KpiCardV2, PacingBarV2, CollapsibleSectionV2:
//     src/v2/components (do OverviewV2)
//   - AudienceFilterV2, SegmentedControlV2: novos no commit 1 da PR-10
//
// QUIRK PRESERVADA DO LEGACY
//   Filtro de detail por tactic usa `line_name?.toLowerCase()
//   .includes(dispTab.toLowerCase())` em vez de `tactic_type === dispTab`.
//   Convenção HYPR: line_name carrega o token "O2O" ou "OOH" como
//   substring. Mantido por fidelidade — qualquer mudança aqui
//   afetaria contagens existentes.

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
import { DualChartV2 } from "../components/DualChartV2";
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

  // Derivações por tactic + filtro de audiência. Mesma quirk Legacy:
  // detail filtrado por substring no line_name (ver header).
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

    // Séries pros 3 charts. groupByDate respeita o filtro do usuário;
    // groupByAudience opera sobre detailAll (a visão de audiências precisa
    // mostrar TODAS, independente do filtro — coerente com Legacy).
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

  const downloadCSV = () => {
    const headers = [
      "Data",
      "Campanha",
      "Line",
      "Criativo",
      "Tamanho",
      "Tática",
      "Impressões",
      "Imp. Visíveis",
      "Cliques",
      "CTR",
      "CPM Ef.",
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
      r.impressions,
      r.viewable_impressions,
      r.clicks,
      r.ctr,
      r.effective_cpm_amount,
      r.effective_total_cost,
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map(escape).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `display_${tactic}_${camp.campaign_name || "campanha"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Toolbar interna — tactic à esquerda, filtro de audiência à direita.
          Filtro de período é global (vive no ClientDashboardV2 acima das
          tabs) — compartilhado entre Visão Geral e Display. */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <SegmentedControlV2
          label="Tática Display"
          options={TACTIC_OPTIONS}
          value={tactic}
          onChange={(t) => {
            setTactic(t);
            // Limpa filtro de audiência ao trocar tactic — o conjunto de
            // line_names é diferente entre O2O e OOH.
            setLines([]);
          }}
        />
        <AudienceFilterV2
          lines={lineOptions}
          selected={lines}
          onChange={setLines}
        />
      </div>

      {/* KPI grid 1 — contratual */}
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

      {/* KPI grid 2 — entrega */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
          Entrega
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

      {/* Pacing — esconde quando há filtro de período (não faz sentido em
          janela parcial; coerente com OverviewV2). */}
      {!aggregates.isFiltered && (
        <PacingBarV2
          label={`Pacing ${tactic}`}
          pacing={kpis.pac}
          budget={kpis.budget}
          cost={kpis.cost}
        />
      )}

      {/* Chart diário — full width */}
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

      {/* Charts por dimensão — 2 colunas em ≥md, 1 em mobile */}
      {(bySize.length > 0 || byAudience.length > 0) && (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {bySize.length > 0 && (
            <div className="rounded-xl border border-border bg-surface p-5">
              <div className="text-[11px] font-bold uppercase tracking-widest text-signature mb-3">
                Entrega × CTR por Tamanho
              </div>
              <DualChartV2
                data={bySize}
                xKey="size"
                y1Key="viewable_impressions"
                y2Key="ctr"
                label1="Imp. Visíveis"
                label2="CTR %"
              />
            </div>
          )}
          {byAudience.length > 0 && (
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
          )}
        </section>
      )}

      {/* Tabela detalhada — colapsável + CSV */}
      {detailFiltered.length > 0 && (
        <section>
          <CollapsibleSectionV2 title="Detalhamento Diário">
            <div className="flex justify-end mb-3">
              <Button variant="secondary" size="sm" onClick={downloadCSV}>
                ⬇ Download CSV
              </Button>
            </div>
            <DisplayDetailTable rows={detailFiltered} />
          </CollapsibleSectionV2>
        </section>
      )}
    </div>
  );
}

// ─── Tabela detalhada inline ───────────────────────────────────────────
//
// Tabela específica do DisplayV2 — só colunas relevantes pra Display.
// Diferente do DataTableV2 (que serve a Visão Geral, com mix de
// Display+Video), aqui não tem filtro media_type nem colunas de video
// (video_view_*). Mais limpo pra leitura operacional.
//
// Limit visual de 200 linhas (mesma regra do Legacy / DataTableV2 do
// OverviewV2). CSV completo via botão acima.

const DETAIL_COLUMNS = [
  { key: "date", label: "Data" },
  { key: "line_name", label: "Line" },
  { key: "creative_name", label: "Criativo" },
  { key: "creative_size", label: "Tamanho" },
  { key: "impressions", label: "Impressões", numeric: true },
  { key: "viewable_impressions", label: "Imp. Visíveis", numeric: true },
  { key: "clicks", label: "Cliques", numeric: true },
  { key: "ctr", label: "CTR", numeric: true, formatter: fmtP2 },
  {
    key: "effective_cpm_amount",
    label: "CPM Ef.",
    numeric: true,
    formatter: fmtR,
  },
  {
    key: "effective_total_cost",
    label: "Custo Ef.",
    numeric: true,
    formatter: fmtR,
  },
];

const ROW_LIMIT = 200;

function DisplayDetailTable({ rows }) {
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
