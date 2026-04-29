// src/v2/components/AudienceFilterV2.jsx
//
// Filtro multiselect de audiências (line_names). Equivalente V2 do
// AudienceFilter Legacy — mesma UX, base totalmente diferente:
//
//   - Radix Popover (a11y, focus trap, ESC, click outside, collision
//     detection — tudo do Radix em vez de Portal manual)
//   - Tailwind v4 + tokens HYPR (em vez de inline styles)
//   - Sem dependência de tema dark/light passado por prop (V2 é dark-first)
//
// Mantém o COMPORTAMENTO Legacy:
//   - selected vazio = "todas as audiências" (filtro inativo)
//   - Clicar numa linha toggla; "Limpar" reseta tudo
//   - Label do trigger:
//       inativo  → "Audiência"
//       1 ativo  → últimos 2 segmentos do line_name (compacto)
//       N ativos → "N audiências" + counter
//   - Lista mostra o line_name truncado (3 últimos segmentos) com
//     title= no hover pra ler completo
//
// Mobile
// ──────
// Radix Popover honra `collisionPadding` automático — o popover
// reposiciona em viewport pequeno. Em telas <380px o conteúdo width
// faz fallback pra `calc(100vw - 32px)` via max-w no className.

import { useId } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../ui/cn";

export function AudienceFilterV2({ lines, selected, onChange }) {
  const headerId = useId();

  const isActive = selected.length > 0;
  const triggerLabel = !isActive
    ? "Audiência"
    : selected.length === 1
      ? selected[0].split("_").slice(-2).join("_")
      : `${selected.length} audiências`;

  const toggle = (line) => {
    if (selected.includes(line)) onChange(selected.filter((l) => l !== line));
    else onChange([...selected, line]);
  };

  const clear = () => onChange([]);

  return (
    <div className="inline-flex items-center gap-1.5">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Filtrar por audiência"
            className={cn(
              "inline-flex items-center gap-2 whitespace-nowrap",
              "h-9 px-4 rounded-full text-xs font-semibold",
              "border transition-colors duration-150 cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
              "max-w-[280px]",
              isActive
                ? "bg-signature-soft border-signature/40 text-signature hover:border-signature/70"
                : "bg-surface border-border text-fg hover:border-border-strong",
            )}
          >
            {/* Ícone de pessoas — mesmo do Legacy */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="shrink-0"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span className="truncate">{triggerLabel}</span>
            {isActive && (
              <span className="shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-signature text-fg text-[10px] font-bold tabular-nums">
                {selected.length}
              </span>
            )}
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="currentColor"
              aria-hidden="true"
              className="opacity-60 shrink-0"
            >
              <path d="M0 2.5L5 7.5L10 2.5z" />
            </svg>
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            sideOffset={6}
            collisionPadding={16}
            align="end"
            className={cn(
              "z-50 w-[380px] max-w-[calc(100vw-32px)]",
              "max-h-[min(440px,calc(100vh-32px))]",
              "rounded-xl border border-border bg-canvas-elevated shadow-lg",
              "overflow-hidden flex flex-col",
              "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
              "focus-visible:outline-none",
            )}
            aria-labelledby={headerId}
          >
            {/* Header sticky com counter + ação Limpar */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 bg-surface-strong border-b border-border">
              <span
                id={headerId}
                className="text-[11px] font-bold uppercase tracking-wider text-fg-muted"
              >
                {selected.length === 0
                  ? "Todas as audiências"
                  : `${selected.length} de ${lines.length}`}
              </span>
              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={clear}
                  className="text-[11px] font-semibold text-signature hover:text-signature-hover px-2 py-0.5 rounded-md hover:bg-signature-soft transition-colors cursor-pointer"
                >
                  Limpar
                </button>
              )}
            </div>

            {/* Lista scrollável de checkboxes */}
            <div className="overflow-y-auto flex-1">
              {lines.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-fg-subtle">
                  Nenhuma audiência disponível.
                </div>
              ) : (
                lines.map((line) => {
                  const checked = selected.includes(line);
                  const parts = line.split("_");
                  const shortLabel =
                    parts.length > 3 ? "…_" + parts.slice(-3).join("_") : line;
                  return (
                    <label
                      key={line}
                      title={line}
                      className={cn(
                        "flex items-center gap-2.5 px-4 py-2.5 cursor-pointer",
                        "border-b border-border/40 last:border-b-0",
                        "transition-colors",
                        checked
                          ? "bg-signature-soft hover:bg-signature/20"
                          : "hover:bg-surface",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(line)}
                        className="sr-only peer"
                      />
                      {/* Checkbox custom — mantém visual do Legacy */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          "shrink-0 w-4 h-4 rounded-[4px] border-2 inline-flex items-center justify-center",
                          "transition-colors",
                          checked
                            ? "bg-signature border-signature"
                            : "border-fg-subtle",
                          "peer-focus-visible:ring-2 peer-focus-visible:ring-signature peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-canvas-elevated",
                        )}
                      >
                        {checked && (
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="none"
                            stroke="white"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M1.5 5.5L4 8L8.5 2" />
                          </svg>
                        )}
                      </span>
                      <span
                        className={cn(
                          "text-xs flex-1 min-w-0 truncate",
                          checked
                            ? "text-fg font-semibold"
                            : "text-fg-muted font-normal",
                        )}
                      >
                        {shortLabel}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {/* Botão de limpar fora do trigger — atalho consistente com Legacy.
          Aparece somente quando há filtro ativo. */}
      {isActive && (
        <button
          type="button"
          onClick={clear}
          aria-label="Limpar filtro de audiência"
          title="Limpar filtro"
          className={cn(
            "inline-flex items-center justify-center w-7 h-7 rounded-full",
            "border border-border text-fg-subtle",
            "hover:border-danger hover:text-danger",
            "transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
          )}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M2 2L10 10M10 2L2 10" />
          </svg>
        </button>
      )}
    </div>
  );
}
