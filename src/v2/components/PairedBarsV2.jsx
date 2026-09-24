// src/v2/components/PairedBarsV2.jsx
//
// Modo "Gráfico" do Explorador para dimensões categóricas (audiência,
// tamanho, linha criativa, line): duas colunas de barras horizontais
// alinhadas pela mesma linha — volume à esquerda, taxa à direita, cada uma
// na sua escala. Substitui o gráfico de eixo duplo "Entrega × CTR por
// audiência". Uma série por coluna → uma cor; valores sempre em texto.

import { fmt } from "../../shared/format";

export function PairedBarsV2({ rows, groupKey, volumeKey, volumeLabel, rateKey, rateLabel, rateDecimals = 2, limit = 12 }) {
  const data = [...(rows || [])]
    .sort((a, b) => (Number(b[volumeKey]) || 0) - (Number(a[volumeKey]) || 0))
    .slice(0, limit);
  if (!data.length) return <p className="px-5 py-6 text-center text-sm text-fg-subtle">Sem dados para o período selecionado.</p>;
  const maxV = Math.max(...data.map((r) => Number(r[volumeKey]) || 0), 1);
  const maxR = Math.max(...data.map((r) => Number(r[rateKey]) || 0), 0.0001);
  const hidden = (rows?.length || 0) - data.length;
  return (
    <div className="px-4 md:px-5 py-4">
      <div className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_minmax(0,1fr)] sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 sm:gap-x-4 gap-y-2 items-center">
        <span />
        <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">{volumeLabel}</span>
        <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">{rateLabel}</span>
        {data.map((r) => {
          const v = Number(r[volumeKey]) || 0;
          const t = Number(r[rateKey]) || 0;
          return (
            <div key={r[groupKey]} className="contents">
              <span className="text-[12px] text-fg truncate" title={r[groupKey]}>{r[groupKey] || "—"}</span>
              <div className="flex items-center gap-2 min-w-0">
                <div className="h-3 flex-1 rounded-r-[4px] bg-track overflow-hidden">
                  <div className="h-full rounded-r-[4px] bg-chart-s1" style={{ width: `${Math.max(1, (v / maxV) * 100)}%` }} />
                </div>
                <span className="w-[3.75rem] sm:w-[4.5rem] shrink-0 text-right text-[11px] font-semibold text-fg tabular-nums">{fmt(v)}</span>
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <div className="h-3 flex-1 rounded-r-[4px] bg-track overflow-hidden">
                  <div className="h-full rounded-r-[4px] bg-chart-s2" style={{ width: `${Math.max(1, (t / maxR) * 100)}%` }} />
                </div>
                <span className="w-[3.25rem] sm:w-[3.75rem] shrink-0 text-right text-[11px] font-semibold text-fg tabular-nums">{fmt(t, rateDecimals)}%</span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-fg-subtle">
        Ordenado por {volumeLabel.toLowerCase()}. Cada coluna tem a sua escala.
        {hidden > 0 ? ` ${hidden} ${hidden === 1 ? "item menor fica" : "itens menores ficam"} na tabela.` : ""}
      </p>
    </div>
  );
}
