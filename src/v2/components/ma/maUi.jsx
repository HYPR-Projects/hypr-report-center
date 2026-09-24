// src/v2/components/ma/maUi.jsx
//
// Peças pequenas de UI compartilhadas pela aba Max Attention: selo de
// camada (Mídia / Peça / Widget), cabeçalho de card e botão de CSV.

import { cn } from "../../../ui/cn";

const LAYER = {
  midia: { label: "Mídia", cls: "bg-surface-strong text-fg-muted border-border" },
  peca: { label: "Peça", cls: "bg-signature-soft text-signature border-signature/40" },
  widget: { label: "Widget", cls: "border-border text-fg-muted" },
};

export function LayerBadge({ kind }) {
  const l = LAYER[kind] || LAYER.midia;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider", l.cls)}>
      {kind === "widget" && <PuzzleIcon className="size-3" />}
      {l.label}
    </span>
  );
}

export function MaCard({ title, subtitle, layer, actions, className, children }) {
  return (
    <section className={cn("rounded-xl border border-border bg-surface-2 p-4 md:p-5 min-w-0", className)}>
      {(title || layer || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            {layer && <LayerBadge kind={layer} />}
            {title && <h3 className="text-[12px] font-bold uppercase tracking-widest text-fg-muted">{title}</h3>}
            {subtitle && <span className="text-[11px] text-fg-subtle">{subtitle}</span>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Marca o que só a HYPR (admin) vê — nunca aparece no report do cliente. */
export function HyprOnlyBadge() {
  return (
    <span className="inline-flex items-center rounded border border-warning/40 bg-warning-soft px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-warning">
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

export function PuzzleIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19.4 12.6a2 2 0 0 0 0-3.2V6a1 1 0 0 0-1-1h-3.4a2 2 0 0 0-3.2 0H8.4a1 1 0 0 0-1 1v3.4a2 2 0 0 0 0 3.2V16a1 1 0 0 0 1 1h3.4a2 2 0 0 0 3.2 0h3.4a1 1 0 0 0 1-1z" />
    </svg>
  );
}
