// src/v2/components/CumulativePacingChartV2.jsx
//
// Chart cumulativo de delivery × tempo, complementar ao PacingBar.
//
// Conceito
//   A barra de pacing mostra delivered/expected_today × 100 — um SNAPSHOT
//   do ritmo atual. Já este chart mostra a CURVA cumulativa da campanha:
//   eixo X tempo (start → end date), eixo Y % do contratado entregue.
//
//   Linha real (signature): cumulative delivery / contracted × 100, ponto
//   por dia, vai apenas até "hoje".
//
//   Linha ideal (cinza tracejado): linear de 0% no start até 100% no end.
//   É o que o "marker esperado hoje" do PR-13 tentava resumir num único
//   ponto, agora distribuído ao longo de todo o eixo.
//
//   ReferenceLine vertical em "hoje" separa o passado (curva real visível)
//   do futuro (só ideal).
//
// Como ler
//   - Real ACIMA da ideal no mesmo dia → over-delivery acumulada
//   - Real ABAIXO da ideal no mesmo dia → sub-delivery acumulada
//   - Distância vertical entre as linhas no "hoje" ≈ pacing − 100 pp
//
// Fonte de dados
//   - Real: soma cumulativa de viewable_impressions por data, do daily0
//   - Contratado: soma de contracted_*_impressions de todas as linhas
//   - Datas: camp.start_date e camp.end_date
//
// Caveat
//   Display contrata em impressões (viewable), Video em alguns casos
//   contrata em views/CPCV. Aqui agregamos tudo como "impressões" para
//   ter um eixo único — é uma aproximação razoável da curva de delivery
//   geral. Para análise específica por mídia, usar as barras Display/Video.
//
// Renderiza null se não houver dados suficientes (sem datas, sem
// contratado, sem daily).

import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMemo } from "react";
import { useThemeColors, useChartNeutral } from "../hooks/useThemeColors";
import { fmt } from "../../shared/format";

const ONE_DAY = 86_400_000;

function parseISODate(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatShortDate(d) {
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

function buildSeries({ daily, contracted, startDate, endDate }) {
  // Mapa data ISO → soma de impressions do dia (somando media_type/tactic_type)
  const byDate = {};
  daily.forEach((r) => {
    if (!r.date) return;
    const imp = Number(r.viewable_impressions || r.impressions || 0);
    byDate[r.date] = (byDate[r.date] || 0) + imp;
  });

  const totalDays = Math.max(
    1,
    Math.round((endDate - startDate) / ONE_DAY) + 1,
  );
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let cumulative = 0;
  const points = [];

  for (let i = 0; i < totalDays; i++) {
    const date = new Date(startDate.getTime() + i * ONE_DAY);
    const iso = date.toISOString().slice(0, 10);
    const dayDelivery = byDate[iso] || 0;

    const idealPct = ((i + 1) / totalDays) * 100;
    const isPast = date <= today;

    if (isPast) cumulative += dayDelivery;

    const realPct = isPast && contracted > 0
      ? (cumulative / contracted) * 100
      : null; // null no futuro deixa Recharts pular o ponto

    points.push({
      date: iso,
      label: formatShortDate(date),
      real: realPct,
      ideal: idealPct,
    });
  }

  return points;
}

function findTodayLabel(points) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = points.length - 1; i >= 0; i--) {
    const [y, m, d] = points[i].date.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    if (date <= today) return points[i].label;
  }
  return points[0]?.label;
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const real = payload.find((p) => p.dataKey === "real")?.value;
  const ideal = payload.find((p) => p.dataKey === "ideal")?.value;
  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] shadow-md">
      <div className="font-semibold text-fg mb-1">{label}</div>
      <div className="flex items-center gap-2 text-fg-muted">
        <span className="size-2 rounded-full bg-signature" />
        Real: <span className="text-fg font-semibold tabular-nums">
          {real != null ? `${fmt(real, 1)}%` : "—"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-fg-muted mt-0.5">
        <span className="size-2 rounded-full" style={{ background: "var(--color-fg-subtle)" }} />
        Esperado: <span className="text-fg font-semibold tabular-nums">
          {fmt(ideal, 1)}%
        </span>
      </div>
      {real != null && (
        <div className="mt-1 pt-1 border-t border-border text-fg-muted">
          Δ: <span
            className="font-semibold tabular-nums"
            style={{ color: real >= ideal ? "var(--color-success)" : "var(--color-warning)" }}
          >
            {real >= ideal ? "+" : ""}{fmt(real - ideal, 1)} pp
          </span>
        </div>
      )}
    </div>
  );
}

export function CumulativePacingChartV2({
  daily = [],
  contracted = 0,
  startDate: startISO,
  endDate: endISO,
  height = 220,
}) {
  const hypr = useThemeColors();
  const chartNeutral = useChartNeutral();

  const startDate = parseISODate(startISO);
  const endDate = parseISODate(endISO);

  const series = useMemo(() => {
    if (!startDate || !endDate || !contracted || !daily.length) return [];
    return buildSeries({ daily, contracted, startDate, endDate });
  }, [daily, contracted, startISO, endISO]);

  if (series.length === 0) return null;

  const todayLabel = findTodayLabel(series);

  return (
    <div className="rounded-xl border border-border bg-surface-2 px-5 py-5">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          <span className="size-2 rounded-full bg-signature" aria-hidden />
          Curva de delivery
        </span>
        <div className="flex items-center gap-3 text-[10px] text-fg-muted uppercase tracking-wider">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-3 bg-signature" /> Real
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-0.5 w-3"
              style={{
                background: `repeating-linear-gradient(to right, var(--color-fg-subtle) 0 3px, transparent 3px 6px)`,
              }}
            />
            Esperado
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart
          data={series}
          margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke={chartNeutral.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            stroke={chartNeutral.axis}
            tick={{ fill: chartNeutral.label, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: chartNeutral.axis }}
            minTickGap={32}
            padding={{ left: 8, right: 8 }}
          />
          <YAxis
            stroke={chartNeutral.axis}
            tick={{ fill: chartNeutral.label, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: chartNeutral.axis }}
            tickFormatter={(v) => `${v}%`}
            domain={[0, (dataMax) => Math.max(100, Math.ceil(dataMax / 10) * 10)]}
            width={44}
          />
          <RTooltip content={<ChartTooltip />} cursor={{ stroke: chartNeutral.grid }} />

          <Line
            type="monotone"
            dataKey="ideal"
            stroke="var(--color-fg-subtle)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="real"
            stroke={hypr.signature}
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 4, fill: hypr.signature, stroke: hypr.canvas, strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={true}
            animationDuration={500}
          />

          {todayLabel && (
            <ReferenceLine
              x={todayLabel}
              stroke={chartNeutral.axis}
              strokeDasharray="2 2"
              label={{
                value: "hoje",
                position: "top",
                fill: chartNeutral.label,
                fontSize: 10,
              }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
