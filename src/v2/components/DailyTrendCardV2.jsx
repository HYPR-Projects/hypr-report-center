// src/v2/components/DailyTrendCardV2.jsx
//
// "Tendência diária" da Visão Geral: uma métrica por vez, escolhida nos
// chips, sempre no mesmo eixo. Substitui os dois gráficos de eixo duplo
// (Imp. visíveis × CTR e Views 100% × VTR). Os chips só oferecem o que a
// campanha tem (sem clique não há CTR; sem vídeo não há VTR).

import { useRef, useState } from "react";
import { fmt, fmtCompactTick, fmtR } from "../../shared/format";
import { availableTrendMetrics } from "../../shared/overviewSeries";
import { Card } from "../../ui/Card";
import { ChipGroupV2 } from "./ChipGroupV2";
import { TrendChartV2 } from "./TrendChartV2";
import { DownloadPngButtonV2 } from "./DownloadPngButtonV2";

const TREND_METRICS = {
  viewable_impressions: {
    label: "Imp. visíveis",
    kind: "bar",
    formatValue: (v) => fmt(v),
    formatTick: (v) => fmtCompactTick(v),
  },
  clicks: {
    label: "Cliques",
    kind: "bar",
    formatValue: (v) => fmt(v),
    formatTick: (v) => fmtCompactTick(v),
  },
  ctr: {
    label: "CTR",
    kind: "line",
    percent: true,
    formatValue: (v) => `${fmt(v, 2)}%`,
  },
  video_view_100: {
    label: "Views 100%",
    kind: "bar",
    formatValue: (v) => fmt(v),
    formatTick: (v) => fmtCompactTick(v),
  },
  vtr: {
    label: "VTR",
    kind: "line",
    percent: true,
    formatValue: (v) => `${fmt(v, 1)}%`,
  },
  cost: {
    label: "Custo efetivo",
    kind: "bar",
    formatValue: (v) => fmtR(v),
    formatTick: (v) => `R$\u00A0${fmtCompactTick(v)}`,
  },
};

export function DailyTrendCardV2({ series, downloadable = false, filename }) {
  const cardRef = useRef(null);
  const available = availableTrendMetrics(series);
  const [picked, setPicked] = useState(available[0]);
  const metricKey = available.includes(picked) ? picked : available[0];
  const metric = TREND_METRICS[metricKey];

  if (!series?.length || !metric) return null;

  return (
    <Card ref={cardRef} className="p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">
          Tendência diária
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {available.length > 1 && (
            <ChipGroupV2
              label="Métrica do gráfico"
              options={available.map((k) => ({ value: k, label: TREND_METRICS[k].label }))}
              value={metricKey}
              onChange={setPicked}
            />
          )}
          {downloadable && (
            <DownloadPngButtonV2
              targetRef={cardRef}
              filename={`${filename || "campanha"} - ${metric.label}`}
              exportMaxWidth={820}
            />
          )}
        </div>
      </div>
      <TrendChartV2
        data={series}
        dataKey={metricKey}
        label={metric.label}
        kind={metric.kind}
        formatValue={metric.formatValue}
        formatTick={metric.formatTick}
        percent={!!metric.percent}
        height={220}
      />
    </Card>
  );
}
