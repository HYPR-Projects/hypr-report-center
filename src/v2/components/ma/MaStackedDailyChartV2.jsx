// src/v2/components/ma/MaStackedDailyChartV2.jsx
//
// Sessões engajadas por dia, empilhadas por formato. Um eixo, cores da
// paleta categórica na ordem fixa dos formatos (formatColorSlots), legenda
// sempre presente com 2+ formatos e tooltip com o valor de cada formato.

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmt, fmtCompactTick } from "../../../shared/format";
import { formatLabel } from "../../../shared/maMetrics";
import { resolveChartVar } from "./maFormat";
import { useChartNeutral, useThemeColors } from "../../hooks/useThemeColors";

const WEEKDAY_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const ddmm = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  return m ? `${m[3]}/${m[2]}` : String(ymd ?? "");
};
const ddmmWd = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  if (!m) return String(ymd ?? "");
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${m[3]}/${m[2]} ${WEEKDAY_PT[d.getDay()]}`;
};

function StackTooltip({ active, payload, label, colorFor }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (Number(p.value) || 0), 0);
  return (
    <div className="rounded-md border border-border-strong bg-canvas-elevated px-3 py-2 text-[11px] shadow-md">
      <div className="font-semibold text-fg-muted mb-1">{ddmmWd(label)}</div>
      {[...payload].reverse().map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-fg-muted">
          <span className="size-2 rounded-full" style={{ background: colorFor(p.dataKey) }} aria-hidden />
          {formatLabel(p.dataKey)}:
          <span className="ml-auto pl-3 text-fg font-semibold tabular-nums">{fmt(p.value)}</span>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="mt-1 pt-1 border-t border-border flex text-fg-muted">
          Total<span className="ml-auto pl-3 text-fg font-semibold tabular-nums">{fmt(total)}</span>
        </div>
      )}
    </div>
  );
}

export function MaStackedDailyChartV2({ rows, formats, colors, height = 210 }) {
  const neutral = useChartNeutral();
  const hypr = useThemeColors();
  if (!rows?.length || !formats?.length) return null;
  // Recharts precisa da cor resolvida (var() não entra no fill do SVG em
  // todos os navegadores): traduz var(--color-chart-sN) pelo tema atual.
  const colorFor = (f) => {
    const c = colors[f] || "var(--color-fg-subtle)"; // "outros" e formato sem vaga
    return resolveChartVar(c, hypr) || c;
  };
  const n = rows.length;
  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={n > 40 ? 2 : "22%"}>
          <CartesianGrid vertical={false} stroke={neutral.grid} />
          <XAxis
            dataKey="date"
            tickFormatter={ddmm}
            tick={{ fill: neutral.label, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: neutral.grid }}
            minTickGap={24}
            interval="preserveStartEnd"
          />
          <YAxis
            width={48}
            tickFormatter={fmtCompactTick}
            tick={{ fill: neutral.label, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <RTooltip cursor={{ fill: hypr.surfaceStrong || "rgba(127,127,127,.12)" }} content={<StackTooltip colorFor={colorFor} />} />
          {formats.map((f, i) => (
            <Bar
              key={f}
              dataKey={f}
              stackId="fmt"
              fill={colorFor(f)}
              stroke={hypr.surface2 || "transparent"}
              strokeWidth={formats.length > 1 ? 1 : 0}
              radius={i === formats.length - 1 ? (n > 40 ? [2, 2, 0, 0] : [4, 4, 0, 0]) : 0}
              maxBarSize={28}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      {formats.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {formats.map((f) => (
            <span key={f} className="inline-flex items-center gap-1.5 text-[11px] text-fg-muted">
              <span className="size-2 rounded-full" style={{ background: colorFor(f) }} aria-hidden />
              {formatLabel(f)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
