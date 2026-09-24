// src/v2/components/AlignedTrendCardV2.jsx
//
// "Tendência diária" das abas Display e Vídeo: volume (barras) em cima e
// taxa (linha) embaixo, cada um na sua escala, no mesmo eixo de tempo e com
// o crosshair sincronizado. Substitui o gráfico de eixo duplo, em que as
// alturas de barra e linha pareciam comparáveis sem ser.

import { useId, useRef } from "react";
import { fmt, fmtCompactTick } from "../../shared/format";
import { Card } from "../../ui/Card";
import { TrendChartV2 } from "./TrendChartV2";
import { DownloadPngButtonV2 } from "./DownloadPngButtonV2";

export function AlignedTrendCardV2({
  data,
  volumeKey,
  volumeLabel,
  rateKey,
  rateLabel,
  rateDecimals = 2,
  subtitle = "Volume e taxa no mesmo eixo de tempo, cada um na sua escala",
  downloadable = false,
  filename,
}) {
  const ref = useRef(null);
  const syncId = useId();
  if (!data?.length) return null;
  return (
    <Card ref={ref} className="p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap items-baseline gap-2 min-w-0">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">Tendência diária</h3>
          <span className="text-[11px] text-fg-subtle">{subtitle}</span>
        </div>
        {downloadable && <DownloadPngButtonV2 targetRef={ref} filename={filename} exportMaxWidth={820} />}
      </div>
      <div className="text-[11px] font-semibold text-fg-muted mb-1">{volumeLabel}</div>
      <TrendChartV2
        data={data}
        dataKey={volumeKey}
        label={volumeLabel}
        kind="bar"
        formatValue={(v) => fmt(v)}
        formatTick={fmtCompactTick}
        height={170}
        syncId={syncId}
        showXAxis={false}
      />
      <div className="text-[11px] font-semibold text-fg-muted mt-3 mb-1">{rateLabel}</div>
      <TrendChartV2
        data={data}
        dataKey={rateKey}
        label={rateLabel}
        kind="line"
        formatValue={(v) => `${fmt(v, rateDecimals)}%`}
        percent
        height={130}
        syncId={syncId}
        animationDelay={120}
      />
    </Card>
  );
}
