// src/v2/components/DateRangeFilterV2.jsx
//
// Filtro de período do V2 — REDESIGN PR-15
//
// Substitui o filtro com chips inline (que era visualmente pesado e
// quebrava em telas estreitas) por um pill dropdown único:
//
//   ┌─────────────────────────────────────┐
//   │ 📅  Período: 15 Abr → 28 Abr   ▼   │
//   └─────────────────────────────────────┘
//                ↓ click
//   ┌──────────────────────────────────────────────┐
//   │  Todo o período          ┃   < Abril 2026 >  │
//   │  Ontem                   ┃    D S T Q Q S S  │
//   │  Últimos 7 dias          ┃    1 2 3 4 5 6 7  │
//   │  Últimos 15 dias         ┃    8 9 ...        │
//   │  Últimos 30 dias         ┃                   │
//   │  Este mês                ┃                   │
//   │  Mês passado             ┃                   │
//   ├──────────────────────────────────────────────┤
//   │ 15 Abr → 28 Abr · 14 dias  [Cancelar][OK]   │
//   └──────────────────────────────────────────────┘
//
// PRESETS VERTICAIS À ESQUERDA + CALENDAR À DIREITA, sempre visíveis.
// Click num preset atualiza o draft e aplica imediato (UX rápida).
// Click no calendar exige clicar Aplicar (UX previsível pra range).
//
// API mantida idêntica ao filtro anterior:
//   { value, campaignStart, campaignEnd, availableDates, onChange }
//
// Por que Popover (Radix) e não Dialog
//   Popover é ancorado no botão e não bloqueia a página — UX correto pra
//   filtro contextual. Dialog é pra fluxos modais (confirmação destrutiva,
//   form de criação). O filtro anterior usou Dialog porque era a UI mais
//   simples de implementar, não porque era a certa.

import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import { ptBR } from "date-fns/locale";
import { format } from "date-fns";
import "react-day-picker/style.css";
import "./DateRangeFilterV2.css";

import {
  buildPresets,
  pickActivePreset,
  daysInRange,
  ymd,
  parseYmd,
} from "../../shared/dateFilter";

import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";

export function DateRangeFilterV2({
  value,
  campaignStart,
  campaignEnd,
  availableDates,
  onChange,
  // ID do preset que originou o `value` atual (quando vier de click em
  // preset). Usado pra desempatar quando vários presets casam o mesmo
  // range — preserva intenção do user ao trocar de view.
  presetId = null,
  // Classes extras pro botão-gatilho (pill). Anexadas por último no cn() —
  // como cn() usa twMerge, utilitárias conflitantes (altura, raio, bg) são
  // sobrescritas. Permite ao Portal do Cliente casar o pill com os demais
  // filtros (h-9 rounded-lg bg-canvas-deeper) sem afetar o uso no report.
  triggerClassName = "",
}) {
  const presets = useMemo(
    () => buildPresets(new Date(), campaignStart, campaignEnd),
    [campaignStart, campaignEnd],
  );

  // Preset ativo único. Heurística: hint do caller > não-clampado > primeiro
  // match. Sem hint, presets que colapsam no mesmo range caíam no primeiro
  // `find` (= "Últimos 7 dias" sempre vencendo "Este mês" / "Mês passado").
  const activePreset = useMemo(
    () => pickActivePreset(value, presets, presetId),
    [value, presets, presetId],
  );

  const [open, setOpen] = useState(false);
  // Draft local enquanto o popover está aberto. Sincronizado com `value`
  // no momento da abertura (callback determinístico, não useEffect — o
  // React 19 reclama de setState síncrono dentro de effect).
  const [draft, setDraft] = useState(value);
  const handleOpenChange = (next) => {
    if (next) setDraft(value); // abrindo: reseta draft pro value atual
    setOpen(next);
  };

  // Limites do DayPicker (clampa hoje pra não permitir futuro).
  const minDate = campaignStart ? parseYmd(campaignStart) : undefined;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDateRaw = campaignEnd ? parseYmd(campaignEnd) : undefined;
  const maxDate = !maxDateRaw
    ? today
    : maxDateRaw < today
      ? maxDateRaw
      : today;

  const availableSet = useMemo(() => {
    if (!availableDates || !availableDates.length) return null;
    return new Set(availableDates);
  }, [availableDates]);

  const disabledMatcher = useMemo(() => {
    const matchers = [];
    if (minDate) matchers.push({ before: minDate });
    if (maxDate) matchers.push({ after: maxDate });
    if (availableSet) matchers.push((day) => !availableSet.has(ymd(day)));
    return matchers;
  }, [minDate, maxDate, availableSet]);

  // Aplica preset diretamente (sem precisar de Aplicar — UX rápida).
  // Propaga `preset.id` pro caller persistir a *intenção* do filtro: ao
  // trocar de view num report agrupado, o range é recalculado a partir
  // do id, não do valor numérico.
  const applyPreset = (preset) => {
    setDraft(preset.range);
    onChange(preset.range, preset.id);
    setOpen(false);
  };

  // Custom range (ajuste no calendar) → presetId null. Filtros custom
  // não acompanham troca de view (não há intenção semântica pra recalcular).
  const applyCustom = () => {
    if (draft?.from && draft?.to) {
      onChange(draft, null);
      setOpen(false);
    }
  };

  const cancel = () => {
    setDraft(value);
    setOpen(false);
  };

  const pillLabel = formatPillLabel(value, activePreset);
  const draftRangeLabel =
    draft?.from && draft?.to
      ? formatPillLabel(draft, pickActivePreset(draft, presets))
      : null;
  const draftDayCount = draft?.from && draft?.to ? daysInRange(draft) : 0;

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Selecionar período do filtro"
          className={cn(
            "inline-flex items-center gap-2 h-10 px-4 rounded-full",
            "text-xs font-semibold whitespace-nowrap",
            "border border-border bg-surface text-fg",
            "hover:border-border-strong hover:bg-surface-strong",
            "transition-colors duration-150 cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
            open && "border-signature bg-surface-strong",
            triggerClassName,
          )}
        >
          <CalendarIcon className="size-3.5 text-fg-muted" />
          <span className="text-fg-muted">Período:</span>
          <span className="text-fg">{pillLabel}</span>
          <ChevronDownIcon
            className={cn(
              "size-3 text-fg-muted transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          // collisionPadding garante que o popover não cole nas bordas da
          // viewport — Radix calcula reposicionamento automático em mobile.
          collisionPadding={8}
          className={cn(
            "z-50 rounded-xl overflow-hidden border border-border bg-surface-2 shadow-2xl",
            // Mobile: limita ao max possível dentro da viewport (com folga
            // do collisionPadding). Desktop: tamanho natural do conteúdo.
            "max-w-[calc(100vw-1rem)] sm:max-w-none",
            "animate-in fade-in-0 zoom-in-95",
            "data-[side=bottom]:slide-in-from-top-2",
          )}
        >
          {/* Mobile: stack vertical (presets em cima, calendar embaixo).
              Desktop: row horizontal (presets ao lado do calendar). Os
              presets ficam em row scrollable horizontal em mobile pra não
              consumir altura demais (lista vertical com 7 itens × 36px =
              252px só de presets, mais o calendar = popover com 600px+ de
              altura). Em desktop mantém o layout vertical original. */}
          <div className="flex flex-col md:flex-row">
            {/* ─── Presets ───────────────────────────────────────── */}
            <div
              role="radiogroup"
              aria-label="Presets de período"
              className={cn(
                "p-2 border-b md:border-b-0 md:border-r border-border",
                // Mobile: row horizontal scrollable (chips estilo iOS).
                // Desktop: column vertical com largura fixa.
                "flex md:flex-col gap-1 md:gap-0",
                "overflow-x-auto md:overflow-x-visible scrollbar-hidden",
                "md:min-w-[180px]",
              )}
            >
              {presets.map((p) => {
                const active = activePreset?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => applyPreset(p)}
                    className={cn(
                      "flex items-center justify-between text-xs font-medium",
                      // Mobile: pill compacto (whitespace-nowrap pra não
                      // quebrar). Desktop: linha full-width.
                      "whitespace-nowrap shrink-0 md:shrink",
                      "px-3 py-2 rounded-md text-left",
                      "transition-colors duration-150 cursor-pointer",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                      active
                        ? "bg-signature-soft text-signature font-semibold"
                        : "text-fg-muted hover:bg-surface-strong hover:text-fg",
                    )}
                  >
                    <span>{p.label}</span>
                    {active && <CheckIcon className="size-3.5 hidden md:inline" />}
                  </button>
                );
              })}
            </div>

            {/* ─── Calendar ─────────────────────────────────────── */}
            <div className="p-3 flex justify-center md:block">
              <div className="rdp-hypr">
                <DayPicker
                  mode="range"
                  locale={ptBR}
                  numberOfMonths={1}
                  pagedNavigation
                  selected={draft || undefined}
                  onSelect={setDraft}
                  disabled={disabledMatcher}
                  defaultMonth={draft?.from || maxDate || new Date()}
                  weekStartsOn={0}
                />
              </div>
            </div>
          </div>

          {/* ─── Footer: range atual + ações ──────────────────────── */}
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border bg-surface-2 flex-wrap">
            <div className="text-xs tabular-nums min-w-0">
              {draft?.from && draft?.to ? (
                <span className="text-fg-muted">
                  <span className="text-fg font-semibold">{draftRangeLabel}</span>
                  <span className="ml-2">· {draftDayCount} dia{draftDayCount !== 1 ? "s" : ""}</span>
                </span>
              ) : (
                <span className="text-fg-subtle italic">
                  Selecione um intervalo
                </span>
              )}
            </div>
            <div className="flex gap-2 ml-auto">
              <Button variant="ghost" size="sm" onClick={cancel}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!draft?.from || !draft?.to}
                onClick={applyCustom}
              >
                Aplicar
              </Button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ─── Helpers de label ────────────────────────────────────────────────
//
// formatPillLabel retorna o texto exibido na pill — cobre 3 casos:
//   1. Sem filtro (value=null) → "Todo o período"
//   2. Preset que matcha → label do preset ("Últimos 7 dias")
//   3. Range custom → "15 Abr → 28 Abr"
//
// `activePreset` já vem resolvido por pickActivePreset (prefere o preset
// não-clampado quando vários colapsam no mesmo range).

function formatPillLabel(value, activePreset) {
  if (!value) return "Todo o período";
  if (activePreset && activePreset.id !== "all") return activePreset.label;
  return formatRangePill(value);
}

function formatRangePill(range) {
  if (!range) return "";
  const fmt = (d) => format(d, "dd MMM", { locale: ptBR });
  if (ymd(range.from) === ymd(range.to)) return fmt(range.from);
  return `${fmt(range.from)} → ${fmt(range.to)}`;
}

// ─── Ícones inline ───────────────────────────────────────────────────

function CalendarIcon({ className }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="3.5" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5 2v3M11 2v3" />
    </svg>
  );
}

function ChevronDownIcon({ className }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}

function CheckIcon({ className }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="3 8 7 12 13 4" />
    </svg>
  );
}
