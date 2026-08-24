// src/v2/admin/shell/AdminSidebar.jsx
//
// O rail. Três blocos fixos e um scrollável no meio:
//
//   marca         — logo (vira monograma colapsado) + botão de colapsar
//   [scroll]      — busca global, grupos de navegação, grupo Operação
//   pé            — usuário → menu (tema, densidade, demo, sair)
//
// Por que os grupos são colapsáveis mas nascem abertos
// ────────────────────────────────────────────────────────────────────────
// Reports (5) + PMP (5) + Operação (3) = 13 linhas de 33px + 3 cabeçalhos.
// Cabe em ~520px, folgado em qualquer viewport de trabalho. Deixar tudo à
// vista é o que faz o salto entre seções custar UM clique — que era
// exatamente o problema do botão "PMP Deals" perdido no herói. Quem não
// usa uma seção pode fechá-la, e a escolha persiste.
//
// Grupos colapsados no rail colapsado: não. Com 68px de largura não há
// rótulo de grupo pra clicar, e esconder ícones atrás de um acordeão
// invisível é pior que mostrar 13 ícones. No estado colapsado os grupos
// ficam sempre abertos e o separador vira uma régua curta.

import { useCallback, useEffect, useState } from "react";
import { cn } from "../../../ui/cn";
import HyprReportCenterLogo from "../../../components/HyprReportCenterLogo";
import { AdminNavItem } from "./AdminNavItem";
import { ChevronDownIcon, SearchIcon, CloseIcon } from "./navIcons";
import { NAV_GROUPS } from "./navConfig";
import { UserMenu } from "./UserMenu";

const LS_CLOSED_GROUPS = "hypr.admin.railClosedGroups";

function readClosedGroups() {
  try {
    const raw = localStorage.getItem(LS_CLOSED_GROUPS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((g) => typeof g === "string") : [];
  } catch { return []; }
}

export function AdminSidebar({
  section,
  layout,
  counts = {},
  onNavigate,
  onSearch,
  // Slots de Operação — o AdminShell injeta os popovers já montados
  // (Bases, DSPs, Alertas) porque cada um traz o próprio estado e fetch.
  operationSlots = null,
  // Mobile
  isDrawer = false,
  onCloseDrawer,
  collapsed = false,
  // Usuário
  user,
  onLogout,
  density,
  onDensityChange,
}) {
  const [closedGroups, setClosedGroups] = useState(readClosedGroups);

  useEffect(() => {
    try { localStorage.setItem(LS_CLOSED_GROUPS, JSON.stringify(closedGroups)); }
    catch { /* ignore */ }
  }, [closedGroups]);

  const toggleGroup = useCallback((id) => {
    setClosedGroups((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]
    );
  }, []);

  // No rail colapsado o acordeão não se aplica (ver nota do topo).
  const isGroupOpen = (id) => collapsed || !closedGroups.includes(id);

  return (
    <div className="flex flex-col h-full min-h-0 bg-canvas-elevated">

      {/* ── Marca ──────────────────────────────────────────────────────── */}
      {/* O wordmark oficial tem proporção 8,13:1 — a 26px de altura ele
          mede ~211px, que é exatamente o que sobra numa faixa de 248px com
          o padding do rail. Por isso o botão de colapsar NÃO mora aqui: ele
          vive na barra de contexto, junto dos outros controles de chrome.
          Dividir esta faixa com um botão de 28px forçaria o logo a ~22px,
          e aí o wordmark começa a fechar os contraformas. */}
      <div
        className={cn(
          "h-14 shrink-0 flex items-center gap-2 border-b border-border",
          "pl-4 pr-3",
          !isDrawer && "rail-collapsed:px-0 rail-collapsed:justify-center",
        )}
      >
        <button
          type="button"
          onClick={() => onNavigate(NAV_GROUPS[0].id, NAV_GROUPS[0].views[0].layout)}
          aria-label="Ir para Reports por mês"
          title="Reports · Por mês"
          className={cn(
            "flex items-center min-w-0 text-fg cursor-pointer rounded",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-elevated",
          )}
        >
          <span className={cn(!isDrawer && "rail-collapsed:hidden")}>
            <HyprReportCenterLogo height={26} />
          </span>
          {/* Colapsado: monograma. Um recorte do wordmark daria uma fatia
              arbitrária de letras; o "H°" é a marca de fato. */}
          {!isDrawer && (
            <span className="hidden rail-collapsed:block text-[15px] font-extrabold tracking-[0.08em] leading-none">
              H<sup className="text-[8px] align-super">o</sup>
            </span>
          )}
        </button>

        {isDrawer && (
          <button
            type="button"
            onClick={onCloseDrawer}
            aria-label="Fechar navegação"
            className={cn(
              "ml-auto shrink-0 size-8 grid place-items-center rounded-md",
              "text-fg-subtle hover:bg-surface-strong hover:text-fg transition-colors cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
            )}
          >
            <CloseIcon />
          </button>
        )}
      </div>

      {/* ── Navegação ──────────────────────────────────────────────────── */}
      <nav
        aria-label={isDrawer ? "Navegação do admin (gaveta)" : "Navegação do admin"}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pt-2.5 pb-1 scrollbar-thin"
      >
        {/* Busca global — abre a busca da view atual com foco. É a mesma
            caixa de busca que já existia; o que muda é ter um ponto de
            entrada fixo, alcançável de qualquer scroll. */}
        {onSearch && (
          <button
            type="button"
            onClick={onSearch}
            className={cn(
              "w-full flex items-center gap-2 h-8 px-2.5 mb-3 rounded-md cursor-pointer",
              "bg-surface border border-border text-fg-subtle text-[12.5px]",
              "hover:border-border-strong hover:text-fg-muted transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
              "rail-collapsed:justify-center rail-collapsed:px-0",
            )}
          >
            <span className="shrink-0 grid place-items-center"><SearchIcon /></span>
            <span className="rail-collapsed:hidden">Buscar</span>
            <span
              className={cn(
                "ml-auto font-mono text-[9.5px] px-1 py-px rounded",
                "bg-canvas-deeper border border-border text-fg-subtle",
                "rail-collapsed:hidden",
              )}
            >
              /
            </span>
          </button>
        )}

        {NAV_GROUPS.map((group) => {
          const open = isGroupOpen(group.id);
          return (
            <div key={group.id} className="mb-3.5">
              <GroupLabel
                label={group.label}
                open={open}
                collapsible={!collapsed}
                onToggle={() => toggleGroup(group.id)}
              />
              {open && (
                <div>
                  {group.views.map((view) => (
                    <AdminNavItem
                      key={`${group.id}:${view.layout}`}
                      icon={view.icon}
                      label={view.label}
                      count={view.count ? counts[view.count] : undefined}
                      badge={view.badge ? counts[view.badge] : undefined}
                      active={section === group.id && layout === view.layout}
                      onClick={() => onNavigate(group.id, view.layout)}
                      tipHint={
                        view.badge && counts[view.badge]
                          ? `${counts[view.badge]} críticas`
                          : (view.count ? counts[view.count] : undefined)
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* ── Operação ─────────────────────────────────────────────────── */}
        {operationSlots && (
          <div className="mb-2">
            <GroupLabel label="Operação" open collapsible={false} />
            {operationSlots}
          </div>
        )}
      </nav>

      {/* ── Pé ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-border p-2">
        <UserMenu
          user={user}
          onLogout={onLogout}
          density={density}
          onDensityChange={onDensityChange}
        />
      </div>
    </div>
  );
}

/**
 * Rótulo de grupo. Clicável quando o rail está expandido; no colapsado vira
 * uma régua curta centralizada — o separador que resta quando não há texto.
 */
function GroupLabel({ label, open, collapsible, onToggle }) {
  const text = (
    <>
      <span className="rail-collapsed:hidden">{label}</span>
      <span
        aria-hidden="true"
        className="hidden rail-collapsed:block w-5 h-px bg-border"
      />
    </>
  );

  const base = cn(
    "w-full flex items-center gap-1.5 px-3 mb-1",
    "text-[9.5px] font-extrabold uppercase tracking-[0.14em] text-fg-subtle",
    "rail-collapsed:justify-center rail-collapsed:px-0",
  );

  if (!collapsible) {
    return <div className={cn(base, "h-4")}>{text}</div>;
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        base, "h-4 border-0 bg-transparent cursor-pointer",
        "hover:text-fg-muted transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:rounded",
      )}
    >
      {text}
      <ChevronDownIcon
        size={11}
        className={cn(
          "shrink-0 transition-transform duration-200 rail-collapsed:hidden",
          !open && "-rotate-90",
        )}
      />
    </button>
  );
}
