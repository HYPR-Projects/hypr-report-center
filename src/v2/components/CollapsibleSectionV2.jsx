// src/v2/components/CollapsibleSectionV2.jsx
//
// Seção colapsável usando <details>/<summary> nativos do HTML.
//
// Por que <details> em vez de gerenciar estado com useState?
//   - A11y nativa: leitor de tela já anuncia "expandido/colapsado"
//   - Keyboard nav (Enter/Space) funciona sem código
//   - Funciona com JS desabilitado
//   - Atributo `open` controla estado, fácil de estilizar via CSS
//
// API:
//   <CollapsibleSectionV2 title="Tabela Consolidada" defaultOpen>
//     ...children...
//   </CollapsibleSectionV2>

import { cn } from "../../ui/cn";

export function CollapsibleSectionV2({
  title,
  defaultOpen = false,
  children,
  className,
}) {
  return (
    <details
      className={cn(
        "group rounded-xl border border-border bg-surface overflow-hidden",
        className,
      )}
      open={defaultOpen}
    >
      <summary
        className={cn(
          "flex items-center justify-between gap-3",
          "px-5 py-4 cursor-pointer select-none",
          "list-none [&::-webkit-details-marker]:hidden",
          "hover:bg-surface-strong transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-inset",
        )}
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
          {title}
        </span>
        <ChevronIcon className="size-4 text-signature transition-transform duration-200 group-open:rotate-180" />
      </summary>

      <div className="px-5 pb-5 pt-2 border-t border-border">
        {children}
      </div>
    </details>
  );
}

function ChevronIcon({ className }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
