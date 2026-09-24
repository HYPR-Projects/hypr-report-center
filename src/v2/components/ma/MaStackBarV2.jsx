// src/v2/components/ma/MaStackBarV2.jsx
//
// Barra 100% com legenda: participação de cada superfície/botão/controle.
// Cores da paleta categórica em ordem fixa (a 5ª parte em diante fica
// neutra), com 2px de respiro entre segmentos. A legenda carrega valor e %
// em texto, então a identidade nunca depende só da cor.
//
// `list` troca a barra por linhas independentes (quando as partes não somam
// um todo, ex.: pessoas por ação, em que uma pessoa faz mais de uma).

import { fmt } from "../../../shared/format";

const COLORS = [
  "var(--color-chart-s1)",
  "var(--color-chart-s2)",
  "var(--color-chart-s3)",
  "var(--color-chart-s4)",
];
const colorAt = (i) => COLORS[i] || "var(--color-fg-subtle)";

// `percentOnly`: legenda só com a participação (%). No report do cliente os
// cliques no CTA contados pela peça não aparecem em número absoluto — somados,
// competiriam com os cliques da DSP.
export function MaStackBarV2({ parts = [], unit = "", list = false, percentOnly = false }) {
  const total = parts.reduce((s, p) => s + (p.value || 0), 0);
  if (!parts.length || total <= 0) {
    return <p className="text-[12px] text-fg-subtle">Sem registros no período.</p>;
  }

  if (list) {
    const max = Math.max(...parts.map((p) => p.value || 0), 1);
    return (
      <div className="grid gap-2">
        {parts.map((p, i) => (
          <div key={p.label} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_4.5rem] items-center gap-3">
            <span className="text-[12px] text-fg-muted truncate">{p.label}</span>
            <div className="h-2 rounded-full bg-track overflow-hidden">
              <div className="bar-grow-x h-full rounded-full bg-signature" style={{ width: `${Math.max(1, (p.value / max) * 100)}%`, "--i": i }} />
            </div>
            <span className="text-[12px] font-semibold text-fg tabular-nums text-right">{fmt(p.value)}</span>
          </div>
        ))}
        {unit && <p className="text-[11px] text-fg-subtle">Em {unit}.</p>}
      </div>
    );
  }

  const label = parts.map((p) => `${p.label} ${fmt((p.value / total) * 100, 1)}%`).join(", ");
  return (
    <div>
      <div className="bar-grow-x flex h-3 w-full gap-[2px] overflow-hidden rounded-full" role="img" aria-label={label}>
        {parts.map((p, i) =>
          p.value > 0 ? (
            <div
              key={p.label}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(p.value / total) * 100}%`, background: colorAt(i), minWidth: 3 }}
              title={percentOnly ? `${p.label}: ${fmt((p.value / total) * 100, 1)}%` : `${p.label}: ${fmt(p.value)}`}
            />
          ) : null,
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {parts.map((p, i) => (
          <span key={p.label} className="inline-flex items-center gap-1.5 text-[11px] text-fg-muted">
            <span className="size-2 rounded-full shrink-0" style={{ background: colorAt(i) }} aria-hidden />
            {p.label}
            {percentOnly ? (
              <span className="font-semibold text-fg tabular-nums">{fmt((p.value / total) * 100, 1)}%</span>
            ) : (
              <>
                <span className="font-semibold text-fg tabular-nums">{fmt(p.value)}</span>
                <span className="text-fg-subtle tabular-nums">{fmt((p.value / total) * 100, 1)}%</span>
              </>
            )}
          </span>
        ))}
      </div>
      {unit && <p className="mt-2 text-[11px] text-fg-subtle">{percentOnly ? `Participação no total de ${unit}, no período.` : `Em ${unit}, no período.`}</p>}
    </div>
  );
}
