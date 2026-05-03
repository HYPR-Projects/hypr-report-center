// src/v2/admin/components/OwnerFilter.jsx
//
// Filtro multiselect de owners (CPs + CSs). Substitui o native <select>
// que permitia 1 só de cada vez.
//
// Por que multiselect
// ───────────────────
// User pediu: "ver as campanhas do CP Eduarda E do CS João" — caso real,
// owners se cruzam em todo lugar. Native <select multiple> não suporta
// optgroup com checkbox e renderiza como listbox feio. Radix Popover +
// checkboxes custom dá controle total + a11y de graça.
//
// Espelha o pattern do AudienceFilterV2 (mesma combo Popover + checkbox
// custom + header com "Limpar"), só muda o agrupamento (CPs / CSs em
// seções) e o trigger label.
//
// Comportamento
// ─────────────
// - selected vazio = "Todos os owners" (filtro inativo)
// - 1 selecionado: nome
// - 2+ selecionados: "Nome +N"
// - Header do popover mostra contador "X de Y"
// - Botão "Limpar" zera quando há filtro ativo
// - Setas ↑↓ navegam (vem do Radix), Espaço/Enter toggla o item

import { useId, useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../../ui/cn";

export function OwnerFilter({ selected, onChange, teamMembers }) {
  const headerId = useId();

  const allMembers = useMemo(() => {
    const cps = (teamMembers?.cps || []).map((p) => ({ ...p, role: "cp" }));
    const css = (teamMembers?.css || []).map((p) => ({ ...p, role: "cs" }));
    return [...cps, ...css];
  }, [teamMembers]);

  const totalCount = allMembers.length;
  const selectedCount = selected.length;
  const isActive = selectedCount > 0;

  // Label do trigger: nome do 1º + "+N" se houver mais. Resolve email→nome
  // pelo allMembers; fallback é o local-part do email.
  const triggerLabel = useMemo(() => {
    if (!isActive) return "Todos os owners";
    const firstEmail = selected[0];
    const firstMember = allMembers.find((m) => m.email === firstEmail);
    const firstName = firstMember?.name || firstEmail.split("@")[0];
    return selectedCount === 1 ? firstName : `${firstName} +${selectedCount - 1}`;
  }, [selected, allMembers, isActive, selectedCount]);

  const toggle = (email) => {
    if (selected.includes(email)) onChange(selected.filter((e) => e !== email));
    else onChange([...selected, email]);
  };
  const clear = () => onChange([]);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Filtrar por owner"
          className={cn(
            "inline-flex items-center gap-2 whitespace-nowrap",
            "h-9 pl-3 pr-3 rounded-lg text-sm",
            "border transition-colors duration-150 cursor-pointer max-w-[240px]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
            isActive
              ? "bg-signature-soft border-signature/40 text-signature hover:border-signature/70"
              : "bg-surface border-border text-fg hover:bg-surface-strong",
          )}
        >
          {/* Ícone person — bate com o do select antigo */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
          </svg>
          <span className="truncate">{triggerLabel}</span>
          {isActive && selectedCount > 1 && (
            <span className="shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-signature text-on-signature text-[10px] font-bold tabular-nums">
              {selectedCount}
            </span>
          )}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="opacity-60 shrink-0">
            <path d="m6 9 6 6 6-6" />
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
            "max-h-[min(440px,calc(100vh-32px))]",
            "rounded-xl border border-border bg-canvas-elevated shadow-lg",
            "overflow-hidden flex flex-col",
            "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
            "focus-visible:outline-none",
          )}
          aria-labelledby={headerId}
        >
          {/* Header com contador + Limpar */}
          <div className="flex items-center justify-between gap-2 px-4 py-3 bg-surface-strong border-b border-border">
            <span id={headerId} className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">
              {selectedCount === 0 ? "Todos os owners" : `${selectedCount} de ${totalCount}`}
            </span>
            {isActive && (
              <button
                type="button"
                onClick={clear}
                className="text-[11px] font-semibold text-signature hover:text-signature-hover px-2 py-0.5 rounded-md hover:bg-signature-soft transition-colors cursor-pointer"
              >
                Limpar
              </button>
            )}
          </div>

          {/* Lista scrollável agrupada CPs / CSs */}
          <div className="overflow-y-auto flex-1 py-1">
            {totalCount === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-fg-subtle">
                Nenhum owner disponível.
              </div>
            ) : (
              <>
                <Group label="CPs" people={teamMembers?.cps} selected={selected} onToggle={toggle} />
                <Group label="CSs" people={teamMembers?.css} selected={selected} onToggle={toggle} />
              </>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Group({ label, people, selected, onToggle }) {
  if (!people || people.length === 0) return null;
  return (
    <div className="py-1">
      <div className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      {people.map((p) => {
        const checked = selected.includes(p.email);
        return (
          <label
            key={p.email}
            className={cn(
              "flex items-center gap-2.5 px-4 py-2 cursor-pointer",
              "transition-colors",
              checked ? "bg-signature-soft hover:bg-signature/20" : "hover:bg-surface",
            )}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggle(p.email)}
              className="sr-only peer"
            />
            <span
              aria-hidden="true"
              className={cn(
                "shrink-0 w-4 h-4 rounded-[4px] border-2 inline-flex items-center justify-center",
                "transition-colors",
                checked ? "bg-signature border-signature" : "border-fg-subtle",
                "peer-focus-visible:ring-2 peer-focus-visible:ring-signature peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-canvas-elevated",
              )}
            >
              {checked && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 5.5L4 8L8.5 2" />
                </svg>
              )}
            </span>
            <span className={cn("text-xs flex-1 min-w-0 truncate", checked ? "text-fg font-semibold" : "text-fg-muted")}>
              {p.name}
            </span>
          </label>
        );
      })}
    </div>
  );
}
