// src/v2/components/TrendChartV2.jsx
//
// Série temporal de UMA métrica, com um eixo Y só. Substitui o padrão de
// eixo duplo (barras de volume + linha de taxa em escalas diferentes), que
// faz o leitor comparar alturas que não têm relação entre si.
//
//   kind="bar"  → volume (imp. visíveis, cliques, views, custo)
//   kind="line" → taxa (CTR, VTR, viewability)
//
// Dois gráficos empilhados com o mesmo `syncId` e o mesmo `yWidth` ficam
// alinhados no tempo e compartilham o crosshair: é assim que as abas
// Display e Vídeo mostram volume e taxa juntos sem misturar escalas.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmt, fmtCompactTick } from "../../shared/format";
import { useChartNeutral, useThemeColors } from "../hooks/useThemeColors";
import { CHART_ANIMATION_MS, seriesSignature, useAnimationWindow } from "../lib/motion";

const WEEKDAY_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function ddmm(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  return m ? `${m[3]}/${m[2]}` : String(ymd ?? "");
}

function ddmmWeekday(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  if (!m) return String(ymd ?? "");
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${m[3]}/${m[2]} ${WEEKDAY_PT[d.getDay()]}`;
}

function TrendTooltip({ active, payload, label, metricLabel, formatValue, color }) {
  if (!active || !payload?.length) return null;
  const v = payload[0]?.value;
  return (
    <div className="rounded-md border border-border-strong bg-canvas-elevated px-3 py-2 text-[11px] shadow-md">
      <div className="font-semibold text-fg-muted mb-1">{ddmmWeekday(label)}</div>
      <div className="flex items-center gap-2 text-fg-muted">
        <span className="size-2 rounded-full" style={{ background: color }} aria-hidden />
        {metricLabel}:{" "}
        <span className="text-fg font-semibold tabular-nums">
          {v == null ? "—" : formatValue(v)}
        </span>
      </div>
    </div>
  );
}

export function TrendChartV2({
  data,
  dataKey,
  label,
  kind = "bar",
  formatValue = (v) => fmt(v),
  formatTick = (v) => fmtCompactTick(v),
  color,
  height = 220,
  syncId,
  showXAxis = true,
  yWidth = 56,
  ariaLabel,
  // Taxa em %: o eixo escolhe as casas decimais pelo intervalo visível (com
  // CTR entre 0,60% e 0,62%, duas casas repetiriam "0,61%" em todo tick).
  percent = false,
  // Atraso da animação (ms). No par volume + taxa, a linha entra um pouco
  // depois das barras.
  animationDelay = 0,
}) {
  const hypr = useThemeColors();
  const neutral = useChartNeutral();
  // Anima na montagem e quando a série muda de verdade (métrica, período,
  // filtro); fica desligada em resize, re-render e export PNG.
  const animate = useAnimationWindow(`${kind}|${seriesSignature(data, dataKey)}`, CHART_ANIMATION_MS + animationDelay + 380);

  if (!Array.isArray(data) || data.length === 0) return null;

  const n = data.length;
  const stroke = color || hypr.chartS1 || hypr.signature;
  // Barras sempre partem do zero. Linha de taxa pode não partir: com CTR
  // entre 0,45% e 0,50%, um eixo de 0 a 0,6% achata a variação numa reta.
  // A folga em volta do intervalo evita exagerar oscilação pequena.
  // O intervalo mínimo (30% da média) evita transformar ruído de 0,005 p.p.
  // numa montanha-russa quando a taxa é quase constante.
  let yDomain = [0, "auto"];
  let tickDecimals = null;
  if (kind === "line") {
    const vals = data.map((d) => d?.[dataKey]).filter((v) => Number.isFinite(v));
    if (vals.length) {
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const span = Math.max(hi - lo, Math.abs(mean) * 0.3, 1e-6);
      const mid = (hi + lo) / 2;
      const d0 = Math.max(0, mid - span * 0.8);
      const d1 = mid + span * 0.8;
      yDomain = [d0, d1];
      const step = (d1 - d0) / 4;
      tickDecimals = step >= 5 ? 0 : step >= 0.5 ? 1 : step >= 0.05 ? 2 : 3;
    }
  }
  const tickFormatter = percent
    ? (v) => `${fmt(v, tickDecimals ?? 1)}%`
    : formatTick;
  const surface = hypr.surface2 || hypr.canvas;
  const Chart = kind === "line" ? LineChart : BarChart;

  const common = {
    data,
    syncId,
    margin: { top: 8, right: 8, left: 0, bottom: 0 },
  };
  const barProps = kind === "bar"
    ? {
        // ≥ 2px de respiro entre barras vizinhas mesmo com 60–90 dias.
        barCategoryGap: n > 40 ? 2 : "22%",
      }
    : {};

  return (
    <figure aria-label={ariaLabel || `Tendência diária: ${label}`} className="m-0">
      <ResponsiveContainer width="100%" height={height}>
        {/* key por métrica: trocar Imp. visíveis → CTR remonta o gráfico e
            ele entra do zero (barras crescendo, linha se desenhando). Troca
            de período na mesma métrica interpola do valor antigo pro novo. */}
        <Chart key={`${kind}:${dataKey}`} {...common} {...barProps}>
          <CartesianGrid vertical={false} stroke={neutral.grid} />
          <XAxis
            dataKey="date"
            hide={!showXAxis}
            tickFormatter={ddmm}
            tick={{ fill: neutral.label, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: neutral.grid }}
            minTickGap={24}
            interval="preserveStartEnd"
          />
          <YAxis
            width={yWidth}
            tickFormatter={tickFormatter}
            tick={{ fill: neutral.label, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            domain={yDomain}
            allowDecimals={kind === "line"}
            tickCount={5}
          />
          <RTooltip
            cursor={
              kind === "line"
                ? { stroke: neutral.axis, strokeWidth: 1 }
                : { fill: hypr.surfaceStrong || "rgba(127,127,127,0.12)" }
            }
            content={
              <TrendTooltip metricLabel={label} formatValue={formatValue} color={stroke} />
            }
          />
          {kind === "line" ? (
            <Line
              type="monotone"
              dataKey={dataKey}
              name={label}
              stroke={stroke}
              strokeWidth={2}
              dot={n <= 14 ? { r: 4, fill: stroke, stroke: surface, strokeWidth: 2 } : false}
              activeDot={{ r: 5, fill: stroke, stroke: surface, strokeWidth: 2 }}
              isAnimationActive={animate}
              animationBegin={animationDelay}
              animationDuration={CHART_ANIMATION_MS}
              animationEasing="ease-out"
            />
          ) : (
            <Bar
              dataKey={dataKey}
              name={label}
              fill={stroke}
              radius={n > 40 ? [2, 2, 0, 0] : [4, 4, 0, 0]}
              maxBarSize={28}
              isAnimationActive={animate}
              animationBegin={animationDelay}
              animationDuration={CHART_ANIMATION_MS}
              animationEasing="ease-out"
            />
          )}
        </Chart>
      </ResponsiveContainer>
    </figure>
  );
}
