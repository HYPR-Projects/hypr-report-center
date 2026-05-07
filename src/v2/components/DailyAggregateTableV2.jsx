// src/v2/components/DailyAggregateTableV2.jsx
//
// Tabela "Entrega Agregada por Dia" — agrega o `daily` (granular por
// line+criativo+dia) somando todas as lines pra ter uma visão por dia
// inteira. Tem toggle Agregado/Display/Video que troca o conjunto de
// métricas exibidas, porque misturar CPM (display) com CPCV (video) na
// mesma linha confunde mais do que ajuda — agora cada mídia mostra só
// o que faz sentido pra ela.
//
// Métricas por mídia:
//   AGGREGATED: union — Data · Impressões · Imp. Visíveis · Cliques ·
//               CTR · Viewability · Start Views · 100% Views · VTR ·
//               CPM Ef. · CPCV Ef. · Custo Efetivo. CPM/CPCV viram
//               "blended" (custo total dividido pelo denominador) —
//               útil pra ver o efetivo de campanha mista.
//   DISPLAY:    Data · Impressões · Imp. Visíveis · Cliques · CTR ·
//               Viewability · CPM Ef. · Custo Efetivo
//   VIDEO:      Data · Impressões · Imp. Visíveis · Cliques · CTR ·
//               Viewability · Start Views · 100% Views · VTR ·
//               CPCV Ef. · Custo Efetivo
//
// Fórmulas de derivados:
//   CTR         = cliques            / imp. visíveis
//   Viewability = imp. visíveis      / impressões
//   VTR         = views 100%         / imp. visíveis
//   CPM Ef.     = custo efetivo      / imp. visíveis × 1000
//   CPCV Ef.    = custo efetivo      / views 100%
//
// Comportamento:
//   - Default = AGGREGATED quando há ambas as mídias, senão a única
//   - Toggle Agregado só aparece quando a campanha tem Display E Video
//   - Linha de Total no rodapé (counts somados, ratios recalculados)
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
  { value: "AGGREGATED", label: "Agregado" },
  { value: "DISPLAY",    label: "Display"  },
  { value: "VIDEO",      label: "Video"    },
];

const MEDIA_LABEL = MEDIA_OPTIONS.reduce((acc, opt) => {
  acc[opt.value] = opt.label;
  return acc;
}, {});

// Configuração de colunas por mídia. Mantém estrutura serializável pra
// reutilizar no CSV header + table head sem duplicar.
const COLUMNS = {
  AGGREGATED: [
    { key: "date",                  label: "Data",          align: "left", type: "date" },
    { key: "impressions",           label: "Impressões",    type: "number" },
    { key: "viewable_impressions",  label: "Imp. Visíveis", type: "number" },
    { key: "clicks",                label: "Cliques",       type: "number" },
    { key: "ctr",                   label: "CTR",           type: "percent2" },
    { key: "viewability",           label: "Viewability",   type: "percent1" },
    { key: "video_starts",          label: "Start Views",   type: "number" },
    { key: "video_view_100",        label: "100% Views",    type: "number" },
    { key: "vtr",                   label: "VTR",           type: "percent1" },
    { key: "cpm",                   label: "CPM Ef.",       type: "currency" },
    { key: "cpcv",                  label: "CPCV Ef.",      type: "currency" },
    { key: "cost",                  label: "Custo Ef.",     type: "currency" },
  ],
  DISPLAY: [
    { key: "date",                  label: "Data",          align: "left", type: "date" },
    { key: "impressions",           label: "Impressões",    type: "number" },
    { key: "viewable_impressions",  label: "Imp. Visíveis", type: "number" },
    { key: "clicks",                label: "Cliques",       type: "number" },
    { key: "ctr",                   label: "CTR",           type: "percent2" },
    { key: "viewability",           label: "Viewability",   type: "percent1" },
    { key: "cpm",                   label: "CPM Ef.",       type: "currency" },
    { key: "cost",                  label: "Custo Ef.",     type: "currency" },
  ],
  VIDEO: [
    { key: "date",                  label: "Data",          align: "left", type: "date" },
    { key: "impressions",           label: "Impressões",    type: "number" },
    { key: "viewable_impressions",  label: "Imp. Visíveis", type: "number" },
    { key: "clicks",                label: "Cliques",       type: "number" },
    { key: "ctr",                   label: "CTR",           type: "percent2" },
    { key: "viewability",           label: "Viewability",   type: "percent1" },
    { key: "video_starts",          label: "Start Views",   type: "number" },
    { key: "video_view_100",        label: "100% Views",    type: "number" },
    { key: "vtr",                   label: "VTR",           type: "percent1" },
    { key: "cpcv",                  label: "CPCV Ef.",      type: "currency" },
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
  // Quando passado, restringe as opções do toggle a esse subset (ex:
  // campanha só Display passa ["DISPLAY"]). Default = ambas. Quando
  // resta só uma opção, o toggle é escondido (1 botão é UI ruim) e a
  // mídia única vira a selecionada.
  availableMedia = null,
}) {
  // Filtra MEDIA_OPTIONS pelo conjunto disponível (se passado). Mantém
  // ordem original (Agregado, Display, Video). Agregado só faz sentido
  // quando há ambas mídias — se a campanha tem só uma, mostra direto a
  // mídia única (sem opção "Agregado" redundante).
  const filteredMediaOptions = useMemo(() => {
    const hasBoth =
      !availableMedia
      || (availableMedia.includes("DISPLAY") && availableMedia.includes("VIDEO"));
    return MEDIA_OPTIONS.filter((opt) => {
      if (opt.value === "AGGREGATED") return hasBoth;
      return availableMedia ? availableMedia.includes(opt.value) : true;
    });
  }, [availableMedia]);
  const showToggle = !lockedMedia && filteredMediaOptions.length > 1;
  const fallbackMedia = filteredMediaOptions[0]?.value || "DISPLAY";

  // Toggle interno — Display por padrão se disponível, senão a primeira
  // opção válida. Quando lockedMedia ou availableMedia restringe, o state
  // interno pode ficar dessincronizado; effectiveMedia abaixo cobre.
  const [internalMedia, setInternalMedia] = useState(fallbackMedia);
  const media = lockedMedia
    || (filteredMediaOptions.some((o) => o.value === internalMedia)
      ? internalMedia
      : fallbackMedia);

  const aggregated = useMemo(
    () => aggregateByDay(daily, media),
    [daily, media],
  );

  // Linha de Total: counts somados, ratios (CTR, Viewability, VTR)
  // recalculados a partir dos somatórios — somar percentuais brutos
  // dá média ponderada errada.
  const totalsRow = useMemo(
    () => computeTotalsRow(aggregated),
    [aggregated],
  );

  const columns = COLUMNS[media];

  const downloadCsv = () => {
    const headers = columns.map((c) => c.label);
    const rows = aggregated.map((r) =>
      columns.map((c) => formatCsvCell(r[c.key], c.type)),
    );
    const totalLine = totalsRow
      ? [columns.map((c) => formatCsvCell(totalsRow[c.key], c.type))]
      : [];
    const csv = [headers, ...rows, ...totalLine]
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
          {showToggle && (
            <SegmentedControlV2
              label="Mídia"
              options={filteredMediaOptions}
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
          Sem entregas de {MEDIA_LABEL[media] || media} no período.
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
            {totalsRow && (
              <tfoot>
                <tr className="border-t-2 border-border bg-surface font-semibold">
                  {columns.map((c) => (
                    <Td
                      key={c.key}
                      align={c.align}
                      mono={c.type === "date"}
                    >
                      {c.key === "date"
                        ? "Total"
                        : formatCell(totalsRow[c.key], c.type)}
                    </Td>
                  ))}
                </tr>
              </tfoot>
            )}
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
// recalcula derivados (CTR, VTR, Viewability). Quando mediaFilter é
// "AGGREGATED", não filtra — soma Display + Video no mesmo balde.
function aggregateByDay(daily, mediaFilter) {
  if (!daily || !daily.length) return [];

  const filtered = mediaFilter === "AGGREGATED"
    ? daily
    : daily.filter((r) => r.media_type === mediaFilter);
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
      // CPM Efetivo = custo / imp. visíveis × 1000 (custo por mil
      // impressões realmente vistas). null quando não há denominador
      // pra exibir "—" em vez de "R$ 0,00".
      cpm: r.viewable_impressions > 0
        ? (r.cost / r.viewable_impressions) * 1000
        : null,
      // CPCV Efetivo = custo / views 100% (custo por view completa).
      // Usa custo total por dia mesmo no AGGREGATED — vira "blended".
      cpcv: r.video_view_100 > 0
        ? r.cost / r.video_view_100
        : null,
    }))
    .sort((a, b) => b.date.localeCompare(a.date)); // mais recente no topo
}

// Linha de Total: soma counts e recalcula ratios. Reaproveita as mesmas
// fórmulas do aggregateByDay pra manter coerência entre célula diária e
// totalizador.
function computeTotalsRow(rows) {
  if (!rows || !rows.length) return null;
  const sum = rows.reduce(
    (acc, r) => ({
      impressions:          acc.impressions          + (r.impressions          || 0),
      viewable_impressions: acc.viewable_impressions + (r.viewable_impressions || 0),
      clicks:               acc.clicks               + (r.clicks               || 0),
      video_starts:         acc.video_starts         + (r.video_starts         || 0),
      video_view_100:       acc.video_view_100       + (r.video_view_100       || 0),
      cost:                 acc.cost                 + (r.cost                 || 0),
    }),
    { impressions: 0, viewable_impressions: 0, clicks: 0, video_starts: 0, video_view_100: 0, cost: 0 },
  );
  return {
    ...sum,
    ctr: sum.viewable_impressions > 0
      ? (sum.clicks / sum.viewable_impressions) * 100
      : 0,
    viewability: sum.impressions > 0
      ? (sum.viewable_impressions / sum.impressions) * 100
      : 0,
    vtr: sum.viewable_impressions > 0
      ? (sum.video_view_100 / sum.viewable_impressions) * 100
      : 0,
    cpm: sum.viewable_impressions > 0
      ? (sum.cost / sum.viewable_impressions) * 1000
      : null,
    cpcv: sum.video_view_100 > 0
      ? sum.cost / sum.video_view_100
      : null,
  };
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
