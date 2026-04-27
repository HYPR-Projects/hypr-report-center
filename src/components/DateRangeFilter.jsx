import { useState, useEffect, useRef, useMemo, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { DayPicker } from "react-day-picker";
import { ptBR } from "date-fns/locale";
import "react-day-picker/style.css";
import { C } from "../shared/theme";
import {
  buildPresets,
  matchesPreset,
  formatRangeShort,
  daysInRange,
  ymd,
  parseYmd,
} from "../shared/dateFilter";

/**
 * DateRangeFilter — chip + popover compacto com presets + calendar de range.
 *
 * O popover é renderizado via Portal no body com position fixed e backdrop
 * sutil — assim flutua acima de toda a UI sem sobrepor o layout do
 * dashboard ou ser limitado por stacking contexts.
 *
 * Props
 *  - value: { from: Date, to: Date } | null
 *  - onChange: (range | null) => void
 *  - minDate / maxDate: limites brutos (geralmente start/end da campanha).
 *    Internamente clampa com `today` e `availableDates` pra não permitir
 *    selecionar dias futuros ou sem dados.
 *  - availableDates: string[] de YYYY-MM-DD onde houve entrega/dado.
 *    Quando fornecido, datas fora dessa lista ficam riscadas e desabilitadas.
 *  - isDark: tema atual (controla cores)
 */
const DateRangeFilter = ({
  value,
  onChange,
  minDate,
  maxDate,
  availableDates,
  isDark = true,
}) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const [popPos, setPopPos] = useState({ top: 0, left: 0 });

  useEffect(() => { setDraft(value); }, [value]);

  // Recalcula posição do popover baseado no trigger e no viewport.
  // Renderizado em Portal (body) com position fixed, então não causa
  // sobreposição via stacking context — flutua acima de tudo, com backdrop
  // sutil pra deixar claro que é modal.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !popoverRef.current) return;
    const recalc = () => {
      const trig = triggerRef.current?.getBoundingClientRect();
      const pop = popoverRef.current?.getBoundingClientRect();
      if (!trig || !pop) return;
      const margin = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Horizontal: alinha à direita do trigger por padrão. Se passar do
      // viewport pela esquerda, alinha à esquerda do trigger.
      let left = trig.right - pop.width;
      if (left < margin) left = margin;
      if (left + pop.width > vw - margin) left = vw - pop.width - margin;

      // Vertical: por padrão abaixo do trigger. Se não couber abaixo, abre
      // acima.
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

  // Fechar ao clicar fora (trigger ou popover) ou apertar Esc
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

  // Limites efetivos: nunca passa de `today`, nunca passa do `maxDate`,
  // e quando há `availableDates` clampa pelo último dia com dado.
  const today = useMemo(() => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }, []);

  const availableSet = useMemo(
    () => (availableDates ? new Set(availableDates) : null),
    [availableDates]
  );

  const lastDataDate = useMemo(() => {
    if (!availableDates || availableDates.length === 0) return null;
    return parseYmd([...availableDates].sort().pop());
  }, [availableDates]);

  const firstDataDate = useMemo(() => {
    if (!availableDates || availableDates.length === 0) return null;
    return parseYmd([...availableDates].sort().shift());
  }, [availableDates]);

  // Min efetivo: max entre minDate (campanha) e firstDataDate
  const effectiveMin = useMemo(() => {
    const candidates = [minDate, firstDataDate].filter(Boolean);
    if (candidates.length === 0) return null;
    return new Date(Math.max(...candidates.map(d => d.getTime())));
  }, [minDate, firstDataDate]);

  // Max efetivo: min entre maxDate (campanha), today e lastDataDate
  const effectiveMax = useMemo(() => {
    const candidates = [maxDate, today, lastDataDate].filter(Boolean);
    if (candidates.length === 0) return today;
    return new Date(Math.min(...candidates.map(d => d.getTime())));
  }, [maxDate, today, lastDataDate]);

  const presets = useMemo(
    () => buildPresets(
      effectiveMax,
      effectiveMin ? ymd(effectiveMin) : null,
      effectiveMax ? ymd(effectiveMax) : null
    ),
    [effectiveMin, effectiveMax]
  );

  // Se há availableDates, filtra presets que caiam fora delas.
  const presetsClamped = useMemo(() => {
    if (!availableSet) return presets;
    return presets.map(p => {
      if (!p.range) return p;
      // Reduz o range ao subset que tem dados disponíveis
      let f = p.range.from, t = p.range.to;
      // Encontra primeiro dia com dado dentro do range
      const dates = availableDates
        .filter(d => {
          const dt = parseYmd(d);
          return dt >= f && dt <= t;
        })
        .sort();
      if (dates.length === 0) return { ...p, range: null };
      return {
        ...p,
        range: { from: parseYmd(dates[0]), to: parseYmd(dates[dates.length - 1]) },
      };
    });
  }, [presets, availableSet, availableDates]);

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
    : "Período";

  const apply = (range) => {
    onChange(range);
    setDraft(range);
    setOpen(false);
  };

  // Disabled matcher pro DayPicker — bloqueia datas fora do range válido
  // OU sem dados disponíveis.
  const disabledMatcher = useMemo(() => {
    const matchers = [];
    if (effectiveMin) matchers.push({ before: effectiveMin });
    if (effectiveMax) matchers.push({ after: effectiveMax });
    if (availableSet) {
      matchers.push((day) => !availableSet.has(ymd(day)));
    }
    return matchers;
  }, [effectiveMin, effectiveMax, availableSet]);

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      {/* Trigger chip */}
      <div ref={triggerRef} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
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
            onMouseEnter={e => { e.currentTarget.style.color = "#E74C3C"; e.currentTarget.style.borderColor = "#E74C3C80"; }}
            onMouseLeave={e => { e.currentTarget.style.color = muted; e.currentTarget.style.borderColor = border; }}
          >×</button>
        )}
      </div>

      {/* Popover renderizado via Portal no body — flutua sobre toda a UI
          sem ser limitado por stacking context do dashboard. */}
      {open && createPortal(
        <>
          {/* Backdrop sutil pra dar contexto modal sem escurecer demais */}
          <div
            onClick={() => setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: isDark ? "rgba(0,0,0,0.35)" : "rgba(15,30,55,0.18)",
              backdropFilter: "blur(2px)",
              WebkitBackdropFilter: "blur(2px)",
              zIndex: 9998,
              animation: "drpBackdropFade 0.14s ease-out",
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
              display: "flex",
              flexDirection: "row",
              width: 560,
              maxWidth: "calc(100vw - 32px)",
              overflow: "hidden",
              animation: "drpFadeIn 0.14s ease-out",
            }}
          >
          {/* Estilos do react-day-picker — temáticos e compactos */}
          <style>{`
            @keyframes drpFadeIn {
              from { opacity: 0; transform: translateY(-4px) scale(0.98); }
              to   { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes drpBackdropFade {
              from { opacity: 0; }
              to   { opacity: 1; }
            }
            .drp-presets {
              display: flex;
              flex-direction: column;
              gap: 2px;
              padding: 10px 6px;
              background: ${bg2};
              border-right: 1px solid ${border};
              width: 144px;
              flex-shrink: 0;
            }
            .drp-presets button {
              text-align: left;
              background: transparent;
              border: none;
              color: ${text};
              padding: 8px 12px;
              border-radius: 7px;
              cursor: pointer;
              font-size: 12.5px;
              font-weight: 500;
              transition: all 0.12s;
              white-space: nowrap;
            }
            .drp-presets button:hover:not(:disabled) {
              background: ${isDark ? "rgba(51,151,185,0.14)" : "rgba(51,151,185,0.10)"};
              color: ${accent};
            }
            .drp-presets button.active { background: ${accent}; color: white; }
            .drp-presets button.active:hover { background: ${accent}; color: white; }
            .drp-presets button:disabled { opacity: 0.35; cursor: not-allowed; }

            .drp-right { display: flex; flex-direction: column; flex: 1; min-width: 0; overflow: hidden; }
            .drp-cal {
              padding: 10px 14px 6px;
              display: flex;
              justify-content: center;
            }
            .drp-cal .rdp-root { width: 100%; }
            .drp-cal .rdp-months { width: 100%; }
            .drp-cal .rdp-month { width: 100%; }
            .drp-cal .rdp-month_grid { width: 100%; table-layout: fixed; }

            /* Reset/override do react-day-picker pra respeitar tema */
            .drp-cal .rdp-root {
              --rdp-accent-color: ${accent};
              --rdp-accent-background-color: ${accent}22;
              --rdp-day-height: 32px;
              --rdp-day-width: 32px;
              --rdp-day_button-height: 28px;
              --rdp-day_button-width: 28px;
              --rdp-day_button-border-radius: 6px;
              --rdp-selected-border: 2px solid ${accent};
              --rdp-range_middle-color: ${text};
              --rdp-range_middle-background-color: ${accent}1f;
              --rdp-range_start-color: white;
              --rdp-range_start-background: ${accent};
              --rdp-range_end-color: white;
              --rdp-range_end-background: ${accent};
              --rdp-today-color: ${accent};
              --rdp-disabled-opacity: 0.28;
              color: ${text};
              font-size: 12.5px;
              margin: 0;
              background: transparent;
            }
            .drp-cal .rdp-months { background: transparent; }
            .drp-cal .rdp-month_caption {
              font-weight: 600;
              font-size: 13px;
              color: ${text};
              text-transform: capitalize;
              padding: 4px 0 6px;
              background: transparent;
            }
            .drp-cal .rdp-weekdays { background: transparent; }
            .drp-cal .rdp-weekday {
              color: ${muted};
              font-weight: 600;
              font-size: 10.5px;
              text-transform: uppercase;
              background: transparent;
              padding: 4px 0;
            }
            .drp-cal .rdp-day { color: ${text}; background: transparent; }
            .drp-cal .rdp-day_button {
              color: ${text};
              background: transparent;
              border: none;
              font-size: 12.5px;
            }
            .drp-cal .rdp-day_button:hover:not([disabled]) {
              background: ${isDark ? "rgba(255,255,255,0.07)" : "rgba(15,30,55,0.06)"};
            }
            .drp-cal .rdp-day.rdp-disabled,
            .drp-cal .rdp-day.rdp-disabled .rdp-day_button {
              color: ${muted};
              opacity: 0.32;
              cursor: not-allowed;
              text-decoration: line-through;
              text-decoration-thickness: 1px;
              text-decoration-color: ${muted}50;
            }
            .drp-cal .rdp-day.rdp-outside { color: ${muted}80; }
            .drp-cal .rdp-day.rdp-outside .rdp-day_button { color: ${muted}80; }
            .drp-cal .rdp-day.rdp-today .rdp-day_button {
              font-weight: 700;
              color: ${accent};
            }
            .drp-cal .rdp-chevron {
              fill: ${text};
              opacity: 0.7;
            }
            .drp-cal .rdp-button_previous, .drp-cal .rdp-button_next {
              color: ${text};
              background: transparent;
              border: none;
              padding: 4px;
              border-radius: 6px;
            }
            .drp-cal .rdp-button_previous:hover, .drp-cal .rdp-button_next:hover {
              background: ${isDark ? "rgba(255,255,255,0.07)" : "rgba(15,30,55,0.06)"};
            }
            .drp-cal .rdp-nav { padding: 0 4px; }

            .drp-footer {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 8px 12px 10px;
              border-top: 1px solid ${border};
              gap: 8px;
              background: ${bg};
            }
            .drp-footer .drp-info {
              font-size: 11px;
              color: ${muted};
              flex: 1;
              min-width: 0;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .drp-footer .drp-actions { display: flex; gap: 6px; flex-shrink: 0; }
            .drp-footer button {
              padding: 6px 12px;
              border-radius: 7px;
              font-size: 12px;
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

            @media (max-width: 520px) {
              .drp-presets {
                flex-direction: row;
                overflow-x: auto;
                min-width: 0;
                border-right: none;
                border-bottom: 1px solid ${border};
                padding: 6px;
              }
              .drp-presets button { white-space: nowrap; font-size: 12px; padding: 6px 10px; }
            }
          `}</style>

          {/* Presets */}
          <div className="drp-presets">
            {presetsClamped.map(p => (
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

          {/* Calendar + footer */}
          <div className="drp-right">
            <div className="drp-cal">
              <DayPicker
                mode="range"
                locale={ptBR}
                numberOfMonths={1}
                pagedNavigation
                selected={draft || undefined}
                onSelect={setDraft}
                disabled={disabledMatcher}
                defaultMonth={draft?.from || effectiveMax || new Date()}
                weekStartsOn={0}
              />
            </div>
            <div className="drp-footer">
              <div className="drp-info">
                {draft?.from && draft?.to
                  ? `${formatRangeShort(draft)} · ${daysInRange(draft)}d`
                  : draft?.from
                    ? "Selecione data final"
                    : "Selecione duas datas"}
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
        </>,
        document.body
      )}
    </div>
  );
};

export default DateRangeFilter;
