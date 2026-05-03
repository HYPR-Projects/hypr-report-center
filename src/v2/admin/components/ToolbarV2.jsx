// src/v2/admin/components/ToolbarV2.jsx
//
// Toolbar do menu admin — search + filtro de owner + ordenação.
// Layout flex com search ocupando flex-1 e demais elementos shrink-fit.
//
// Componente "burro" — recebe valores e callbacks via props. Estado vive
// no CampaignMenuV2.
//
// Sort = <select> agrupado (campo) + botão de toggle (direção). User pode
// inverter ASC/DESC sem mudar o campo, padrão GitHub/Linear/Notion. Native
// select dá agrupamento + keyboard nav e bate com o filter de owner.

import { useMemo } from "react";
import { cn } from "../../../ui/cn";
import { OwnerFilter } from "./OwnerFilter";

export function ToolbarV2({
  search,
  onSearchChange,
  searchPlaceholder = "Buscar cliente, campanha ou token...",
  ownerFilter,
  onOwnerChange,
  teamMembers,
  sortBy,
  onSortByChange,
  sortDir,            // "asc" | "desc"
  onSortDirToggle,    // () => void
  // Lista de opções: [{ value, label, group }]. Cada `group` distinto
  // vira um <optgroup>. Se omitido, sort é escondido.
  sortOptions,
  className,
}) {
  // Agrupa as options por `group` mantendo a ordem de inserção — match
  // com a ordem visual do dropdown.
  const sortGroups = useMemo(() => {
    if (!sortOptions?.length) return null;
    const map = new Map();
    for (const opt of sortOptions) {
      const key = opt.group || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(opt);
    }
    return [...map.entries()];
  }, [sortOptions]);
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {/* Search field — flex-1 */}
      <div className="flex items-center gap-2 flex-1 min-w-[220px] h-9 px-3 rounded-lg bg-surface border border-border focus-within:border-signature/60 transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-fg-subtle shrink-0">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle outline-none"
        />
      </div>

      {/* Filtro multiselect de owners (CPs + CSs) — substitui o native
          <select> single-select. Componente próprio em OwnerFilter.jsx. */}
      {teamMembers && (
        <OwnerFilter
          selected={ownerFilter}
          onChange={onOwnerChange}
          teamMembers={teamMembers}
        />
      )}

      {/* Sort dropdown — escondido se sortOptions não vier (ex: layout=performers) */}
      {sortGroups && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
            Ordenar
          </span>
          <div className="relative">
            <select
              value={sortBy}
              onChange={(e) => onSortByChange(e.target.value)}
              aria-label="Ordenar por"
              className={cn(
                "appearance-none h-9 pl-9 pr-8 rounded-lg",
                "bg-surface border border-border text-sm text-fg",
                "hover:bg-surface-strong transition-colors cursor-pointer",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas"
              )}
            >
              {sortGroups.map(([groupName, opts]) => (
                groupName ? (
                  <optgroup key={groupName} label={groupName}>
                    {opts.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  opts.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))
                )
              ))}
            </select>
            {/* Ícone arrows up/down */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none">
              <path d="M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {/* Chevron */}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                 className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
          {/* Toggle de direção — só renderiza se o caller passou o handler.
            * Seta pra baixo = desc (maior → menor / mais recente → antigo / Z→A).
            * Seta pra cima  = asc  (menor → maior / antigo → recente / A→Z). */}
          {onSortDirToggle && (
            <button
              type="button"
              onClick={onSortDirToggle}
              aria-label={sortDir === "desc" ? "Ordem decrescente — clique pra inverter" : "Ordem crescente — clique pra inverter"}
              title={sortDir === "desc" ? "Maior → menor" : "Menor → maior"}
              className={cn(
                "h-9 w-9 rounded-lg flex items-center justify-center cursor-pointer",
                "bg-surface border border-border text-fg-muted",
                "hover:bg-surface-strong hover:text-fg transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas"
              )}
            >
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                className={cn(
                  "transition-transform duration-200",
                  sortDir === "asc" && "rotate-180"
                )}
              >
                <path d="M12 5v14M19 12l-7 7-7-7" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
