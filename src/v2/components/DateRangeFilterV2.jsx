// src/v2/components/DateRangeFilterV2.jsx
//
// Filtro de período do V2 — versão com presets como chips horizontais.
//
// Reusa os helpers puros de shared/dateFilter (buildPresets, matchesPreset)
// que JÁ existem e são usados pelo DateRangeFilter Legacy. Comportamento
// dos presets idêntico (mesmas regras de clamp por start/end_date).
//
// LIMITAÇÃO ASSUMIDA NESSA PR
// ───────────────────────────────────────────────────────────────────────
// Custom range arbitrário (calendário pra escolher dias específicos) NÃO
// está nessa primeira PR — fica pra PR-07, junto com o popover de calendário
// do V2. Os 7 presets do buildPresets cobrem a maioria dos casos de uso
// (Tudo, Ontem, 7d, 15d, 30d, Este mês, Mês passado).
//
// Quem precisar de janela arbitrária por enquanto pode usar ?v=legacy.

import { buildPresets, matchesPreset } from "../../shared/dateFilter";
import { cn } from "../../ui/cn";

export function DateRangeFilterV2({ value, campaignStart, campaignEnd, onChange }) {
  const presets = buildPresets(new Date(), campaignStart, campaignEnd);

  return (
    <div
      role="radiogroup"
      aria-label="Período do filtro"
      className="flex flex-wrap gap-2"
    >
      {presets.map((p) => {
        const active = matchesPreset(value, p);
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(p.range)}
            className={cn(
              "h-8 px-3 rounded-full text-xs font-semibold whitespace-nowrap",
              "border transition-colors duration-150 cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
              active
                ? "bg-signature border-signature text-fg"
                : "bg-surface border-border text-fg-muted hover:text-fg hover:border-border-strong",
            )}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
