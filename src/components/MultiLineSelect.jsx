import { useState, useEffect, useRef } from "react";
import { Line } from "recharts";
import { C } from "../shared/theme";

const MultiLineSelect = ({ lines, selected, onChange, theme }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Cores totalmente derivadas do tema — dark ou light
  const isDark = !(theme?.bg === "#F4F6FA");
  const bg2    = theme?.bg2  || C.dark2;
  const bg3    = theme?.bg3  || C.dark3;
  const bdr    = theme?.bdr  || C.dark3;
  const txt    = theme?.text || C.white;
  const muted  = theme?.muted|| C.muted;
  const rowHov = isDark ? `${C.blue}22` : "#EBF6FB";
  const rowSel = isDark ? `${C.blue}28` : "#D6EFF8";
  const shadow = isDark ? "0 8px 32px rgba(0,0,0,0.5)" : "0 8px 32px rgba(51,151,185,0.18)";
  const chkBdr = isDark ? "#4a6070" : "#b0ccd8";

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggle = (line) => {
    if (selected.includes(line)) onChange(selected.filter(l => l !== line));
    else onChange([...selected, line]);
  };

  const label = selected.length === 0
    ? "Todos os Line Items"
    : selected.length === 1
      ? selected[0].split("_").slice(-2).join("_")
      : `${selected.length} lines selecionadas`;

  return (
    <div ref={ref} style={{ position: "relative", flex: 1, maxWidth: 560 }}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          background: bg3, border: `1.5px solid ${open ? C.blue : bdr}`, borderRadius: 8,
          padding: "8px 13px", cursor: "pointer", color: selected.length > 0 ? txt : muted,
          fontSize: 13, fontWeight: selected.length > 0 ? 600 : 400, textAlign: "left",
          transition: "border-color 0.15s", outline: "none",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {label}
        </span>
        {selected.length > 0 && (
          <span style={{
            background: C.blue, color: "#fff", borderRadius: 20,
            padding: "1px 7px", fontSize: 11, fontWeight: 700, marginLeft: 8, flexShrink: 0,
          }}>{selected.length}</span>
        )}
        <span style={{
          marginLeft: 8, fontSize: 11, color: muted, flexShrink: 0,
          display: "inline-block",
          transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s",
        }}>▾</span>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 300,
          background: bg2, border: `1.5px solid ${C.blue}50`, borderRadius: 10,
          boxShadow: shadow, maxHeight: 340, overflowY: "auto",
        }}>
          {/* "Todos" row */}
          <div
            onClick={() => { onChange([]); setOpen(false); }}
            style={{
              padding: "10px 14px", cursor: "pointer",
              borderBottom: `1px solid ${bdr}`,
              display: "flex", alignItems: "center", gap: 10,
              background: selected.length === 0 ? rowSel : "transparent",
            }}
            onMouseEnter={e => e.currentTarget.style.background = rowHov}
            onMouseLeave={e => e.currentTarget.style.background = selected.length === 0 ? rowSel : "transparent"}
          >
            {/* Checkbox */}
            <div style={{
              width: 16, height: 16, borderRadius: 4, flexShrink: 0,
              border: `2px solid ${selected.length === 0 ? C.blue : chkBdr}`,
              background: selected.length === 0 ? C.blue : bg3,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {selected.length === 0 && <span style={{ color: "#fff", fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>}
            </div>
            <span style={{ fontSize: 13, color: txt, fontWeight: 700 }}>Todos os Line Items</span>
          </div>

          {/* Line rows */}
          {lines.map(line => {
            const checked = selected.includes(line);
            // Mostrar apenas os últimos 3 segmentos como label curto, tooltip com nome completo
            const parts = line.split("_");
            const shortLabel = parts.length > 3 ? "…_" + parts.slice(-3).join("_") : line;
            return (
              <div
                key={line}
                onClick={() => toggle(line)}
                title={line}
                style={{
                  padding: "9px 14px", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 10,
                  background: checked ? rowSel : "transparent",
                  borderBottom: `1px solid ${bdr}30`,
                }}
                onMouseEnter={e => e.currentTarget.style.background = rowHov}
                onMouseLeave={e => e.currentTarget.style.background = checked ? rowSel : "transparent"}
              >
                <div style={{
                  width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                  border: `2px solid ${checked ? C.blue : chkBdr}`,
                  background: checked ? C.blue : bg3,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all 0.12s",
                }}>
                  {checked && <span style={{ color: "#fff", fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                </div>
                <span style={{
                  fontSize: 12, color: checked ? txt : muted,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  fontWeight: checked ? 600 : 400,
                }}>
                  {shortLabel}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};


// ══════════════════════════════════════════════════════════════════════════════
// CLIENT DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
// ── SurveyChart ──────────────────────────────────────────────────────────────

export default MultiLineSelect;
