// src/v2/admin/components/dspAnalytics/DspEvolutionChart.jsx
//
// Evolução de uma métrica no tempo, uma linha por DSP (ou o total). Um eixo
// só: trocar a métrica troca o gráfico inteiro, nunca sobrepõe duas escalas.
//
// Identidade da DSP não depende só da cor (DV360 e Yahoo ficam próximos pra
// protanopia): cada DSP tem traço próprio (DSP_DASH), legenda e rótulo direto
// no último ponto.

import { useMemo } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { ChartCardV2 } from "../../../components/ChartCardV2";
import { useChartNeutral, useThemeColors } from "../../../hooks/useThemeColors";
import { useUniformTicks } from "../../../hooks/useUniformTicks";
import { dspColor, dspLabel, dspDash } from "../../../../shared/dspMeta";
import { METRICS } from "../../lib/dspAnalytics";
import { cn } from "../../../../ui/cn";
import { fmtMetric, fmtMetricFull, bucketLabel, bucketLabelLong, CHART_METRICS } from "./dspFormat";

const TOTAL_KEY = "__total__";

function Pills({ label, options, value, onChange }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-0.5 p-0.5 rounded-lg bg-canvas-deeper border border-border">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "px-2.5 h-7 rounded-md text-xs font-medium cursor-pointer transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
            value === o.value ? "bg-canvas-elevated text-fg shadow-sm" : "text-fg-muted hover:text-fg hover:bg-surface-strong",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function DspEvolutionChart({
  buckets, sources, metric, onMetricChange, granularity, onGranularityChange,
  mode, onModeChange, filename, lineScoped,
}) {
  const neutral = useChartNeutral();
  const colors = useThemeColors();
  const keys = useMemo(() => (mode === "total" ? [TOTAL_KEY] : sources), [mode, sources]);

  const bucketsByKey = useMemo(() => new Map(buckets.map((b) => [b.key, b])), [buckets]);

  const data = useMemo(() => buckets.map((b) => {
    const row = {
      key: b.key, partial: b.partial, days: b.days,
      label: `${bucketLabel(b.key, granularity)}${b.partial ? "*" : ""}`,
    };
    if (mode === "total") row[TOTAL_KEY] = b.total?.[metric] ?? null;
    else for (const s of sources) row[s] = b.bySource[s]?.[metric] ?? null;
    return row;
  }), [buckets, sources, metric, mode, granularity]);

  // Reservado: YAxis 64 + margens + rótulo direto à direita (~76px).
  const [chartRef, xTicks] = useUniformTicks(data.map((r) => r.label), {
    reservedPx: 64 + 8 + 76,
    slotPx: granularity === "month" ? 60 : 60,
  });

  const lastIdx = data.length - 1;
  const hasPartial = data.some((r) => r.partial);
  const isVolume = METRICS[metric].kind !== "rate" && !["ecpm", "vcpm", "cpcv"].includes(metric);

  // Rótulo direto só onde cabe: séries que terminam coladas (ex.: DSPs
  // pequenas perto do zero) ficam só na legenda, em vez de empilhar texto.
  const labeled = useMemo(() => {
    const last = data[lastIdx] || {};
    const max = Math.max(0, ...data.flatMap((r) => keys.map((k) => r[k] ?? 0)));
    const gap = max * 0.07;
    const kept = [];
    for (const k of [...keys].sort((a, b) => (last[b] ?? -1) - (last[a] ?? -1))) {
      const v = last[k];
      if (v == null) continue;
      if (kept.every((x) => Math.abs(x.v - v) > gap)) kept.push({ k, v });
    }
    return new Set(kept.map((x) => x.k));
  }, [data, keys, lastIdx]);

  const endLabel = (key) => function EndLabel({ x, y, index, value }) {
    if (index !== lastIdx || value == null || !labeled.has(key)) return null;
    return (
      <text x={x + 6} y={y} dy={4} fontSize={11} fontWeight={600} fill={neutral.label}>
        {key === TOTAL_KEY ? "Total" : dspLabel(key)}
      </text>
    );
  };

  const SHORT = { measRate: "Mensuração", viewShare: "Visíveis/Total" };
  const metricOptions = CHART_METRICS.map((k) => ({ value: k, label: SHORT[k] || METRICS[k].label }));

  return (
    <ChartCardV2
      title={`Evolução · ${METRICS[metric].label}`}
      downloadable
      filename={filename}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Pills label="Visão" value={mode} onChange={onModeChange}
            options={[{ value: "source", label: "Por DSP" }, { value: "total", label: "Total" }]} />
          <Pills label="Granularidade" value={granularity} onChange={onGranularityChange}
            options={[{ value: "day", label: "Dia" }, { value: "week", label: "Semana" }, { value: "month", label: "Mês" }]} />
        </div>
      }
    >
      <div className="mb-3 overflow-x-auto scrollbar-thin">
        <Pills label="Métrica" value={metric} onChange={onMetricChange} options={metricOptions} />
      </div>
      {lineScoped && (
        <p className="mb-2 text-[11px] text-fg-subtle">Série das lines selecionadas no filtro.</p>
      )}
      <div ref={chartRef} className="h-[320px]">
        {data.length === 0 ? (
          <div className="h-full grid place-items-center text-sm text-fg-subtle">Sem entrega no recorte.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 76, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={neutral.grid} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: neutral.axis }}
                tickLine={false}
                axisLine={false}
                ticks={xTicks}
                interval={0}
              />
              <YAxis
                tick={{ fontSize: 11, fill: neutral.axis }}
                tickLine={false}
                axisLine={false}
                width={64}
                tickFormatter={(v) => fmtMetric(metric, v)}
                domain={[0, "auto"]}
              />
              <Tooltip
                cursor={{ stroke: neutral.grid, strokeWidth: 1 }}
                content={<EvolutionTooltip metric={metric} granularity={granularity} bucketsByKey={bucketsByKey} />}
              />
              {keys.length > 1 && (
                <Legend
                  iconType="plainline"
                  formatter={(v) => <span style={{ color: neutral.label, fontSize: 12 }}>{dspLabel(v)}</span>}
                />
              )}
              {keys.map((k) => (
                <Line
                  key={k}
                  type="monotone"
                  dataKey={k}
                  name={k}
                  stroke={k === TOTAL_KEY ? (colors.signature || "#3397B9") : dspColor(k)}
                  strokeDasharray={k === TOTAL_KEY ? undefined : dspDash(k)}
                  strokeWidth={2}
                  dot={data.length <= 14 ? { r: 3, strokeWidth: 0, fill: k === TOTAL_KEY ? (colors.signature || "#3397B9") : dspColor(k) } : false}
                  activeDot={{ r: 5, strokeWidth: 2, stroke: colors.surface || "#1a1a1a" }}
                  connectNulls
                  isAnimationActive={false}
                  label={endLabel(k)}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      {hasPartial && (
        <p className="mt-2 text-[11px] text-fg-subtle">
          * {granularity === "week" ? "Semana" : "Mês"} cortado pelo período
          {isVolume ? ": o volume desse ponto soma menos dias que os vizinhos." : "."}
        </p>
      )}
    </ChartCardV2>
  );
}

// Tooltip do ponto: valor por DSP e, embaixo, as campanhas que mais pesaram
// no bucket (por custo quando a métrica é de custo, por impressão no resto).
// É o que responde "o que foi esse pico?" sem sair do gráfico.
function EvolutionTooltip({ active, payload, metric, granularity, bucketsByKey }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row?.key) return null;
  const bucket = bucketsByKey.get(row.key);
  const byCost = ["cost", "ecpm", "vcpm", "cpcv"].includes(metric);
  const top = (byCost ? bucket?.topByCost : bucket?.topByImp) || [];
  const title = bucketLabelLong(row.key, granularity);
  const items = [...payload].filter((p) => p.value != null).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return (
    <div className="rounded-lg border border-border bg-canvas-elevated px-3 py-2.5 text-xs shadow-lg max-w-[320px]">
      <div className="text-fg-muted mb-1.5">
        {title}
        {row.partial && <span className="text-fg-subtle"> · parcial, {row.days} dia{row.days > 1 ? "s" : ""}</span>}
      </div>
      <ul className="space-y-0.5">
        {items.map((p) => (
          <li key={p.dataKey} className="flex items-center justify-between gap-4">
            <span className="inline-flex items-center gap-1.5 text-fg-muted">
              <span className="size-2 rounded-full" style={{ backgroundColor: p.color }} aria-hidden />
              {p.dataKey === TOTAL_KEY ? "Total" : dspLabel(p.dataKey)}
            </span>
            <span className="font-semibold tabular-nums text-fg">{fmtMetricFull(metric, p.value)}</span>
          </li>
        ))}
      </ul>
      {top.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border">
          <div className="text-[10.5px] uppercase tracking-wider text-fg-subtle mb-1">
            Maior {byCost ? "custo" : "volume"} no ponto
          </div>
          <ul className="space-y-0.5">
            {top.map((t) => (
              <li key={`${t.token}|${t.s}`} className="flex items-baseline justify-between gap-3">
                <span className="truncate text-fg-muted" title={`${t.client} · ${t.campaign}`}>
                  <span className="text-fg">{t.client}</span> · {dspLabel(t.s)}
                </span>
                <span className="tabular-nums text-fg shrink-0">
                  {byCost ? fmtMetric("cost", t.cost) : fmtMetric("imp", t.imp)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
