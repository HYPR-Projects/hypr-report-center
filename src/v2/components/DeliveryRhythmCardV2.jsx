// src/v2/components/DeliveryRhythmCardV2.jsx
//
// Módulo "Ritmo de entrega" da Visão Geral. Junta, num card só, o que antes
// eram dois blocos separados:
//
//   Hoje      → barras de pacing de Display e Vídeo (com sub-barras por
//               frente e zonas contrato × bônus), sem moldura própria.
//   Evolução  → curva de pacing acumulado (Display × Vídeo × no alvo).
//
// Embaixo, uma frase de ritmo ("X% do budget investido em Y% do período")
// e, quando existir, o aviso de pacing sobre o contrato original.

import { useState } from "react";
import { Card } from "../../ui/Card";
import { cn } from "../../ui/cn";
import { SegmentedControlV2 } from "./SegmentedControlV2";
import { PacingBarV2 } from "./PacingBarV2";
import { CumulativePacingChartV2 } from "./CumulativePacingChartV2";

const VIEWS = [
  { value: "today", label: "Hoje" },
  { value: "evolution", label: "Evolução" },
];

export function DeliveryRhythmCardV2({
  displayBar = null, // props do PacingBarV2 de Display, ou null
  videoBar = null,   // props do PacingBarV2 de Vídeo, ou null
  curve = null,      // props do CumulativePacingChartV2, ou null (sem curva)
  sentence = null,   // ReactNode: frase de ritmo
  notice = null,     // ReactNode: aviso (ex.: encerramento antecipado)
}) {
  const [view, setView] = useState("today");
  const bars = [displayBar, videoBar].filter(Boolean);
  if (!bars.length && !curve) return null;

  const activeView = curve && (view === "evolution" || !bars.length) ? "evolution" : "today";

  return (
    <Card className="p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">
          Ritmo de entrega
        </h3>
        {curve && bars.length > 0 && (
          <SegmentedControlV2
            label="Visão do pacing"
            options={VIEWS}
            value={activeView}
            onChange={setView}
          />
        )}
      </div>

      {activeView === "today" ? (
        <div
          className={cn(
            "grid grid-cols-1 gap-6",
            bars.length > 1 && "md:grid-cols-2 md:gap-0 md:divide-x md:divide-border/60",
          )}
        >
          {bars.map((b, i) => (
            <div
              key={b.label}
              className={cn(bars.length > 1 && (i === 0 ? "md:pr-6" : "md:pl-6"))}
            >
              <PacingBarV2 {...b} variant="compact" />
            </div>
          ))}
        </div>
      ) : (
        <CumulativePacingChartV2 {...curve} bare />
      )}

      {(sentence || notice) && (
        <div className="mt-4 pt-3 border-t border-border/60 space-y-2">
          {sentence && (
            <p className="flex items-start gap-2 text-[12px] leading-snug text-fg-muted">
              <InfoIcon className="size-3.5 mt-px shrink-0 text-fg-subtle" />
              <span>{sentence}</span>
            </p>
          )}
          {notice}
        </div>
      )}
    </Card>
  );
}

function InfoIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
