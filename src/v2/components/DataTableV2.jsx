// src/v2/components/DataTableV2.jsx
//
// Tabela detalhada da Visão Geral V2. Mostra `detail` (já enriquecido
// pelo computeAggregates), filtra por audiência, line, tamanho e formato
// (multi-select), e exporta CSV.
//
// Filtros (multi-select, todos opcionais, combinam como AND):
//   - Audiência: extractAudience(line_name) → penúltimo token do _
//   - Line:      line_name completo         → label encurtado (…_últ3 segs)
//   - Tamanho:   creative_size              → "300x250", "970x250", ...
//   - Formato:   media_type                 → DISPLAY / VIDEO
// "Selected vazio" = filtro inativo (mostra tudo). Substituiu a barra
// antiga de chips Tudo/Display/Video (que era single-select e só cobria
// média).
//
// Diferenças vs Legacy DetailTable
//   - Filtros multi-select em vez de chips (escala melhor com campanhas
//     com muitas audiências/tamanhos)
//   - Estilo HYPR (header sticky, hover row, zebra sutil)
//   - Mostra contador "X de Y" sempre (não só quando trunca)
//   - Header sticky funciona via position:sticky no <thead> dentro do
//     scroll container (mesma estratégia Legacy)
//
// Cores (PR-16 audit visual)
//   - Container: bg-surface-2 (sólido, consistente com KpiCard/HeroKpi/etc).
//     Antes era bg-canvas-deeper (#0F1419 — quase preto, destoava do resto).
//   - Header e footer sticky: bg-surface-3 (sólido em ambos os temas).
//     Antes usava bg-surface-strong (overlay 10%) — quando sticky, rows
//     scrolladas vazavam por baixo (10% transparente NÃO esconde nada).
//     surface-3 dark=#2D3D4F / light=#F1F3F6: opaco e ainda diferencia
//     do container bg-surface-2.
//   - Hover row: bg-surface-strong (continua overlay — não é sticky, sem
//     problema de pass-through).
//
// Limit de 200 linhas visuais
//   Renderizar 10k+ linhas no DOM degrada scroll. Mostra primeiras 200
//   e oferece CSV pra ver tudo. Mesma regra do Legacy.

import { useMemo, useState } from "react";
import { fmt } from "../../shared/format";
import { extractAudience } from "../../shared/aggregations";
import { cn } from "../../ui/cn";
import { Button } from "../../ui/Button";
import { TableMultiSelectFilter } from "./TableMultiSelectFilter";
import { useReportTrackingContext } from "../contexts/ReportTrackingContext";

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
  // Filtros multi-select. Cada um é independente — empty = "todos".
  //   audience: extractAudience(line_name) → token do penúltimo segmento
  //   line:     line_name completo         → match exato
  //   size:     creative_size              → "300x250", "970x250", etc.
  //   format:   media_type                 → DISPLAY / VIDEO
  // Filtros combinam como AND: row passa se atende a TODOS os filtros ativos.
  const [audiences, setAudiences] = useState([]);
  const [lines, setLines] = useState([]);
  const [sizes, setSizes] = useState([]);
  const [formats, setFormats] = useState([]);

  // Opções únicas extraídas do `detail` cru — recalcula só quando detail
  // muda (troca de view ou filtro de período no dashboard pai).
  // Ordenação alfabética estável pra dropdown não pular ao re-render.
  const { audienceOptions, lineOptions, sizeOptions, formatOptions } = useMemo(() => {
    const aud = new Set();
    const lin = new Set();
    const siz = new Set();
    const fmt = new Set();
    for (const r of detail) {
      const a = extractAudience(r.line_name);
      if (a && a !== "N/A") aud.add(a);
      if (r.line_name) lin.add(r.line_name);
      if (r.creative_size) siz.add(r.creative_size);
      if (r.media_type) fmt.add(r.media_type);
    }
    return {
      audienceOptions: [...aud].sort((a, b) => a.localeCompare(b)),
      lineOptions: [...lin].sort((a, b) => a.localeCompare(b)),
      // Size: ordena numericamente pelo primeiro número (larguras) pra que
      // "300x50" venha antes de "970x250" — alpha simples colocaria "970"
      // antes de "300" se string. Default fallback pra string-compare.
      sizeOptions: [...siz].sort((a, b) => {
        const na = parseInt(a, 10);
        const nb = parseInt(b, 10);
        if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
        return a.localeCompare(b);
      }),
      formatOptions: [...fmt].sort((a, b) => a.localeCompare(b)),
    };
  }, [detail]);

  const filtered = useMemo(() => detail.filter((r) => {
    if (audiences.length > 0) {
      const a = extractAudience(r.line_name);
      if (!audiences.includes(a)) return false;
    }
    if (lines.length > 0 && !lines.includes(r.line_name)) return false;
    if (sizes.length > 0 && !sizes.includes(r.creative_size)) return false;
    if (formats.length > 0 && !formats.includes(r.media_type)) return false;
    return true;
  }), [detail, audiences, lines, sizes, formats]);

  const visible = filtered.slice(0, ROW_LIMIT);

  // Totais agregados das colunas numéricas. Calculado sobre `filtered`
  // (NÃO `visible`) — quando há mais de ROW_LIMIT rows, a tabela mostra
  // só as primeiras 200 mas o total ainda reflete o conjunto inteiro.
  // Sem isso, o "TOTAL" mentiria pra qualquer filtro com >200 resultados.
  const totals = useMemo(() => {
    const acc = {};
    for (const col of COLUMNS) {
      if (col.numeric) acc[col.key] = 0;
    }
    for (const r of filtered) {
      for (const col of COLUMNS) {
        if (col.numeric) acc[col.key] += Number(r[col.key]) || 0;
      }
    }
    return acc;
  }, [filtered]);

  // trackCta vem do contexto montado pelo ClientDashboardV2; noop fora
  // dele (preview/teste isolado).
  const { trackCta } = useReportTrackingContext();

  const downloadCSV = () => {
    trackCta("csv_download");
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
      {/* Barra de filtros + download. Antes era radio Tudo/Display/Video.
          Agora 3 multi-selects (Audiência, Tamanho, Formato) — substituem
          o chip de mídia (que vira o filtro "Formato") e adicionam dois
          eixos novos pra investigação fina. Layout: filtros à esquerda,
          download à direita. flex-wrap permite quebra natural em telas
          estreitas (cada filtro tem max-w-[240px]).
          gap-y-2 evita que filtros e botão fiquem colados quando quebram. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <TableMultiSelectFilter
            label="Audiência"
            pluralLabel="audiências"
            options={audienceOptions}
            selected={audiences}
            onChange={setAudiences}
            icon={
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            }
          />
          <TableMultiSelectFilter
            label="Line"
            pluralLabel="lines"
            options={lineOptions}
            selected={lines}
            onChange={setLines}
            // Line names podem ter 100+ chars em campanhas reais (Itaú etc).
            // Estratégia:
            //   - Popover bumpado pra 420px (mais respiro horizontal)
            //   - wrapItems: itens quebram em várias linhas, mostrando o
            //     nome COMPLETO em vez de truncar
            //   - formatLabel só aplica ao trigger (pill compacto), via
            //     últimos 4 segmentos — formatItem não passado, então
            //     popover mostra raw line_name por completo
            //   - searchable: line names são longos e parecidos; busca por
            //     substring resolve "qual era a line que tinha CONGRESSO?"
            popoverWidth={420}
            triggerMaxWidth={360}
            wrapItems={true}
            searchable={true}
            formatLabel={(ln) => {
              const parts = ln.split("_");
              return parts.length > 4 ? "…_" + parts.slice(-4).join("_") : ln;
            }}
            icon={
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2 4h12M2 8h12M2 12h8" />
              </svg>
            }
          />
          <TableMultiSelectFilter
            label="Tamanho"
            pluralLabel="tamanhos"
            options={sizeOptions}
            selected={sizes}
            onChange={setSizes}
            icon={
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="3" width="12" height="10" rx="1" />
                <path d="M2 7h12M6 3v10" />
              </svg>
            }
          />
          <TableMultiSelectFilter
            label="Formato"
            pluralLabel="formatos"
            options={formatOptions}
            selected={formats}
            onChange={setFormats}
            // Display/Video vêm em UPPERCASE do BQ — exibir capitalizado
            // pra leitura (Display/Video) sem mudar o valor interno.
            formatLabel={(v) => v.charAt(0) + v.slice(1).toLowerCase()}
            icon={
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="2.5" width="12" height="9" rx="1" />
                <path d="M5 14h6" />
              </svg>
            }
          />
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

      {/* Mobile: max-h 480px (~60% viewport iPhone padrão) — evita que a
          tabela ocupe a tela inteira e prenda o scroll. Desktop mantém
          640px (mockup original). overflow-auto cobre x (16 colunas
          estouram) e y (até ROW_LIMIT linhas). */}
      <div className="overflow-auto max-h-[480px] sm:max-h-[640px] rounded-lg border border-border bg-surface-2">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "px-3 py-2 text-[10px] font-bold uppercase tracking-wider whitespace-nowrap",
                    // bg-surface-3 (sólido) em vez de bg-surface-strong
                    // (overlay) — sticky precisa esconder o que scrolla
                    // por baixo.
                    "bg-surface-3 text-fg-muted border-b border-border-strong",
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
          {/* Linha de TOTAL — sticky no fundo do scroll container, sempre
              visível enquanto o usuário rola pela tabela. Soma é sobre
              `filtered` (todas as rows que passam pelos filtros), não
              `visible` (que pode estar truncado em ROW_LIMIT). Sem isso,
              o total mentiria pra filtros com >200 resultados.
              Atualiza automaticamente quando audiences/sizes/formats mudam
              via re-render → useMemo recompute. */}
          {filtered.length > 0 && (
            <tfoot className="sticky bottom-0 z-10">
              <tr>
                {COLUMNS.map((c, i) => {
                  // Primeira coluna textual recebe o label "TOTAL".
                  // Outras colunas textuais ficam vazias (espaço pro número
                  // alinhar visualmente com os headers numéricos à direita).
                  const isFirstText = !c.numeric && i === 0;
                  return (
                    <td
                      key={c.key}
                      className={cn(
                        "px-3 py-2.5 text-xs whitespace-nowrap font-bold",
                        // bg-surface-3 (sólido) — ver nota no thead acima.
                        "bg-surface-3 text-fg border-t-2 border-border-strong",
                        c.numeric
                          ? "text-right tabular-nums"
                          : "text-left",
                      )}
                    >
                      {c.numeric
                        ? fmt(totals[c.key])
                        : isFirstText
                        ? "TOTAL"
                        : ""}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
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
