// src/v2/components/ChipGroupV2.jsx
//
// Grupo de chips de escolha única (radiogroup). Mais leve que o
// SegmentedControlV2 e quebra linha em telas estreitas, então serve para
// listas de 4–8 opções, como o seletor de métrica da tendência diária.
//
// A11y: role="radiogroup" + role="radio"/aria-checked, setas ←/→ trocam a
// seleção e só o chip ativo entra no Tab (padrão WAI-ARIA).

import { useRef } from "react";
import { cn } from "../../ui/cn";

export function ChipGroupV2({ label, options, value, onChange, className, size = "sm" }) {
  const refs = useRef([]);

  const onKeyDown = (e, idx) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = e.key === "ArrowLeft" ? -1 : 1;
    const next = (idx + dir + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {options.map((opt, idx) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => { refs.current[idx] = el; }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={opt.disabled}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold",
              "transition-colors duration-150 cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
              "disabled:opacity-40 disabled:cursor-not-allowed",
              size === "sm" ? "h-7 px-3 text-[11px]" : "h-8 px-3.5 text-xs",
              active
                ? "border-signature bg-signature-soft text-signature"
                : "border-border text-fg-muted hover:text-fg hover:border-border-strong",
            )}
          >
            {opt.icon}
            {opt.label}
            {opt.count != null && (
              <span className={cn("tabular-nums", active ? "text-signature/80" : "text-fg-subtle")}>
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
