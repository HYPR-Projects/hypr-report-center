// src/v2/admin/shell/AdminContextBar.jsx
//
// A faixa de 52px fixa no topo do conteúdo. Substitui o header de 64px que
// era copiado à mão nas três páginas admin — e faz um trabalho diferente
// dele.
//
// O header antigo carregava marca + widgets de status + identidade: nada
// que mudasse conforme o que você estava olhando. Ao rolar 500px numa
// lista de 490 campanhas você perdia em que view estava, quais filtros
// valiam, quantos resultados havia e onde estava "+ Novo Report" (que
// morava no herói e rolava pra fora).
//
// Esta barra carrega justamente o que muda:
//
//   [☰/⇤]  Seção / View  · contagem     [status de operação] │ [ações da view]
//
// A marca subiu pro rail. Tema, densidade e Sair estão no menu do usuário.
// O que sobra aqui é contexto, estado e ação — e tudo fica alcançável em
// qualquer posição de scroll.
//
// Status de operação (Bases, DSPs, Alertas, Sync das curadorias) morou no
// rail como grupo "Operação" entre ago e set/26. Saiu de lá porque o rail é
// navegação: 3 linhas de status com dot no meio de 10 destinos disputavam o
// mesmo olhar, e o rail colapsado escondia justamente o dot que importava.
// Aqui eles ficam ao lado das ações, no canto onde se olha pra "fazer algo"
// — e a densidade, que era preferência e não ação, foi pro menu do usuário.

import { cn } from "../../../ui/cn";
import { MenuIcon, PanelLeftIcon } from "./navIcons";

export function AdminContextBar({
  sectionLabel,
  viewLabel,
  tally,
  onSectionClick,
  // Chrome
  collapsed,
  onToggleCollapsed,
  onOpenDrawer,
  // Status de operação (popovers já montados pela página)
  status = null,
  // Ações da view (nós React já montados pela página)
  actions = null,
  // Sinal discreto de refetch em andamento
  busy = false,
}) {

  return (
    <div
      data-shell="context-bar"
      className={cn(
        // shell-header-row: MESMA altura da faixa da marca no rail.
        "shell-header-row flex items-center gap-3 px-4 md:px-5",
        "border-b border-border bg-canvas/85 backdrop-blur-md",
        // z acima do conteúdo e da FilterBar sticky, abaixo dos portais do
        // Radix (drawers e modais ficam em z-50+).
        "relative z-30",
      )}
    >
      {/* Hambúrguer (mobile) / colapsar rail (desktop). Um só slot: os dois
          controles fazem a mesma coisa conceitualmente — mostrar e esconder
          a navegação — então ocupam a mesma posição em cada breakpoint. */}
      <button
        type="button"
        onClick={onOpenDrawer}
        aria-label="Abrir navegação"
        className={cn(
          "md:hidden shrink-0 size-8 grid place-items-center rounded-md cursor-pointer",
          "border border-transparent bg-transparent text-fg-subtle",
          "hover:bg-surface hover:text-fg hover:border-border transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
        )}
      >
        <MenuIcon />
      </button>

      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? "Expandir navegação" : "Colapsar navegação"}
        title={collapsed ? "Expandir navegação  (⌘\\)" : "Colapsar navegação  (⌘\\)"}
        aria-expanded={!collapsed}
        className={cn(
          "hidden md:grid shrink-0 size-8 place-items-center rounded-md cursor-pointer",
          "border border-transparent bg-transparent text-fg-subtle",
          "hover:bg-surface hover:text-fg hover:border-border transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
        )}
      >
        <PanelLeftIcon size={16} collapsed={collapsed} />
      </button>

      {/* Rastro de navegação. Em mobile a seção some (o espaço é do que
          importa: a view atual e a contagem). */}
      <div className="flex items-center gap-2 min-w-0 text-[12.5px]">
        {sectionLabel && (
          <>
            {onSectionClick ? (
              <button
                type="button"
                onClick={onSectionClick}
                className={cn(
                  "hidden sm:inline shrink-0 border-0 bg-transparent cursor-pointer",
                  "font-semibold text-fg-subtle hover:text-fg transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature rounded",
                )}
              >
                {sectionLabel}
              </button>
            ) : (
              <span className="hidden sm:inline shrink-0 font-semibold text-fg-subtle">{sectionLabel}</span>
            )}
            <span aria-hidden="true" className="hidden sm:inline shrink-0 text-fg-subtle/50">/</span>
          </>
        )}

        <span className="font-bold text-fg truncate">{viewLabel}</span>

        {tally && (
          <span
            className={cn(
              "hidden md:inline shrink-0 px-2 py-0.5 rounded-full",
              "bg-surface text-[10.5px] font-bold text-fg-subtle tabular-nums whitespace-nowrap",
            )}
          >
            {tally}
          </span>
        )}

        {busy && (
          <span
            role="status"
            aria-label="Atualizando dados"
            className="shrink-0 size-1.5 rounded-full bg-signature animate-pulse"
          />
        )}
      </div>

      {/* ── Ações ──────────────────────────────────────────────────────── */}
      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        {/* Status de operação: botões-ícone de 32px com dot de severidade,
            cada um abrindo o próprio popover pra baixo. Ficam ANTES das
            ações e separados por uma régua: estado à esquerda, ação à
            direita — a ordem em que se lê ("está tudo bem? então faça"). */}
        {status && (
          <div
            role="group"
            aria-label="Status de operação"
            className="flex items-center gap-1.5"
          >
            {status}
          </div>
        )}
        {status && actions && (
          <span aria-hidden="true" className="mx-1 h-5 w-px bg-border shrink-0" />
        )}

        {actions}
      </div>
    </div>
  );
}
