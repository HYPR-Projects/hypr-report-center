// src/v2/portal/PortalFilters.jsx
//
// Controles de filtro compartilhados do Portal do Cliente — extraídos do
// ClientPortalPage pra serem reusados também na seção Analytics (PortalAnalytics)
// sem duplicar o visual nem criar import circular.

import { useState, useEffect, useRef } from "react";
import { cn } from "../../ui/cn";

// ── Filtro multi-seleção (dropdown 100% custom, estilo do site) ────────────────
export function MultiSelectDropdown({ label, allLabel, options, selected, onChange, accent }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  const count = selected.length;
  const toggle = (v) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const active = count > 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "h-9 pl-3 pr-2.5 inline-flex items-center gap-2 rounded-lg bg-canvas-deeper border text-[12px] transition-colors",
          active ? "text-fg" : "text-fg-muted",
          open ? "border-signature" : "border-border hover:border-border-strong",
        )}
        style={active ? { borderColor: `color-mix(in srgb, ${accent} 45%, transparent)` } : undefined}
      >
        <span className="whitespace-nowrap">{label}</span>
        {active && (
          <span className="tabular-nums text-[10px] font-bold px-1.5 py-0.5 rounded-md text-on-signature" style={{ background: accent }}>
            {count}
          </span>
        )}
        <svg className={cn("transition-transform text-fg-subtle", open && "rotate-180")} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 z-40 mt-1.5 min-w-[200px] max-h-[300px] overflow-y-auto rounded-xl bg-canvas-elevated border border-border shadow-lg p-1.5 animate-fade-in">
          {active && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full text-left px-2 py-1.5 rounded-lg text-[11px] uppercase tracking-wider font-semibold text-fg-subtle hover:bg-surface hover:text-fg-muted transition-colors"
            >
              {allLabel}
            </button>
          )}
          {options.map((opt) => {
            const on = selected.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggle(opt.value)}
                className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-[12.5px] text-fg hover:bg-surface transition-colors text-left"
              >
                <Checkbox on={on} accent={accent} />
                <span className="flex-1 truncate">{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Checkbox({ on, accent }) {
  return (
    <span
      className={cn("shrink-0 w-4 h-4 rounded flex items-center justify-center border transition-colors", on ? "border-transparent" : "border-border-strong")}
      style={on ? { background: accent } : undefined}
      aria-hidden
    >
      {on && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </span>
  );
}
