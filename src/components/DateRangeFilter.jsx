import { useState, useEffect, useRef, useMemo } from "react";
import { DayPicker } from "react-day-picker";
import { ptBR } from "date-fns/locale";
import "react-day-picker/style.css";
import { C } from "../shared/theme";
import {
  buildPresets,
  matchesPreset,
  formatRangeShort,
  daysInRange,
} from "../shared/dateFilter";

/**
 * DateRangeFilter — chip clicável que abre popover com presets +
 * calendário de range.
 *
 * Props
 *  - value: { from: Date, to: Date } | null
 *  - onChange: (range | null) => void
 *  - minDate / maxDate: limites do calendar (geralmente start/end da campanha)
 *  - isDark: tema atual (controla cores)
 *  - align: "left" | "right" (lado de abertura do popover, default right)
 */
const DateRangeFilter = ({ value, onChange, minDate, maxDate, isDark = true, align = "right" }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const wrapRef = useRef(null);

  useEffect(() => { setDraft(value); }, [value]);

  // Fechar ao clicar fora
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Refresh today às 00:00 do user — refToday é hoje, mas clampa em maxDate.
  const refToday = useMemo(() => {
    const today = new Date();
    if (maxDate && today > maxDate) return maxDate;
    return today;
  }, [maxDate]);

  const presets = useMemo(
    () => buildPresets(refToday, minDate ? minDate.toISOString().slice(0, 10) : null, maxDate ? maxDate.toISOString().slice(0, 10) : null),
    [refToday, minDate, maxDate]
  );

  // Visual tokens
  const bg     = isDark ? C.dark2 : "#FFFFFF";
  const bg2    = isDark ? C.dark3 : "#F4F6FA";
  const border = isDark ? C.dark3 : "#DDE2EC";
  const text   = isDark ? C.white : "#1C262F";
  const muted  = isDark ? C.muted : "#6B7A8D";
  const accent = C.blue;

  const isActive = !!value;
  const days = isActive ? daysInRange(value) : 0;

  const triggerLabel = isActive
    ? `${formatRangeShort(value)} · ${days}d`
    : "Todo o período";

  const apply = (range) => {
    onChange(range);
    setDraft(range);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      {/* Trigger chip */}
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-label="Filtrar por período"
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
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = `${accent}80`; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = isActive ? `${accent}55` : border; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="3"/>
            <path d="M16 2v4M8 2v4M3 10h18"/>
          </svg>
          <span>{triggerLabel}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style={{ opacity: 0.6 }}>
            <path d="M0 2.5L5 7.5L10 2.5z"/>
          </svg>
        </button>
        {isActive && (
          <button
            type="button"
            onClick={() => apply(null)}
            aria-label="Limpar filtro de data"
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
            onMouseEnter={e => { e.currentTarget.style.color = C.red || "#E74C3C"; e.currentTarget.style.borderColor = `${C.red || "#E74C3C"}80`; }}
            onMouseLeave={e => { e.currentTarget.style.color = muted; e.currentTarget.style.borderColor = border; }}
          >×</button>
        )}
      </div>

      {/* Popover */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            [align]: 0,
            zIndex: 1000,
            background: bg,
            border: `1px solid ${border}`,
            borderRadius: 16,
            boxShadow: isDark
              ? "0 24px 64px rgba(0,0,0,0.55), 0 4px 12px rgba(0,0,0,0.4)"
              : "0 24px 64px rgba(15,30,55,0.18), 0 4px 12px rgba(15,30,55,0.08)",
            padding: 0,
            display: "flex",
            minWidth: 580,
            maxWidth: "calc(100vw - 32px)",
            overflow: "hidden",
            animation: "drpFadeIn 0.15s ease-out",
          }}
        >
          {/* Estilos do react-day-picker — temáticos */}
          <style>{`
            @keyframes drpFadeIn {
              from { opacity: 0; transform: translateY(-4px); }
              to   { opacity: 1; transform: translateY(0); }
            }
            .drp-presets {
              display: flex;
              flex-direction: column;
              gap: 2px;
              padding: 12px 8px;
              background: ${bg2};
              border-right: 1px solid ${border};
              min-width: 180px;
            }
            .drp-presets button {
              text-align: left;
              background: transparent;
              border: none;
              color: ${text};
              padding: 9px 14px;
              border-radius: 8px;
              cursor: pointer;
              font-size: 13px;
              font-weight: 500;
              transition: all 0.12s;
              white-space: nowrap;
            }
            .drp-presets button:hover { background: ${isDark ? "rgba(51,151,185,0.12)" : "rgba(51,151,185,0.08)"}; color: ${accent}; }
            .drp-presets button.active { background: ${accent}; color: white; }
            .drp-presets button.active:hover { background: ${accent}; color: white; }
            .drp-cal {
              padding: 14px 16px 12px;
              flex: 1;
            }
            .drp-cal .rdp-root {
              --rdp-accent-color: ${accent};
              --rdp-accent-background-color: ${accent}25;
              --rdp-day-height: 36px;
              --rdp-day-width: 36px;
              --rdp-day_button-height: 32px;
              --rdp-day_button-width: 32px;
              --rdp-day_button-border-radius: 8px;
              --rdp-selected-border: 2px solid ${accent};
              --rdp-range_middle-color: ${text};
              --rdp-range_middle-background-color: ${accent}20;
              color: ${text};
              font-size: 13px;
              margin: 0;
            }
            .drp-cal .rdp-month_caption { font-weight: 600; font-size: 14px; color: ${text}; }
            .drp-cal .rdp-weekday { color: ${muted}; font-weight: 600; font-size: 11px; text-transform: uppercase; }
            .drp-cal .rdp-day { color: ${text}; }
            .drp-cal .rdp-day.rdp-disabled { color: ${muted}55; }
            .drp-cal .rdp-day.rdp-outside { color: ${muted}80; }
            .drp-cal .rdp-day_button:hover:not([disabled]) { background: ${isDark ? "rgba(255,255,255,0.06)" : "rgba(15,30,55,0.06)"}; }
            .drp-cal .rdp-chevron { fill: ${text}; }
            .drp-footer {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 10px 16px 12px;
              border-top: 1px solid ${border};
              gap: 12px;
            }
            .drp-footer .drp-info { font-size: 12px; color: ${muted}; }
            .drp-footer .drp-actions { display: flex; gap: 8px; }
            .drp-footer button {
              padding: 8px 14px;
              border-radius: 8px;
              font-size: 13px;
              font-weight: 600;
              cursor: pointer;
              border: 1px solid ${border};
              background: transparent;
              color: ${text};
              transition: all 0.12s;
            }
            .drp-footer button.primary {
              background: ${accent};
              color: white;
              border-color: ${accent};
            }
            .drp-footer button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
            .drp-footer button:hover:not(:disabled) { transform: translateY(-1px); }
          `}</style>

          {/* Presets */}
          <div className="drp-presets">
            {presets.map(p => (
              <button
                key={p.id}
                className={matchesPreset(value, p) ? "active" : ""}
                onClick={() => apply(p.range)}
                disabled={p.id !== "all" && !p.range}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Calendar */}
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div className="drp-cal">
              <DayPicker
                mode="range"
                locale={ptBR}
                numberOfMonths={2}
                pagedNavigation
                selected={draft || undefined}
                onSelect={setDraft}
                disabled={[
                  ...(minDate ? [{ before: minDate }] : []),
                  ...(maxDate ? [{ after: maxDate }] : []),
                ]}
                defaultMonth={draft?.from || maxDate || new Date()}
                weekStartsOn={0}
              />
            </div>
            <div className="drp-footer">
              <div className="drp-info">
                {draft?.from && draft?.to
                  ? `${formatRangeShort(draft)} · ${daysInRange(draft)} dia${daysInRange(draft) > 1 ? "s" : ""}`
                  : "Selecione duas datas no calendário"}
              </div>
              <div className="drp-actions">
                <button onClick={() => { setDraft(value); setOpen(false); }}>Cancelar</button>
                <button
                  className="primary"
                  disabled={!draft?.from || !draft?.to}
                  onClick={() => apply(draft)}
                >Aplicar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DateRangeFilter;
