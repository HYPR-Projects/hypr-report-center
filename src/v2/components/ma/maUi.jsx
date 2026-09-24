// src/v2/components/ma/maUi.jsx
//
// Padrões de UI da aba Max Attention. Toda a aba monta a partir daqui, sem
// estilo próprio por bloco:
//
//   MaSection   título de seção (18px) + subtítulo + ferramentas (chips)
//   MaCard      cabeçalho (título 15px, subtítulo 12px, ação à direita) ·
//               corpo · rodapé opcional (nota, badge, link) com linha acima
//   MaStat      rótulo em caixa alta em cima · valor · nota. Três tamanhos
//               por papel: xl (um por tela), m (KPIs), s (apoio)
//   MaStatGroup números lado a lado, separados por divisória vertical
//   MaBarRows   rótulo · valor · participação, barra de 8px embaixo (4px
//               nos detalhes ↳), uma cor só
//   MaBadge     estado/alerta, não clicável (chip clicável é o ChipGroupV2)
//   InfoTip     "?" que abre a explicação de método sob demanda
//
// Nada abaixo de 11px.

import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../../ui/cn";

const LAYER = {
  midia: { label: "Mídia", cls: "bg-surface-strong text-fg-muted border-border" },
  peca: { label: "Peça", cls: "bg-signature-soft text-signature border-signature/40" },
  widget: { label: "Widget", cls: "border-border text-fg-muted" },
};

export function LayerBadge({ kind }) {
  const l = LAYER[kind] || LAYER.midia;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 h-5 text-[11px] font-bold uppercase tracking-wider", l.cls)}>
      {kind === "widget" && <PuzzleIcon className="size-3" />}
      {l.label}
    </span>
  );
}

const BADGE_TONE = {
  neutral: "bg-surface-strong text-fg-muted",
  info: "bg-signature-soft text-signature",
  warn: "bg-warning-soft text-warning",
  good: "bg-success-soft text-success",
  bad: "bg-danger-soft text-danger",
};

export function MaBadge({ tone = "neutral", className, children, title }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 h-5 rounded-md px-1.5 text-[11px] font-bold uppercase tracking-wider whitespace-nowrap",
        BADGE_TONE[tone] || BADGE_TONE.neutral,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function MaSection({ title, subtitle, tools, className, children }) {
  return (
    <section className={cn("space-y-4 min-w-0", className)} aria-label={typeof title === "string" ? title : undefined}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-fg leading-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[12.5px] text-fg-subtle leading-snug">{subtitle}</p>}
        </div>
        {tools && <div className="flex flex-wrap items-center gap-1.5">{tools}</div>}
      </div>
      {children}
    </section>
  );
}

export function MaCard({ title, subtitle, layer, actions, footer, className, bodyClassName, children }) {
  return (
    <section className={cn("flex flex-col rounded-xl border border-border bg-surface-2 p-4 md:p-5 min-w-0", className)}>
      {(title || layer || actions) && (
        <header className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {layer && <LayerBadge kind={layer} />}
              {title && <h3 className="text-[15px] font-bold text-fg leading-snug">{title}</h3>}
            </div>
            {subtitle && <p className="mt-0.5 text-xs text-fg-subtle leading-snug">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("flex-1 min-w-0", bodyClassName)}>{children}</div>
      {footer && <MaCardFooter>{footer}</MaCardFooter>}
    </section>
  );
}

/** Rodapé no padrão do card, para quem monta o próprio corpo (funil, lista). */
export function MaCardFooter({ className, children }) {
  return (
    <footer className={cn("mt-4 pt-3 border-t border-border/70 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs leading-snug text-fg-subtle [&_b]:text-fg [&_b]:font-semibold", className)}>
      {children}
    </footer>
  );
}

const STAT_SIZE = {
  xl: "text-[36px] tracking-tight",
  m: "text-2xl",
  s: "text-lg",
};

export function MaStat({ label, value, note, size = "m", tone = null, accent = false, title, className }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[11px] font-bold uppercase tracking-wider text-fg-subtle truncate max-sm:whitespace-normal" title={title || (typeof label === "string" ? label : undefined)}>
        {label}
      </div>
      <div
        className={cn(
          "mt-1.5 font-bold leading-tight tabular-nums truncate",
          STAT_SIZE[size] || STAT_SIZE.m,
          tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : accent || size === "xl" ? "text-signature" : "text-fg",
        )}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </div>
      {note && <div className="mt-1 text-xs text-fg-subtle leading-snug">{note}</div>}
    </div>
  );
}

// Classes fixas (o Tailwind precisa ver o nome inteiro no fonte).
const GROUP_COLS = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-5",
  6: "sm:grid-cols-3 xl:grid-cols-6",
};

/**
 * Números lado a lado com divisória vertical. No celular vira 2 colunas
 * (divisória só na da direita); a última sobra ocupa a linha inteira.
 */
export function MaStatGroup({ cols = 3, className, children }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-y-4",
        GROUP_COLS[cols] || GROUP_COLS[3],
        "[&>*]:border-border [&>*]:px-4",
        "max-sm:[&>*:nth-child(odd)]:pl-0 max-sm:[&>*:nth-child(even)]:border-l max-sm:[&>*:last-child:nth-child(odd)]:col-span-2",
        "sm:[&>*:first-child]:pl-0 sm:[&>*+*]:border-l",
        cols === 6 && "sm:max-xl:[&>*:nth-child(3n+1)]:border-l-0 sm:max-xl:[&>*:nth-child(3n+1)]:pl-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Linhas de barra. Cada linha: { key?, label, valueText, shareText?, width
 * (0–100), sub?, base?, hot?, hint? }. A ordem é a do array: quem chama
 * ordena (do maior para o menor, exceto funil).
 */
export function MaBarRows({ rows = [], label, startIndex = 0 }) {
  return (
    <div className="grid gap-3" role="table" aria-label={label}>
      {rows.map((r, i) => (
        <div
          key={r.key || r.label}
          role="row"
          className={cn("grid grid-cols-[minmax(0,1fr)_auto_3.5rem] items-baseline gap-x-3 gap-y-1.5", r.sub && "pl-4")}
        >
          <span
            role="cell"
            className={cn("truncate text-[13px]", r.sub ? "text-fg-muted" : "font-semibold text-fg")}
            title={r.hint || (typeof r.label === "string" ? r.label : undefined)}
          >
            {r.sub ? "↳ " : ""}
            {r.label}
          </span>
          <span role="cell" className="text-right text-[13px] font-bold tabular-nums text-fg whitespace-nowrap">{r.valueText}</span>
          <span
            role="cell"
            className={cn("text-right text-xs tabular-nums whitespace-nowrap", r.hot ? "font-bold text-warning" : "text-fg-subtle")}
            title={r.shareHint}
          >
            {r.shareText ?? ""}
          </span>
          {r.width != null && (
            <div className={cn("col-span-3 rounded-full bg-track overflow-hidden", r.sub ? "h-1" : "h-2")} aria-hidden>
              <div
                className={cn("bar-grow-x h-full rounded-full", r.base ? "bg-fg-subtle/40" : r.sub ? "bg-signature/55" : "bg-signature")}
                style={{ width: `${Math.max(r.width > 0 ? 0.8 : 0, Math.min(100, r.width))}%`, "--i": startIndex + i }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** "?" que abre a explicação de método (clique/toque, funciona no celular). */
export function InfoTip({ label = "Como ler", children, className }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-grid size-6 shrink-0 place-items-center rounded-full border border-border text-[11px] font-bold text-fg-subtle hover:text-fg hover:border-border-strong cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
            className,
          )}
        >
          ?
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-w-[320px] rounded-lg border border-border bg-canvas-elevated px-3.5 py-3 text-xs leading-relaxed text-fg-muted shadow-md focus:outline-none"
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Marca o que só a HYPR (admin) vê — nunca aparece no report do cliente. */
export function HyprOnlyBadge() {
  return (
    <span className="inline-flex items-center rounded border border-warning/40 bg-warning-soft px-1.5 h-5 text-[11px] font-bold uppercase tracking-wider text-warning">
      Só HYPR
    </span>
  );
}

export function CsvButton({ onClick, label = "CSV" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border text-[11px] font-semibold text-fg-muted hover:text-fg hover:border-border-strong cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature"
    >
      <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      {label}
    </button>
  );
}

/** Botão pequeno no padrão das ações de card ("Ver todos", "Mostrar os 28"). */
export function MaActionButton({ onClick, children, className, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border text-xs font-semibold text-fg-muted hover:text-fg hover:border-border-strong cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function PuzzleIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19.4 12.6a2 2 0 0 0 0-3.2V6a1 1 0 0 0-1-1h-3.4a2 2 0 0 0-3.2 0H8.4a1 1 0 0 0-1 1v3.4a2 2 0 0 0 0 3.2V16a1 1 0 0 0 1 1h3.4a2 2 0 0 0 3.2 0h3.4a1 1 0 0 0 1-1z" />
    </svg>
  );
}
