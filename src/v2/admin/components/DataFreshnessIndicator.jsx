// src/v2/admin/components/DataFreshnessIndicator.jsx
//
// Bolinha de status do rollup diário das bases de dados (DV360 / Xandr /
// StackAdapt). Visível só pra admin, mora ao lado do toggle de tema no
// header.
//
// A RÉGUA mora em ../lib/dspFreshness.js (pura, testada). Aqui fica só a
// apresentação. Em resumo do que ela decide:
//
//   Severidade por DIAS de atraso, não por quantidade de fontes: 1 fonte
//     parada há 5 dias é vermelho. Até 18/09/2026 era `blockers.length >= 2 ?
//     error : warn` e a Amazon passou 5 dias amarela no cabeçalho com a
//     própria linha dela vermelha logo abaixo.
//   Antes das 07h BR, atraso de 1–2 dias não se julga (o rollup ainda pode
//     estar rodando). Fonte PARADA (>= 3 dias) alarma em qualquer hora —
//     nenhum rollup das 06h explica três dias.
//   Consolidado é medido no total E por fonte: fresco na data com uma DSP
//     faltando dentro é PARCIAL, não verde.
//
// CRÍTICO: as fontes são medidas na própria camada raw/tratada
// (`query_source_landings` no backend), não no `unified`. Ler o `unified`
// (output) fazia uma fonte travada pintar TODAS de vermelho e escondia fonte
// parada há +7d (fora da janela).
//
// Refresh
// -------
// Refetch a cada 5min (bate com o TTL de cache do backend) e on focus.
// O custo da query é trivial (GROUP BY com partition pruning) e a UI
// continua "viva" se o admin deixa o menu aberto a manhã inteira.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AdminRailRow, StatusDot } from "../shell/AdminNavItem";
import { cn } from "../../../ui/cn";
import { getDataFreshness, getRebuildStatus, triggerUnifiedRebuild } from "../../../lib/api";
import { isFeatureAdmin } from "../../../shared/auth";
import {
  deriveStatus, daysBehindBr, brHour, fmtBrDate, humanizeSource, toneForDays,
  CUTOFF_HOUR_BR, SOURCE_DOWN_DAYS, isAuditable,
} from "../lib/dspFreshness";
import { DspLandingAuditModal } from "./DspLandingAuditModal";

const REFETCH_MS = 5 * 60 * 1000;

const TONE_CLASSES = {
  ok:      { dot: "bg-success",   text: "text-success",   ring: "ring-success/30" },
  warn:    { dot: "bg-warning",   text: "text-warning",   ring: "ring-warning/30" },
  error:   { dot: "bg-danger",    text: "text-danger",    ring: "ring-danger/30" },
  neutral: { dot: "bg-fg-subtle", text: "text-fg-subtle", ring: "ring-border" },
};

export function DataFreshnessIndicator({ className, user, variant = "icon" }) {
  // Reconstrução manual é restrita à lista FEATURE_ADMINS. Demais admins
  // veem o status das bases mas não o botão "Reconstruir agora".
  const canRebuild = isFeatureAdmin(user);
  const [state, setState] = useState({
    loading:    true,
    error:      null,
    sources:    [],
    unifiedMax: null,
    unifiedBySource: null,
    serverNow:  null,
    lastFetch:  null,
  });

  // Estado do botão de reconstrução manual (dispara o job no Dagster+).
  // `polling` = run em andamento sendo acompanhada até o fim.
  const [rebuild, setRebuild] = useState({ busy: false, polling: false, ok: null, msg: "", runUrl: null });

  // Fonte sendo auditada no modal ("por que parou?"). Fora do popover: o modal
  // é overlay e clicar nele fecharia o popover por outside-click.
  const [auditSource, setAuditSource] = useState(null);

  // Ref pra cancelar fetches stale (modo strict + unmount durante refetch).
  const cancelRef = useRef({ cancelled: false });
  // Interval do acompanhamento da run de rebuild (limpo no unmount).
  const pollRef = useRef(null);

  const fetchOnce = async () => {
    cancelRef.current.cancelled = false;
    try {
      const data = await getDataFreshness();
      if (cancelRef.current.cancelled) return;
      setState({
        loading:    false,
        error:      null,
        sources:    data.sources || [],
        unifiedMax: data.unifiedMax || null,
        unifiedBySource: data.unifiedBySource || null,
        serverNow:  data.serverNow,
        lastFetch:  Date.now(),
      });
    } catch (e) {
      if (cancelRef.current.cancelled) return;
      setState((prev) => ({ ...prev, loading: false, error: e }));
    }
  };

  // Acompanha a run no Dagster até terminar (poll 30s, teto 30 min). No
  // SUCCESS o backend já derrubou o cache da lista (rebuild_status) — o
  // evento `hypr:bases-rebuilt` avisa o menu pra refazer a lista com
  // refresh:true; aqui recarregamos o frescor do indicador.
  const startRunPolling = (runId, runUrl) => {
    if (!runId) {
      // Sem run_id não há o que acompanhar — mantém o comportamento antigo.
      setRebuild({ busy: false, polling: false, ok: true, msg: "Reconstrução disparada — leva alguns minutos.", runUrl });
      return;
    }
    clearInterval(pollRef.current);
    const startedAt = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > 30 * 60_000) {
        clearInterval(pollRef.current);
        setRebuild({ busy: false, polling: false, ok: false, msg: "A run não terminou em 30 min — acompanhe no Dagster.", runUrl });
        return;
      }
      try {
        const st = await getRebuildStatus(runId);
        if (!st?.done) return;
        clearInterval(pollRef.current);
        if (st.succeeded) {
          setRebuild({ busy: false, polling: false, ok: true, msg: "Bases reconstruídas — lista de campanhas atualizada.", runUrl });
          fetchOnce();
          window.dispatchEvent(new CustomEvent("hypr:bases-rebuilt"));
        } else {
          setRebuild({ busy: false, polling: false, ok: false, msg: `Reconstrução terminou com status ${st.status}.`, runUrl });
        }
      } catch {
        /* erro transiente de poll — tenta de novo no próximo tick até o teto */
      }
    }, 30_000);
  };

  // Dispara a reconstrução manual no Dagster e acompanha a run até o fim.
  // Não bloqueia o popover.
  const onRebuild = async () => {
    setRebuild({ busy: true, polling: false, ok: null, msg: "", runUrl: null });
    try {
      const res = await triggerUnifiedRebuild();
      // O backend deduplica: se já há run em fila/execução, devolve a run
      // existente com already_running=true em vez de disparar (e cobrar) outra.
      setRebuild({
        busy: false, polling: true, ok: null,
        msg: res?.already_running
          ? "Já existe uma reconstrução em andamento — acompanhando essa run."
          : "Reconstrução disparada — acompanhando a run até o fim (leva alguns minutos).",
        runUrl: res?.run_url || null,
      });
      startRunPolling(res?.run_id, res?.run_url || null);
    } catch (e) {
      setRebuild({ busy: false, polling: false, ok: false, msg: e.message || "Falha ao disparar.", runUrl: null });
    }
  };

  useEffect(() => {
    fetchOnce();
    const id = setInterval(fetchOnce, REFETCH_MS);
    // Voltar pra aba dispara `visibilitychange` E `focus` — com um fetch em
    // cada, todo alt-tab custava 2 requests idênticas (× 2 componentes que
    // fazem isso = 4 por alt-tab, todas com preflight CORS). O guard de 10s
    // colapsa a dupla num fetch só sem perder a atualização ao retomar.
    let lastFocusFetch = 0;
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFocusFetch < 10_000) return;
      lastFocusFetch = Date.now();
      fetchOnce();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelRef.current.cancelled = true;
      clearInterval(id);
      clearInterval(pollRef.current);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = useMemo(
    () => deriveStatus({
      sources:         state.sources,
      unifiedMax:      state.unifiedMax,
      unifiedBySource: state.unifiedBySource,
      serverNow:       state.serverNow,
    }),
    [state.sources, state.unifiedMax, state.unifiedBySource, state.serverNow],
  );
  const tone = TONE_CLASSES[status.tone] || TONE_CLASSES.neutral;

  // Tom da linha "Consolidado" (o que os reports servem de fato) — vem da
  // régua, que cruza o MAX global com o MAX por fonte lá dentro. Calcular só
  // pela data aqui era o que pintava de verde um consolidado sem Amazon.
  const unifiedTone = TONE_CLASSES[status.unified?.tone || "neutral"];

  const isRail = variant === "rail";
  // Meta da linha do rail: a hora do último rollup consolidado. É o número
  // que a operação procura ("já rodou hoje?") e cabe em 5 caracteres —
  // então vale o espaço à direita do rótulo. Enquanto carrega, fica vazio
  // em vez de "—": o dot já está pulsando e dizer "sem dado" seria mentira.
  const railMeta = state.loading
    ? undefined
    : (state.unifiedMax ? formatRailClock(state.unifiedMax) : undefined);

  return (
    <>
    <Popover.Root>
      <Popover.Trigger asChild>
        {isRail ? (
          // Variante de rail: linha nomeada com dot de severidade e a hora
          // do último rollup à direita. No header antigo isto era um
          // botão-ícone de 36px indistinguível dos outros três — você
          // precisava passar o mouse pra saber o que era.
          <AdminRailRow
            label="Estado das bases"
            iconNode={<StatusDot toneClass={tone.dot} pulse={state.loading} />}
            meta={railMeta}
            tipHint={status.summary}
            // O nome acessível começa com o rótulo VISÍVEL ("Estado das
            // bases") — WCAG 2.5.3: controle por voz usa o que se lê na tela.
            aria-label={`Estado das bases — ${status.summary}`}
            title={status.summary}
          />
        ) : (
          <button
            type="button"
            // O nome acessível começa com o rótulo VISÍVEL ("Estado das
            // bases") — WCAG 2.5.3: controle por voz usa o que se lê na tela.
            aria-label={`Estado das bases — ${status.summary}`}
            title={status.summary}
            className={cn(
              "inline-flex items-center justify-center size-8 rounded-full",
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
        )}
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side={isRail ? "right" : "bottom"}
          sideOffset={8}
          align={isRail ? "start" : "end"}
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
              <span className="lbl-section text-fg-muted">
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
                  // Pré-cutoff: sem julgamento pra quem está só atrasado —
                  // o rollup das 06h ainda pode estar rodando. Fonte PARADA
                  // (>= SOURCE_DOWN_DAYS) pinta em qualquer hora.
                  const hour = brHour(state.serverNow);
                  const isPreCutoff = hour < CUTOFF_HOUR_BR;
                  // Mesma régua do cabeçalho (toneForDays). Antes eram duas
                  // implementações e elas discordavam: linha vermelha embaixo
                  // de cabeçalho amarelo, 18/09/2026.
                  const rowTone = isPreCutoff && (d == null || d < SOURCE_DOWN_DAYS)
                    ? "neutral"
                    : toneForDays(d);
                  const rc = TONE_CLASSES[rowTone];
                  return (
                    <li
                      key={s.source}
                      className="flex items-center gap-3 px-4 py-2 text-[12px]"
                      title={d == null ? undefined : d <= 1 ? "em dia" : `${d} dias atrás`}
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

          {/* Consolidado — o que os reports realmente servem. Separado das
              fontes: uma fonte pode estar fresca e o consolidado atrasado (e
              vice-versa). É a fonte da verdade do "report atualizado?". */}
          {state.unifiedMax && (
            <div className="flex items-center gap-3 px-4 py-2 text-[12px] border-t border-border bg-surface-strong/40">
              <span className={cn("size-1.5 rounded-full shrink-0", unifiedTone.dot)} />
              <span className="font-medium text-fg-muted flex-1 min-w-0">
                Consolidado (reports)
                {/* Fonte que não entrou no build. Sem isto a linha dizia só a
                    data — e a data estava certa; o que faltava era metade da
                    verdade. */}
                {status.unified?.label && (
                  <span className={cn("block truncate font-normal", unifiedTone.text)}>
                    {status.unified.label}
                  </span>
                )}
              </span>
              <span className={cn("font-mono tabular-nums shrink-0", unifiedTone.text)}>
                {fmtBrDate(state.unifiedMax)}
              </span>
            </div>
          )}

          {/* "Por que parou?" — a pergunta que o dot não responde. Liberado
              pra qualquer admin: reconstruir custa uma run de BQ e por isso é
              restrito, mas LER o diagnóstico é barato, e quem precisa dele é
              exatamente quem não tem gcloud na mão. */}
          {status.blockers.filter((b) => isAuditable(b.source)).length > 0 && (
            <div className="px-4 pt-2 pb-1 border-t border-border">
              {status.blockers.filter((b) => isAuditable(b.source)).map((b) => (
                <button
                  key={b.source}
                  type="button"
                  onClick={() => setAuditSource(b.source)}
                  className={cn(
                    "w-full h-8 rounded-md text-[12px] font-medium transition-colors mb-1 last:mb-0",
                    "border border-border bg-surface text-fg",
                    "hover:bg-surface-strong hover:border-border-strong cursor-pointer",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                  )}
                >
                  Por que a {humanizeSource(b.source)} parou?
                </button>
              ))}
            </div>
          )}

          {/* Reconstrução manual — escape pra quando a consolidação atrasou com
              as fontes prontas. NÃO resolve fonte que não entregou (upstream):
              o hint abaixo deixa isso explícito pra não dar falsa esperança.
              Restrito à lista FEATURE_ADMINS (mesmos 4 do PMP Deals). */}
          {canRebuild && (
          <div className="px-4 pt-2 pb-3 border-t border-border">
            {!rebuild.msg && status.blockers.length > 0 && (
              <p className="mb-2 text-[11px] leading-snug text-danger">
                {status.blockers
                  .map((b) => `${humanizeSource(b.source)} (${b.days}d)`)
                  .join(", ")}{" "}
                não {status.blockers.length > 1 ? "entregaram" : "entregou"} a
                montante (export/connector da DSP). Reconstruir não traz dado que
                a fonte não mandou — corrija na origem.
              </p>
            )}
            {!rebuild.msg && status.rebuildHelps && (
              <p className="mb-2 text-[11px] leading-snug text-warning">
                {status.unified?.missing?.length
                  ? "A fonte entregou e o build não pegou — reconstruir monta o unified com ela agora."
                  : "Fontes prontas, consolidação atrasada — reconstruir monta o unified agora."}
              </p>
            )}
            {/* Desabilitado também após disparo OK: a run leva minutos e
                clique repetido custava uma run inteira de BQ. O backend ainda
                deduplica server-side (dois admins, máquinas diferentes). */}
            <button
              type="button"
              onClick={onRebuild}
              disabled={rebuild.busy || rebuild.polling || rebuild.ok === true}
              className={cn(
                "w-full h-8 rounded-md text-[12px] font-medium transition-colors",
                "disabled:opacity-60 disabled:cursor-not-allowed",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                status.rebuildHelps
                  ? "border border-signature/40 bg-signature/10 text-signature hover:bg-signature/20"
                  : "border border-border bg-surface text-fg hover:bg-surface-strong hover:border-border-strong",
              )}
            >
              {rebuild.busy
                ? "Disparando…"
                : rebuild.polling
                  ? "Reconstruindo…"
                  : rebuild.ok === true
                    ? "Bases reconstruídas ✓"
                    : "Reconstruir agora"}
            </button>
            {rebuild.msg && (
              <p className={cn(
                "mt-2 text-[11px] leading-snug",
                rebuild.ok === true ? "text-success"
                  : rebuild.ok === false ? "text-danger"
                  : "text-fg-muted",
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
          )}

          <div className="px-4 py-2 border-t border-border text-[10.5px] text-fg-subtle leading-snug">
            Rollup diário às 06h · referência <span className="font-medium">ontem</span>.
            {" "}Falha → reportar no #data-pipelines.
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    {auditSource && (
      <DspLandingAuditModal source={auditSource} onClose={() => setAuditSource(null)} />
    )}
    </>
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

/**
 * Hora (HH:MM) do rollup consolidado, no fuso de São Paulo — o mesmo em que
 * a operação pensa. Recebe o que o backend devolve em `unifiedMax`, que pode
 * ser uma data (YYYY-MM-DD, sem hora) ou um timestamp completo; no primeiro
 * caso não há hora pra mostrar e devolvemos a data curta.
 */
function formatRailClock(value) {
  if (!value) return undefined;
  const raw = String(value);
  // "2026-08-24" → sem componente de hora.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw.slice(8, 10)}/${raw.slice(5, 7)}`;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    return d.toLocaleTimeString("pt-BR", {
      hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
    });
  } catch {
    return undefined;
  }
}
