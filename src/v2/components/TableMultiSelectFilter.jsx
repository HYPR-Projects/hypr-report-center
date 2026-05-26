// src/v2/components/TableMultiSelectFilter.jsx
//
// Filtro multi-select genérico pra DataTableV2 (e qualquer outra tabela
// que precise filtrar por valores discretos). Não é uma cópia do
// AudienceFilterV2: aquele é específico pra line_names (label "compacto"
// dos últimos 2 segmentos do _, ícone fixo de pessoas). Aqui é dropdown
// genérico — options são strings simples, ícone é passado por prop.
//
// Comportamento:
//   - selected = []  → "todos" (filtro inativo)
//   - selected = [x] → label do trigger mostra "x"
//   - selected = [x,y,...] → "N {pluralLabel}"
//   - Click no item toggla; "Limpar" reseta
//
// Estilo: trigger compacto (h-8) pra caber junto com o botão Download CSV
// na barra da DataTableV2 sem dominar visualmente. AudienceFilterV2 (h-9)
// é usado nas abas Display/Video onde os filtros são protagonistas.

import { useId } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../ui/cn";

export function TableMultiSelectFilter({
  label,           // "Audiência" | "Tamanho" | "Formato"
  pluralLabel,     // "audiências" | "tamanhos" | "formatos" — usado quando N>1
  options,         // string[] — valores únicos disponíveis
  selected,        // string[] — subset de `options`
  onChange,        // (newSelected: string[]) => void
  icon,            // ReactNode — SVG opcional (mesmo "slot" do AudienceFilterV2)
  formatLabel,     // (opt: string) => string — opcional, customiza display de cada item
}) {
  const headerId = useId();
  const isActive = selected.length > 0;
  const display = formatLabel || ((s) => s);

  const triggerLabel = !isActive
    ? label
    : selected.length === 1
      ? `${label}: ${display(selected[0])}`
      : `${selected.length} ${pluralLabel}`;

  const toggle = (val) => {
    if (selected.includes(val)) onChange(selected.filter((s) => s !== val));
    else onChange([...selected, val]);
  };

  const clear = () => onChange([]);

  return (
    <div className="inline-flex items-center gap-1.5">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={`Filtrar por ${label.toLowerCase()}`}
            className={cn(
              "inline-flex items-center gap-2 whitespace-nowrap",
              "h-8 px-3 rounded-full text-[11px] font-bold uppercase tracking-wider",
              "border transition-colors duration-150 cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
              "max-w-[240px]",
              isActive
                ? "bg-signature-soft border-signature/40 text-signature hover:border-signature/70"
                : "bg-surface border-border text-fg-muted hover:text-fg hover:border-border-strong",
            )}
          >
            {icon && <span className="shrink-0">{icon}</span>}
            <span className="truncate">{triggerLabel}</span>
            {isActive && (
              <span className="shrink-0 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-signature text-on-signature text-[9px] font-bold tabular-nums">
                {selected.length}
              </span>
            )}
            <svg
              width="9"
              height="9"
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
            align="start"
            className={cn(
              "z-50 w-[280px] max-w-[calc(100vw-32px)]",
              "max-h-[min(360px,calc(100vh-32px))]",
              "rounded-xl border border-border bg-canvas-elevated shadow-lg",
              "overflow-hidden flex flex-col",
              "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
              "focus-visible:outline-none",
            )}
            aria-labelledby={headerId}
          >
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-surface-strong border-b border-border">
              <span
                id={headerId}
                className="text-[10px] font-bold uppercase tracking-wider text-fg-muted"
              >
                {selected.length === 0
                  ? `Todos (${options.length})`
                  : `${selected.length} de ${options.length}`}
              </span>
              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={clear}
                  className="text-[10px] font-semibold text-signature hover:text-signature-hover px-2 py-0.5 rounded-md hover:bg-signature-soft transition-colors cursor-pointer"
                >
                  Limpar
                </button>
              )}
            </div>

            <div className="overflow-y-auto flex-1">
              {options.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-fg-subtle">
                  Sem opções disponíveis.
                </div>
              ) : (
                options.map((opt) => {
                  const checked = selected.includes(opt);
                  return (
                    <label
                      key={opt}
                      title={opt}
                      className={cn(
                        "flex items-center gap-2.5 px-4 py-2 cursor-pointer",
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
                        onChange={() => toggle(opt)}
                        className="sr-only peer"
                      />
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
                        {display(opt)}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {isActive && (
        <button
          type="button"
          onClick={clear}
          aria-label={`Limpar filtro de ${label.toLowerCase()}`}
          title="Limpar filtro"
          className={cn(
            "inline-flex items-center justify-center w-6 h-6 rounded-full",
            "border border-border text-fg-subtle",
            "hover:border-danger hover:text-danger",
            "transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
          )}
        >
          <svg
            width="10"
            height="10"
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
