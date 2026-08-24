// src/v2/admin/components/FilterBar.jsx
//
// Uma barra, um lugar para o estado do filtro.
//
// O QUE ISTO SUBSTITUI
// ────────────────────────────────────────────────────────────────────────
// No menu admin o filtro vivia em sete lugares: a busca, o multiselect de
// owner, o select de ordenação, o botão de direção, a pill "Apenas ativas",
// dez pills de mês e três pills de worklist. Ao clicar numa pill de
// worklist aparecia um OITAVO elemento — o `ActiveWorklistBanner`, faixa
// cheia em `signature-soft` — só pra dizer que o filtro estava ativo. Três
// linguagens visuais para uma única interação: ver a contagem, filtrar,
// saber que está filtrado.
//
// No PMP era pior: busca + Cliente + Bid + Fonte + Status, mais
// período/trimestre/mês por aba, mais o `SortChip`, mais situação/ciclo da
// Carteira — e DOIS links "Limpar" em linhas diferentes, cada um limpando
// um subconjunto distinto.
//
// E em nenhuma das dez views existia um "você está vendo X de Y".
//
// COMO FUNCIONA
// ────────────────────────────────────────────────────────────────────────
// A página declara os filtros; a barra desenha. Cada filtro é um chip que
// mostra o VALOR quando setado (`Owner · João Buzolin`) e só o rótulo
// quando não. Abaixo, os filtros ativos viram chips removíveis com um
// "Limpar tudo" único e a contagem de resultados à direita.
//
//   <FilterBar
//     search={search} onSearchChange={setSearch}
//     chips={[
//       { id: "owner", label: "Owner", value: "João Buzolin", panel: (close) => <OwnerPanel …/> },
//       { id: "period", label: "Período", value: "Ago 26", panel: … },
//     ]}
//     active={[{ id: "period", label: "Ago 26", onClear: … }]}
//     onClearAll={…}
//     resultLabel="4 de 490 campanhas"
//   />
//
// A barra é `sticky` no topo do scroller do shell. Numa lista de 490 itens
// isso é a diferença entre poder refinar de onde você está e ter que rolar
// de volta ao topo pra mexer num filtro.

import { forwardRef, useCallback, useEffect, useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../../ui/cn";
import { useAdminShell } from "../shell/shellContext";
import { filterChipClass } from "./filterChipStyle";

// ─────────────────────────────────────────────────────────────────────────
// Barra
// ─────────────────────────────────────────────────────────────────────────
export function FilterBar({
  // Busca
  search,
  onSearchChange,
  searchPlaceholder = "Buscar…",
  // Filtros declarados pela view
  chips = [],
  // Filtros ativos (chips removíveis)
  active = [],
  onClearAll,
  // "4 de 490 campanhas"
  resultLabel,
  // Nó extra à direita da linha de chips (ex: aviso de janela do Histórico)
  trailing,
  // Aviso derivado do filtro — encosta na linha de ativos, onde nasceu
  notice,
  className,
}) {
  const inputRef = useRef(null);
  const { registerSearchFocus } = useAdminShell();
  const [stuck, setStuck] = useState(false);
  const sentinelRef = useRef(null);

  // Registra o foco da busca no shell — é o que faz a tecla "/" e o botão
  // "Buscar" do rail chegarem até aqui sem prop drilling.
  useEffect(() => {
    if (!onSearchChange) return;
    return registerSearchFocus(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [registerSearchFocus, onSearchChange]);

  // Sombra só quando a barra realmente encostou. Um IntersectionObserver
  // sobre um sentinela de 1px é o jeito de detectar isso sem ouvir `scroll`
  // (que dispararia dezenas de vezes por segundo numa lista longa).
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => setStuck(!entry.isIntersecting),
      { threshold: 1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const hasActive = active.length > 0;

  return (
    <>
      <div ref={sentinelRef} aria-hidden="true" className="h-px" />
      <div
        className={cn(
          "sticky top-0 z-20 -mx-1 px-1 pt-2.5 pb-2.5 mb-1",
          "bg-canvas/92 backdrop-blur-md",
          "border-b transition-colors duration-200",
          stuck ? "border-border" : "border-transparent",
          className,
        )}
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          {onSearchChange && (
            <SearchField
              ref={inputRef}
              value={search}
              onChange={onSearchChange}
              placeholder={searchPlaceholder}
            />
          )}

          {chips.map((chip) => (
            <FilterChip key={chip.id} {...chip} />
          ))}

          {trailing}
        </div>

        {(hasActive || resultLabel || notice) && (
          <div className="flex items-center gap-1.5 flex-wrap pt-2">
            {hasActive && (
              <>
                <span className="text-[9.5px] font-extrabold uppercase tracking-[0.13em] text-fg-subtle mr-0.5">
                  Filtros
                </span>
                {active.map((f) => (
                  <ActiveChip key={f.id} label={f.label} onClear={f.onClear} />
                ))}
                {onClearAll && active.length > 1 && (
                  <button
                    type="button"
                    onClick={onClearAll}
                    className={cn(
                      "border-0 bg-transparent cursor-pointer px-1",
                      "text-[11px] font-semibold text-fg-subtle hover:text-fg",
                      "underline underline-offset-2 transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature rounded",
                    )}
                  >
                    Limpar tudo
                  </button>
                )}
              </>
            )}

            {notice && (
              <span className="text-[11px] text-fg-muted inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-signature shrink-0" />
                {notice}
              </span>
            )}

            {resultLabel && (
              <span
                role="status"
                className="ml-auto text-[11px] text-fg-subtle tabular-nums whitespace-nowrap"
              >
                {resultLabel}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Busca
// ─────────────────────────────────────────────────────────────────────────
const SearchField = forwardRef(function SearchField({ value, onChange, placeholder }, ref) {
  return (
    <div
      className={cn(
        "flex-1 min-w-[190px] basis-[240px] h-8 flex items-center gap-2 px-2.5",
        "rounded-md bg-surface border border-border",
        "focus-within:border-signature transition-colors",
      )}
    >
      <svg
        width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        aria-hidden="true" className="text-fg-subtle shrink-0"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" strokeLinecap="round" />
      </svg>
      <input
        ref={ref}
        type="search"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn(
          "flex-1 min-w-0 bg-transparent border-0 outline-none",
          "text-[12.5px] text-fg placeholder:text-fg-subtle",
          // Chrome desenha um X próprio no type=search que não segue o
          // tema; a limpeza acontece pelo chip de filtro ativo.
          "[&::-webkit-search-cancel-button]:hidden",
        )}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Limpar busca"
          className={cn(
            "shrink-0 size-4 grid place-items-center rounded-full border-0 cursor-pointer",
            "bg-transparent text-fg-subtle hover:bg-surface-strong hover:text-fg transition-colors",
          )}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      ) : null}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Chip de filtro
// ─────────────────────────────────────────────────────────────────────────
/** Chevron do chip — o mesmo glifo, na mesma medida, em todos eles. */
export function FilterChipChevron({ open }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" aria-hidden="true"
      className={cn("shrink-0 transition-transform duration-150", open && "rotate-180")}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Valor exibido no chip (`Período · Ago 26`). */
export function FilterChipValue({ children }) {
  return (
    <>
      <span aria-hidden="true" className="text-fg-subtle">·</span>
      <span className="font-bold text-fg max-w-[150px] truncate">{children}</span>
    </>
  );
}

/**
 * Um chip. Três formas de uso, na ordem de preferência:
 *
 *   panel   — função `(close) => ReactNode`, abre num Popover. É o caso
 *             normal: owner, período, status, cliente.
 *   onClick — ação direta, sem painel. Usado por toggles binários
 *             ("Apenas ativas").
 *   nenhum  — chip inerte (raro; só quando a view quer exibir um recorte
 *             que não é editável ali).
 *
 * `value` é o que transforma o chip de rótulo em resumo: com valor setado
 * ele mostra `Owner · João Buzolin` e ganha o tratamento signature. Era
 * exatamente essa leitura que faltava — antes você tinha que abrir cada
 * dropdown pra descobrir o que estava filtrando.
 */
export function FilterChip({
  label,
  value,
  icon,
  panel,
  onClick,
  pressed,
  count,
  align = "start",
  panelClassName,
  disabled,
}) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const isSet = value != null || pressed === true;

  const body = (
    <>
      {icon && (
        <span
          aria-hidden="true"
          className={cn("shrink-0 grid place-items-center", isSet ? "text-signature" : "text-fg-subtle")}
        >
          {icon}
        </span>
      )}
      <span className={isSet ? "font-semibold" : undefined}>{label}</span>
      {value != null && <FilterChipValue>{value}</FilterChipValue>}
      {count != null && (
        <span
          className={cn(
            "shrink-0 min-w-[17px] h-[16px] px-1 rounded-full inline-flex items-center justify-center",
            "text-[9.5px] font-extrabold tabular-nums",
            isSet ? "bg-signature-fill text-on-signature" : "bg-surface-strong text-fg-muted",
          )}
        >
          {count}
        </span>
      )}
      {panel && <FilterChipChevron open={open} />}
    </>
  );

  const classes = filterChipClass({ isSet, disabled });

  if (!panel) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={pressed != null ? pressed : undefined}
        disabled={disabled}
        className={classes}
      >
        {body}
      </button>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-expanded={open} disabled={disabled} className={classes} id={labelId}>
          {body}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align={align}
          collisionPadding={16}
          aria-labelledby={labelId}
          className={cn(
            "z-50 w-[280px] max-w-[calc(100vw-32px)]",
            "rounded-xl border border-border bg-canvas-elevated shadow-lg overflow-hidden",
            "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
            "focus-visible:outline-none",
            panelClassName,
          )}
        >
          {panel(() => setOpen(false))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Chip ativo (removível)
// ─────────────────────────────────────────────────────────────────────────
function ActiveChip({ label, onClear }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 h-[23px] pl-2.5 pr-1 rounded-full",
        "bg-signature-soft border border-signature",
        "text-[11px] font-semibold text-fg",
      )}
    >
      <span className="max-w-[220px] truncate">{label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remover filtro: ${label}`}
        className={cn(
          "shrink-0 size-[15px] grid place-items-center rounded-full border-0 cursor-pointer",
          "bg-transparent text-fg-muted hover:bg-surface-strong hover:text-fg transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
        )}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Peças de painel — o miolo dos popovers
// ─────────────────────────────────────────────────────────────────────────
/** Moldura padrão: título opcional, corpo com scroll, pé opcional. */
export function FilterPanel({ title, children, footer, maxHeight = 320 }) {
  return (
    <div>
      {title && (
        <div className="px-3 py-2 border-b border-border bg-surface-strong">
          <span className="text-[9.5px] font-extrabold uppercase tracking-[0.13em] text-fg-muted">
            {title}
          </span>
        </div>
      )}
      <div className="overflow-y-auto scrollbar-thin p-1.5" style={{ maxHeight }}>
        {children}
      </div>
      {footer && <div className="px-2 py-1.5 border-t border-border">{footer}</div>}
    </div>
  );
}

/**
 * Linha selecionável do painel. `multi` desenha caixa; single desenha
 * marca de seleção — a mesma distinção que o OwnerFilter já fazia, agora
 * disponível pra todo filtro em vez de reimplementada por cada um.
 */
export function FilterOption({ label, sub, count, selected, onSelect, multi = false }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      role={multi ? "checkbox" : "menuitemradio"}
      aria-checked={!!selected}
      className={cn(
        "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md cursor-pointer border-0 text-left",
        "bg-transparent hover:bg-surface transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
      )}
    >
      {multi ? (
        <span
          aria-hidden="true"
          className={cn(
            "shrink-0 size-[15px] rounded border grid place-items-center transition-colors",
            selected ? "bg-signature-fill border-signature" : "border-border-strong bg-transparent",
          )}
        >
          {selected && (
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"
                 strokeLinecap="round" strokeLinejoin="round" className="text-on-signature">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </span>
      ) : (
        <span aria-hidden="true" className="shrink-0 size-[15px] grid place-items-center text-signature">
          {selected && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </span>
      )}

      <span className="flex-1 min-w-0">
        <span className={cn("block text-[12.5px] truncate", selected ? "font-semibold text-fg" : "text-fg-muted")}>
          {label}
        </span>
        {sub && <span className="block text-[10px] text-fg-subtle truncate">{sub}</span>}
      </span>

      {count != null && (
        <span className="shrink-0 text-[10.5px] font-bold text-fg-subtle tabular-nums">{count}</span>
      )}
    </button>
  );
}

/** Cabeçalho de bloco dentro de um painel (ex: "CP" / "CS" no owner). */
export function FilterGroupLabel({ children }) {
  return (
    <div className="px-2 pt-2 pb-1 text-[9px] font-extrabold uppercase tracking-[0.13em] text-fg-subtle">
      {children}
    </div>
  );
}

/** Pé "Limpar" padrão dos painéis. */
export function FilterPanelClear({ onClear, disabled, label = "Limpar seleção" }) {
  return (
    <button
      type="button"
      onClick={onClear}
      disabled={disabled}
      className={cn(
        "w-full h-7 rounded-md border-0 bg-transparent cursor-pointer",
        "text-[11.5px] font-semibold text-fg-subtle hover:text-fg hover:bg-surface transition-colors",
        "disabled:opacity-40 disabled:pointer-events-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Ordenação como chip. Campo + direção num painel só — antes eram dois
 * controles lado a lado (um `<select>` nativo e um botão de seta), e o
 * `<select>` do PMP ainda vinha com um chevron em `stroke='%23999'`
 * cravado em `style` inline, cego a tema.
 */
export function SortChipFilter({ options, value, dir, onValueChange, onDirToggle, defaultValue, defaultDir }) {
  const current = options?.find((o) => o.value === value);
  const isDefault = value === defaultValue && dir === defaultDir;

  const groups = groupBy(options || [], (o) => o.group || "");

  const handlePick = useCallback((next, close) => {
    onValueChange(next);
    close();
  }, [onValueChange]);

  return (
    <FilterChip
      label="Ordenar"
      value={isDefault ? undefined : current?.label}
      align="end"
      icon={
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4" />
        </svg>
      }
      panel={(close) => (
        <FilterPanel
          title="Ordenar por"
          footer={
            <div className="flex items-center gap-1.5">
              <DirButton active={dir === "desc"} onClick={() => dir !== "desc" && onDirToggle()} label="Maior → menor" dir="desc" />
              <DirButton active={dir === "asc"}  onClick={() => dir !== "asc"  && onDirToggle()} label="Menor → maior" dir="asc" />
            </div>
          }
        >
          {groups.map(([groupName, opts]) => (
            <div key={groupName || "_"}>
              {groupName && <FilterGroupLabel>{groupName}</FilterGroupLabel>}
              {opts.map((o) => (
                <FilterOption
                  key={o.value}
                  label={o.label}
                  selected={o.value === value}
                  onSelect={() => handlePick(o.value, close)}
                />
              ))}
            </div>
          ))}
        </FilterPanel>
      )}
    />
  );
}

function DirButton({ active, onClick, label, dir }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={cn(
        "flex-1 h-7 rounded-md inline-flex items-center justify-center gap-1.5 cursor-pointer border",
        "text-[11px] font-semibold transition-colors",
        active
          ? "bg-signature-soft border-signature text-fg"
          : "bg-transparent border-border text-fg-subtle hover:text-fg hover:bg-surface",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
      )}
    >
      <svg
        width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className={dir === "asc" ? "rotate-180" : undefined}
      >
        <path d="M12 5v14M19 12l-7 7-7-7" />
      </svg>
      {dir === "desc" ? "Maior" : "Menor"}
    </button>
  );
}

function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()];
}
