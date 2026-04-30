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
//   ┌────────────────────────────────────────────────────────────────────────┐
//   │ FORMATO        ▮▮▮▮▮▮▮▮ SHARE  IMP. VIS.  CTR/VTR  VIEW/CTR  CUSTO EF. │
//   │ 320x480        ▮▮▮▮▮▮   45.2%  1.2M       0.85%    72.1%     R$ 850,12 │
//   │ 1024x768       ▮▮▮▮     32.1%  856K       0.62%    68.4%     R$ 612,34 │
//   │ ...                                                                     │
//   └────────────────────────────────────────────────────────────────────────┘
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
  // Junta cost / impressions brutas / clicks por chave de agrupamento se
  // extraRows foi passado. groupBySize/groupByDuration só trazem 2 campos
  // (numeratorKey + denomKey). Aqui derivamos campos extra que precisamos
  // pra Viewability (viewable/impressions) e CTR de Video (clicks/viewable),
  // sem alterar shared/aggregations.js.
  const enriched = useMemo(() => {
    if (!rows?.length) return [];

    const totalDenom = rows.reduce((s, r) => s + (r[denomKey] || 0), 0);

    // Agrega cost + impressions + clicks por grupo a partir das rows brutas
    const extraByGroup = {};
    if (extraRows?.length) {
      const detailKey = groupKey === "size" ? "creative_size" : groupKey;
      for (const r of extraRows) {
        const k = r[detailKey] || "N/A";
        if (!extraByGroup[k]) {
          extraByGroup[k] = { cost: 0, impressions: 0, clicks: 0 };
        }
        extraByGroup[k].cost        += r.effective_total_cost || 0;
        extraByGroup[k].impressions += r.impressions          || 0;
        extraByGroup[k].clicks      += r.clicks               || 0;
      }
    }

    return rows
      .map((r) => {
        const extra = extraByGroup[r[groupKey]] || { cost: 0, impressions: 0, clicks: 0 };
        const viewable = r[denomKey] || 0;
        // Viewability = visíveis / total medidas (display only). >70% é
        // considerado bom em DV360.
        const viewability = extra.impressions > 0
          ? (viewable / extra.impressions) * 100
          : 0;
        // CTR derivado das clicks brutas — necessário pra Video, onde
        // numeratorKey = video_view_100 (não clicks).
        const ctrFromExtra = viewable > 0
          ? (extra.clicks / viewable) * 100
          : 0;
        return {
          ...r,
          share: totalDenom > 0 ? (viewable / totalDenom) * 100 : 0,
          cost: extra.cost,
          viewability,
          ctr_extra: ctrFromExtra,
        };
      })
      .sort((a, b) => b.share - a.share)
      .slice(0, ROW_LIMIT);
  }, [rows, groupKey, denomKey, extraRows]);

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
              {/* Última fileira: por mídia.
                  - Display: Viewability + Custo Ef.
                  - Video:   CTR + Custo Ef.
                  Ambas terminam em Custo Efetivo pra fechar com a métrica
                  financeira mais relevante (substitui o antigo CPM/CPCV
                  efetivo, que misturava preço com performance). */}
              {mediaType === "DISPLAY" ? (
                <>
                  <Th>Viewability</Th>
                  <Th>Custo Ef.</Th>
                </>
              ) : (
                <>
                  <Th>CTR</Th>
                  <Th>Custo Ef.</Th>
                </>
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
                  <>
                    <Td>{r.viewability > 0 ? `${r.viewability.toFixed(1)}%` : "—"}</Td>
                    <Td accent={r.cost > 0}>{r.cost > 0 ? fmtR(r.cost) : "—"}</Td>
                  </>
                ) : (
                  <>
                    <Td>{r.ctr_extra > 0 ? `${r.ctr_extra.toFixed(2)}%` : "—"}</Td>
                    <Td accent={r.cost > 0}>{r.cost > 0 ? fmtR(r.cost) : "—"}</Td>
                  </>
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
