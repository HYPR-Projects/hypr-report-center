// src/v2/components/ChartCardV2.jsx
//
// Wrapper padrão dos cards de gráfico (DualChartV2) na Visão Geral / Display
// / Video. Antes cada call-site repetia o mesmo bloco:
//
//   <div className="rounded-xl border border-border bg-surface p-4 md:p-5">
//     <div className="text-[11px] ... text-signature mb-3">{título}</div>
//     <DualChartV2 .../>
//   </div>
//
// Centralizar aqui dá um lugar único pro botão de baixar (DownloadPngButtonV2),
// que aparece no canto superior direito do header quando `downloadable` é true
// (= admin). O ref da capture aponta pro card inteiro.

import { useRef } from "react";
import { cn } from "../../ui/cn";
import { DownloadPngButtonV2 } from "./DownloadPngButtonV2";

export function ChartCardV2({
  title,
  downloadable = false,
  filename,
  className,
  children,
  // Largura-alvo da imagem exportada. Gráficos no report ocupam a largura
  // cheia (~1500px) e saem "esticados" pra slide — na exportação o card é
  // estreitado pra cá (o recharts reflua) e a imagem fica mais PPT-friendly.
  exportMaxWidth = 820,
}) {
  const ref = useRef(null);
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-xl border border-border bg-surface p-4 md:p-5",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-[11px] font-bold uppercase tracking-widest text-signature">
          {title}
        </div>
        {downloadable && (
          <DownloadPngButtonV2
            targetRef={ref}
            filename={filename}
            exportMaxWidth={exportMaxWidth}
          />
        )}
      </div>
      {children}
    </div>
  );
}
