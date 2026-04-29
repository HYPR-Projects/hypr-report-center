// src/v2/components/DailyAggregateTableV2.jsx
//
// Tabela "Entrega Agregada por Dia" — agrega o `daily` (que vem
// granular por line+criativo+dia) somando todas as lines pra ter
// uma visão por dia inteira. Mostra os principais KPIs lado a lado:
// Imp. Visíveis, Cliques, CTR, Views 100%, VTR, CPM Ef, CPCV Ef,
// Custo Ef.
//
// Diferente da DataTableV2 (Detalhamento por Linha) — esta é a visão
// "alto nível" que CSs e clientes pediam.
//
// Comportamento:
//   - Dias ordenados decrescente (mais recente no topo)
//   - Datas formatadas "28/04 ter" (curto + dia da semana)
//   - Linhas com CPM e CPCV em accent (azul) quando valor > 0
//   - Botão CSV no header da tabela
//   - Skeleton 6 linhas quando loading
//
// Quando rangeLabel é menor que 14 dias, mostra todas. Quando maior,
// limita a 14 e oferece "ver mais" (TODO Fase 4).

import { useMemo } from "react";
import { fmt, fmtR } from "../../shared/format";
import { cn } from "../../ui/cn";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";

const WEEKDAY_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export function DailyAggregateTableV2({
  daily,
  campaignName,
  className,
  // Opcional: filtros de mídia (default = todas)
  mediaFilter = null, // "DISPLAY" | "VIDEO" | null (todas)
}) {
  const aggregated = useMemo(
    () => aggregateByDay(daily, mediaFilter),
    [daily, mediaFilter],
  );

  const downloadCsv = () => {
    const headers = [
      "Data",
      "Impressões",
      "Imp. Visíveis",
      "Cliques",
      "CTR",
      "Views 100%",
      "VTR",
      "CPM Efetivo",
      "CPCV Efetivo",
      "Custo Efetivo",
    ];
    const rows = aggregated.map((r) => [
      r.date,
      r.impressions,
      r.viewable_impressions,
      r.clicks,
      r.ctr,
      r.video_view_100,
      r.vtr,
      r.cpm,
      r.cpcv,
      r.cost,
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((v) => `"${v ?? ""}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${campaignName}_agregado_dia.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!aggregated.length) {
    return (
      <Card className={cn("p-6 text-center text-sm text-fg-subtle", className)}>
        Sem dados para o período selecionado.
      </Card>
    );
  }

  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <span className="text-xs font-semibold text-fg-muted">
          {aggregated.length} {aggregated.length === 1 ? "dia" : "dias"} · sem dimensão de line
        </span>
        <Button variant="primary" size="sm" onClick={downloadCsv} iconLeft={<DownloadIcon />}>
          CSV
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <Th align="left">Data</Th>
              <Th>Impressões</Th>
              <Th>Imp. Visíveis</Th>
              <Th>Cliques</Th>
              <Th>CTR</Th>
              <Th>Views 100%</Th>
              <Th>VTR</Th>
              <Th>CPM Ef.</Th>
              <Th>CPCV Ef.</Th>
              <Th>Custo Ef.</Th>
            </tr>
          </thead>
          <tbody>
            {aggregated.map((r) => (
              <tr
                key={r.date}
                className="border-b border-border/50 last:border-b-0 hover:bg-surface transition-colors"
              >
                <Td align="left" mono>
                  {formatDateLabel(r.date)}
                </Td>
                <Td>{fmt(r.impressions)}</Td>
                <Td>{fmt(r.viewable_impressions)}</Td>
                <Td>{fmt(r.clicks)}</Td>
                <Td>{r.ctr ? `${r.ctr.toFixed(2)}%` : "—"}</Td>
                <Td>{fmt(r.video_view_100)}</Td>
                <Td>{r.vtr ? `${r.vtr.toFixed(1)}%` : "—"}</Td>
                <Td accent={r.cpm > 0}>{r.cpm > 0 ? fmtR(r.cpm) : "—"}</Td>
                <Td accent={r.cpcv > 0}>{r.cpcv > 0 ? `R$ ${r.cpcv.toFixed(3).replace(".", ",")}` : "—"}</Td>
                <Td>{fmtR(r.cost)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function Th({ children, align = "right" }) {
  return (
    <th
      className={cn(
        "px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-fg-subtle whitespace-nowrap",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, align = "right", mono = false, accent = false }) {
  return (
    <td
      className={cn(
        "px-4 py-2.5 whitespace-nowrap",
        align === "right" ? "text-right" : "text-left",
        mono && "tabular-nums font-medium",
        align === "right" && "tabular-nums",
        accent ? "text-signature font-semibold" : "text-fg",
      )}
    >
      {children}
    </td>
  );
}

function formatDateLabel(ymd) {
  // ymd no formato "2026-04-28"
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(y, m - 1, d);
  const dayLabel = `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
  return `${dayLabel} ${WEEKDAY_PT[date.getDay()]}`;
}

// Agrupa por data, soma counts, recalcula derivados (CTR, VTR, CPM, CPCV).
function aggregateByDay(daily, mediaFilter) {
  if (!daily || !daily.length) return [];

  const filtered = mediaFilter
    ? daily.filter((r) => r.media_type === mediaFilter)
    : daily;

  const byDate = filtered.reduce((acc, r) => {
    const date = r.date;
    if (!date) return acc;
    if (!acc[date]) {
      acc[date] = {
        date,
        impressions: 0,
        viewable_impressions: 0,
        clicks: 0,
        video_view_100: 0,
        cost: 0,
        // Pra recalcular CPM/CPCV efetivos precisamos de cost+imp+views
        // (não dá pra fazer média ponderada de cpm que vem por linha).
      };
    }
    acc[date].impressions += r.impressions || 0;
    acc[date].viewable_impressions += r.viewable_impressions || 0;
    acc[date].clicks += r.clicks || 0;
    acc[date].video_view_100 += r.video_view_100 || 0;
    acc[date].cost += r.effective_total_cost || 0;
    return acc;
  }, {});

  return Object.values(byDate)
    .map((r) => ({
      ...r,
      ctr:
        r.viewable_impressions > 0
          ? (r.clicks / r.viewable_impressions) * 100
          : 0,
      vtr:
        r.viewable_impressions > 0
          ? (r.video_view_100 / r.viewable_impressions) * 100
          : 0,
      cpm:
        r.viewable_impressions > 0
          ? (r.cost / r.viewable_impressions) * 1000
          : 0,
      cpcv: r.video_view_100 > 0 ? r.cost / r.video_view_100 : 0,
    }))
    .sort((a, b) => b.date.localeCompare(a.date)); // mais recente no topo
}

function DownloadIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
