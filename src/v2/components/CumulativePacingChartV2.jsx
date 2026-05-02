// src/v2/components/CumulativePacingChartV2.jsx
//
// Chart cumulativo de pacing × tempo, complementar ao PacingBar.
//
// Conceito (Opção G — alinhada com Pacing Geral)
//   A barra de pacing mostra delivered/expected_today × 100 — um SNAPSHOT
//   do ritmo atual. Já este chart mostra a CURVA de pacing acumulado:
//   eixo X tempo (start → end date), eixo Y % do esperado linear até cada
//   data, ponderado por budget Display+Video.
//
//   Linha real (signature): pacing % cumulativo, ponto por dia, vai apenas
//   até "hoje". Mesma fórmula do KPI Pacing Geral aplicada a cada dia
//   (média ponderada por budget de pacing Display + pacing Video).
//
//   Linha "no alvo" (cinza tracejado): horizontal em 100% — convenção
//   universal de pacing em ad-tech (acima = over, abaixo = atrasado).
//
//   ReferenceLine vertical em "hoje" separa o passado (curva real visível)
//   do futuro (sem dados).
//
// Como ler
//   - Real ACIMA da linha 100% → over-pacing (entregando mais que o ritmo)
//   - Real ABAIXO da linha 100% → sub-pacing (atrasado vs ritmo linear)
//   - Valor no marker "hoje" bate com o KPI Pacing Geral acima.
//
// Por que a curva pode oscilar (especialmente nos primeiros dias):
//   No início da campanha o esperado linear é minúsculo (1/totalDays do
//   contrato). Qualquer entrega significativa aparece como pacing alto
//   (200%+). É esperado e estabiliza com o tempo conforme acumula dias.
//
// Fonte de dados
//   - Daily: viewable_impressions (Display) + video_view_100 (Video)
//     por data, separados por mídia (cada uma comparada com seu próprio
//     contrato — Display em impressões, Video em completions).
//   - Contratado: contracted+bonus por mídia (denormalizado, lê de rows[0]).
//   - Budget: o2o_*_budget + ooh_*_budget por mídia (sem bonus — bônus
//     não fatura).
//   - Datas: camp.start_date e camp.end_date.
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

function buildSeries({
  daily,
  contractedDisplay,
  contractedVideo,
  budgetDisplay,
  budgetVideo,
  startDate,
  endDate,
}) {
  // Mapa data ISO → entrega do dia separada por mídia.
  // Display contrata em viewable_impressions, Video em completions
  // (campo `video_view_100` no daily — confere com totals.completions).
  const dailyByDate = {};
  daily.forEach((r) => {
    if (!r.date) return;
    if (!dailyByDate[r.date]) dailyByDate[r.date] = { display: 0, video: 0 };
    if (r.media_type === "DISPLAY") {
      dailyByDate[r.date].display += Number(r.viewable_impressions || 0);
    } else if (r.media_type === "VIDEO") {
      dailyByDate[r.date].video += Number(r.video_view_100 || r.completions || 0);
    }
  });

  const totalDays = Math.max(1, Math.round((endDate - startDate) / ONE_DAY) + 1);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const totalBudget = budgetDisplay + budgetVideo;

  let cumDisplay = 0;
  let cumVideo = 0;
  const points = [];

  for (let i = 0; i < totalDays; i++) {
    const date = new Date(startDate.getTime() + i * ONE_DAY);
    const iso = date.toISOString().slice(0, 10);
    const dayData = dailyByDate[iso] || { display: 0, video: 0 };
    const isPast = date <= today;

    if (isPast) {
      cumDisplay += dayData.display;
      cumVideo += dayData.video;
    }

    let realPct = null;
    if (isPast && totalBudget > 0) {
      // elapsed = i (mesma convenção de computeMediaPacing:
      // Math.floor((noon de dia i − start)/1d) = i). Pós-end usa cap
      // em totalDays (espelha o `now > end ? tDays` do KPI).
      const elapsedDays = date > endDate ? totalDays : i;
      if (elapsedDays > 0) {
        const elapsedFrac = elapsedDays / totalDays;
        const expDisplay = contractedDisplay * elapsedFrac;
        const expVideo = contractedVideo * elapsedFrac;
        const pacingD = expDisplay > 0 ? (cumDisplay / expDisplay) * 100 : 0;
        const pacingV = expVideo > 0 ? (cumVideo / expVideo) * 100 : 0;
        realPct = (pacingD * budgetDisplay + pacingV * budgetVideo) / totalBudget;
      } else {
        // Dia 0 — campanha começou agora, esperado = 0 (não dividir por zero)
        realPct = 0;
      }
    }

    points.push({
      date: iso,
      label: formatShortDate(date),
      real: realPct,
      ideal: 100,
    });
  }

  return points;
}

function findTodayLabel(points, endDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Campanha já encerrada — não faz sentido marcar "hoje" no chart.
  if (endDate && today > endDate) return null;
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
  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] shadow-md">
      <div className="font-semibold text-fg mb-1">{label}</div>
      <div className="flex items-center gap-2 text-fg-muted">
        <span className="size-2 rounded-full bg-signature" />
        Pacing: <span className="text-fg font-semibold tabular-nums">
          {real != null ? `${fmt(real, 1)}%` : "—"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-fg-muted mt-0.5">
        <span className="size-2 rounded-full" style={{ background: "var(--color-fg-subtle)" }} />
        No alvo: <span className="text-fg font-semibold tabular-nums">100,0%</span>
      </div>
      {real != null && (
        <div className="mt-1 pt-1 border-t border-border text-fg-muted">
          Δ: <span
            className="font-semibold tabular-nums"
            style={{ color: real >= 100 ? "var(--color-success)" : "var(--color-warning)" }}
          >
            {real >= 100 ? "+" : ""}{fmt(real - 100, 1)} pp
          </span>
        </div>
      )}
    </div>
  );
}

export function CumulativePacingChartV2({
  daily = [],
  contractedDisplay = 0,
  contractedVideo = 0,
  budgetDisplay = 0,
  budgetVideo = 0,
  startDate: startISO,
  endDate: endISO,
  height = 220,
}) {
  const hypr = useThemeColors();
  const chartNeutral = useChartNeutral();

  const startDate = parseISODate(startISO);
  const endDate = parseISODate(endISO);

  const series = useMemo(() => {
    if (!startDate || !endDate || !daily.length) return [];
    if (!contractedDisplay && !contractedVideo) return [];
    if (!budgetDisplay && !budgetVideo) return [];
    return buildSeries({
      daily,
      contractedDisplay,
      contractedVideo,
      budgetDisplay,
      budgetVideo,
      startDate,
      endDate,
    });
  }, [daily, contractedDisplay, contractedVideo, budgetDisplay, budgetVideo, startISO, endISO]);

  if (series.length === 0) return null;

  const todayLabel = findTodayLabel(series, endDate);

  return (
    <div className="rounded-xl border border-border bg-surface-2 px-5 py-5">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          <span className="size-2 rounded-full bg-signature" aria-hidden />
          Curva de pacing
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
            No alvo (100%)
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart
          data={series}
          margin={{ top: 20, right: 12, left: 0, bottom: 0 }}
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
            domain={[0, (dataMax) => Math.max(120, Math.ceil(dataMax / 10) * 10)]}
            width={48}
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
