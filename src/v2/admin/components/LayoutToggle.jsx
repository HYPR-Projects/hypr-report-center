// src/v2/admin/components/LayoutToggle.jsx
//
// Segmented control de 3 botões pra alternar entre layouts:
//   - month:  agrupado por mês (legacy refatorado)
//   - client: agrupado por cliente (view nova)
//   - list:   lista densa estilo Linear
//
// Adota o mesmo padrão visual do SegmentedControlV2 já em uso no
// dashboard cliente, mas com 3 opções em vez de 2 e ícones inline.

import { cn } from "../../../ui/cn";

const OPTIONS = [
  {
    value: "month",
    label: "Por mês",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
    ),
  },
  {
    value: "client",
    label: "Por cliente",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="7" r="3.5" />
        <path d="M3 21v-1a6 6 0 0 1 12 0v1" />
        <circle cx="17" cy="7" r="3" strokeOpacity="0.5" />
      </svg>
    ),
  },
  {
    value: "list",
    label: "Lista",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </svg>
    ),
  },
];

export function LayoutToggle({ value, onChange, className }) {
  return (
    <div
      role="tablist"
      aria-label="Layout"
      className={cn(
        "inline-flex gap-0.5 p-0.5 rounded-lg bg-surface border border-border",
        className
      )}
    >
      {OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 h-7 rounded-md",
              "text-xs font-medium",
              "transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
              active
                ? "bg-canvas-elevated text-fg shadow-sm"
                : "text-fg-muted hover:text-fg hover:bg-surface-strong"
            )}
          >
            <span className="shrink-0">{opt.icon}</span>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
