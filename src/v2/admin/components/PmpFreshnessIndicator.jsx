// src/v2/admin/components/PmpFreshnessIndicator.jsx
//
// Indicador de frescor do sync das fontes de curadoria do PMP
// (Xandr Curate + PubMatic) → pmp_lines_enriched, exposto no header da página
// /admin/pmp. Permite o admin validar de manhã se o cron diário das 04h BRT
// rodou com sucesso em CADA fonte, sem precisar abrir o BQ ou checar row a row.
//
// Multi-fonte: o popover lista uma seção por fonte; o dot do gatilho reflete o
// PIOR estado entre elas (pra alertar quando qualquer fonte atrasa).
//
// O QUE ESTE INDICADOR MEDE
// -------------------------
// DUAS perguntas independentes por fonte, porque em ago/26 as duas estiveram
// erradas por motivos opostos:
//
//   1. O JOB rodou?    → ledger `pmp_sync_runs` (lastRunAt/lastRunStatus/lastError)
//   2. O DADO chegou?  → `apiLastDay`/`lagDays` do ledger, com o
//                        `latestDeliveryDay` das lines como fallback
//
// Até ago/26 só existia um sinal, e ele era `last_synced_at` das LINHAS DE
// ENTREGA — que confundia as duas nos dois sentidos:
//   • deal encerrado (nenhuma row tocada) parecia "sync atrasada" — falso alarme;
//   • sync QUEBRADO (401 da PubMatic, 19–21/08) ficava idêntico a deal
//     encerrado — o alarme que importava nunca tocou, e um deal novo entregando
//     ~R$32k passou 3 dias fora do hub.
// O ledger resolveu (1). Ficou faltando (2), e em 24/08 ela cobrou: o job da
// PubMatic rodava VERDE todo dia e a base vivia 2 dias atrás (às 04h BRT a
// fonte ainda não fechou D-1, e o conector descarta dia zerado). O painel
// mostrava "Sync rodou hoje" com um "Última entrega" desatualizado ao lado —
// dado informativo que nunca virava alerta. Agora o atraso de DADO tem régua
// própria e mexe no dot.
//
// O falso alarme de deal encerrado NÃO volta: quem decide se há atraso de dado
// é `expectsDelivery`, que a página só liga quando existe deal que DEVERIA
// estar entregando. Fonte 100% encerrada não alarma, por construção.
//
// Diferente do DataFreshnessIndicator do menu admin: aquele lê
// unified_daily_performance_metrics (delivery DV360/Xandr/StackAdapt).
//
// Régua do JOB (hora-local America/Sao_Paulo), aplicada por fonte:
//   • Último run com status de erro                  → vermelho (mostra o erro)
//   • Último run 'skipped' (sem credencial)          → vermelho (não rodou)
//   • Run bem-sucedido com data BR == hoje           → verde (ok)
//   • Antes do cutoff 05h e sem run de hoje          → cinza (aguardando)
//   • Após cutoff, último run OK = ontem             → amarelo (warn)
//   • Após cutoff, último run OK ≥ 2 dias atrás      → vermelho (error)
//
// Régua do DADO (só quando `expectsDelivery`), aplicada sobre o mesmo dot:
//   • dado até D-1                                   → não mexe (em dia)
//   • dado em D-2 antes da hora em que a fonte fecha → cinza (aguardando a fonte;
//     PubMatic libera D-1 entre 08h e 10h BRT, ver SOURCE_CLOSE_HOUR_BRT)
//   • dado em D-2 depois dessa hora                  → amarelo
//   • dado em D-3 ou mais velho                      → vermelho
//
// D-2 é amarelo e não verde de propósito: é exatamente o estado em que a base
// ficou parada por semanas sem ninguém ver. É também o estado que o
// `pmp-pubmatic-refresh` (de hora em hora) existe pra evitar — se ele estiver de pé,
// amarelo aqui significa que a PRÓPRIA fonte atrasou, o que é informação.
//
// Cutoff 05h cobre o cron de 04h + margem pro report do Xandr terminar.
// Sem ledger (backend antigo), cai no `lastSyncedAt` das lines — comportamento
// antigo, degradado mas nunca quebrado.

import { useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AdminRailRow, StatusDot } from "../shell/AdminNavItem";
import { cn } from "../../../ui/cn";
import {
  deriveStatus, deriveDataLag, worstTone,
  fmtBrDateTime, fmtBrDate, fmtBrDayHour,
} from "../lib/pmpFreshness";

const TONE_CLASSES = {
  ok:      { dot: "bg-success",   text: "text-success"   },
  warn:    { dot: "bg-warning",   text: "text-warning"   },
  error:   { dot: "bg-danger",    text: "text-danger"    },
  neutral: { dot: "bg-fg-subtle", text: "text-fg-subtle" },
};

export function PmpFreshnessIndicator({
  sources = [],
  onSync, syncing = false,
  className,
  variant = "icon",
}) {
  // Cada fonte: { key, label, lastRunAt, lastRunStatus, lastError, lastOkAt,
  //               credential, lastSyncedAt, latestDeliveryDay, apiLastDay,
  //               lagDays, expectsDelivery, linesCount, note }.
  // Anexa o status derivado por fonte e o tone agregado do gatilho.
  const withStatus = useMemo(
    () => sources.map((s) => ({ ...s, status: deriveStatus(s), dataLag: deriveDataLag(s) })),
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

  const isRail = variant === "rail";

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        {isRail ? (
          <AdminRailRow
            label="Sync das curadorias"
            iconNode={<StatusDot toneClass={tone.dot} pulse={syncing} />}
            meta={syncing ? "…" : (multi ? withStatus.length : undefined)}
            tipHint={triggerLabel}
            // Começa pelo rótulo visível (WCAG 2.5.3 — Label in Name).
            aria-label={`Sync das curadorias — ${triggerLabel}`}
            title={triggerLabel}
          />
        ) : (
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
        )}
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side={isRail ? "right" : "bottom"}
          sideOffset={8}
          align={isRail ? "start" : "end"}
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
            <span className="lbl-section text-fg-muted">
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
                    <Row
                      label="Última execução"
                      value={fmtBrDateTime(s.lastRunAt || s.lastSyncedAt)}
                    />
                    {s.lastRunStatus === "error" && (
                      <Row label="Último sync OK" value={s.lastOkAt ? fmtBrDateTime(s.lastOkAt) : "nunca"} />
                    )}
                    <Row label="Última entrega" value={fmtBrDate(s.latestDeliveryDay)} />
                    {/* Frescor da FONTE, medido pelo próprio sync: até onde a
                        API tinha dado. Separado de "Última entrega" porque um
                        deal pode ter só parado de entregar — o que responde
                        "a base está atrasada?" é este. */}
                    {s.apiLastDay && (
                      <Row
                        label="Dado da fonte até"
                        value={s.status.waitingSourceClose
                          ? `${fmtBrDate(s.apiLastDay)} · ontem ainda não fechou na fonte`
                          : s.status.closedZero
                            ? `${fmtBrDate(s.apiLastDay)} · fonte em dia, entrega zero depois disso`
                          : s.dataLag && s.dataLag.days >= 1
                            ? `${fmtBrDate(s.apiLastDay)} · ${s.dataLag.days}d atrás`
                            : `${fmtBrDate(s.apiLastDay)} · em dia`}
                      />
                    )}
                    {s.linesCount != null && (
                      <Row label="Lines sincronizadas" value={String(s.linesCount)} />
                    )}
                  </ul>
                  <RunHistory runs={s.recentRuns} />
                  <ul className="py-1">
                  </ul>
                  {/* O erro cru da API é o que responde "por que parou?" sem
                      abrir o Cloud Logging — vale a feiura de mostrar inteiro. */}
                  {s.lastRunStatus === "error" && s.lastError && (
                    <p className="mx-4 mb-2 rounded-md bg-danger/10 px-2 py-1.5 text-[10.5px]
                                  leading-snug text-danger break-words font-mono">
                      {s.lastError.length > 240 ? `${s.lastError.slice(0, 240)}…` : s.lastError}
                    </p>
                  )}
                  {s.lastRunStatus === "ok" && s.credential && s.credential !== "primary" && (
                    <p className="px-4 pb-2 text-[10.5px] text-warning leading-snug">
                      Autenticado pela credencial de fallback ({s.credential}) — a primária
                      precisa ser reativada no seat.
                    </p>
                  )}
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
            Cron às 04h · PubMatic sondada de hora em hora (05h–23h) ·
            {" "}referência <span className="font-medium">ontem</span>.
            {" "}Falha → reportar no #data-pipelines.
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Histórico das últimas execuções de UMA fonte.
//
// Existe pra separar dois estados que a "última execução" sozinha funde — e
// que pedem consertos opostos:
//   • base velha porque a FONTE ainda não fechou D-1 → as sondagens rodaram,
//     todas vendo o mesmo dia; é esperar (ou a fonte está mesmo atrasada);
//   • base velha porque o SCHEDULER parou de disparar → há buracos de horas
//     na coluna da esquerda; é infra, e nenhuma mudança de schedule ajuda.
//
// Antes de existir, distinguir os dois exigia abrir o BigQuery — que na
// prática significa que ninguém distinguia, e o conserto virava chute.
function RunHistory({ runs }) {
  if (!runs || runs.length === 0) return null;
  return (
    <details className="group px-4 pb-2">
      <summary
        className="cursor-pointer list-none text-[11px] text-fg-muted
                   hover:text-fg transition-colors select-none
                   focus-visible:outline-none focus-visible:ring-2
                   focus-visible:ring-signature rounded"
      >
        <span className="inline-flex items-center gap-1">
          <span className="transition-transform group-open:rotate-90" aria-hidden>›</span>
          Últimas {runs.length} execuções
        </span>
      </summary>
      <ol className="mt-1.5 flex flex-col gap-0.5">
        {runs.map((r, i) => {
          const bad = r.status === "error" || r.status === "skipped";
          return (
            <li
              key={`${r.started_at}-${i}`}
              className="flex items-center gap-2 text-[10.5px] font-mono tabular-nums leading-relaxed"
              title={r.error || undefined}
            >
              <span className="text-fg-subtle w-[5.5rem] shrink-0">
                {fmtBrDayHour(r.started_at)}
              </span>
              <span
                className={cn("size-1.5 rounded-full shrink-0",
                  bad ? "bg-danger" : "bg-success")}
                aria-hidden
              />
              {/* O dia que a API tinha NAQUELE momento. Ler a coluna de cima
                  pra baixo mostra a hora exata em que a fonte fechou D-1 —
                  que é a pergunta que fazia o schedule ser palpite. */}
              <span className={cn("truncate", bad ? "text-danger" : "text-fg-muted")}>
                {bad
                  ? (r.status === "skipped" ? "não executado" : "falhou")
                  : r.api_last_day
                    ? `dado até ${fmtBrDate(r.api_last_day)}`
                    : "ok"}
              </span>
              {r.actor === "scheduler" ? null : (
                <span className="text-fg-subtle shrink-0">manual</span>
              )}
            </li>
          );
        })}
      </ol>
    </details>
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
