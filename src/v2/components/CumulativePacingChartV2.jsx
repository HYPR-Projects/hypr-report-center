// src/v2/components/CumulativePacingChartV2.jsx
//
// Chart cumulativo de pacing × tempo, complementar ao PacingBar.
//
// Conceito (Display + Video separados)
//   A barra de pacing mostra delivered/expected_today × 100 — um SNAPSHOT
//   do ritmo atual. Já este chart mostra a CURVA de pacing acumulado:
//   eixo X tempo (start → end date), eixo Y % do esperado linear até cada
//   data, calculado SEPARADO por mídia.
//
//   Antes mostrava 1 linha agregada (média ponderada Display + Video).
//   Trocado pra 2 linhas (Display + Video) porque:
//     1. A linha agregada não dizia mais que o KPI "Pacing Geral" acima.
//     2. Display em 130% + Video em 50% dá média ~90%, parece "perto do
//        alvo" mas tem dois problemas separados se compensando — o agregado
//        escondia o diagnóstico.
//     3. A pergunta natural diante do chart é "o que tá puxando o pacing?"
//        — duas linhas respondem direto.
//
//   Linha Display (signature): pacing % cumulativo de viewable_impressions.
//   Linha Video (signature-light): pacing % cumulativo de video_view_100.
//   Ambas vão até D-1 (ontem). Os ETLs entregam dados defasados 1 dia —
//   incluir hoje contaria o dia no esperado linear sem ter entrega
//   correspondente, gerando um drop artificial.
//
//   Linha "no alvo" (cinza tracejado): horizontal em 100% — convenção
//   universal de pacing em ad-tech (acima = over, abaixo = atrasado).
//
//   ReferenceLine vertical em "ontem" marca o último dia com dado completo
//   (D-1) — coincide com a ponta direita das curvas.
//
// Como ler
//   - Linha ACIMA de 100% → over-pacing daquela mídia
//   - Linha ABAIXO de 100% → sub-pacing
//   - Distância entre Display e Video → quanto cada uma destoa da outra
//
// Edge cases
//   - Campanha só Display (sem contracted/budget Video): renderiza só Display.
//   - Campanha só Video: renderiza só Video.
//   - Ambas: 2 linhas + tooltip mostra os dois valores.
//
// Por que a curva pode oscilar (especialmente nos primeiros dias):
//   No início da campanha o esperado linear é minúsculo (1/totalDays do
//   contrato). Qualquer entrega significativa aparece como pacing alto
//   (200%+). É esperado e estabiliza com o tempo conforme acumula dias.
//
// Fonte de dados
//   - Daily: viewable_impressions (Display) + video_view_100 (Video)
//     por data, separados por mídia.
//   - Contratado: contracted+bonus por mídia (denormalizado, lê de rows[0]).
//   - Datas: camp.start_date e camp.end_date.
//
// Renderiza null se não houver dados suficientes (sem datas, sem nenhum
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
import { useMemo, useRef } from "react";
import { useThemeColors, useChartNeutral } from "../hooks/useThemeColors";
import { fmt } from "../../shared/format";
import { DownloadPngButtonV2 } from "./DownloadPngButtonV2";

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
  // Cutoff = ontem (D-1). Os ETLs entregam dados sempre defasados em 1 dia,
  // então hoje ainda tem entrega 0 enquanto o esperado linear já contaria
  // o dia. Cortar em ontem evita o drop artificial no fim da curva.
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 1);

  let cumDisplay = 0;
  let cumVideo = 0;
  const points = [];

  for (let i = 0; i < totalDays; i++) {
    const date = new Date(startDate.getTime() + i * ONE_DAY);
    const iso = date.toISOString().slice(0, 10);
    const dayData = dailyByDate[iso] || { display: 0, video: 0 };
    const isPast = date <= cutoff;

    if (isPast) {
      cumDisplay += dayData.display;
      cumVideo += dayData.video;
    }

    let displayPct = null;
    let videoPct = null;
    if (isPast) {
      // elapsed = i + 1 — cada ponto representa "pacing ao FIM da data X".
      // Como cumDisplay/cumVideo já somaram dayData[X] acima, o numerador
      // tem (i+1) dias de entrega; o denominador tem que casar pra o ponto
      // de "ontem" bater com os KPIs Pacing DSP / Pacing VID separados.
      // Usar elapsed=i (índice) gerava off-by-one.
      // Pós-end (campanha encerrada) cap em totalDays.
      const elapsedDays = date > endDate ? totalDays : i + 1;
      const elapsedFrac = elapsedDays / totalDays;
      if (contractedDisplay > 0) {
        const expDisplay = contractedDisplay * elapsedFrac;
        displayPct = expDisplay > 0 ? (cumDisplay / expDisplay) * 100 : 0;
      }
      if (contractedVideo > 0) {
        const expVideo = contractedVideo * elapsedFrac;
        videoPct = expVideo > 0 ? (cumVideo / expVideo) * 100 : 0;
      }
    }

    points.push({
      date: iso,
      label: formatShortDate(date),
      display: displayPct,
      video: videoPct,
      ideal: 100,
    });
  }

  return points;
}

function findCutoffLabel(points, endDate) {
  // Marker fica em D-1 (ontem) — coincide com o último ponto da curva,
  // já que dados são D-1 e o cutoff em buildSeries também é ontem.
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 1);
  // Campanha já encerrada — não faz sentido marcar referência temporal.
  if (endDate && cutoff > endDate) return null;
  for (let i = points.length - 1; i >= 0; i--) {
    const [y, m, d] = points[i].date.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    if (date <= cutoff) return points[i].label;
  }
  return null;
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const display = payload.find((p) => p.dataKey === "display")?.value;
  const video   = payload.find((p) => p.dataKey === "video")?.value;
  // Filtra entradas null pra não poluir tooltip de campanha mono-mídia.
  const rows = [
    display != null && {
      label: "Display",
      value: display,
      dot: "var(--color-signature)",
    },
    video != null && {
      label: "Video",
      value: video,
      dot: "var(--color-signature-light)",
    },
  ].filter(Boolean);

  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] shadow-md">
      <div className="font-semibold text-fg mb-1">{label}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-fg-muted">
          <span className="size-2 rounded-full" style={{ background: r.dot }} />
          {r.label}: <span className="text-fg font-semibold tabular-nums">
            {fmt(r.value, 1)}%
          </span>
          <span
            className="text-[10px] tabular-nums ml-auto"
            style={{ color: r.value >= 100 ? "var(--color-success)" : "var(--color-warning)" }}
          >
            {r.value >= 100 ? "+" : ""}{fmt(r.value - 100, 1)} pp
          </span>
        </div>
      ))}
      <div className="flex items-center gap-2 text-fg-muted mt-1 pt-1 border-t border-border">
        <span className="size-2 rounded-full" style={{ background: "var(--color-fg-subtle)" }} />
        No alvo: <span className="text-fg font-semibold tabular-nums">100,0%</span>
      </div>
    </div>
  );
}

export function CumulativePacingChartV2({
  daily = [],
  contractedDisplay = 0,
  contractedVideo = 0,
  // budgetDisplay/budgetVideo eram usados pra ponderar a média agregada.
  // Não são mais necessários (cada linha usa só o seu próprio contracted),
  // mas mantemos os props no contrato pra evitar quebrar o caller.
  // eslint-disable-next-line no-unused-vars
  budgetDisplay = 0,
  // eslint-disable-next-line no-unused-vars
  budgetVideo = 0,
  startDate: startISO,
  endDate: endISO,
  height = 220,
  // Botão de baixar PNG no header (só admin). filename = nome do arquivo.
  downloadable = false,
  filename,
}) {
  const hypr = useThemeColors();
  const chartNeutral = useChartNeutral();
  const cardRef = useRef(null);

  const startDate = parseISODate(startISO);
  const endDate = parseISODate(endISO);

  const series = useMemo(() => {
    if (!startDate || !endDate || !daily.length) return [];
    if (!contractedDisplay && !contractedVideo) return [];
    return buildSeries({
      daily,
      contractedDisplay,
      contractedVideo,
      startDate,
      endDate,
    });
  }, [daily, contractedDisplay, contractedVideo, startISO, endISO]);

  if (series.length === 0) return null;

  const cutoffLabel = findCutoffLabel(series, endDate);

  // Renderiza só linha que tem dado (evita Line vazia em campanha mono-mídia).
  const showDisplay = contractedDisplay > 0;
  const showVideo   = contractedVideo > 0;

  return (
    <div ref={cardRef} className="rounded-xl border border-border bg-surface-2 px-5 py-5">
      <div className="flex items-baseline justify-between gap-3 mb-4 flex-wrap">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          <span className="size-2 rounded-full bg-signature" aria-hidden />
          Curva de pacing
        </span>
        <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-3 text-[10px] text-fg-muted uppercase tracking-wider">
          {showDisplay && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-3 bg-signature" /> Display
            </span>
          )}
          {showVideo && (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-0.5 w-3"
                style={{ background: "var(--color-signature-light)" }}
              />
              Video
            </span>
          )}
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
          {downloadable && (
            <DownloadPngButtonV2 targetRef={cardRef} filename={filename} exportMaxWidth={820} />
          )}
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
          {showDisplay && (
            <Line
              type="monotone"
              dataKey="display"
              name="Display"
              stroke={hypr.signature}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4, fill: hypr.signature, stroke: hypr.canvas, strokeWidth: 2 }}
              connectNulls={false}
              // Sem animação — a re-renderização ao estreitar pra exportar
              // pegava a linha no meio da animação e a curva saía deformada
              // no PNG (mesmo motivo do DualChartV2).
              isAnimationActive={false}
            />
          )}
          {showVideo && (
            <Line
              type="monotone"
              dataKey="video"
              name="Video"
              stroke={hypr.signatureLight}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4, fill: hypr.signatureLight, stroke: hypr.canvas, strokeWidth: 2 }}
              connectNulls={false}
              // Sem animação — ver nota na Line de Display acima.
              isAnimationActive={false}
            />
          )}

          {cutoffLabel && (
            <ReferenceLine
              x={cutoffLabel}
              stroke={chartNeutral.axis}
              strokeDasharray="2 2"
              label={{
                value: "ontem",
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
