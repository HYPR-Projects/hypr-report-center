// src/v2/components/DataTableV2.jsx
//
// Tabela detalhada da Visão Geral V2. Mostra `detail` (já enriquecido
// pelo computeAggregates), filtra por mídia (Tudo/Display/Video) e
// exporta CSV.
//
// Diferenças vs Legacy DetailTable
//   - Filtro por chips em vez de botões inline (consistente com
//     DateRangeFilterV2)
//   - Estilo HYPR (header sticky, hover row, zebra sutil)
//   - Mostra contador "X de Y" sempre (não só quando trunca)
//   - Header sticky funciona via position:sticky no <thead> dentro do
//     scroll container (mesma estratégia Legacy)
//
// Cores (PR-16 audit visual)
//   - Container: bg-surface-2 (sólido, consistente com KpiCard/HeroKpi/etc).
//     Antes era bg-canvas-deeper (#0F1419 — quase preto, destoava do resto).
//   - Header sticky: bg-surface-strong (overlay 10% sobre surface-2, sutil
//     mas visível pra distinguir de tbody). Antes bg-canvas-elevated, quase
//     idêntico ao novo container — sem contraste.
//   - Hover row: bg-surface-strong (mais claro que zebra surface/40).
//
// Limit de 200 linhas visuais
//   Renderizar 10k+ linhas no DOM degrada scroll. Mostra primeiras 200
//   e oferece CSV pra ver tudo. Mesma regra do Legacy.

import { useState } from "react";
import { fmt } from "../../shared/format";
import { cn } from "../../ui/cn";
import { Button } from "../../ui/Button";

const COLUMNS = [
  { key: "date",                     label: "Data" },
  { key: "campaign_name",            label: "Campanha" },
  { key: "line_name",                label: "Line" },
  { key: "creative_name",            label: "Criativo" },
  { key: "creative_size",            label: "Tamanho" },
  { key: "media_type",               label: "Tipo" },
  { key: "impressions",              label: "Impressões",      numeric: true },
  { key: "viewable_impressions",     label: "Imp. Visíveis",   numeric: true },
  { key: "clicks",                   label: "Cliques",         numeric: true },
  { key: "video_starts",             label: "Video Starts",    numeric: true },
  { key: "video_view_25",            label: "25%",             numeric: true },
  { key: "video_view_50",            label: "50%",             numeric: true },
  { key: "video_view_75",            label: "75%",             numeric: true },
  { key: "video_view_100",           label: "100%",            numeric: true },
  { key: "effective_total_cost",     label: "Custo Efetivo",   numeric: true },
  { key: "effective_cost_with_over", label: "Custo Ef. + Over",numeric: true },
];

const ROW_LIMIT = 200;

export function DataTableV2({ detail, campaignName }) {
  const [filter, setFilter] = useState("ALL");
  const filtered = filter === "ALL" ? detail : detail.filter((r) => r.media_type === filter);
  const visible = filtered.slice(0, ROW_LIMIT);

  const downloadCSV = () => {
    const header = COLUMNS.map((c) => c.key).join(",");
    const rows = filtered.map((r) =>
      COLUMNS.map((c) => `"${(r[c.key] ?? "").toString().replace(/"/g, '""')}"`).join(","),
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${campaignName || "campanha"}_detail.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="radiogroup" aria-label="Filtrar por mídia" className="flex gap-1.5">
          {["ALL", "DISPLAY", "VIDEO"].map((f) => {
            const active = filter === f;
            return (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setFilter(f)}
                className={cn(
                  "h-8 px-3 rounded-full text-[11px] font-bold uppercase tracking-wider",
                  "border transition-colors duration-150 cursor-pointer",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
                  active
                    ? "bg-signature border-signature text-fg"
                    : "bg-surface border-border text-fg-muted hover:text-fg hover:border-border-strong",
                )}
              >
                {f === "ALL" ? "Tudo" : f}
              </button>
            );
          })}
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={downloadCSV}
          iconLeft={<DownloadIcon />}
          disabled={!filtered.length}
        >
          Download CSV
        </Button>
      </div>

      <div className="overflow-auto max-h-[640px] rounded-lg border border-border bg-surface-2">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "px-3 py-2 text-[10px] font-bold uppercase tracking-wider whitespace-nowrap",
                    "bg-surface-strong text-fg-muted border-b border-border-strong",
                    c.numeric ? "text-right" : "text-left",
                  )}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="px-3 py-8 text-center text-sm text-fg-muted"
                >
                  Nenhum registro pra mostrar.
                </td>
              </tr>
            ) : (
              visible.map((r, i) => (
                <tr
                  key={i}
                  className={cn(
                    "border-b border-border/60 last:border-b-0",
                    "hover:bg-surface-strong transition-colors",
                    i % 2 === 1 && "bg-surface/40",
                  )}
                >
                  {COLUMNS.map((c) => {
                    const v = r[c.key];
                    const isNum = typeof v === "number";
                    return (
                      <td
                        key={c.key}
                        className={cn(
                          "px-3 py-2 text-xs whitespace-nowrap",
                          isNum
                            ? "text-right tabular-nums text-fg"
                            : "text-left text-fg-muted",
                        )}
                      >
                        {v == null || v === ""
                          ? "—"
                          : isNum
                          ? fmt(v)
                          : String(v)}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-fg-subtle text-center">
        {filtered.length === 0
          ? "0 registros"
          : visible.length === filtered.length
          ? `${fmt(filtered.length)} ${filtered.length === 1 ? "registro" : "registros"}`
          : `Mostrando ${fmt(visible.length)} de ${fmt(filtered.length)} registros — use Download CSV pra ver tudo.`}
      </p>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <path d="M8 2v9M4 7l4 4 4-4M2 14h12" />
    </svg>
  );
}
