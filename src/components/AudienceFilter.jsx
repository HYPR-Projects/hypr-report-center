import { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { C } from "../shared/theme";

/**
 * AudienceFilter — chip + popover para selecionar múltiplas audiências
 * (line_items) com checkboxes. Mesmo padrão visual do DateRangeFilter
 * (Portal no body, position fixed, backdrop sutil).
 *
 * Props
 *  - lines: string[] — todas as audiências disponíveis
 *  - selected: string[] — audiências marcadas (vazio = todas)
 *  - onChange: (string[]) => void
 *  - theme: { bg, bg2, bg3, bdr, text, muted } do dashboard
 *  - isDark: boolean (controla algumas tonalidades)
 *
 * Renomeado de MultiLineSelect/Line Item → Audience por escolha do usuário:
 * apesar de tecnicamente line_items conterem mais do que só audiência,
 * na prática da HYPR cada linha representa uma audiência específica.
 */
const AudienceFilter = ({ lines, selected, onChange, theme, isDark = true }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const [popPos, setPopPos] = useState({ top: 0, left: 0 });

  // Tokens do tema. Aceita o `theme` do dashboard ou fallback pro C global.
  const bg     = theme?.bg2  || (isDark ? C.dark2 : "#FFFFFF");
  const bg2    = theme?.bg3  || (isDark ? C.dark3 : "#F4F6FA");
  const border = theme?.bdr  || (isDark ? C.dark3 : "#DDE2EC");
  const text   = theme?.text || (isDark ? C.white : "#1C262F");
  const muted  = theme?.muted|| (isDark ? C.muted : "#6B7A8D");
  const accent = C.blue;

  const isActive = selected.length > 0;
  const triggerLabel = !isActive
    ? "Audiência"
    : selected.length === 1
      ? selected[0].split("_").slice(-2).join("_")
      : `${selected.length} audiências`;

  // Recalcula posição do popover. Mesma lógica do DateRangeFilter — abre
  // abaixo por padrão, acima se não couber, clampa nas bordas.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !popoverRef.current) return;
    const recalc = () => {
      const trig = triggerRef.current?.getBoundingClientRect();
      const pop = popoverRef.current?.getBoundingClientRect();
      if (!trig || !pop) return;
      const margin = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Alinha à esquerda do trigger por padrão (popover desce pra baixo-direita)
      let left = trig.left;
      if (left + pop.width > vw - margin) left = vw - pop.width - margin;
      if (left < margin) left = margin;
      let top = trig.bottom + 6;
      if (top + pop.height > vh - margin) {
        const above = trig.top - pop.height - 6;
        if (above >= margin) top = above;
        else top = Math.max(margin, vh - pop.height - margin);
      }
      setPopPos({ top, left });
    };
    recalc();
    window.addEventListener("resize", recalc);
    window.addEventListener("scroll", recalc, true);
    return () => {
      window.removeEventListener("resize", recalc);
      window.removeEventListener("scroll", recalc, true);
    };
  }, [open]);

  // Fechar ao clicar fora ou apertar Esc
  useEffect(() => {
    if (!open) return;
    const click = (e) => {
      const inTrig = triggerRef.current?.contains(e.target);
      const inPop = popoverRef.current?.contains(e.target);
      if (!inTrig && !inPop) setOpen(false);
    };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const toggle = (line) => {
    if (selected.includes(line)) onChange(selected.filter(l => l !== line));
    else onChange([...selected, line]);
  };

  const clear = () => onChange([]);

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      {/* Trigger chip */}
      <div ref={triggerRef} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-label="Filtrar por audiência"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: isActive ? `${accent}18` : bg,
            color: isActive ? accent : text,
            border: `1px solid ${isActive ? `${accent}55` : border}`,
            borderRadius: 999,
            padding: "8px 14px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            transition: "all 0.15s",
            whiteSpace: "nowrap",
            maxWidth: 280,
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = `${accent}80`; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = isActive ? `${accent}55` : border; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{triggerLabel}</span>
          {isActive && (
            <span style={{
              background: accent,
              color: "#fff",
              borderRadius: 999,
              padding: "1px 7px",
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
            }}>{selected.length}</span>
          )}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style={{ opacity: 0.6 }}>
            <path d="M0 2.5L5 7.5L10 2.5z"/>
          </svg>
        </button>
        {isActive && (
          <button
            type="button"
            onClick={clear}
            aria-label="Limpar filtro de audiência"
            title="Limpar filtro"
            style={{
              background: "transparent",
              color: muted,
              border: `1px solid ${border}`,
              borderRadius: 999,
              width: 28,
              height: 28,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
              transition: "all 0.15s",
            }}
            onMouseEnter={e => { e.currentTarget.style.color = "#E74C3C"; e.currentTarget.style.borderColor = "#E74C3C80"; }}
            onMouseLeave={e => { e.currentTarget.style.color = muted; e.currentTarget.style.borderColor = border; }}
          >×</button>
        )}
      </div>

      {/* Popover via Portal */}
      {open && createPortal(
        <>
          <div
            onClick={() => setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: isDark ? "rgba(0,0,0,0.35)" : "rgba(15,30,55,0.18)",
              backdropFilter: "blur(2px)",
              WebkitBackdropFilter: "blur(2px)",
              zIndex: 9998,
              animation: "audFade 0.14s ease-out",
            }}
          />
          <div
            ref={popoverRef}
            style={{
              position: "fixed",
              top: popPos.top,
              left: popPos.left,
              zIndex: 9999,
              background: bg,
              border: `1px solid ${border}`,
              borderRadius: 14,
              boxShadow: isDark
                ? "0 16px 48px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)"
                : "0 16px 48px rgba(15,30,55,0.16), 0 2px 8px rgba(15,30,55,0.08)",
              width: 380,
              maxWidth: "calc(100vw - 32px)",
              maxHeight: "min(440px, calc(100vh - 32px))",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              animation: "audPop 0.14s ease-out",
            }}
          >
            <style>{`
              @keyframes audFade {
                from { opacity: 0; }
                to { opacity: 1; }
              }
              @keyframes audPop {
                from { opacity: 0; transform: translateY(-4px) scale(0.98); }
                to { opacity: 1; transform: translateY(0) scale(1); }
              }
              .aud-row {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 9px 14px;
                cursor: pointer;
                transition: background 0.1s;
                border-bottom: 1px solid ${border}40;
              }
              .aud-row:hover { background: ${isDark ? "rgba(51,151,185,0.10)" : "rgba(51,151,185,0.06)"}; }
              .aud-row.selected { background: ${isDark ? "rgba(51,151,185,0.16)" : "rgba(51,151,185,0.10)"}; }
              .aud-checkbox {
                width: 16px; height: 16px;
                border-radius: 4px;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.12s;
              }
              .aud-label {
                font-size: 12.5px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                flex: 1;
                min-width: 0;
              }
              .aud-header {
                padding: 10px 14px;
                background: ${bg2};
                border-bottom: 1px solid ${border};
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
              }
              .aud-header-title {
                font-size: 11px;
                font-weight: 700;
                color: ${muted};
                text-transform: uppercase;
                letter-spacing: 0.8px;
              }
              .aud-header-action {
                font-size: 11.5px;
                color: ${accent};
                background: transparent;
                border: none;
                cursor: pointer;
                font-weight: 600;
                padding: 2px 6px;
                border-radius: 5px;
              }
              .aud-header-action:hover { background: ${accent}18; }
              .aud-list {
                overflow-y: auto;
                flex: 1;
              }
              .aud-list::-webkit-scrollbar { width: 8px; }
              .aud-list::-webkit-scrollbar-thumb { background: ${border}; border-radius: 4px; }
            `}</style>

            <div className="aud-header">
              <span className="aud-header-title">
                {selected.length === 0 ? "Todas as audiências" : `${selected.length} de ${lines.length}`}
              </span>
              {selected.length > 0 && (
                <button className="aud-header-action" onClick={clear}>Limpar</button>
              )}
            </div>

            <div className="aud-list">
              {lines.map(line => {
                const checked = selected.includes(line);
                const parts = line.split("_");
                const shortLabel = parts.length > 3 ? "…_" + parts.slice(-3).join("_") : line;
                return (
                  <div
                    key={line}
                    className={`aud-row${checked ? " selected" : ""}`}
                    onClick={() => toggle(line)}
                    title={line}
                  >
                    <div
                      className="aud-checkbox"
                      style={{
                        border: `2px solid ${checked ? accent : (isDark ? "#4a6070" : "#b0ccd8")}`,
                        background: checked ? accent : "transparent",
                      }}
                    >
                      {checked && <span style={{ color: "#fff", fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                    </div>
                    <span
                      className="aud-label"
                      style={{
                        color: checked ? text : muted,
                        fontWeight: checked ? 600 : 400,
                      }}
                    >
                      {shortLabel}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
};

export default AudienceFilter;
