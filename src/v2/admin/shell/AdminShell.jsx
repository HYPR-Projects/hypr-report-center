// src/v2/admin/shell/AdminShell.jsx
//
// O único dono do chrome administrativo. As três rotas admin
// (CampaignMenuV2, PmpDealsPage, ClientDetailPage) passam a ser SÓ
// conteúdo — antes cada uma repetia o próprio header à mão, e as três já
// tinham divergido: o botão "Sair" era `h-9 md:h-8` em duas e `h-8` na
// outra, o gap era `gap-2 md:gap-3` versus `gap-3`, e o ClientDetailPage
// não tinha indicador de frescor nenhum (quem estava no drilldown de um
// cliente não sabia se o dado era de hoje).
//
// Estrutura
// ────────────────────────────────────────────────────────────────────────
//   ┌─────────┬───────────────────────────────────────┐
//   │  rail   │  AdminContextBar (52px, fixa)         │
//   │  248px  ├───────────────────────────────────────┤
//   │  ou 68  │  scroll: PageHeader, KPIs, FilterBar, │
//   │         │          conteúdo da view             │
//   └─────────┴───────────────────────────────────────┘
//
// O scroll é do PAINEL, não da janela. Isso é o que permite a barra de
// contexto e a FilterBar ficarem fixas sem `position: fixed` e sem
// calcular offsets à mão — e é o que faz o rail nunca rolar junto.
//
// Consequência a conhecer: `window.scrollTo` não move mais o conteúdo
// admin. Quem precisava disso recebe `scrollToTop` via
// `useAdminShellScroll`.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { cn } from "../../../ui/cn";
import { AdminSidebar } from "./AdminSidebar";
import { AdminContextBar } from "./AdminContextBar";
import { useShellState } from "./useShellState";
import { NAV_GROUPS, viewMeta } from "./navConfig";
import { ShellContext } from "./shellContext";

const RAIL_W           = 248;
const RAIL_W_COLLAPSED = 68;

export function AdminShell({
  // Navegação
  section,
  layout,
  navCounts,
  onNavigate,
  // Contexto
  viewLabel,
  tally,
  actions,
  busy = false,
  // Operação (popovers já montados pela página — cada um traz seu fetch)
  operationSlots,
  // Usuário
  user,
  onLogout,
  // Conteúdo
  children,
  // Largura da coluna: `wide` vem da view (só as tabelas pedem 1600px).
  wide,
}) {
  const {
    collapsed, toggleCollapsed,
    density, setDensity, isDense,
    drawerOpen, openDrawer, closeDrawer,
  } = useShellState();

  const scrollRef = useRef(null);
  const searchFocusRef = useRef(null);

  const scrollToTop = useCallback((behavior = "smooth") => {
    scrollRef.current?.scrollTo({ top: 0, behavior });
  }, []);

  // A página registra como focar sua própria busca; o rail e a tecla "/"
  // chamam por aqui. Devolve o desregistrador pro cleanup do effect.
  const registerSearchFocus = useCallback((fn) => {
    searchFocusRef.current = fn;
    return () => {
      if (searchFocusRef.current === fn) searchFocusRef.current = null;
    };
  }, []);

  const focusSearch = useCallback(() => {
    const fn = searchFocusRef.current;
    if (!fn) return false;
    fn();
    return true;
  }, []);

  const shellApi = useMemo(
    () => ({ scrollToTop, registerSearchFocus, isDense }),
    [scrollToTop, registerSearchFocus, isDense],
  );

  // ── Atalhos de teclado ────────────────────────────────────────────────
  //   ⌘\ / Ctrl+\  → colapsa e expande o rail
  //   /            → foca a busca da view (padrão GitHub/Linear)
  // Ambos são ignorados quando o foco está num campo de texto — digitar
  // "/" numa busca não pode roubar o próprio foco.
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggleCollapsed();
        return;
      }
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (focusSearch()) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCollapsed, focusSearch]);

  // Navegar fecha a gaveta e volta o scroll pro topo. `instant` aqui de
  // propósito: trocar de view é uma troca de página, e animar o scroll de
  // uma página que já sumiu é só atraso percebido.
  const handleNavigate = useCallback((nextSection, nextLayout) => {
    closeDrawer();
    onNavigate(nextSection, nextLayout);
    scrollRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [closeDrawer, onNavigate]);

  const group = NAV_GROUPS.find((g) => g.id === section);
  const meta  = section && layout ? viewMeta(section, layout) : null;
  // `wide` explícito ganha do que a view declara — o ClientDetailPage não
  // tem view interna e precisa poder dizer a própria largura.
  const isWide = wide != null ? wide : !!meta?.wide;

  const sidebarProps = {
    section, layout,
    counts: navCounts,
    onNavigate: handleNavigate,
    onSearch: focusSearch,
    operationSlots,
    user, onLogout,
    density, onDensityChange: setDensity,
  };

  return (
    <ShellContext.Provider value={shellApi}>
      <div className="flex h-screen w-full overflow-hidden bg-canvas text-fg">

        {/* ── Rail (desktop) ───────────────────────────────────────────── */}
        <aside
          aria-label="Navegação lateral"
          className={cn(
            "hidden md:flex shrink-0 flex-col border-r border-border",
            "transition-[width] duration-200 ease-out motion-reduce:transition-none",
          )}
          style={{ width: collapsed ? RAIL_W_COLLAPSED : RAIL_W }}
        >
          <AdminSidebar {...sidebarProps} collapsed={collapsed} />
        </aside>

        {/* ── Gaveta (mobile) ──────────────────────────────────────────── */}
        {/* Sempre montada pra que a transição de entrada exista. O `inert`
            (não só o `pointer-events-none`) é o que impede o Tab de entrar
            numa gaveta fechada — sem ele, os 13 itens do rail continuam na
            ordem de tabulação atrás do conteúdo.

            `inert` é boolean de verdade no React 19: passar string vazia
            dispara "Received an empty string for a boolean attribute" e o
            React trata como false, ou seja, o oposto do pretendido. */}
        <div
          className={cn(
            "md:hidden fixed inset-0 z-[60] transition-opacity duration-200",
            drawerOpen ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
          aria-hidden={!drawerOpen}
          inert={!drawerOpen}
        >
          <button
            type="button"
            aria-label="Fechar navegação"
            onClick={closeDrawer}
            className="absolute inset-0 w-full bg-black/50 cursor-default border-0"
          />
          <div
            className={cn(
              "absolute inset-y-0 left-0 w-[276px] max-w-[85vw] shadow-lg",
              "border-r border-border",
              "transition-transform duration-200 ease-out motion-reduce:transition-none",
              drawerOpen ? "translate-x-0" : "-translate-x-full",
            )}
          >
            <AdminSidebar {...sidebarProps} isDrawer onCloseDrawer={closeDrawer} collapsed={false} />
          </div>
        </div>

        {/* ── Conteúdo ─────────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col">
          <AdminContextBar
            sectionLabel={group?.label}
            viewLabel={viewLabel || meta?.label || group?.label || "Admin"}
            tally={tally}
            onSectionClick={
              group
                ? () => handleNavigate(group.id, group.views[0].layout)
                : undefined
            }
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onOpenDrawer={openDrawer}
            density={density}
            onDensityChange={setDensity}
            actions={actions}
            busy={busy}
          />

          <main
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-thin"
          >
            <div className={cn(isWide ? "shell-wide" : "shell-col", "py-5 md:py-6")}>
              {children}
            </div>
          </main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}
