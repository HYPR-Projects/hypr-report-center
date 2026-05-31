// src/v2/admin/components/DataFreshnessIndicator.jsx
//
// Bolinha de status do rollup diário das bases de dados (DV360 / Xandr /
// StackAdapt). Visível só pra admin, mora ao lado do toggle de tema no
// header.
//
// Regras (hora-local America/Sao_Paulo, computada a partir do
// `server_now` UTC pro client não depender do clock local):
//
//   Antes das 07h BR → "aguardando rollup 06h" (cinza, neutro). Falsos
//     positivos seriam comuns se julgasse aqui: dependendo do horário,
//     o batch ainda está rodando, e a base de ontem (esperada) só vira
//     `MAX(date)` quando termina.
//   Depois das 07h BR:
//     0 fontes com `max_date < ontem`  → verde (ok)
//     1 fonte stale                    → amarelo (warn — uma falhou)
//     ≥2 fontes stale                  → vermelho (multi-falha)
//
// "Stale" = `dias_atrás(max_date) > 1`. O esperado depois do rollup é
// `max_date = ontem` (dia D-1), nunca hoje — o pipeline agrega o dia
// fechado.
//
// Refresh
// -------
// Refetch a cada 5min (bate com o TTL de cache do backend) e on focus.
// O custo da query é trivial (GROUP BY com partition pruning) e a UI
// continua "viva" se o admin deixa o menu aberto a manhã inteira.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../../ui/cn";
import { getDataFreshness, triggerUnifiedRebuild } from "../../../lib/api";

const REFETCH_MS       = 5 * 60 * 1000;
const CUTOFF_HOUR_BR   = 7;
const TZ_BR            = "America/Sao_Paulo";

// Labels humanizados pros valores brutos de `source` em BQ. Se o backend
// passar a expor uma nova plataforma (ex: TheTradeDesk), aparece com o
// valor cru até o label entrar aqui — sem quebrar nada.
const SOURCE_LABELS = {
  XANDR:      "Xandr",
  DV360:      "DV360",
  STACKADAPT: "StackAdapt",
};

const humanizeSource = (s) => {
  if (!s) return "?";
  return SOURCE_LABELS[String(s).toUpperCase()] || s;
};

// "2026-05-18" → "18/05". Aceita TIMESTAMP/DATE ISO; pega só DD/MM.
const fmtBrDate = (iso) => {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}` : iso;
};

// Extrai YYYY-MM-DD do `now` UTC convertendo pro fuso BR. `Intl` em
// "en-CA" devolve ISO-compatível direto (YYYY-MM-DD), evitando
// reordenação manual de partes.
function brDateString(utcIso) {
  const d = utcIso ? new Date(utcIso) : new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ_BR,
    year:  "numeric",
    month: "2-digit",
    day:   "2-digit",
  });
  return fmt.format(d);
}

function brHour(utcIso) {
  const d = utcIso ? new Date(utcIso) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_BR,
    hour:    "2-digit",
    hour12:  false,
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
}

// Diff de dias entre hoje BR e a data ISO. > 1 = stale.
function daysBehindBr(maxDateIso, serverNowIso) {
  if (!maxDateIso) return null;
  const today = brDateString(serverNowIso);
  const a = new Date(`${maxDateIso.slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${today}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// Tone do indicador a partir das fontes + relógio do servidor.
function deriveStatus(sources, serverNowIso) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return { tone: "neutral", summary: "Sem dados de frescor" };
  }
  const hour = brHour(serverNowIso);
  if (hour < CUTOFF_HOUR_BR) {
    return { tone: "neutral", summary: "Aguardando rollup 06h" };
  }
  const stale = sources.filter((s) => {
    const d = daysBehindBr(s.max_date, serverNowIso);
    return d != null && d > 1;
  });
  if (stale.length === 0) {
    return { tone: "ok", summary: "Bases atualizadas" };
  }
  if (stale.length === 1) {
    return { tone: "warn", summary: `${humanizeSource(stale[0].source)} desatualizada` };
  }
  return { tone: "error", summary: `${stale.length} fontes desatualizadas` };
}

const TONE_CLASSES = {
  ok:      { dot: "bg-success",   text: "text-success",   ring: "ring-success/30" },
  warn:    { dot: "bg-warning",   text: "text-warning",   ring: "ring-warning/30" },
  error:   { dot: "bg-danger",    text: "text-danger",    ring: "ring-danger/30" },
  neutral: { dot: "bg-fg-subtle", text: "text-fg-subtle", ring: "ring-border" },
};

export function DataFreshnessIndicator({ className }) {
  const [state, setState] = useState({
    loading:    true,
    error:      null,
    sources:    [],
    serverNow:  null,
    lastFetch:  null,
  });

  // Estado do botão de reconstrução manual (dispara o job no Dagster+).
  const [rebuild, setRebuild] = useState({ busy: false, ok: null, msg: "", runUrl: null });

  // Ref pra cancelar fetches stale (modo strict + unmount durante refetch).
  const cancelRef = useRef({ cancelled: false });

  const fetchOnce = async () => {
    cancelRef.current.cancelled = false;
    try {
      const data = await getDataFreshness();
      if (cancelRef.current.cancelled) return;
      setState({
        loading:   false,
        error:     null,
        sources:   data.sources || [],
        serverNow: data.serverNow,
        lastFetch: Date.now(),
      });
    } catch (e) {
      if (cancelRef.current.cancelled) return;
      setState((prev) => ({ ...prev, loading: false, error: e }));
    }
  };

  // Dispara a reconstrução manual no Dagster e re-checa o frescor depois (o
  // job leva alguns minutos pra materializar). Não bloqueia o popover.
  const onRebuild = async () => {
    setRebuild({ busy: true, ok: null, msg: "", runUrl: null });
    try {
      const res = await triggerUnifiedRebuild();
      setRebuild({
        busy: false, ok: true,
        msg: "Reconstrução disparada — leva alguns minutos.",
        runUrl: res?.run_url || null,
      });
      // Re-checa o frescor conforme o job vai terminando.
      setTimeout(fetchOnce, 90_000);
      setTimeout(fetchOnce, 240_000);
    } catch (e) {
      setRebuild({ busy: false, ok: false, msg: e.message || "Falha ao disparar.", runUrl: null });
    }
  };

  useEffect(() => {
    fetchOnce();
    const id = setInterval(fetchOnce, REFETCH_MS);
    const onFocus = () => {
      if (document.visibilityState === "visible") fetchOnce();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelRef.current.cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = useMemo(
    () => deriveStatus(state.sources, state.serverNow),
    [state.sources, state.serverNow],
  );
  const tone = TONE_CLASSES[status.tone] || TONE_CLASSES.neutral;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Status das bases — ${status.summary}`}
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
          {/* Ícone database em currentColor + dot de status sobreposto.
              Loading vira pulse no dot pra dar feedback sem placeholder
              feio. */}
          <span className="relative inline-flex">
            <DatabaseIcon />
            <span
              aria-hidden
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-surface",
                tone.dot,
                state.loading && "animate-pulse",
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
            "z-50 w-[280px] max-w-[calc(100vw-32px)]",
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
                Estado das bases
              </span>
            </div>
            <p className={cn("mt-1 text-[12px] font-medium", tone.text)}>
              {status.summary}
            </p>
          </div>

          <div className="py-1">
            {state.error ? (
              <p className="px-4 py-3 text-[12px] text-fg-subtle italic">
                Não foi possível consultar o status.
              </p>
            ) : state.loading && state.sources.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-fg-subtle italic">
                Consultando…
              </p>
            ) : state.sources.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-fg-subtle italic">
                Nenhuma fonte retornada.
              </p>
            ) : (
              <ul>
                {state.sources.map((s) => {
                  const d = daysBehindBr(s.max_date, state.serverNow);
                  // Pré-cutoff: sem julgamento, mostra cinza pra todos.
                  const hour = brHour(state.serverNow);
                  const isPreCutoff = hour < CUTOFF_HOUR_BR;
                  const rowTone = isPreCutoff
                    ? "neutral"
                    : d == null     ? "neutral"
                    : d <= 1        ? "ok"
                    : d === 2       ? "warn"
                    : "error";
                  const rc = TONE_CLASSES[rowTone];
                  return (
                    <li
                      key={s.source}
                      className="flex items-center gap-3 px-4 py-2 text-[12px]"
                    >
                      <span className={cn("size-1.5 rounded-full shrink-0", rc.dot)} />
                      <span className="font-medium text-fg flex-1">
                        {humanizeSource(s.source)}
                      </span>
                      <span className={cn("font-mono tabular-nums", rc.text)}>
                        {fmtBrDate(s.max_date)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Reconstrução manual — escape pra quando o run diário falhou
              (fonte atrasada). Dispara o job no Dagster+. */}
          <div className="px-4 pt-2 pb-3 border-t border-border">
            <button
              type="button"
              onClick={onRebuild}
              disabled={rebuild.busy}
              className={cn(
                "w-full h-8 rounded-md text-[12px] font-medium",
                "border border-border bg-surface text-fg",
                "hover:bg-surface-strong hover:border-border-strong transition-colors",
                "disabled:opacity-60 disabled:cursor-not-allowed",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
              )}
            >
              {rebuild.busy ? "Disparando…" : "Reconstruir agora"}
            </button>
            {rebuild.msg && (
              <p className={cn(
                "mt-2 text-[11px] leading-snug",
                rebuild.ok ? "text-success" : "text-danger",
              )}>
                {rebuild.msg}
                {rebuild.runUrl && (
                  <>
                    {" "}
                    <a
                      href={rebuild.runUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:no-underline"
                    >
                      ver run ↗
                    </a>
                  </>
                )}
              </p>
            )}
          </div>

          <div className="px-4 py-2 border-t border-border text-[10.5px] text-fg-subtle leading-snug">
            Rollup diário às 06h · referência <span className="font-medium">ontem</span>.
            {" "}Falha → reportar no #data-pipelines.
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
