// src/v2/admin/components/Worklist.jsx
//
// Painel de operação no topo do menu admin: 4 cards mostrando
// campanhas que precisam de atenção do time.
//
// Click em qualquer card chama `onSelect(bucketKey)` — o caller
// decide o que fazer (filtrar a lista, abrir modal, etc.).
//
// Buckets vêm do backend (PR-1) ou do fallback client-side com
// schema idêntico:
//   { count: number, tokens: string[] }
//
// Status colors (mantém alinhado com tokens HYPR):
//   pacing_critical  → danger
//   no_owner         → warning
//   reports_not_viewed → signature (info-ish)
//   ending_soon      → success (verde — neutro positivo, "está próximo de fechar")

import { cn } from "../../../ui/cn";

const BUCKETS = [
  {
    key: "pacing_critical",
    label: "Pacing crítico",
    sublabel: ">140% ou <75%",
    dotClass: "bg-danger",
    glowClass: "shadow-[0_0_0_3px_rgba(245,39,43,0.15)]",
  },
  {
    key: "no_owner",
    label: "Sem owner",
    sublabel: "atribuir CP/CS",
    dotClass: "bg-warning",
    glowClass: "shadow-[0_0_0_3px_rgba(237,217,0,0.15)]",
  },
  {
    key: "reports_not_viewed",
    label: "Não vistos",
    sublabel: "cliente nunca acessou",
    dotClass: "bg-signature",
    glowClass: "shadow-[0_0_0_3px_rgba(51,151,185,0.18)]",
  },
  {
    key: "ending_soon",
    label: "Encerram em 7d",
    sublabel: "finalizar e faturar",
    dotClass: "bg-success",
    glowClass: "shadow-[0_0_0_3px_rgba(76,176,80,0.15)]",
  },
];

export function Worklist({ worklist, activeKey, onSelect, className }) {
  if (!worklist) return null;

  return (
    <div
      className={cn(
        "grid grid-cols-2 lg:grid-cols-4 gap-2",
        className
      )}
      role="region"
      aria-label="Atenção necessária"
    >
      {BUCKETS.map(({ key, label, sublabel, dotClass, glowClass }) => {
        const bucket = worklist[key] || { count: 0, tokens: [] };
        const count = bucket.count || 0;
        const isActive = activeKey === key;
        const hasItems = count > 0;

        return (
          <button
            key={key}
            type="button"
            onClick={() => hasItems && onSelect(isActive ? null : key)}
            disabled={!hasItems}
            className={cn(
              "group text-left rounded-xl border p-4",
              "transition-all duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
              isActive
                ? "bg-surface-strong border-signature/50 shadow-md"
                : "bg-surface border-border hover:border-signature/35 hover:-translate-y-px",
              !hasItems && "opacity-50 cursor-default hover:translate-y-0"
            )}
            aria-pressed={isActive}
          >
            {/* Header: dot + label */}
            <div className="flex items-center gap-2 mb-2">
              <span className={cn("w-1.5 h-1.5 rounded-full", dotClass, hasItems && glowClass)} />
              <span className="text-[10px] uppercase tracking-widest font-bold text-fg-muted">
                {label}
              </span>
            </div>

            {/* Big number */}
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold tracking-tight text-fg tabular-nums leading-none">
                {count}
              </span>
              <span className="text-[11px] text-fg-subtle font-medium">
                {count === 1 ? "campanha" : "campanhas"}
              </span>
            </div>

            {/* Sublabel */}
            <p className="text-[11px] text-fg-subtle mt-1">{sublabel}</p>
          </button>
        );
      })}
    </div>
  );
}
