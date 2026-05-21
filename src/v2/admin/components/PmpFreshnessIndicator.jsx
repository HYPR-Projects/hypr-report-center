// src/v2/admin/components/PmpFreshnessIndicator.jsx
//
// Indicador de frescor do sync Xandr Curate → pmp_deals_delivery, exposto no
// header da página /admin/pmp. Permite o admin validar de manhã se o cron
// diário das 04h BRT rodou com sucesso, sem precisar abrir o BQ ou checar
// row a row.
//
// Diferente do DataFreshnessIndicator do menu admin: aquele lê
// unified_daily_performance_metrics (delivery DV360/Xandr/StackAdapt). Este
// usa o `last_synced_at` por line já carregado na página — derivado do
// sync Xandr Curate específico do PMP.
//
// Régua (hora-local America/Sao_Paulo):
//   • Sync com data BR == hoje                       → verde (ok)
//   • Antes do cutoff 05h e sem sync de hoje         → cinza (aguardando)
//   • Após cutoff, sync = ontem                      → amarelo (warn)
//   • Após cutoff, sync ≥ 2 dias atrás               → vermelho (error)
//
// Cutoff 05h cobre o cron de 04h + margem pro report do Xandr terminar.

import { useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../../ui/cn";

const TZ_BR = "America/Sao_Paulo";
const CUTOFF_HOUR_BR = 5;

function brDateString(iso) {
  const d = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ_BR, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function brHour(iso) {
  const d = iso ? new Date(iso) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_BR, hour: "2-digit", hour12: false,
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
}

function fmtBrDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ_BR, day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(d);
}

function fmtBrDate(iso) {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[3]}/${m[2]}` : String(iso);
}

function deriveStatus(lastSyncedAt) {
  if (!lastSyncedAt) return { tone: "neutral", summary: "Sem dados de sync" };
  const now = new Date();
  const today = brDateString(now);
  const syncDay = brDateString(lastSyncedAt);
  if (syncDay === today) return { tone: "ok", summary: "Base atualizada hoje" };
  if (brHour(now) < CUTOFF_HOUR_BR) {
    return { tone: "neutral", summary: "Aguardando sync matinal" };
  }
  const a = new Date(`${syncDay}T00:00:00Z`);
  const b = new Date(`${today}T00:00:00Z`);
  const daysBehind = Math.round((b - a) / 86_400_000);
  if (daysBehind === 1) {
    return { tone: "warn", summary: "Sync de ontem — cron pode ter falhado" };
  }
  return { tone: "error", summary: `Sync atrasada (${daysBehind} dias)` };
}

const TONE_CLASSES = {
  ok:      { dot: "bg-success",   text: "text-success"   },
  warn:    { dot: "bg-warning",   text: "text-warning"   },
  error:   { dot: "bg-danger",    text: "text-danger"    },
  neutral: { dot: "bg-fg-subtle", text: "text-fg-subtle" },
};

export function PmpFreshnessIndicator({
  lastSyncedAt, latestDeliveryDay, linesCount,
  onSync, syncing = false,
  className,
}) {
  const status = useMemo(() => deriveStatus(lastSyncedAt), [lastSyncedAt]);
  const tone = TONE_CLASSES[status.tone] || TONE_CLASSES.neutral;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Sync Xandr Curate — ${status.summary}`}
          title={status.summary}
          className={cn(
            "inline-flex items-center justify-center size-9 rounded-full",
            "border border-border bg-surface text-fg-muted",
            "hover:border-border-strong hover:bg-surface-strong hover:text-fg",
            "transition-[colors,transform] duration-150 cursor-pointer",
            "active:scale-90",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
            className,
          )}
        >
          <span className="relative inline-flex">
            <DatabaseIcon />
            <span
              aria-hidden
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-surface",
                tone.dot,
              )}
            />
          </span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          align="end"
          collisionPadding={16}
          className={cn(
            "z-50 w-[300px] max-w-[calc(100vw-32px)]",
            "rounded-xl border border-border bg-canvas-elevated shadow-lg",
            "overflow-hidden",
            "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
            "focus-visible:outline-none",
          )}
        >
          <div className="px-4 py-3 border-b border-border bg-surface-strong">
            <div className="flex items-center gap-2">
              <span className={cn("size-2 rounded-full shrink-0", tone.dot)} />
              <span className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">
                Sync Xandr Curate
              </span>
            </div>
            <p className={cn("mt-1 text-[12px] font-medium", tone.text)}>
              {status.summary}
            </p>
          </div>

          <ul className="py-1">
            <Row label="Última execução" value={lastSyncedAt ? fmtBrDateTime(lastSyncedAt) : "—"} />
            <Row label="Última entrega" value={fmtBrDate(latestDeliveryDay)} />
            {linesCount != null && (
              <Row label="Lines sincronizadas" value={String(linesCount)} />
            )}
          </ul>

          {onSync && (
            <div className="px-4 pt-2 pb-3 border-t border-border">
              <button
                type="button"
                onClick={onSync}
                disabled={syncing}
                className={cn(
                  "w-full h-8 rounded-md text-[12px] font-medium",
                  "border border-border bg-surface text-fg",
                  "hover:bg-surface-strong hover:border-border-strong transition-colors",
                  "disabled:opacity-60 disabled:cursor-not-allowed",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                )}
              >
                {syncing ? "Sincronizando..." : "Sincronizar agora"}
              </button>
            </div>
          )}

          <div className="px-4 py-2 border-t border-border text-[10.5px] text-fg-subtle leading-snug">
            Cron diário às 04h · referência <span className="font-medium">ontem</span>.
            {" "}Falha → reportar no #data-pipelines.
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({ label, value }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2 text-[12px]">
      <span className="text-fg-muted">{label}</span>
      <span className="text-fg font-medium tabular-nums">{value}</span>
    </li>
  );
}

function DatabaseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </svg>
  );
}
