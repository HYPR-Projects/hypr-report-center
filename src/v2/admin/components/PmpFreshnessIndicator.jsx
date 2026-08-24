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
//   • dado em D-2                                    → amarelo
//   • dado em D-3 ou mais velho                      → vermelho
//
// D-2 é amarelo e não verde de propósito: é exatamente o estado em que a base
// ficou parada por semanas sem ninguém ver. É também o estado que o
// `pmp-pubmatic-refresh` (4x/dia) existe pra evitar — se ele estiver de pé,
// amarelo aqui significa que a PRÓPRIA fonte atrasou, o que é informação.
//
// Cutoff 05h cobre o cron de 04h + margem pro report do Xandr terminar.
// Sem ledger (backend antigo), cai no `lastSyncedAt` das lines — comportamento
// antigo, degradado mas nunca quebrado.

import { useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../../ui/cn";

const TZ_BR = "America/Sao_Paulo";
const CUTOFF_HOUR_BR = 5;

// Régua do atraso de DADO, em dias atrás de D-1. Constante nomeada porque é o
// número que precisa de ajuste se algum dia se confirmar que a API de reporting
// de uma fonte fecha D-1 mais tarde que a UI dela: aí o conserto é mexer aqui,
// não na lógica. Hoje 1 dia = amarelo porque foi exatamente em D-2 que a base
// da PubMatic ficou parada por semanas sem ninguém ver.
const DATA_LAG_WARN_DAYS = 1;

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

function daysBetweenBr(fromIso, toDate) {
  const a = new Date(`${brDateString(fromIso)}T00:00:00Z`);
  const b = new Date(`${brDateString(toDate)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// Dia BR de hoje como "YYYY-MM-DD", pra comparar com as datas DATE que o
// backend manda (api_last_day, last_delivery_day) sem passar por Date/UTC —
// que é onde essa comparação erra por um dia.
function brToday() {
  return brDateString(null);
}

function addDaysIso(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Distância em dias entre duas datas "YYYY-MM-DD" (b − a).
function daysBetweenIso(a, b) {
  return Math.round(
    (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

// ATRASO DE DADO. Quantos dias o dado mais recente está atrás de D-1 (o dia que
// a fonte já deveria ter fechado). Retorna null quando não há como afirmar.
//
// `apiLastDay` (do ledger) é a medida boa: é o último dia em que a API TINHA
// dado, medido no próprio sync. `latestDeliveryDay` (das lines) é o fallback
// pra quando o backend ainda não reporta frescor — pior, porque não distingue
// "a fonte não fechou o dia" de "os deals pararam de entregar".
//
// Por isso só roda com `expectsDelivery`: sem a garantia de que existe deal que
// DEVERIA estar entregando, este número mede fim de campanha, não atraso — e
// era justamente esse falso alarme que o ledger tinha acabado de matar.
function deriveDataLag(src) {
  if (!src.expectsDelivery) return null;

  // Caminho bom: frescor medido pelo próprio sync, contra a resposta da API.
  if (src.lagDays != null && src.apiLastDay) {
    return { days: Math.max(0, src.lagDays), day: src.apiLastDay };
  }
  // O ledger reportou frescor e não achou NENHUM dia com dado na janela toda.
  // Não é atraso — é conta sem entrega nenhuma acontecendo. Nada a afirmar.
  if (src.hasFreshness) return null;

  // Backend sem frescor no ledger: cai no last_delivery_day das lines. Pior
  // sinal (não separa "fonte atrasou" de "os deals pararam"), mas melhor que
  // não ter nenhum.
  if (!src.latestDeliveryDay) return null;
  const expected = addDaysIso(brToday(), -1);   // D-1
  return {
    days: Math.max(0, daysBetweenIso(src.latestDeliveryDay, expected)),
    day: src.latestDeliveryDay,
  };
}

// `src` = { lastRunAt, lastRunStatus, lastOkAt, lastSyncedAt, apiLastDay,
//           lagDays, latestDeliveryDay, expectsDelivery }.
// A falha do último run domina qualquer régua de data: um sync que rodou hoje
// e ESTOUROU não é "base atualizada hoje".
function deriveStatus(src) {
  const now = new Date();
  const { lastRunAt, lastRunStatus, lastOkAt } = src;

  if (lastRunStatus === "error") {
    const behind = lastOkAt ? daysBetweenBr(lastOkAt, now) : null;
    return {
      tone: "error",
      summary: behind == null
        ? "Sync falhando — nunca completou"
        : `Sync falhando há ${behind} ${behind === 1 ? "dia" : "dias"}`,
    };
  }

  // 'skipped' = o sync nem foi tentado (sem credencial no ambiente). Antes isso
  // não gerava row nenhuma e a fonte simplesmente não tinha status.
  if (lastRunStatus === "skipped") {
    return { tone: "error", summary: "Sync não executado — credencial ausente" };
  }

  // Sem ledger: fallback pro sinal antigo (synced_at das linhas de entrega).
  const ref = lastOkAt || lastRunAt || src.lastSyncedAt;
  if (!ref) return { tone: "neutral", summary: "Sem dados de sync" };

  const daysBehind = daysBetweenBr(ref, now);
  if (daysBehind > 0) {
    if (brHour(now) < CUTOFF_HOUR_BR) {
      return { tone: "neutral", summary: "Aguardando sync matinal" };
    }
    if (daysBehind === 1) {
      return { tone: "warn", summary: "Último sync foi ontem — cron pode ter falhado" };
    }
    return { tone: "error", summary: `Sem sync há ${daysBehind} dias` };
  }

  // O job está em dia. Falta a outra metade: o DADO chegou?
  // Este é o estado que passou semanas invisível — "Sync rodou hoje" em verde
  // com a base 2 dias atrás. Um job saudável não é evidência de base fresca.
  const lag = deriveDataLag(src);
  if (lag && lag.days >= DATA_LAG_WARN_DAYS) {
    const d = fmtBrDate(lag.day);
    return lag.days === DATA_LAG_WARN_DAYS
      ? { tone: "warn",  summary: `Sync ok, mas o dado para em ${d} (1 dia atrás)` }
      : { tone: "error", summary: `Sync ok, mas o dado para em ${d} (${lag.days} dias atrás)` };
  }
  return { tone: "ok", summary: "Sync rodou hoje · dado em dia" };
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
                        value={s.dataLag && s.dataLag.days >= 1
                          ? `${fmtBrDate(s.apiLastDay)} · ${s.dataLag.days}d atrás`
                          : `${fmtBrDate(s.apiLastDay)} · em dia`}
                      />
                    )}
                    {s.linesCount != null && (
                      <Row label="Lines sincronizadas" value={String(s.linesCount)} />
                    )}
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
            Cron às 04h · PubMatic re-sincroniza 10/14/18/22h ·
            {" "}referência <span className="font-medium">ontem</span>.
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
