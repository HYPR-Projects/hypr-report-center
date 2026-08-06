// src/v2/admin/components/PmpFreshnessIndicator.jsx
//
// Indicador de frescor do sync das fontes de curadoria do PMP
// (Xandr Curate + PubMatic) → pmp_lines_enriched, exposto no header da página
// /admin/pmp. Permite o admin validar de manhã se o cron diário das 04h BRT
// rodou com sucesso em CADA fonte, sem precisar abrir o BQ ou checar row a row.
//
// Multi-fonte: o `pmp_lines_enriched` já calcula `last_synced_at` e
// `last_delivery_day` agrupados por (source, line_id), então cada fonte tem
// seu próprio frescor. O popover lista uma seção por fonte presente; o dot do
// gatilho reflete o PIOR estado entre elas (pra alertar quando qualquer fonte
// atrasa). PubMatic tem lag de reporting (D-2/D-3) na entrega, mas o
// `last_synced_at` marca quando o sync rodou — então a régua abaixo (baseada
// em last_synced_at) vale igual pras duas fontes.
//
// Diferente do DataFreshnessIndicator do menu admin: aquele lê
// unified_daily_performance_metrics (delivery DV360/Xandr/StackAdapt). Este
// usa o `last_synced_at` por line já carregado na página — derivado do
// sync PMP específico.
//
// Régua (hora-local America/Sao_Paulo), aplicada por fonte:
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

// Prioridade pro dot agregado do gatilho: qualquer fonte em alerta ganha do
// resto; "aguardando" (neutral) ainda vem antes de "ok" pra não esconder uma
// fonte que não sincronizou.
const TONE_PRIORITY = ["error", "warn", "neutral", "ok"];

function worstTone(tones) {
  for (const t of TONE_PRIORITY) if (tones.includes(t)) return t;
  return "neutral";
}

export function PmpFreshnessIndicator({
  sources = [],
  onSync, syncing = false,
  className,
}) {
  // Cada fonte: { key, label, lastSyncedAt, latestDeliveryDay, linesCount, note }.
  // Anexa o status derivado por fonte e o tone agregado do gatilho.
  const withStatus = useMemo(
    () => sources.map((s) => ({ ...s, status: deriveStatus(s.lastSyncedAt) })),
    [sources],
  );
  const aggTone = useMemo(
    () => worstTone(withStatus.map((s) => s.status.tone)),
    [withStatus],
  );
  const tone = TONE_CLASSES[aggTone] || TONE_CLASSES.neutral;

  const multi = withStatus.length > 1;
  const triggerLabel = multi
    ? `Sync das fontes de curadoria (${withStatus.length})`
    : `Sync ${withStatus[0]?.label || "PMP"} — ${withStatus[0]?.status.summary || "sem dados"}`;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          title={triggerLabel}
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
            <span className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">
              {multi ? "Sync das fontes" : "Sync da fonte"}
            </span>
          </div>

          {withStatus.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-fg-subtle">Sem dados de sync.</p>
          ) : (
            withStatus.map((s, i) => {
              const st = TONE_CLASSES[s.status.tone] || TONE_CLASSES.neutral;
              return (
                <div key={s.key} className={cn(i > 0 && "border-t border-border")}>
                  <div className="flex items-center gap-2 px-4 pt-3">
                    <span className={cn("size-2 rounded-full shrink-0", st.dot)} />
                    <span className="text-[12px] font-semibold text-fg">{s.label}</span>
                  </div>
                  <p className={cn("px-4 mt-0.5 text-[12px] font-medium", st.text)}>
                    {s.status.summary}
                  </p>
                  <ul className="py-1">
                    <Row label="Última execução" value={s.lastSyncedAt ? fmtBrDateTime(s.lastSyncedAt) : "—"} />
                    <Row label="Última entrega" value={fmtBrDate(s.latestDeliveryDay)} />
                    {s.linesCount != null && (
                      <Row label="Lines sincronizadas" value={String(s.linesCount)} />
                    )}
                  </ul>
                  {s.note && (
                    <p className="px-4 pb-2 text-[10.5px] text-fg-subtle leading-snug">{s.note}</p>
                  )}
                </div>
              );
            })
          )}

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
    <li className="flex items-center justify-between gap-3 px-4 py-1.5 text-[12px]">
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
