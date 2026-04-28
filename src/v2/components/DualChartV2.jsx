// src/v2/components/DualChartV2.jsx
//
// Chart de eixo duplo: Bar (esquerdo, valor absoluto) + Line (direito,
// taxa em %). Mesma estrutura visual do Legacy DualChart (recharts),
// mas com paleta HYPR e tooltip estilizado.
//
// Usado em Visão Geral V2 pra mostrar séries diárias:
//   - Display: Imp. Visíveis (bar) × CTR % (line)
//   - Video:   Views 100%    (bar) × VTR % (line)
//
// Cores
//   - Bar default: signature (--color-signature)
//   - Line default: warning (--color-warning) — contraste forte com bar,
//     destaca a métrica de performance (taxa)

import {
  Bar,
  CartesianGrid,
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { chartNeutral, colors as hypr } from "../../shared/tokens";

const fmtBig = (v) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M`
  : v >= 1_000 ? `${(v / 1_000).toFixed(0)}K`
  : String(v);
const fmtPct = (v) => `${Number(v).toFixed(2)}%`;

export function DualChartV2({
  data,
  xKey,
  y1Key,
  y2Key,
  label1,
  label2,
  color1 = hypr.signature,
  color2 = hypr.warning,
  height = 200,
}) {
  if (!data?.length) return null;

  const isDate = /^\d{4}-\d{2}/.test(String(data[0][xKey]));
  // bar size adaptativa — fica fino em datasets grandes, gordinho em
  // pequenos. Mesma fórmula do Legacy.
  const barSize = Math.min(32, Math.max(8, Math.floor(600 / data.length)));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-3">
        <Legend color={color1} label={label1} />
        <Legend color={color2} label={label2} />
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 64, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chartNeutral.grid} vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={{ fill: chartNeutral.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: chartNeutral.grid }}
            tickFormatter={(v) => (isDate ? String(v).slice(5) : String(v))}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="left"
            tick={{ fill: chartNeutral.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={fmtBig}
            width={52}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fill: chartNeutral.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={fmtPct}
            width={56}
          />
          <RTooltip
            cursor={{ fill: hypr.surfaceStrong }}
            contentStyle={{
              background: hypr.canvasElevated,
              border: `1px solid ${hypr.borderStrong}`,
              borderRadius: 8,
              fontSize: 12,
              color: hypr.fg,
            }}
            labelStyle={{ color: hypr.fgMuted, fontWeight: 600 }}
            itemStyle={{ color: hypr.fg }}
            formatter={(v, name) =>
              name === label2 ? [fmtPct(v), name] : [fmtBig(v), name]
            }
            labelFormatter={(l) => `Data: ${l}`}
          />
          <Bar
            yAxisId="left"
            dataKey={y1Key}
            name={label1}
            fill={color1}
            radius={[3, 3, 0, 0]}
            opacity={0.85}
            isAnimationActive={false}
            barSize={barSize}
          />
          <Line
            yAxisId="right"
            dataKey={y2Key}
            name={label2}
            type="monotone"
            stroke={color2}
            strokeWidth={2}
            dot={{ r: 3, fill: color2 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Legend({ color, label }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] font-semibold"
      style={{ color }}
    >
      <span
        className="size-2 rounded-full"
        style={{ background: color }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
