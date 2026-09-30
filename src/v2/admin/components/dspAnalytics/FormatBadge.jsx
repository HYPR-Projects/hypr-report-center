// src/v2/admin/components/dspAnalytics/FormatBadge.jsx
//
// Identidade visual do formato: ícone + rótulo, no mesmo desenho em toda a
// página (filtro, matriz, custo do ABS, tabela de lines). Ícone de traço
// fino no estilo dos ícones do rail; a cor fica no texto neutro, o formato
// não é categoria de gráfico e não disputa cor com as DSPs.

import { cn } from "../../../../ui/cn";
import { formatLabel } from "./dspFormat";

export function FormatIcon({ media, className = "size-3.5" }) {
  if (media === "VIDEO") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
        <rect x="2.5" y="4.5" width="19" height="15" rx="3" />
        <path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="2.5" y="3.5" width="19" height="13" rx="2.5" />
      <path d="M8 20.5h8M12 16.5v4" />
      <rect x="6" y="7" width="6" height="6" rx="1" fill="currentColor" stroke="none" opacity="0.35" />
    </svg>
  );
}

/** Pill do formato. `size="sm"` pra célula de tabela. */
export function FormatBadge({ media, size = "md", className }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border whitespace-nowrap",
        media === "VIDEO"
          ? "border-signature/30 bg-signature-soft text-fg"
          : "border-border bg-surface-strong text-fg",
        size === "sm" ? "px-1.5 py-px text-[11px]" : "px-2 py-0.5 text-xs",
        className,
      )}
    >
      <FormatIcon media={media} className={size === "sm" ? "size-3" : "size-3.5"} />
      {formatLabel(media)}
    </span>
  );
}
