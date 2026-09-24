// Gráfico de uma pergunta do Brand Lift: % de cada resposta no grupo
// Controle × Exposto. Recharts (antes Chart.js via CDN, que não carregava
// em rede com CDN bloqueada e não seguia o tema). Um eixo em %, cores do
// tema (Controle neutro, Exposto na cor da série 1) e o valor em cima de
// cada barra — a legenda fica no topo da aba.
//
// ctrl/exp opcionais — quando a pergunta tem só um lado, passa null/[] no
// lado faltante e o gráfico oculta a série correspondente (em vez de
// renderizar zeros enganosos).

import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Text,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartNeutral, useThemeColors } from "../v2/hooks/useThemeColors";

function SurveyTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border-strong bg-canvas-elevated px-3 py-2 text-[11px] shadow-md">
      <div className="font-semibold text-fg mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-fg-muted">
          <span className="size-2 rounded-sm" style={{ background: p.color }} aria-hidden />
          {p.name}: <span className="text-fg font-semibold tabular-nums">{p.value}%</span>
        </div>
      ))}
    </div>
  );
}

// Rótulo da resposta quebrando em até 3 linhas na largura da categoria
// (em vez de inclinar o texto, que fica difícil de ler).
function WrapTick({ x, y, payload, width, visibleTicksCount, fill }) {
  const band = visibleTicksCount ? width / visibleTicksCount : 80;
  return (
    <Text
      x={x}
      y={y + 6}
      width={Math.max(48, band - 10)}
      maxLines={3}
      textAnchor="middle"
      verticalAnchor="start"
      fill={fill}
      fontSize={11}
      lineHeight={13}
    >
      {payload?.value}
    </Text>
  );
}

const SurveyChart = ({ labels, ctrl, exp }) => {
  const hypr = useThemeColors();
  const neutral = useChartNeutral();
  const hasCtrl = Array.isArray(ctrl) && ctrl.length > 0;
  const hasExp = Array.isArray(exp) && exp.length > 0;
  const data = (labels || []).map((l, i) => ({
    label: l,
    ctrl: hasCtrl ? ctrl[i] ?? 0 : null,
    exp: hasExp ? exp[i] ?? 0 : null,
  }));
  const ctrlColor = hypr.fgSubtle || "#8A96A3";
  const expColor = hypr.chartS1 || hypr.signature || "#2A93BD";
  const longLabels = (labels || []).some((l) => String(l).length > 14);
  if (!data.length) return null;
  return (
    <div style={{ width: "100%", height: longLabels ? 350 : 320 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 22, right: 8, left: 0, bottom: 4 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke={neutral.grid} />
          <XAxis
            dataKey="label"
            interval={0}
            tickLine={false}
            axisLine={{ stroke: neutral.grid }}
            tick={<WrapTick fill={neutral.label} />}
            height={longLabels ? 52 : 28}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fill: neutral.label, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <RTooltip cursor={{ fill: hypr.surfaceStrong || "rgba(127,127,127,.12)" }} content={<SurveyTooltip />} />
          {hasCtrl && (
            <Bar dataKey="ctrl" name="Controle" fill={ctrlColor} radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
              <LabelList dataKey="ctrl" position="top" formatter={(v) => `${v}%`} style={{ fill: neutral.label, fontSize: 11 }} />
            </Bar>
          )}
          {hasExp && (
            <Bar dataKey="exp" name="Exposto" fill={expColor} radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
              <LabelList dataKey="exp" position="top" formatter={(v) => `${v}%`} style={{ fill: hypr.fg || "#E5EBF2", fontSize: 11, fontWeight: 700 }} />
            </Bar>
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

export default SurveyChart;
