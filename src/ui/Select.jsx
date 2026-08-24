// src/ui/Select.jsx
//
// O `<select>` nativo com a receita do design system.
//
// POR QUE ESTE COMPONENTE EXISTE
// ────────────────────────────────────────────────────────────────────────
// Havia duas receitas para o mesmo controle. O `ToolbarV2` resolvia o
// chevron com um SVG posicionado em `absolute` herdando `text-fg-subtle` —
// theme-aware, como o resto da interface. O select de ordenação da Carteira
// (PMP) resolvia com `style` inline e um data-URI de SVG com
// `stroke='%23999'` cravado: um cinza fixo, cego a tema, que no light fica
// mais escuro que o texto ao lado e no dark fica mais claro que a borda.
//
// Dois chevrons, dois comportamentos, um controle. Aqui é um.
//
// Mantém `<select>` nativo de propósito — agrupamento por `<optgroup>`,
// navegação por teclado e a roda nativa do mobile vêm de graça, e nenhum
// dos usos precisa de opção rica (ícone, subtítulo, multi). Filtros que
// precisam disso usam o `FilterChip` + `FilterOption` do FilterBar.
//
// API:
//   <Select value={v} onChange={setV} options={[{value,label,group?}]}
//           ariaLabel="Ordenar por" icon={<SortIcon/>} />

import { forwardRef, useMemo } from "react";
import { cn } from "./cn";

export const Select = forwardRef(function Select(
  { value, onChange, options = [], ariaLabel, icon, size = "md", className, ...rest },
  ref,
) {
  // Agrupa mantendo a ordem de inserção — a ordem visual do dropdown é a
  // ordem que o caller escreveu.
  const groups = useMemo(() => {
    const map = new Map();
    for (const opt of options) {
      const key = opt.group || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(opt);
    }
    return [...map.entries()];
  }, [options]);

  const h = size === "xs" ? "h-7" : size === "sm" ? "h-8" : "h-9";

  return (
    <div className={cn("relative inline-flex", className)}>
      <select
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={cn(
          "appearance-none w-full cursor-pointer",
          h,
          icon ? "pl-8" : (size === "xs" ? "pl-2" : "pl-3"),
          size === "xs" ? "pr-6" : "pr-7",
          "rounded-md",
          "bg-surface border border-border text-[12.5px] text-fg",
          "hover:bg-surface-strong hover:border-border-strong transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
          "focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
        )}
        {...rest}
      >
        {groups.map(([groupName, opts]) =>
          groupName ? (
            <optgroup key={groupName} label={groupName}>
              {opts.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </optgroup>
          ) : (
            opts.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))
          )
        )}
      </select>

      {icon && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle grid place-items-center"
        >
          {icon}
        </span>
      )}

      {/* O chevron: SVG em currentColor, herdando o token. É a única
          diferença que importa em relação ao data-URI que estava inline —
          e é o que faz o controle funcionar nos dois temas. */}
      <svg
        width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-fg-subtle",
          size === "xs" ? "right-1.5" : "right-2.5",
        )}
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
});
