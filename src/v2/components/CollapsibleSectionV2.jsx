// src/v2/components/CollapsibleSectionV2.jsx
//
// Seção colapsável usando <details>/<summary> nativos do HTML.
//
// Por que <details>/<summary>
//   - A11y nativa: leitor de tela já anuncia "expandido/colapsado"
//   - Keyboard nav (Enter/Space) funciona sem código
//   - Atributo `open` controla estado, fácil de estilizar via CSS
//
// Por que controlamos com useState
//   `<details open={defaultOpen}>` em React é CONTROLED, não default. Sem
//   useState interno, qualquer re-render do parent (ex: usuário muda
//   filtro de período no OverviewV2) faria React re-aplicar `open` igual
//   ao defaultOpen, fechando uma seção que o usuário tinha aberto.
//
//   Com useState + onToggle, o estado vive no componente: parent
//   re-render não afeta, e o toggle nativo do summary continua
//   funcionando (event onToggle é disparado pelo browser).
//
// API:
//   <CollapsibleSectionV2 title="Tabela Consolidada" defaultOpen>
//     ...children...
//   </CollapsibleSectionV2>

import { useState } from "react";
import { cn } from "../../ui/cn";

export function CollapsibleSectionV2({
  title,
  defaultOpen = false,
  children,
  className,
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      className={cn(
        "group rounded-xl border border-border bg-surface overflow-hidden",
        className,
      )}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
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
