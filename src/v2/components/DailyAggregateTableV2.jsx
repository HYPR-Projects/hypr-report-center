// src/v2/components/DailyAggregateTableV2.jsx
//
// Tabela "Entrega Agregada por Dia" — agrega o `daily` (granular por
// line+criativo+dia) somando todas as lines pra ter uma visão por dia
// inteira. Tem toggle Display/Video que troca o conjunto de métricas
// exibidas, porque misturar CPM (display) com CPCV (video) na mesma
// linha confunde mais do que ajuda — agora cada mídia mostra só o que
// faz sentido pra ela.
//
// Métricas por mídia:
//   DISPLAY: Data · Impressões · Imp. Visíveis · Cliques · CTR ·
//            Viewability · Custo Efetivo
//   VIDEO:   Data · Impressões · Imp. Visíveis · Cliques · CTR ·
//            Start Views · 100% Views · VTR · Custo Efetivo
//
// Comportamento:
//   - Default = DISPLAY (mais usado)
//   - Dias ordenados decrescente (mais recente no topo)
//   - Datas formatadas "28/04 ter" (curto + dia da semana)
//   - CSV export respeita a mídia atualmente selecionada
//
// Dependência: requer `video_starts` no payload de `daily` (adicionado
// no backend `query_daily`).

import { useMemo, useState } from "react";
import { fmt, fmtR } from "../../shared/format";
import { cn } from "../../ui/cn";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { SegmentedControlV2 } from "./SegmentedControlV2";

const WEEKDAY_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

const MEDIA_OPTIONS = [
  { value: "DISPLAY", label: "Display" },
  { value: "VIDEO",   label: "Video"   },
];

// Configuração de colunas por mídia. Mantém estrutura serializável pra
// reutilizar no CSV header + table head sem duplicar.
const COLUMNS = {
  DISPLAY: [
    { key: "date",                  label: "Data",          align: "left", type: "date" },
    { key: "impressions",           label: "Impressões",    type: "number" },
    { key: "viewable_impressions",  label: "Imp. Visíveis", type: "number" },
    { key: "clicks",                label: "Cliques",       type: "number" },
    { key: "ctr",                   label: "CTR",           type: "percent2" },
    { key: "viewability",           label: "Viewability",   type: "percent1" },
    { key: "cost",                  label: "Custo Ef.",     type: "currency" },
  ],
  VIDEO: [
    { key: "date",                  label: "Data",          align: "left", type: "date" },
    { key: "impressions",           label: "Impressões",    type: "number" },
    { key: "viewable_impressions",  label: "Imp. Visíveis", type: "number" },
    { key: "clicks",                label: "Cliques",       type: "number" },
    { key: "ctr",                   label: "CTR",           type: "percent2" },
    { key: "video_starts",          label: "Start Views",   type: "number" },
    { key: "video_view_100",        label: "100% Views",    type: "number" },
    { key: "vtr",                   label: "VTR",           type: "percent1" },
    { key: "cost",                  label: "Custo Ef.",     type: "currency" },
  ],
};

export function DailyAggregateTableV2({
  daily,
  campaignName,
  className,
  // Quando passado, esconde o toggle e força a mídia. Usado pelos tabs
  // DisplayV2 / VideoV2, onde o toggle seria redundante (o usuário já
  // está num contexto de mídia específica).
  lockedMedia = null,
}) {
  // Toggle interno — Display por padrão (mais comum + mais colunas
  // contratuais relevantes pra mídia gráfica). Quando lockedMedia é
  // passado, ignora estado interno.
  const [internalMedia, setInternalMedia] = useState("DISPLAY");
  const media = lockedMedia || internalMedia;

  const aggregated = useMemo(
    () => aggregateByDay(daily, media),
    [daily, media],
  );

  const columns = COLUMNS[media];

  const downloadCsv = () => {
    const headers = columns.map((c) => c.label);
    const rows = aggregated.map((r) =>
      columns.map((c) => formatCsvCell(r[c.key], c.type)),
    );
    const csv = [headers, ...rows]
      .map((row) => row.map((v) => `"${v ?? ""}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${campaignName}_${media.toLowerCase()}_agregado_dia.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const empty = !aggregated.length;

  return (
    <Card className={cn("overflow-hidden", className)}>
      {/* Header: meta-info + toggle + CSV */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <span className="text-xs font-semibold text-fg-muted">
          {empty
            ? "Sem entregas"
            : `${aggregated.length} ${aggregated.length === 1 ? "dia" : "dias"} · sem dimensão de line`}
        </span>

        <div className="flex items-center gap-2 flex-wrap">
          {!lockedMedia && (
            <SegmentedControlV2
              label="Mídia"
              options={MEDIA_OPTIONS}
              value={media}
              onChange={setInternalMedia}
            />
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={downloadCsv}
            iconLeft={<DownloadIcon />}
            disabled={empty}
          >
            CSV
          </Button>
        </div>
      </div>

      {empty ? (
        <div className="p-6 text-center text-sm text-fg-subtle">
          Sem entregas de {media === "DISPLAY" ? "Display" : "Video"} no período.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                {columns.map((c) => (
                  <Th key={c.key} align={c.align}>
                    {c.label}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {aggregated.map((r) => (
                <tr
                  key={r.date}
                  className="border-b border-border/50 last:border-b-0 hover:bg-surface transition-colors"
                >
                  {columns.map((c) => (
                    <Td
                      key={c.key}
                      align={c.align}
                      mono={c.type === "date"}
                    >
                      {formatCell(r[c.key], c.type)}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ─── Cell formatting ──────────────────────────────────────────────────

function formatCell(value, type) {
  if (value == null) return "—";
  switch (type) {
    case "date":     return formatDateLabel(value);
    case "number":   return fmt(value);
    case "percent1": return value > 0 ? `${value.toFixed(1)}%` : "—";
    case "percent2": return value > 0 ? `${value.toFixed(2)}%` : "—";
    case "currency": return fmtR(value);
    default:         return String(value);
  }
}

// CSV: números crus pra Excel/Sheets parsearem corretamente; só
// formatamos data e percentuais que querem o sufixo "%".
function formatCsvCell(value, type) {
  if (value == null) return "";
  switch (type) {
    case "date":     return value;
    case "number":   return value;
    case "percent1": return value > 0 ? value.toFixed(1) : "";
    case "percent2": return value > 0 ? value.toFixed(2) : "";
    case "currency": return value;
    default:         return value;
  }
}

// ─── UI primitives ────────────────────────────────────────────────────

function Th({ children, align = "right" }) {
  return (
    <th
      className={cn(
        "px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-fg-subtle whitespace-nowrap",
        align === "left" ? "text-left" : "text-right",
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, align = "right", mono = false }) {
  return (
    <td
      className={cn(
        "px-4 py-2.5 whitespace-nowrap text-fg",
        align === "left" ? "text-left" : "text-right",
        mono && "tabular-nums font-medium",
        align !== "left" && "tabular-nums",
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

// ─── Aggregation ──────────────────────────────────────────────────────

// Agrupa por data filtrando pela mídia atual, soma counts brutos,
// recalcula derivados (CTR, VTR, Viewability).
function aggregateByDay(daily, mediaFilter) {
  if (!daily || !daily.length) return [];

  const filtered = daily.filter((r) => r.media_type === mediaFilter);
  if (!filtered.length) return [];

  const byDate = filtered.reduce((acc, r) => {
    const date = r.date;
    if (!date) return acc;
    if (!acc[date]) {
      acc[date] = {
        date,
        impressions:          0,
        viewable_impressions: 0,
        clicks:               0,
        video_starts:         0,
        video_view_100:       0,
        cost:                 0,
      };
    }
    acc[date].impressions          += r.impressions          || 0;
    acc[date].viewable_impressions += r.viewable_impressions || 0;
    acc[date].clicks               += r.clicks               || 0;
    acc[date].video_starts         += r.video_starts         || 0;
    acc[date].video_view_100       += r.video_view_100       || 0;
    acc[date].cost                 += r.effective_total_cost || 0;
    return acc;
  }, {});

  return Object.values(byDate)
    .map((r) => ({
      ...r,
      // CTR = cliques / impressões visíveis (padrão HYPR)
      ctr: r.viewable_impressions > 0
        ? (r.clicks / r.viewable_impressions) * 100
        : 0,
      // Viewability = visíveis / total medidas. Indica qualidade do
      // inventário comprado (acima de 70% é considerado bom em DV360).
      viewability: r.impressions > 0
        ? (r.viewable_impressions / r.impressions) * 100
        : 0,
      // VTR = views 100% / impressões visíveis (apenas video)
      vtr: r.viewable_impressions > 0
        ? (r.video_view_100 / r.viewable_impressions) * 100
        : 0,
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
