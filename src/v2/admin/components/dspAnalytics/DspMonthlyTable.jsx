// src/v2/admin/components/dspAnalytics/DspMonthlyTable.jsx
//
// Mês a mês por DSP na métrica escolhida no gráfico, com a variação contra o
// mês anterior da mesma DSP e a fatia de custo dela no mês. É a leitura que
// sustenta a conversa de investimento ("a Yahoo melhorou o vCPM três meses
// seguidos e já leva 12% do custo").
//
// Mês cortado pelo período fica marcado. Em volume e custo ele não gera
// variação (12 dias de setembro contra agosto inteiro diria só que setembro é
// mais curto); em razão (eCPM, CTR, viewability) a variação vale.

import { cn } from "../../../../ui/cn";
import { dspColor, dspLabel } from "../../../../shared/dspMeta";
import { tacticColor, tacticLabel } from "../../../../shared/tacticMeta";
import { METRICS } from "../../lib/dspAnalytics";
import { fmtMetric, fmtMetricFull, fmtDelta, fmtPct, bucketLabelLong } from "./dspFormat";

const TOTAL = "__total__";

function DeltaCell({ d, metric }) {
  const def = METRICS[metric];
  const f = fmtDelta(d, def?.kind === "rate" ? def.digits ?? 1 : 1);
  if (!f) return null;
  const good = f.dir === "flat" || !def?.better ? null : (f.dir === "up") === (def.better === "up");
  return (
    <span className={cn("text-[10.5px] font-semibold tabular-nums", good == null ? "text-fg-subtle" : good ? "text-success" : "text-danger")}>
      {f.dir === "up" ? "▲" : f.dir === "down" ? "▼" : "▬"} {f.text}
    </span>
  );
}

export function DspMonthlyTable({ monthly, metric }) {
  if (!monthly || monthly.rows.length < 2) return null;
  const cols = [...monthly.sources, TOTAL];
  const byTactic = monthly.by === "tactic";
  const colLabel = (c) => (byTactic ? tacticLabel(c) : dspLabel(c));
  const colColor = (c) => (byTactic ? tacticColor(c) : dspColor(c));
  const rows = [...monthly.rows].reverse(); // mais recente em cima
  return (
    <section className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-5 py-3 border-b border-border">
        <div className="text-[11px] font-bold uppercase tracking-widest text-signature">
          Mês a mês · {METRICS[metric].label} · por {byTactic ? "tática" : "DSP"}
        </div>
        <p className="mt-0.5 text-[11px] text-fg-subtle">
          Variação contra o mês anterior da mesma {byTactic ? "tática" : "DSP"} e fatia do custo no mês. Segue a métrica e a visão do gráfico.
        </p>
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-fg-muted">
              <th className="px-4 py-2 font-semibold text-left">Mês</th>
              {cols.map((c) => (
                <th key={c} className="px-3 py-2 font-semibold text-right whitespace-nowrap">
                  {c === TOTAL ? "Total" : (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ backgroundColor: colColor(c) }} aria-hidden />
                      {colLabel(c)}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="px-4 py-2 whitespace-nowrap text-fg">
                  <span className="capitalize">{bucketLabelLong(r.key, "month")}</span>
                  {r.partial && <span className="ml-1.5 text-[10.5px] text-fg-subtle">parcial · {r.days}d</span>}
                </td>
                {cols.map((c) => {
                  const cell = r.cells[c];
                  return (
                    <td key={c} className={cn("px-3 py-2 text-right align-top", c === TOTAL && "bg-surface-strong/40")}>
                      <div className="font-semibold text-fg" title={fmtMetricFull(metric, cell?.value)}>
                        {cell?.value == null ? "·" : fmtMetric(metric, cell.value)}
                      </div>
                      <div className="flex items-center justify-end gap-1.5">
                        <DeltaCell d={cell?.delta} metric={metric} />
                        {c !== TOTAL && cell?.costShare != null && metric !== "cost" && (
                          <span className="text-[10.5px] text-fg-subtle" title="Fatia do custo do mês">{fmtPct(cell.costShare, 0)} custo</span>
                        )}
                        {c !== TOTAL && cell?.costShare != null && metric === "cost" && (
                          <span className="text-[10.5px] text-fg-subtle">{fmtPct(cell.costShare, 0)}</span>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
