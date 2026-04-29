// src/v2/components/FormatBreakdownTableV2.jsx
//
// Tabela "Por Formato" — agrupa entrega por creative_size (Display) ou
// por uma chave alternativa (ex.: creative_duration pra Video) e mostra
// uma bar horizontal de share visual ao lado de cada linha.
//
// Faz parte do redesign V2 da PR-14 (tabs Display/Video). O equivalente
// no Legacy era um DualChart "Entrega × CTR por Tamanho" — funcional,
// mas menos legível pra leitura operacional. Tabela facilita
// scanning de top-formatos e comparação direta entre métricas.
//
// LAYOUT
//   ┌──────────────────────────────────────────────────────────────┐
//   │ FORMATO            ▮▮▮▮▮▮▮▮ SHARE  IMP. VIS.  CTR/VTR  CPM   │
//   │ 320x480            ▮▮▮▮▮▮   45.2%  1.2M       0.85%    8.21  │
//   │ 1024x768           ▮▮▮▮     32.1%  856K       0.62%    9.40  │
//   │ ...                                                           │
//   └──────────────────────────────────────────────────────────────┘
//
// API
//   <FormatBreakdownTableV2
//     rows={view.bySize}                  // saída de groupBySize / groupByDuration
//     groupKey="size"                     // "size" (default) | "duration" | etc
//     groupLabel="Formato"                // header da primeira coluna
//     denomKey="viewable_impressions"     // métrica usada pra calcular share
//     denomLabel="Imp. Visíveis"
//     numeratorKey="clicks"               // métrica complementar (cliques | views100)
//     numeratorLabel="Cliques"
//     rateKey="ctr"
//     rateLabel="CTR"
//     rateFormatter={(v) => v.toFixed(2) + "%"}
//     extraRows={detailFiltered}          // rows brutos pra computar custo/CPM por formato
//     mediaType="DISPLAY"                 // "DISPLAY" | "VIDEO" — controla coluna final
//   />
//
// Ordenação: descrescente por share (formato mais entregue no topo).
// Limite visual: 10 linhas (raro ter mais; Display HYPR opera com ~6
// formatos padrão e Video com ~3 durações).

import { useMemo } from "react";
import { fmt, fmtR } from "../../shared/format";
import { Card } from "../../ui/Card";
import { cn } from "../../ui/cn";

const ROW_LIMIT = 10;

export function FormatBreakdownTableV2({
  rows,
  groupKey = "size",
  groupLabel = "Formato",
  denomKey = "viewable_impressions",
  denomLabel = "Imp. Visíveis",
  numeratorKey = "clicks",
  numeratorLabel = "Cliques",
  rateKey = "ctr",
  rateLabel = "CTR",
  rateFormatter = (v) => `${(v || 0).toFixed(2)}%`,
  extraRows = null, // detail rows pra calcular custo/CPM (opcional)
  mediaType = "DISPLAY",
  className,
}) {
  // Junta cost por chave de agrupamento se extraRows foi passado.
  // groupBySize/groupByDuration não trazem custo (só count + rate), então
  // recalculamos aqui pra evitar mudança no shared/aggregations.js.
  const enriched = useMemo(() => {
    if (!rows?.length) return [];

    const totalDenom = rows.reduce((s, r) => s + (r[denomKey] || 0), 0);

    const costByGroup = {};
    if (extraRows?.length) {
      for (const r of extraRows) {
        const k = r[groupKey === "size" ? "creative_size" : groupKey] || "N/A";
        costByGroup[k] = (costByGroup[k] || 0) + (r.effective_total_cost || 0);
      }
    }

    return rows
      .map((r) => {
        const cost = costByGroup[r[groupKey]] || 0;
        const cpm =
          r[denomKey] > 0 ? (cost / r[denomKey]) * 1000 : 0;
        const cpcv =
          mediaType === "VIDEO" && r[numeratorKey] > 0
            ? cost / r[numeratorKey]
            : 0;
        return {
          ...r,
          share: totalDenom > 0 ? (r[denomKey] / totalDenom) * 100 : 0,
          cost,
          cpm,
          cpcv,
        };
      })
      .sort((a, b) => b.share - a.share)
      .slice(0, ROW_LIMIT);
  }, [rows, groupKey, denomKey, numeratorKey, extraRows, mediaType]);

  if (!enriched.length) {
    return (
      <Card className={cn("p-6 text-center text-sm text-fg-subtle", className)}>
        Sem dados para o período selecionado.
      </Card>
    );
  }

  // Largura da bar relativa ao maior share (visual mais punchy que
  // relativo ao 100% — formato top sempre cheia, demais proporcionais).
  const maxShare = enriched[0]?.share || 100;

  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className="px-5 pt-4 pb-3 border-b border-border flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">
          Distribuição por {groupLabel}
        </div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
          {enriched.length} {enriched.length === 1 ? "formato" : "formatos"}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <Th align="left">{groupLabel}</Th>
              <Th align="left" className="w-[180px]">Share</Th>
              <Th>Share %</Th>
              <Th>{denomLabel}</Th>
              <Th>{numeratorLabel}</Th>
              <Th>{rateLabel}</Th>
              {mediaType === "DISPLAY" ? (
                <Th>CPM Ef.</Th>
              ) : (
                <Th>CPCV Ef.</Th>
              )}
            </tr>
          </thead>
          <tbody>
            {enriched.map((r) => (
              <tr
                key={r[groupKey]}
                className="border-b border-border/50 last:border-b-0 hover:bg-surface transition-colors"
              >
                <Td align="left" mono>
                  {r[groupKey] || "—"}
                </Td>
                <Td align="left">
                  <ShareBar pct={r.share} maxShare={maxShare} />
                </Td>
                <Td>
                  <span className="text-fg font-semibold">
                    {r.share.toFixed(1)}%
                  </span>
                </Td>
                <Td>{fmt(r[denomKey])}</Td>
                <Td>{fmt(r[numeratorKey])}</Td>
                <Td>{rateFormatter(r[rateKey])}</Td>
                {mediaType === "DISPLAY" ? (
                  <Td accent={r.cpm > 0}>
                    {r.cpm > 0 ? fmtR(r.cpm) : "—"}
                  </Td>
                ) : (
                  <Td accent={r.cpcv > 0}>
                    {r.cpcv > 0
                      ? `R$ ${r.cpcv.toFixed(3).replace(".", ",")}`
                      : "—"}
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Bar visual de share ──────────────────────────────────────────────
//
// Largura proporcional ao maior share (não ao 100%) — fica mais legível
// quando todos os formatos somam < 50% individualmente. Cor signature
// pra reforçar identidade do dashboard.

function ShareBar({ pct, maxShare }) {
  const width = maxShare > 0 ? (pct / maxShare) * 100 : 0;
  return (
    <div className="relative h-2 rounded-full bg-canvas-deeper overflow-hidden">
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
        style={{
          width: `${width}%`,
          background:
            "linear-gradient(90deg, var(--color-signature) 0%, var(--color-signature-light) 100%)",
        }}
      />
    </div>
  );
}

function Th({ children, align = "right", className }) {
  return (
    <th
      className={cn(
        "px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-fg-subtle whitespace-nowrap",
        align === "right" ? "text-right" : "text-left",
        className,
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
        align === "right" ? "text-right tabular-nums" : "text-left",
        mono && "tabular-nums font-medium",
        accent ? "text-signature font-semibold" : "text-fg",
      )}
    >
      {children}
    </td>
  );
}
