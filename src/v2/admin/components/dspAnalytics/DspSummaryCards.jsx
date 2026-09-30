// src/v2/admin/components/dspAnalytics/DspSummaryCards.jsx
//
// Blocos de leitura do Analytics › Saúde das DSPs que não são gráfico nem
// tabela de lines: KPIs do recorte, card por DSP, custo do ABS, matriz
// formato × DSP e qualidade do dado. Todos recebem números já agregados de
// lib/dspAnalytics.js — aqui só se desenha.

import { cn } from "../../../../ui/cn";
import { SparklineV2 } from "../../../components/SparklineV2";
import { dspColor, dspLabel } from "../../../../shared/dspMeta";
import { METRICS, delta, FLAG_DEFS } from "../../lib/dspAnalytics";
import {
  fmtMetric, fmtMetricFull, fmtDelta, fmtMoney, fmtPct, fmtCompact, toneFor, fmtDay,
} from "./dspFormat";

// ─── Variação ────────────────────────────────────────────────────────────
// Seta + texto carregam a direção; a cor só diz se é bom ou ruim, e métrica
// de volume (better = null) fica neutra: mais impressão não é "bom" por si.
export function DeltaBadge({ metricKey, cur, prev, disabled }) {
  if (disabled) return <span className="text-[11px] text-fg-subtle">—</span>;
  const d = fmtDelta(delta(cur, prev, metricKey));
  if (!d) {
    return <span className="text-[11px] text-fg-subtle" title="Sem dado no período anterior">sem histórico</span>;
  }
  const better = METRICS[metricKey]?.better;
  const good = d.dir === "flat" || !better ? null : (d.dir === "up") === (better === "up");
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums",
        good == null ? "text-fg-muted" : good ? "text-success" : "text-danger",
      )}
    >
      <span aria-hidden="true">{d.dir === "up" ? "▲" : d.dir === "down" ? "▼" : "▬"}</span>
      <span className="sr-only">{d.dir === "up" ? "subiu" : d.dir === "down" ? "caiu" : "estável"}</span>
      {d.text}
    </span>
  );
}

// ─── KPIs do recorte ─────────────────────────────────────────────────────
const KPI_KEYS = ["imp", "meas", "view", "clk", "cost", "ctr", "vtr", "viewability", "ecpm", "vcpm"];
const KPI_HINT = {
  meas: "Impressões que a DSP conseguiu medir",
  view: "Impressões visíveis (padrão MRC)",
  ctr: "Cliques ÷ impressões visíveis (padrão HYPR)",
  vtr: "Completions visíveis ÷ impressões visíveis de vídeo",
  viewability: "Visíveis ÷ mensuráveis",
  ecpm: "Custo total da DSP ÷ impressões × 1000",
  vcpm: "Custo total da DSP ÷ visíveis × 1000. Compara DSPs com mensuração diferente",
  cost: "Custo cobrado pela DSP com todas as fees, em BRL",
};

export function KpiGrid({ totals, prev, noDelta }) {
  return (
    <section aria-label="Totais do recorte" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-px rounded-xl border border-border bg-border overflow-hidden">
      {KPI_KEYS.map((k) => (
        <div key={k} className="bg-surface px-4 py-3.5 min-w-0">
          <div className="text-[11px] text-fg-muted truncate" title={KPI_HINT[k]}>{METRICS[k].label}</div>
          <div className="mt-0.5 text-xl font-extrabold tabular-nums text-fg truncate" title={fmtMetricFull(k, totals[k])}>
            {fmtMetric(k, totals[k])}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 min-w-0">
            <DeltaBadge metricKey={k} cur={totals} prev={prev} disabled={noDelta} />
            {k === "viewability" && totals.measRate != null && (
              <span className={cn("text-[10.5px] tabular-nums truncate", toneFor("measRate", totals.measRate) || "text-fg-subtle")} title="Taxa de mensuração">
                · {fmtPct(totals.measRate, 0)} mensurado
              </span>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

// ─── Card por DSP ────────────────────────────────────────────────────────
function freshnessOf(freshness, source) {
  const f = freshness.find((x) => x.source === source);
  if (!f || f.daysBehind == null) return null;
  const tone = f.daysBehind <= 0 ? "text-success" : f.daysBehind <= 2 ? "text-warning" : "text-danger";
  return { ...f, tone };
}

export function DspScorecards({ cards, spark, freshness, selected, onToggleSource }) {
  if (!cards.length) return null;
  return (
    <section aria-label="Por DSP" className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
      {cards.map(({ source, metrics: m, shareImp, shareCost }) => {
        const fr = freshnessOf(freshness, source);
        const isSel = selected.includes(source);
        const hasVideo = m.vview > 0;
        return (
          <article
            key={source}
            className={cn(
              "rounded-xl border bg-surface p-4 space-y-3 min-w-0 transition-colors",
              isSel ? "border-signature" : "border-border",
            )}
          >
            <header className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => onToggleSource(source)}
                className="flex items-center gap-2 min-w-0 cursor-pointer bg-transparent border-0 p-0 text-left"
                title={isSel ? "Tirar do filtro" : `Filtrar só ${dspLabel(source)}`}
              >
                <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: dspColor(source) }} aria-hidden />
                <span className="font-bold text-fg truncate">{dspLabel(source)}</span>
              </button>
              {fr && (
                <span className={cn("text-[10.5px] font-mono tabular-nums", fr.tone)} title="Último dia com dado aterrissado">
                  dado até {fmtDay(fr.maxDate)}
                </span>
              )}
            </header>

            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10.5px] uppercase tracking-wider text-fg-subtle">Custo</div>
                <div className="text-lg font-extrabold tabular-nums text-fg" title={fmtMetricFull("cost", m.cost)}>
                  {fmtMetric("cost", m.cost)}
                </div>
              </div>
              <div className="text-right text-[11px] tabular-nums text-fg-muted leading-tight">
                <div><span className="font-semibold text-fg">{fmtPct(shareCost, 0)}</span> do custo</div>
                <div><span className="font-semibold text-fg">{fmtPct(shareImp, 0)}</span> das imps</div>
              </div>
            </div>

            <div className="h-1.5 rounded-full bg-canvas-deeper overflow-hidden" aria-hidden>
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, shareCost || 0)}%`, backgroundColor: dspColor(source) }} />
            </div>

            <SparklineV2
              values={spark[source] || []}
              stroke={dspColor(source)}
              fillOpacity={0.15}
              minValue={0}
              width={260}
              height={30}
              className="w-full"
              ariaLabel={`Impressões por dia · ${dspLabel(source)}`}
            />

            <dl className="grid grid-cols-3 gap-x-2 gap-y-2 text-[11px]">
              <Stat label="Impressões" value={fmtMetric("imp", m.imp)} title={fmtMetricFull("imp", m.imp)} />
              <Stat label="eCPM" value={fmtMetric("ecpm", m.ecpm)} />
              <Stat label="vCPM" value={fmtMetric("vcpm", m.vcpm)} />
              <Stat label="CTR" value={fmtMetric("ctr", m.ctr)} />
              <Stat label="Viewability" value={fmtMetric("viewability", m.viewability)} tone={toneFor("viewability", m.viewability)} />
              <Stat label="Mensuração" value={fmtMetric("measRate", m.measRate)} tone={toneFor("measRate", m.measRate)} />
              {hasVideo && <Stat label="VTR" value={fmtMetric("vtr", m.vtr)} tone={toneFor("vtr", m.vtr)} />}
              {hasVideo && <Stat label="CPCV" value={fmtMetric("cpcv", m.cpcv)} />}
              {m.fee > 0 && <Stat label="Fee DV (CPM)" value={fmtMoney(m.feeCpm)} title={`Fee pré-bid DV no período: ${fmtMoney(m.fee)}`} />}
            </dl>
          </article>
        );
      })}
    </section>
  );
}

function Stat({ label, value, tone, title }) {
  return (
    <div className="min-w-0">
      <dt className="text-fg-subtle truncate">{label}</dt>
      <dd className={cn("font-semibold tabular-nums truncate", tone || "text-fg")} title={title}>{value}</dd>
    </div>
  );
}

// ─── Custo do ABS ────────────────────────────────────────────────────────
export function AbsCostCard({ rows, absClients }) {
  const shown = rows.filter((r) => r.withAbs || r.without);
  const headline = shown.find((r) => r.source === "DV360" && r.media === "DISPLAY" && r.ecpmDelta != null)
    || shown.find((r) => r.ecpmDelta != null);
  return (
    <section className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-border">
        <div className="text-[11px] font-bold uppercase tracking-widest text-signature">Custo do ABS</div>
        <p className="mt-1 text-sm text-fg">
          {headline ? (
            <>
              No recorte, {dspLabel(headline.source)} {headline.media === "VIDEO" ? "vídeo" : "display"} com ABS sai{" "}
              <span className="font-bold tabular-nums">{fmtMoney(Math.abs(headline.ecpmDelta))}</span>{" "}
              {headline.ecpmDelta >= 0 ? "mais caro" : "mais barato"} por mil impressões.
            </>
          ) : (
            "Sem as duas bases (com e sem ABS) no recorte para comparar."
          )}
        </p>
        <p className="mt-1 text-[11px] text-fg-subtle leading-snug">
          ABS por line: fee pré-bid da DV no DV360, depois a lista de clientes com ABS
          ({absClients.join(", ")}), depois a marcação manual no drawer. Este bloco ignora o filtro de ABS.
        </p>
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left text-fg-muted">
              <th className="px-4 py-2 font-semibold">DSP · formato</th>
              <th className="px-3 py-2 font-semibold text-right">eCPM sem ABS</th>
              <th className="px-3 py-2 font-semibold text-right">eCPM com ABS</th>
              <th className="px-3 py-2 font-semibold text-right">Diferença</th>
              <th className="px-3 py-2 font-semibold text-right" title="Fee pré-bid da DV por mil impressões (só DV360 traz a fee no dado)">Fee DV / mil</th>
              <th className="px-3 py-2 font-semibold text-right">Imps com ABS</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const absImp = r.withAbs?.imp || 0;
              const tot = absImp + (r.without?.imp || 0);
              return (
                <tr key={`${r.source}|${r.media}`} className="border-t border-border">
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ backgroundColor: dspColor(r.source) }} aria-hidden />
                      <span className="font-semibold text-fg">{dspLabel(r.source)}</span>
                      <span className="text-fg-subtle">{r.media === "VIDEO" ? "Vídeo" : "Display"}</span>
                    </span>
                  </td>
                  <td className={cn("px-3 py-2 text-right", toneFor("ecpm", r.without?.ecpm, { media: r.media, abs: false }))}>
                    {fmtMoney(r.without?.ecpm)}
                  </td>
                  <td className={cn("px-3 py-2 text-right", toneFor("ecpm", r.withAbs?.ecpm, { media: r.media, abs: true }))}>
                    {fmtMoney(r.withAbs?.ecpm)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-fg">
                    {r.ecpmDelta == null ? "—" : `${r.ecpmDelta >= 0 ? "+" : "−"}${fmtMoney(Math.abs(r.ecpmDelta))}`}
                  </td>
                  <td className="px-3 py-2 text-right text-fg-muted">
                    {r.withAbs?.fee > 0 ? fmtMoney(r.withAbs.feeCpm) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-fg-muted whitespace-nowrap">
                    {tot ? `${fmtCompact(absImp)} · ${fmtPct((absImp / tot) * 100, 0)}` : "—"}
                  </td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-fg-subtle">Nada no recorte.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Formato × DSP ───────────────────────────────────────────────────────
const DISPLAY_COLS = [["imp", "Imps"], ["ecpm", "eCPM"], ["vcpm", "vCPM"], ["ctr", "CTR"], ["viewability", "Viewab."]];
const VIDEO_COLS = [["imp", "Imps"], ["ecpm", "eCPM"], ["cpcv", "CPCV"], ["vtr", "VTR"], ["viewability", "Viewab."]];

export function FormatMatrix({ rows, absMode }) {
  const abs = absMode === "abs";
  return (
    <section className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-5 py-3 border-b border-border">
        <div className="text-[11px] font-bold uppercase tracking-widest text-signature">Formato × DSP</div>
        <p className="mt-0.5 text-[11px] text-fg-subtle">Cores pela régua do admin{abs ? " (régua de ABS)" : ""}.</p>
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-fg-muted">
              <th rowSpan={2} className="px-4 py-2 font-semibold text-left align-bottom">DSP</th>
              <th colSpan={DISPLAY_COLS.length} className="px-3 pt-2 font-semibold text-center border-l border-border">Display</th>
              <th colSpan={VIDEO_COLS.length} className="px-3 pt-2 font-semibold text-center border-l border-border">Vídeo</th>
            </tr>
            <tr className="text-fg-subtle">
              {DISPLAY_COLS.map(([k, l], i) => (
                <th key={`d${k}`} className={cn("px-3 pb-2 font-medium text-right", i === 0 && "border-l border-border")}>{l}</th>
              ))}
              {VIDEO_COLS.map(([k, l], i) => (
                <th key={`v${k}`} className={cn("px-3 pb-2 font-medium text-right", i === 0 && "border-l border-border")}>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.source} className="border-t border-border">
                <td className="px-4 py-2 whitespace-nowrap">
                  <span className="inline-flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ backgroundColor: dspColor(r.source) }} aria-hidden />
                    <span className="font-semibold text-fg">{dspLabel(r.source)}</span>
                  </span>
                </td>
                {DISPLAY_COLS.map(([k], i) => (
                  <td key={`d${k}`} className={cn("px-3 py-2 text-right", i === 0 && "border-l border-border", toneFor(k, r.DISPLAY?.[k], { media: "DISPLAY", abs }) || "text-fg")}>
                    {r.DISPLAY ? fmtMetric(k, r.DISPLAY[k]) : "·"}
                  </td>
                ))}
                {VIDEO_COLS.map(([k], i) => (
                  <td key={`v${k}`} className={cn("px-3 py-2 text-right", i === 0 && "border-l border-border", toneFor(k, r.VIDEO?.[k], { media: "VIDEO", abs }) || "text-fg")}>
                    {r.VIDEO ? fmtMetric(k, r.VIDEO[k]) : "·"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Qualidade do dado ───────────────────────────────────────────────────
export function DataQualityCard({ quality, onShowFlag }) {
  const items = [];
  for (const lm of quality.lowMeasurement) {
    items.push({
      tone: "warning",
      title: `${dspLabel(lm.source)} mediu só ${fmtPct(lm.measRate, 0)} das impressões`,
      body: "CTR e VTR sobre visíveis ficam inflados nessa DSP. Para comparar custo entre DSPs, use o vCPM.",
    });
  }
  if (quality.divergent.count) {
    items.push({
      tone: "danger",
      title: `${quality.divergent.count} line${quality.divergent.count > 1 ? "s" : ""} NO-ABS pagando fee da DV (${fmtMoney(quality.divergent.fee)})`,
      body: "Ou o nome da line está errado ou o ABS foi ligado sem querer. Contam como ABS no custo.",
      action: { label: "Ver lines", onClick: () => onShowFlag("abs_divergent") },
    });
  }
  if (quality.nameVsList.count) {
    items.push({
      tone: "info",
      title: `${quality.nameVsList.count} line${quality.nameVsList.count > 1 ? "s" : ""} nomeada${quality.nameVsList.count > 1 ? "s" : ""} NO-ABS de cliente da lista de ABS`,
      body: "A lista de clientes vence o nome da line. Vale conferir se essas lines rodam mesmo com ABS.",
    });
  }
  if (quality.unattributed.imp > 0) {
    items.push({
      tone: "info",
      title: `${fmtCompact(quality.unattributed.imp)} impressões sem campanha (${fmtMoney(quality.unattributed.cost)}, ${fmtPct(quality.unattributed.shareCost, 1)} do custo)`,
      body: "Line fora da nomenclatura, sem short_token. Entra no total por DSP e sai quando você filtra campanha.",
    });
  }
  for (const f of quality.freshness) {
    if (f.daysBehind != null && f.daysBehind > 1) {
      items.push({
        tone: f.daysBehind > 3 ? "danger" : "warning",
        title: `${dspLabel(f.source)} com dado até ${fmtDay(f.maxDate)}`,
        body: `${f.daysBehind} dias atrás do fim do período. Os últimos dias dessa DSP podem estar incompletos.`,
      });
    }
  }
  const TONE = {
    danger: "bg-danger", warning: "bg-warning", info: "bg-fg-subtle",
  };
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="text-[11px] font-bold uppercase tracking-widest text-signature mb-3">Qualidade do dado</div>
      {items.length === 0 ? (
        <p className="text-sm text-fg-muted">Nada a apontar no recorte.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((it, i) => (
            <li key={i} className="flex gap-3">
              <span className={cn("mt-1.5 size-2 rounded-full shrink-0", TONE[it.tone])} aria-hidden />
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-fg">{it.title}</div>
                <div className="text-xs text-fg-muted mt-0.5">{it.body}</div>
                {it.action && (
                  <button type="button" onClick={it.action.onClick} className="mt-1 text-xs font-semibold text-signature hover:underline cursor-pointer bg-transparent border-0 p-0">
                    {it.action.label} →
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 pt-3 border-t border-border text-[11px] text-fg-subtle leading-snug">
        Custo = o que a DSP cobrou com todas as fees, em BRL (DV360: Total Media Cost; Yahoo: Advertiser Spending).
        Sem ajuste de entrega fora do BR. {FLAG_DEFS.meas_low.hint}.
      </p>
    </section>
  );
}
