// src/v2/admin/components/dspAnalytics/DspLinesTable.jsx
//
// Ranking de lines do recorte em quatro leituras: as que mais entregam, as
// de maior custo, as de melhor engajamento (CTR em display, VTR em vídeo,
// como índice da régua verde da mídia) e as com red flag. Clique na line abre
// o report da campanha.

import { useMemo, useState } from "react";
import { cn } from "../../../../ui/cn";
import { dspColor, dspLabel } from "../../../../shared/dspMeta";
import { tacticColor, tacticLabel, chartTacticKey } from "../../../../shared/tacticMeta";
import { FormatBadge } from "./FormatBadge";
import { LINE_TABS, FLAG_DEFS, rankLines, MIN_LINE_IMPS, NO_TOKEN } from "../../lib/dspAnalytics";
import { fmtMetric, fmtMetricFull, fmtPct, toneFor, fmtDay } from "./dspFormat";

const PAGE = 50;
const REASON_LABEL = { fee: "fee DV", cliente: "cliente da lista", override: "marcação manual" };

export function DspLinesTable({ lines, tab, onTabChange, search, onOpenReport, flagFilter, onFlagFilterChange }) {
  const [limit, setLimit] = useState(PAGE);

  const counts = useMemo(() => ({
    flags: lines.filter((l) => l.flags.length > 0).length,
  }), [lines]);

  const rows = useMemo(() => {
    let r = rankLines(lines, tab);
    if (tab === "flags" && flagFilter) r = r.filter((l) => l.flags.includes(flagFilter));
    const q = (search || "").trim().toLowerCase();
    if (q) {
      r = r.filter((l) =>
        l.name.toLowerCase().includes(q) || l.campaign.toLowerCase().includes(q)
        || l.client.toLowerCase().includes(q) || l.io.toLowerCase().includes(q)
        || l.token.toLowerCase().includes(q) || tacticLabel(l.tactic).toLowerCase().includes(q));
    }
    return r;
  }, [lines, tab, flagFilter, search]);

  const flagCounts = useMemo(() => {
    const c = {};
    for (const l of lines) for (const f of l.flags) c[f] = (c[f] || 0) + 1;
    return c;
  }, [lines]);

  const shown = rows.slice(0, limit);

  return (
    <section className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-widest text-signature">Lines</div>
          <p className="mt-0.5 text-[11px] text-fg-subtle">
            Engajamento e red flags só avaliam lines com {fmtMetric("imp", MIN_LINE_IMPS)}+ impressões.
          </p>
        </div>
        <div role="tablist" aria-label="Ranking de lines" className="inline-flex flex-wrap gap-0.5 p-0.5 rounded-lg bg-canvas-deeper border border-border">
          {Object.entries(LINE_TABS).map(([id, def]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => { onTabChange(id); setLimit(PAGE); }}
              className={cn(
                "px-3 h-7 rounded-md text-xs font-medium cursor-pointer transition-colors inline-flex items-center gap-1.5",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                tab === id ? "bg-canvas-elevated text-fg shadow-sm" : "text-fg-muted hover:text-fg hover:bg-surface-strong",
              )}
            >
              {def.label}
              {id === "flags" && counts.flags > 0 && (
                <span className="px-1.5 rounded-full bg-danger-soft text-danger text-[10.5px] font-bold tabular-nums">{counts.flags}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === "flags" && (
        <div className="px-5 py-2.5 border-b border-border flex flex-wrap gap-1.5">
          <FlagPill active={!flagFilter} onClick={() => onFlagFilterChange(null)} label="Todas" count={counts.flags} />
          {Object.entries(FLAG_DEFS).map(([id, def]) => (
            flagCounts[id] ? (
              <FlagPill key={id} active={flagFilter === id} onClick={() => onFlagFilterChange(id)} label={def.label} count={flagCounts[id]} title={def.hint} />
            ) : null
          ))}
        </div>
      )}

      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left text-fg-muted">
              <th className="px-4 py-2 font-semibold min-w-[280px]">Line</th>
              <th className="px-2.5 py-2 font-semibold">Formato</th>
              <th className="px-2.5 py-2 font-semibold text-right">Impressões</th>
              <th className="px-2.5 py-2 font-semibold text-right">Custo</th>
              <th className="px-2.5 py-2 font-semibold text-right">eCPM</th>
              <th className="px-2.5 py-2 font-semibold text-right">vCPM</th>
              <th className="px-2.5 py-2 font-semibold text-right whitespace-nowrap" title="CTR em display, VTR em vídeo">CTR / VTR</th>
              <th className="px-2.5 py-2 font-semibold text-right">Viewability</th>
              <th className="px-2.5 py-2 font-semibold text-right">Mensuração</th>
              <th className="px-2.5 py-2 font-semibold text-right whitespace-nowrap" title="Visíveis ÷ impressões totais">Visív. / Total</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => {
              const video = l.m === "VIDEO";
              const eng = video ? l.vtr : l.ctr;
              const canOpen = l.token !== NO_TOKEN && onOpenReport;
              return (
                <tr key={l.key} className="border-t border-border hover:bg-surface-strong/50 align-top">
                  <td className="px-4 py-2 max-w-[380px]">
                    <div className="flex items-start gap-2 min-w-0">
                      <span className="mt-1 size-2 rounded-full shrink-0" style={{ backgroundColor: dspColor(l.s) }} title={dspLabel(l.s)} aria-hidden />
                      <div className="min-w-0">
                        {canOpen ? (
                          <button
                            type="button"
                            onClick={() => onOpenReport(l.token)}
                            className="block max-w-full text-left font-semibold text-fg truncate hover:underline cursor-pointer bg-transparent border-0 p-0"
                            title={`${l.name}\nAbrir report ${l.token}`}
                          >
                            {l.name}
                          </button>
                        ) : (
                          <div className="font-semibold text-fg truncate" title={l.name}>{l.name}</div>
                        )}
                        <div className="text-[11px] text-fg-subtle truncate" title={`${l.client} · ${l.campaign} · IO ${l.io}`}>
                          {dspLabel(l.s)} · {l.client} · {l.campaign}{l.io ? ` · ${l.io}` : ""}
                        </div>
                        <div className="text-[10.5px] text-fg-subtle/80 flex items-center gap-1.5 flex-wrap">
                          <span className="inline-flex items-center gap-1 text-fg-muted">
                            <span className="size-1.5 rounded-full" style={{ backgroundColor: tacticColor(chartTacticKey(l.tactic)) }} aria-hidden />
                            {tacticLabel(l.tactic)}
                          </span>
                          <span>· {fmtDay(l.first)} → {fmtDay(l.last)}</span>
                        </div>
                        {l.flags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {l.flags.map((f) => (
                              <span key={f} className="px-1.5 py-px rounded bg-danger-soft text-danger text-[10.5px] font-semibold whitespace-nowrap" title={FLAG_DEFS[f].hint}>
                                {FLAG_DEFS[f].label}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-2.5 py-2 whitespace-nowrap">
                    <div className="flex flex-col items-start gap-1">
                      <FormatBadge media={l.m} size="sm" />
                      <div className="flex items-center gap-1">
                        {l.abs && (
                          <span className="px-1.5 py-px rounded bg-signature-soft text-signature text-[10px] font-bold" title={`ABS por ${REASON_LABEL[l.reason] || l.reason}`}>ABS</span>
                        )}
                        {l.sv && <span className="text-[10px] text-fg-subtle">survey</span>}
                      </div>
                    </div>
                  </td>
                  <td className="px-2.5 py-2 text-right text-fg" title={fmtMetricFull("imp", l.imp)}>{fmtMetric("imp", l.imp)}</td>
                  <td className="px-2.5 py-2 text-right text-fg" title={fmtMetricFull("cost", l.cost)}>{fmtMetric("cost", l.cost)}</td>
                  <td className={cn("px-2.5 py-2 text-right", toneFor("ecpm", l.ecpm, { media: l.m, abs: l.abs }) || "text-fg")}>{fmtMetric("ecpm", l.ecpm)}</td>
                  <td className="px-2.5 py-2 text-right text-fg">{fmtMetric("vcpm", l.vcpm)}</td>
                  <td className={cn("px-2.5 py-2 text-right", toneFor(video ? "vtr" : "ctr", eng, { media: l.m, abs: l.abs }) || "text-fg")}>
                    {video ? fmtMetric("vtr", eng) : fmtMetric("ctr", eng)}
                  </td>
                  <td className={cn("px-2.5 py-2 text-right", toneFor("viewability", l.viewability) || "text-fg")}>{fmtPct(l.viewability, 1)}</td>
                  <td className={cn("px-2.5 py-2 text-right", toneFor("measRate", l.measRate) || "text-fg")}>{fmtPct(l.measRate, 0)}</td>
                  <td className="px-2.5 py-2 text-right text-fg">{fmtPct(l.viewShare, 1)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-6 text-center text-fg-subtle">Nenhuma line no recorte.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && (
        <div className="px-5 py-3 border-t border-border flex items-center justify-between text-xs text-fg-muted">
          <span>{shown.length} de {rows.length} lines</span>
          <button type="button" onClick={() => setLimit((n) => n + PAGE)} className="font-semibold text-signature hover:underline cursor-pointer bg-transparent border-0 p-0">
            Mostrar mais {Math.min(PAGE, rows.length - shown.length)}
          </button>
        </div>
      )}
    </section>
  );
}

function FlagPill({ active, onClick, label, count, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full border text-xs cursor-pointer transition-colors",
        active ? "border-signature bg-signature-soft text-fg" : "border-border text-fg-muted hover:text-fg hover:border-border-strong",
      )}
    >
      {label}
      <span className="tabular-nums text-fg-subtle">{count}</span>
    </button>
  );
}
