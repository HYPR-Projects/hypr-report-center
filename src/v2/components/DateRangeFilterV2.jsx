// src/v2/components/DateRangeFilterV2.jsx
//
// Filtro de período do V2 — chips de presets + opção "Personalizar"
// que abre um Dialog com calendário de range (DayPicker do
// react-day-picker, já presente nas deps).
//
// Reusa os helpers puros de shared/dateFilter (buildPresets, matchesPreset,
// formatRangeShort, daysInRange, parseYmd) que JÁ existem e são usados
// pelo DateRangeFilter Legacy. Comportamento dos presets idêntico.
//
// Diferenças vs DateRangeFilter Legacy
//   - UX: Dialog modal centralizado em vez de popover ancorado (a11y,
//     focus trap, ESC, click no overlay tudo do Radix Dialog)
//   - Estilo: paleta HYPR via Tailwind v4 em vez de inline styles
//   - Custom range honra availableDates quando passado (mesmo
//     comportamento Legacy: dias sem entrega ficam desabilitados)

import { useMemo, useState } from "react";
import { DayPicker } from "react-day-picker";
import { ptBR } from "date-fns/locale";
import "react-day-picker/style.css";
import "./DateRangeFilterV2.css";

import {
  buildPresets,
  matchesPreset,
  formatRangeShort,
  daysInRange,
  ymd,
  parseYmd,
} from "../../shared/dateFilter";

import { Button } from "../../ui/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogClose,
} from "../../ui/Dialog";
import { cn } from "../../ui/cn";

export function DateRangeFilterV2({
  value,
  campaignStart,
  campaignEnd,
  availableDates,
  onChange,
}) {
  const presets = buildPresets(new Date(), campaignStart, campaignEnd);

  // Range é "custom" quando não bate com nenhum preset (e não é null).
  const isCustom = value && !presets.some((p) => matchesPreset(value, p));

  const [open, setOpen] = useState(false);
  // Draft local enquanto o Dialog está aberto — só aplica em onChange
  // quando o usuário clica em "Aplicar". Sincronizado com `value` no
  // momento de abrir (não em useEffect — o React 19 reclama de setState
  // síncrono dentro de effect, e o ponto de abertura é determinístico).
  const [draft, setDraft] = useState(value);
  const openDialog = () => {
    setDraft(value);
    setOpen(true);
  };

  // Limites do DayPicker (clampa hoje pra não permitir futuro)
  const minDate = campaignStart ? parseYmd(campaignStart) : undefined;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDateRaw = campaignEnd ? parseYmd(campaignEnd) : undefined;
  const maxDate = !maxDateRaw ? today : (maxDateRaw < today ? maxDateRaw : today);

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

  const apply = () => {
    if (draft?.from && draft?.to) {
      onChange(draft);
      setOpen(false);
    }
  };

  const customLabel = isCustom
    ? `${formatRangeShort(value)} · ${daysInRange(value)}d`
    : "Personalizar";

  return (
    <>
      <div
        role="radiogroup"
        aria-label="Período do filtro"
        className="flex flex-wrap gap-2"
      >
        {presets.map((p) => {
          const active = matchesPreset(value, p);
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(p.range)}
              className={cn(chipBase, active ? chipActive : chipIdle)}
            >
              {p.label}
            </button>
          );
        })}

        <button
          type="button"
          aria-pressed={isCustom}
          onClick={openDialog}
          className={cn(
            chipBase,
            isCustom ? chipActive : chipIdle,
            "gap-1.5",
          )}
        >
          <CalendarIcon className="size-3.5 opacity-80" />
          {customLabel}
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Personalizar período</DialogTitle>
            <DialogDescription>
              Selecione a data inicial e a data final no calendário. Dias sem entrega ficam riscados.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
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

            {draft?.from && draft?.to && (
              <p className="mt-3 text-center text-xs text-fg-muted tabular-nums">
                {formatRangeShort(draft)} · {daysInRange(draft)} dia(s)
              </p>
            )}
          </DialogBody>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancelar</Button>
            </DialogClose>
            <Button
              variant="primary"
              size="sm"
              disabled={!draft?.from || !draft?.to}
              onClick={apply}
            >
              Aplicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Estilo dos chips ───────────────────────────────────────────────────
const chipBase = [
  "inline-flex items-center h-8 px-3 rounded-full text-xs font-semibold whitespace-nowrap",
  "border transition-colors duration-150 cursor-pointer",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
].join(" ");
const chipActive = "bg-signature border-signature text-fg";
const chipIdle = "bg-surface border-border text-fg-muted hover:text-fg hover:border-border-strong";

// ─── Ícone calendar inline ──────────────────────────────────────────────
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
