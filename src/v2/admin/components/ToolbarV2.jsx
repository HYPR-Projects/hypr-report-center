// src/v2/admin/components/ToolbarV2.jsx
//
// Toolbar do menu admin — search + filtro de owner + opções de sort.
// Layout flex com search ocupando flex-1 e demais elementos shrink-fit.
//
// Componente "burro" — recebe valores e callbacks via props. Estado vive
// no CampaignMenuV2.

import { cn } from "../../../ui/cn";

export function ToolbarV2({
  search,
  onSearchChange,
  searchPlaceholder = "Buscar cliente, campanha ou token...",
  ownerFilter,
  onOwnerChange,
  teamMembers,
  sortBy,
  onSortByChange,
  showSortBy = true,
  className,
}) {
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

      {/* Owner select */}
      {teamMembers && (
        <div className="relative">
          <select
            value={ownerFilter || ""}
            onChange={(e) => onOwnerChange(e.target.value)}
            className={cn(
              "appearance-none h-9 pl-9 pr-8 rounded-lg",
              "bg-surface border border-border text-sm text-fg",
              "hover:bg-surface-strong transition-colors cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas"
            )}
          >
            <option value="">Todos os owners</option>
            {teamMembers.cps?.length > 0 && (
              <optgroup label="CPs">
                {teamMembers.cps.map((p) => (
                  <option key={p.email} value={p.email}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
            {teamMembers.css?.length > 0 && (
              <optgroup label="CSs">
                {teamMembers.css.map((p) => (
                  <option key={p.email} value={p.email}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {/* Ícone person */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
          </svg>
          {/* Chevron */}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
               className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      )}

      {/* Sort options */}
      {showSortBy && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle mr-1">
            Ordenar
          </span>
          {[
            { value: "month",      label: "Mês" },
            { value: "start_date", label: "Início" },
            { value: "alpha",      label: "A-Z" },
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSortByChange(opt.value)}
              className={cn(
                "h-7 px-3 rounded-md text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
                sortBy === opt.value
                  ? "bg-signature-soft text-signature border border-signature/30"
                  : "bg-surface text-fg-muted hover:text-fg hover:bg-surface-strong border border-transparent"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
