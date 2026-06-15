// src/v2/components/CoreProductFilterV2.jsx
//
// Filtro de "core product" (O2O / OOH / Todos) exibido na Visão Geral.
// Visualmente pareado com o pill de Período (mesmo height, mesmo radius
// e mesma estética hover/focus).
//
// Escopo: AFETA APENAS A VISÃO GERAL. As tabs Display e Video continuam
// com seus próprios toggles independentes (displayTactic/videoTactic) —
// isso é decisão de produto pra não acoplar contextos: a Visão Geral é
// um "executive summary" filtrável, enquanto Display/Video são deep-dives
// já segmentados por mídia.
//
// Estado: 3 valores fixos. Default "ALL" não vai pra URL (limpa).

import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { cn } from "../../ui/cn";

const OPTIONS = [
  { id: "ALL", label: "Todos" },
  { id: "O2O", label: "O2O" },
  { id: "OOH", label: "OOH" },
  { id: "GROUNDFLOW", label: "Groundflow" },
];

// `available` (opcional): ids de frentes presentes na campanha. Quando passado,
// só mostra "Todos" + as frentes presentes — evita opção que não rende nada.
export function CoreProductFilterV2({ value = "ALL", onChange, available }) {
  const [open, setOpen] = useState(false);
  const options = available
    ? OPTIONS.filter((o) => o.id === "ALL" || available.includes(o.id))
    : OPTIONS;
  const current = options.find((o) => o.id === value) || options[0];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Filtrar por core product"
          className={cn(
            "inline-flex items-center gap-2 h-10 px-4 rounded-full",
            "text-xs font-semibold whitespace-nowrap",
            "border border-border bg-surface text-fg",
            "hover:border-border-strong hover:bg-surface-strong",
            "transition-colors duration-150 cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
            open && "border-signature bg-surface-strong",
          )}
        >
          <ProductIcon className="size-3.5 text-fg-muted" />
          <span className="text-fg-muted">Core Product:</span>
          <span className="text-fg">{current.label}</span>
          <ChevronDownIcon
            className={cn(
              "size-3 text-fg-muted transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          className={cn(
            "z-50 rounded-xl overflow-hidden border border-border bg-surface-2 shadow-2xl",
            "animate-in fade-in-0 zoom-in-95",
            "data-[side=bottom]:slide-in-from-top-2",
            "min-w-[160px]",
          )}
        >
          <div
            role="radiogroup"
            aria-label="Opções de core product"
            className="flex flex-col p-2"
          >
            {options.map((opt) => {
              const active = opt.id === value;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    onChange(opt.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex items-center justify-between text-left text-xs font-medium",
                    "px-3 py-2 rounded-md",
                    "transition-colors duration-150 cursor-pointer",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                    active
                      ? "bg-signature-soft text-signature font-semibold"
                      : "text-fg-muted hover:bg-surface-strong hover:text-fg",
                  )}
                >
                  <span>{opt.label}</span>
                  {active && <CheckIcon className="size-3.5" />}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ProductIcon({ className }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="6" rx="1" />
      <path d="M4 13h8" />
      <path d="M6 9v4M10 9v4" />
    </svg>
  );
}

function ChevronDownIcon({ className }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}

function CheckIcon({ className }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="3 8 7 12 13 4" />
    </svg>
  );
}
