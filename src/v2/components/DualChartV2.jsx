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
//   - Bar default: --color-chart-bar (token dedicado, troca por tema)
//   - Line default: --color-chart-line (token dedicado, troca por tema)
//   Tokens dedicados (em vez de signature/warning) permitem que light
//   e dark invertam quem é bar e quem é line sem mexer no resto da UI.
//
// Espaçamentos (PR-16 audit visual)
//   - margin.right: 8 (não 64 — YAxis right tem width próprio que já
//     reserva o espaço dos labels de %)
//   - margin.left: 0 (YAxis left width=52 cobre tudo)
//   - margin.top: 8 + YAxis padding-top: 8 → maior bar/ponto não cola no topo
//   - XAxis padding.left/right: 16 → primeira e última barra com respiro
//     dos eixos Y (antes ficavam coladas nas pontas)
//   - XAxis minTickGap: 24 → evita sobreposição de labels de data em telas
//     estreitas

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
import { useThemeColors, useChartNeutral } from "../hooks/useThemeColors";
import { useIsMobile } from "../hooks/useIsMobile";

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
  color1,
  color2,
  height = 200,
}) {
  const hypr = useThemeColors();
  const chartNeutral = useChartNeutral();
  const isMobile = useIsMobile();

  // Cores default vêm do tema (re-resolvidas quando tema muda). Se
  // caller passou color1/color2 explícito, respeita override.
  const barColor = color1 || hypr.chartBar || hypr.signature;
  const lineColor = color2 || hypr.chartLine || hypr.warning;

  if (!data?.length) return null;

  const isDate = /^\d{4}-\d{2}/.test(String(data[0][xKey]));
  const n = data.length;

  // Largura útil de referência pra calcular bar/pad. Mobile (<768px) reserva
  // ~360px depois dos Y-axis estreitos; desktop ~600px. Fórmula antiga usava
  // 600 fixo → barras ficavam descalibradas em telas estreitas.
  const refWidth = isMobile ? 360 : 600;
  const barSize = Math.min(isMobile ? 20 : 32, Math.max(6, Math.floor(refWidth / n)));
  // Padding lateral adaptativo — datasets curtos precisam respirar pras
  // barras não colarem no eixo Y. Em mobile o teto cai pra liberar área útil.
  const xPad = Math.max(isMobile ? 12 : 24, Math.min(isMobile ? 32 : 64, Math.floor(refWidth / n)));
  // Dots da linha: > 14 pontos viram um blob denso que parece "linha sólida".
  // Esconde os dots nesse regime — a Line continua visível e o tooltip
  // mostra valor exato no hover. Activedot (hover) sempre aparece.
  const showDots = n <= 14;
  // Y-axis width: 52px × 2 come 104px num viewport mobile de 390px. Reduzir
  // pra 40px libera 24px pra área de plot sem cortar labels ("0,60%" cabe).
  const yWidth = isMobile ? 40 : 52;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-3">
        <Legend color={barColor} label={label1} />
        <Legend color={lineColor} label={label2} />
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chartNeutral.grid} vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={{ fill: chartNeutral.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: chartNeutral.grid }}
            tickFormatter={(v) => (isDate ? String(v).slice(5) : String(v))}
            interval="preserveStartEnd"
            minTickGap={isMobile ? 32 : 24}
            padding={{ left: xPad, right: xPad }}
          />
          <YAxis
            yAxisId="left"
            tick={{ fill: chartNeutral.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={fmtBig}
            width={yWidth}
            padding={{ top: 8, bottom: 0 }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fill: chartNeutral.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={fmtPct}
            width={yWidth}
            padding={{ top: 8, bottom: 0 }}
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
            fill={barColor}
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
            stroke={lineColor}
            strokeWidth={2}
            dot={showDots ? { r: 3, fill: lineColor } : false}
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
