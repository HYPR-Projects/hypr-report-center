// src/v2/admin/components/dspAnalytics/DspTacticsCard.jsx
//
// Performance por tática da line (Top Performance High/Low, Premium List,
// Max Viewable…). A tática vem do nome da line, classificada no backend.
// Cada linha mostra volume e custo com a fatia no recorte, e as métricas de
// eficiência e qualidade; "Abrir por DSP" quebra cada tática nas DSPs, porque
// a mesma tática rende diferente no DV360 e na Yahoo.
//
// Os destaques do topo só consideram táticas com pelo menos 1% das
// impressões: tática com 3 lines não vira "melhor CTR" por acaso.

import { EdgeFadeScroller } from "../../../../ui/EdgeFadeScroller";
import { useState } from "react";
import { cn } from "../../../../ui/cn";
import { dspColor, dspLabel } from "../../../../shared/dspMeta";
import { tacticColor, tacticLabel, chartTacticKey } from "../../../../shared/tacticMeta";
import { fmtMetric, fmtMetricFull, fmtPct, toneFor } from "./dspFormat";

const COLS = [
  ["ecpm", "eCPM"], ["vcpm", "vCPM"], ["ctr", "CTR"], ["vtr", "VTR"],
  ["viewability", "Viewab."], ["viewShare", "Visív./Total"],
];
const MIN_SHARE = 1;

function highlights(rows) {
  const eligible = rows.filter((r) => r.tactic !== "none" && (r.shareImp || 0) >= MIN_SHARE);
  const pick = (key, dir) => {
    const withV = eligible.filter((r) => r.metrics[key] != null);
    if (withV.length < 2) return null;
    return withV.reduce((best, r) => ((dir === "min" ? r.metrics[key] < best.metrics[key] : r.metrics[key] > best.metrics[key]) ? r : best));
  };
  return [
    { label: "Menor vCPM", key: "vcpm", row: pick("vcpm", "min") },
    { label: "Maior CTR", key: "ctr", row: pick("ctr", "max") },
    { label: "Maior Visíveis/Total", key: "viewShare", row: pick("viewShare", "max") },
  ].filter((h) => h.row);
}

export function DspTacticsCard({ rows, selected, onToggleTactic }) {
  const [bySource, setBySource] = useState(false);
  if (!rows.length) return null;
  const hl = highlights(rows);
  return (
    <section className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-border flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-widest text-signature">Táticas</div>
          <p className="mt-0.5 text-[11px] text-fg-subtle">
            Tática lida do nome da line (LI-TOP-PERFORMANCE-HIGH, LI-PREMIUM-LIST…). Clique numa tática para filtrar a página.
          </p>
          {hl.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {hl.map((h) => (
                <span key={h.key} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-surface-strong text-[11px] text-fg-muted">
                  {h.label}
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: tacticColor(chartTacticKey(h.row.tactic)) }} aria-hidden />
                  <span className="font-semibold text-fg">{tacticLabel(h.row.tactic)}</span>
                  <span className="tabular-nums">{fmtMetric(h.key, h.row.metrics[h.key])}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-fg-muted cursor-pointer select-none">
          <input type="checkbox" checked={bySource} onChange={(e) => setBySource(e.target.checked)} className="accent-[var(--color-signature)]" />
          Abrir por DSP
        </label>
      </div>
      <EdgeFadeScroller className="scrollbar-thin">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left text-fg-muted">
              <th className="px-5 py-2 font-semibold min-w-[210px]">Tática</th>
              <th className="px-2.5 py-2 font-semibold text-right whitespace-nowrap">Impressões</th>
              <th className="px-2.5 py-2 font-semibold text-right whitespace-nowrap">Custo</th>
              {COLS.map(([k, l]) => (
                <th key={k} className="px-2.5 py-2 font-semibold text-right whitespace-nowrap">{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isSel = selected.includes(r.tactic);
              return (
                <TacticRows
                  key={r.tactic}
                  row={r}
                  isSel={isSel}
                  bySource={bySource}
                  onToggle={() => onToggleTactic(r.tactic)}
                />
              );
            })}
          </tbody>
        </table>
      </EdgeFadeScroller>
    </section>
  );
}

function TacticRows({ row: r, isSel, bySource, onToggle }) {
  const m = r.metrics;
  return (
    <>
      <tr className={cn("border-t border-border", isSel && "bg-signature-soft/40")}>
        <td className="px-5 py-2.5">
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex items-center gap-2 text-left cursor-pointer bg-transparent border-0 p-0 group"
            title={isSel ? "Tirar do filtro" : `Filtrar só ${tacticLabel(r.tactic)}`}
          >
            <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: tacticColor(chartTacticKey(r.tactic)) }} aria-hidden />
            <span className={cn("font-semibold group-hover:underline", r.tactic === "none" ? "text-fg-muted" : "text-fg")}>
              {tacticLabel(r.tactic)}
            </span>
          </button>
          <div className="mt-0.5 pl-[18px] text-[10.5px] text-fg-subtle">
            {r.lines} line{r.lines !== 1 ? "s" : ""}
            {r.flagged > 0 && <span className="text-danger"> · {r.flagged} com red flag</span>}
          </div>
        </td>
        <td className="px-2.5 py-2.5 text-right">
          <div className="text-fg" title={fmtMetricFull("imp", m.imp)}>{fmtMetric("imp", m.imp)}</div>
          <ShareBar pct={r.shareImp} color={tacticColor(chartTacticKey(r.tactic))} />
        </td>
        <td className="px-2.5 py-2.5 text-right">
          <div className="text-fg" title={fmtMetricFull("cost", m.cost)}>{fmtMetric("cost", m.cost)}</div>
          <ShareBar pct={r.shareCost} color={tacticColor(chartTacticKey(r.tactic))} />
        </td>
        {COLS.map(([k]) => (
          <td key={k} className={cn("px-2.5 py-2.5 text-right align-top", metricTone(k, m) || "text-fg")}>
            {fmtMetric(k, m[k])}
          </td>
        ))}
      </tr>
      {bySource && r.bySource.map((s) => (
        <tr key={`${r.tactic}|${s.source}`} className="bg-canvas-deeper/40">
          <td className="pl-10 pr-5 py-1.5">
            <span className="inline-flex items-center gap-2 text-fg-muted">
              <span className="size-1.5 rounded-full" style={{ backgroundColor: dspColor(s.source) }} aria-hidden />
              {dspLabel(s.source)}
            </span>
          </td>
          <td className="px-2.5 py-1.5 text-right text-fg-muted">{fmtMetric("imp", s.metrics.imp)}</td>
          <td className="px-2.5 py-1.5 text-right text-fg-muted">{fmtMetric("cost", s.metrics.cost)}</td>
          {COLS.map(([k]) => (
            <td key={k} className={cn("px-2.5 py-1.5 text-right", metricTone(k, s.metrics) || "text-fg-muted")}>
              {fmtMetric(k, s.metrics[k])}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// Régua só onde ela é inequívoca pra um agregado de lines misturadas:
// viewability e VTR. eCPM e CTR dependem de formato e ABS, que a tática mistura.
function metricTone(k, m) {
  if (k === "viewability" || k === "vtr") return toneFor(k, m[k]);
  return "";
}

function ShareBar({ pct, color }) {
  return (
    <div className="mt-1 flex items-center justify-end gap-1.5">
      <div className="h-1 w-14 rounded-full bg-canvas-deeper overflow-hidden" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(2, pct || 0))}%`, backgroundColor: color }} />
      </div>
      <span className="text-[10.5px] text-fg-subtle w-8 text-right">{fmtPct(pct, 0)}</span>
    </div>
  );
}
