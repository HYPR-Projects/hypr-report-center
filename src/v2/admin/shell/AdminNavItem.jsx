// src/v2/admin/shell/AdminNavItem.jsx
//
// A linha do rail. Duas variantes do mesmo desenho:
//
//   AdminNavItem  — item de navegação (troca a view). Tem `aria-current`.
//   AdminRailRow  — linha genérica que serve de gatilho pra um popover
//                   (Bases, DSPs, Alertas). `forwardRef` + spread de props
//                   pra funcionar como `<Popover.Trigger asChild>`.
//
// Estado colapsado
// ────────────────────────────────────────────────────────────────────────
// Quando o rail encolhe pra 68px, rótulo e contagem somem e sobra o ícone
// centralizado. Um ícone sozinho não diz o que faz, então o tooltip deixa
// de ser cortesia e passa a ser a única legenda — por isso ele mostra
// rótulo E contagem, não só o rótulo.
//
// O tooltip é CSS puro (não o Tooltip do Radix) de propósito: são 13 itens
// permanentes no rail, e montar 13 Tooltip.Root com portal cada um pra uma
// dica de duas palavras é peso sem retorno. Ele fica atrelado ao `:hover`
// e ao `:focus-visible` do próprio botão — o que o torna alcançável por
// teclado também.
//
// A barra de seleção à esquerda carrega o estado ativo junto com o fundo.
// Só o fundo `signature-soft` não sobrevive ao rail colapsado: com 68px de
// largura, um retângulo tintado de 52px lê como "botão", não como "você
// está aqui". A barra vertical lê nos dois estados.

import { forwardRef } from "react";
import { cn } from "../../../ui/cn";

const ROW_BASE = [
  // h-8 (32px) é A altura de controle do DS — a mesma dos chips de
  // filtro, da busca e dos botões da barra de contexto. Antes eram
  // 33px aqui: 1px de diferença, usada com a mesma frequência que os
  // 32px do resto. Ninguém sabe apontar 1px, todo mundo sente.
  "group relative w-full h-8 flex items-center gap-2.5",
  "rounded-md border-0 bg-transparent text-left cursor-pointer",
  "text-[13px] font-medium",
  "transition-colors duration-150",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
  "focus-visible:ring-offset-1 focus-visible:ring-offset-canvas-elevated",
  // Colapsado: sem padding, conteúdo centralizado.
  "pl-3 pr-2.5 rail-collapsed:px-0 rail-collapsed:gap-0",
  "rail-collapsed:justify-center",
];

const ROW_IDLE   = "text-fg-muted hover:bg-surface hover:text-fg";
const ROW_ACTIVE = "bg-signature-soft text-fg font-semibold";

/** Barra de seleção à esquerda. */
function ActiveRail() {
  return (
    <span
      aria-hidden="true"
      className="absolute -left-2 top-1/2 -translate-y-1/2 w-[3px] h-[18px] rounded-r-[3px] bg-signature"
    />
  );
}

/** Tooltip que só existe quando o rail está colapsado. */
function CollapsedTip({ label, hint }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute left-[calc(100%+12px)] top-1/2 -translate-y-1/2",
        "hidden rail-collapsed:block",
        "whitespace-nowrap rounded-md px-2.5 py-1.5",
        "bg-canvas-elevated border border-border-strong shadow-md",
        "text-xs font-semibold text-fg",
        "opacity-0 translate-x-[-4px] transition-[opacity,transform] duration-150",
        "group-hover:opacity-100 group-hover:translate-x-0",
        "group-focus-visible:opacity-100 group-focus-visible:translate-x-0",
        // z alto: o tooltip precisa passar por cima do conteúdo à direita.
        "z-[70]",
      )}
    >
      {label}
      {hint != null && (
        <span className="ml-1.5 font-medium text-fg-subtle tabular-nums">{hint}</span>
      )}
    </span>
  );
}

/** Ícone + slot de badge no canto quando colapsado. */
function RowIcon({ icon: Icon, iconNode, active }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "shrink-0 grid place-items-center w-4 transition-colors duration-150",
        active ? "text-signature" : "text-fg-subtle group-hover:text-fg-muted",
      )}
    >
      {iconNode ?? (Icon ? <Icon /> : null)}
    </span>
  );
}

export const AdminNavItem = forwardRef(function AdminNavItem(
  { icon, iconNode, label, count, badge, active, onClick, tipHint, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(ROW_BASE, active ? ROW_ACTIVE : ROW_IDLE)}
      {...rest}
    >
      {active && <ActiveRail />}
      <RowIcon icon={icon} iconNode={iconNode} active={active} />

      <span className="flex-1 min-w-0 truncate rail-collapsed:hidden">
        {label}
      </span>

      {count != null && badge == null && (
        <span
          className={cn(
            "shrink-0 text-[10.5px] font-bold tabular-nums rail-collapsed:hidden",
            active ? "text-signature" : "text-fg-subtle",
          )}
        >
          {count}
        </span>
      )}

      {badge != null && <RowBadge value={badge} />}

      <CollapsedTip label={label} hint={tipHint ?? count} />
    </button>
  );
});

/**
 * Selo de severidade. Diferente da contagem: sobrevive ao rail colapsado
 * (vira um ponto no canto do ícone), porque "tem 14 críticas" é informação
 * que não pode depender do rail estar aberto.
 */
export function RowBadge({ value, tone = "danger" }) {
  const display = typeof value === "number" && value > 99 ? "99+" : value;
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center justify-center tabular-nums font-extrabold",
        "min-w-[18px] h-[16px] px-1.5 rounded-full text-[10px]",
        tone === "danger"  && "bg-danger text-on-semantic",
        tone === "warning" && "bg-warning text-on-semantic",
        tone === "neutral" && "bg-surface-strong text-fg-muted",
        // Colapsado: encosta no canto superior direito do ícone.
        "rail-collapsed:absolute rail-collapsed:top-0.5",
        "rail-collapsed:right-1.5 rail-collapsed:min-w-[15px]",
        "rail-collapsed:h-[15px] rail-collapsed:px-1",
        "rail-collapsed:text-[9px]",
      )}
    >
      {display}
    </span>
  );
}

/**
 * Linha do rail usada como gatilho de popover. Mesma geometria do
 * AdminNavItem, sem `aria-current` (não é navegação) e com `statusDot`
 * em vez de ícone quando o que importa é a severidade.
 */
export const AdminRailRow = forwardRef(function AdminRailRow(
  { icon, iconNode, label, meta, badge, badgeTone, tipHint, className, ...rest },
  ref,
) {
  return (
    <button ref={ref} type="button" className={cn(ROW_BASE, ROW_IDLE, className)} {...rest}>
      <RowIcon icon={icon} iconNode={iconNode} active={false} />

      <span className="flex-1 min-w-0 truncate rail-collapsed:hidden">
        {label}
      </span>

      {meta != null && badge == null && (
        <span className="shrink-0 text-[10.5px] font-semibold text-fg-subtle tabular-nums rail-collapsed:hidden">
          {meta}
        </span>
      )}

      {badge != null && <RowBadge value={badge} tone={badgeTone} />}

      <CollapsedTip label={label} hint={tipHint ?? meta} />
    </button>
  );
});

/**
 * Dot de status para as linhas de Operação. Recebe a classe de tom que os
 * painéis já derivam (`bg-success` / `bg-warning` / `bg-danger` /
 * `bg-fg-subtle`) — o halo é montado a partir dela pra dot e glow nunca
 * divergirem de cor.
 */
export function StatusDot({ toneClass = "bg-fg-subtle", pulse = false, size = 15 }) {
  const glow =
    toneClass.includes("success") ? "shadow-glow-success" :
    toneClass.includes("warning") ? "shadow-glow-warning" :
    toneClass.includes("danger")  ? "shadow-glow-danger"  : "";
  return (
    <span className="inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <span
        className={cn("size-1.5 rounded-full", toneClass, glow, pulse && "animate-pulse")}
      />
    </span>
  );
}
