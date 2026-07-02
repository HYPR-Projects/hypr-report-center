// src/v2/admin/components/PeriodPicker.jsx
//
// Seletor de período compartilhado (Top Performers + Diagnóstico) — pills
// de preset ("Agora", 7d, 30d, 90d, Mês passado) + "Custom" que abre um
// Popover com DayPicker em modo range.
//
// Extraído do TopPerformers.jsx quando o Diagnóstico ganhou filtro de
// período — mesma UI, mesmos presets (PERIOD_PRESETS de lib/period.js),
// pra manter a semântica de janela idêntica entre as duas abas.

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import { ptBR } from "date-fns/locale";
import { format } from "date-fns";
import "react-day-picker/style.css";
import "../../components/DateRangeFilterV2.css";
import { cn } from "../../../ui/cn";
import { PERIOD_PRESETS } from "../lib/period";
import { ymd, parseYmd } from "../../../shared/dateFilter";

export function PeriodPicker({ preset, onPresetChange, custom, onCustomChange, ariaLabel = "Período" }) {
  // Popover do calendário custom. Fica controlado aqui pra:
  //   (a) auto-abrir quando o user clica no pill "Custom" sem range ainda
  //   (b) re-abrir clicando novamente quando já existe range (edita)
  //   (c) fechar ao aplicar via footer
  const [popoverOpen, setPopoverOpen] = useState(false);
  // Draft do range enquanto o popover está aberto — só aplica quando user
  // clica Aplicar. Sincronizado com `custom` ao abrir (callback determinístico,
  // mesma técnica do DateRangeFilterV2).
  const [draftRange, setDraftRange] = useState(() => customToRange(custom));

  const handleOpenChange = (open) => {
    if (open) setDraftRange(customToRange(custom));
    setPopoverOpen(open);
  };

  const handleCustomClick = () => {
    onPresetChange("custom");
    // Se já tem custom range aplicado, abre direto pra edição.
    // Se está virando custom agora, também abre — UX rápida.
    setDraftRange(customToRange(custom));
    setPopoverOpen(true);
  };

  const applyCustom = () => {
    if (draftRange?.from && draftRange?.to) {
      onCustomChange({ from: ymd(draftRange.from), to: ymd(draftRange.to) });
      setPopoverOpen(false);
    }
  };

  const cancelCustom = () => {
    setDraftRange(customToRange(custom));
    setPopoverOpen(false);
  };

  // Limita seleção: não permite datas no futuro. Não tem `min` — admin pode
  // querer comparar trimestres antigos.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const draftCount =
    draftRange?.from && draftRange?.to
      ? Math.round((draftRange.to - draftRange.from) / 86400000) + 1
      : 0;

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex flex-wrap gap-0.5 p-0.5 rounded-lg bg-canvas-deeper border border-border w-fit"
    >
      {PERIOD_PRESETS.map((opt) => {
        const active = preset === opt.id;
        if (opt.id === "custom") {
          // Pill "Custom" é o trigger do Popover. Quando ativo, mostra o
          // range escolhido (ex.: "15 abr → 30 abr") em vez do label "Custom".
          const customLabel =
            active && custom.from && custom.to
              ? formatRangeCompact(custom.from, custom.to)
              : opt.shortLabel;
          return (
            <Popover.Root key={opt.id} open={popoverOpen} onOpenChange={handleOpenChange}>
              <Popover.Trigger asChild>
                <button
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={handleCustomClick}
                  className={cn(
                    "inline-flex items-center gap-1 px-3 h-7 rounded-md cursor-pointer",
                    "text-xs font-medium",
                    "transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
                    active
                      ? "bg-canvas-elevated text-fg shadow-sm"
                      : "text-fg-muted hover:text-fg hover:bg-surface-strong",
                  )}
                >
                  {customLabel}
                  <ChevronDownPico
                    className={cn(
                      "size-2.5 text-fg-subtle transition-transform duration-200",
                      popoverOpen && "rotate-180",
                    )}
                  />
                </button>
              </Popover.Trigger>

              <Popover.Portal>
                <Popover.Content
                  align="end"
                  sideOffset={8}
                  collisionPadding={8}
                  // Animações: o Radix expõe data-[state=open|closed] e
                  // data-[side=...] pra Tailwind animar entrada/saída. fade +
                  // zoom suave + slide-from-top dá o "drop" natural do popover.
                  className={cn(
                    "z-50 rounded-xl overflow-hidden border border-border bg-surface-2 shadow-2xl",
                    "max-w-[calc(100vw-1rem)] sm:max-w-none",
                    "data-[state=open]:animate-in data-[state=closed]:animate-out",
                    "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                    "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
                    "data-[side=bottom]:slide-in-from-top-2",
                    "data-[side=top]:slide-in-from-bottom-2",
                  )}
                >
                  {/* DayPicker em modo range — clique 1 = from, clique 2 = to.
                      `defaultMonth` sincroniza com o from selecionado: se o
                      user já escolheu uma data em abril, ao reabrir cai em
                      abril direto. Sem from ainda, abre no mês atual.
                      `numberOfMonths={2}` mostra 2 meses lado a lado: range
                      cross-month fica visível sem precisar navegar. */}
                  <div className="p-3 rdp-hypr">
                    <DayPicker
                      mode="range"
                      locale={ptBR}
                      numberOfMonths={2}
                      pagedNavigation
                      selected={draftRange}
                      onSelect={setDraftRange}
                      disabled={{ after: today }}
                      defaultMonth={
                        draftRange?.from
                          ? draftRange.from
                          : new Date(today.getFullYear(), today.getMonth() - 1, 1)
                      }
                      weekStartsOn={0}
                    />
                  </div>

                  {/* Footer com contagem de dias + Aplicar/Cancelar */}
                  <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border bg-surface-2">
                    <div className="text-xs tabular-nums min-w-0">
                      {draftRange?.from && draftRange?.to ? (
                        <span className="text-fg-muted">
                          <span className="text-fg font-semibold">
                            {formatRangeCompact(ymd(draftRange.from), ymd(draftRange.to))}
                          </span>
                          <span className="ml-2">
                            · {draftCount} dia{draftCount !== 1 ? "s" : ""}
                          </span>
                        </span>
                      ) : draftRange?.from ? (
                        <span className="text-fg-subtle italic">
                          Selecione a data final
                        </span>
                      ) : (
                        <span className="text-fg-subtle italic">
                          Selecione um intervalo
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2 ml-auto">
                      <button
                        type="button"
                        onClick={cancelCustom}
                        className="px-3 h-7 rounded-md text-xs font-medium text-fg-muted hover:bg-surface-strong cursor-pointer transition-colors"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        onClick={applyCustom}
                        disabled={!draftRange?.from || !draftRange?.to}
                        className={cn(
                          "px-3 h-7 rounded-md text-xs font-semibold cursor-pointer transition-colors",
                          "bg-signature text-white hover:bg-signature/90",
                          "disabled:bg-surface-strong disabled:text-fg-subtle disabled:cursor-not-allowed",
                        )}
                      >
                        Aplicar
                      </button>
                    </div>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          );
        }
        return (
          <button
            key={opt.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onPresetChange(opt.id)}
            className={cn(
              "inline-flex items-center px-3 h-7 rounded-md cursor-pointer",
              "text-xs font-medium",
              "transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
              active
                ? "bg-canvas-elevated text-fg shadow-sm"
                : "text-fg-muted hover:text-fg hover:bg-surface-strong",
            )}
          >
            {opt.shortLabel}
          </button>
        );
      })}
    </div>
  );
}

// Custom helpers — `custom` (ISO strings) ↔ DayPicker range (Date objects).
// parseYmd cuida do parsing local-safe que `new Date("YYYY-MM-DD")` quebra
// em fusos negativos (vira midnight UTC = dia anterior em BRT).
function customToRange(custom) {
  if (!custom?.from || !custom?.to) return undefined;
  try {
    return { from: parseYmd(custom.from), to: parseYmd(custom.to) };
  } catch {
    return undefined;
  }
}

function formatRangeCompact(fromIso, toIso) {
  if (!fromIso || !toIso) return "";
  try {
    const f = parseYmd(fromIso);
    const t = parseYmd(toIso);
    const fmt = (d) => format(d, "dd MMM", { locale: ptBR });
    if (fromIso === toIso) return fmt(f);
    return `${fmt(f)} → ${fmt(t)}`;
  } catch {
    return `${fromIso} → ${toIso}`;
  }
}

function ChevronDownPico({ className }) {
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
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}
