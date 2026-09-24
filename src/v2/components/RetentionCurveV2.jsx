// src/v2/components/RetentionCurveV2.jsx
//
// Curva de retenção do vídeo: de quem deu play, quantos chegaram a 25%, 50%,
// 75% e ao fim. Os quartis já vinham no detail (video_view_25/50/75/100) e
// só apareciam na Base de dados. Barras de uma cor só (uma série), rótulo
// com o % sobre as views iniciadas e a queda de um marco para o outro.

import { useRef } from "react";
import { fmt } from "../../shared/format";
import { buildRetention } from "../../shared/videoRetention";
import { Card } from "../../ui/Card";
import { DownloadPngButtonV2 } from "./DownloadPngButtonV2";

export function RetentionCurveV2({ detail, downloadable = false, filename }) {
  const ref = useRef(null);
  const { starts, points, hasQuartiles } = buildRetention(detail);
  if (!starts || !hasQuartiles) return null;
  // Base = views iniciadas; se algum marco vier maior (fonte inconsistente),
  // a base vira o maior valor pra curva nunca passar de 100%.
  const base = Math.max(starts, ...points.map((p) => p.value));
  return (
    <Card ref={ref} className="p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">Retenção do vídeo</h3>
          <span className="text-[11px] text-fg-subtle">De quem deu play, quantos chegaram a cada marco</span>
        </div>
        {downloadable && <DownloadPngButtonV2 targetRef={ref} filename={filename} exportMaxWidth={820} />}
      </div>
      <div className="grid grid-cols-5 gap-2 sm:gap-4 items-end h-[180px]" role="img" aria-label={points.map((p) => `${p.label}: ${fmt((p.value / base) * 100, 1)}%`).join(", ")}>
        {points.map((p, i) => {
          const pct = (p.value / base) * 100;
          const prev = i > 0 ? points[i - 1].value : null;
          const drop = prev ? ((prev - p.value) / prev) * 100 : null;
          return (
            <div key={p.key} className="flex h-full flex-col items-center justify-end gap-1.5 min-w-0">
              <span className="text-[12px] font-semibold text-fg tabular-nums">{fmt(pct, pct < 10 ? 1 : 0)}%</span>
              <div className="bar-grow-y w-full max-w-[72px] rounded-t-[4px] bg-chart-s1" style={{ height: `${Math.max(2, Math.min(100, pct)) * 1.2}px`, "--i": i }} />
              <span className="text-[11px] text-fg-muted">{p.label}</span>
              <span className="text-[10px] text-fg-subtle tabular-nums h-3">{drop != null && drop > 0 ? `↓ ${fmt(drop, 1)}%` : ""}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] leading-snug text-fg-subtle">
        {fmt(starts)} views iniciadas no recorte. A seta mostra a queda de um marco para o seguinte.
      </p>
    </Card>
  );
}
