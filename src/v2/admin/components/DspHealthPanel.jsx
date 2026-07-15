// src/v2/admin/components/DspHealthPanel.jsx
//
// Sneak peek da saúde de entrega POR DSP (DV360 / Xandr / Amazon /
// StackAdapt / Yahoo) — mora no header do menu admin ao lado do
// DataFreshnessIndicator, de quem herda o padrão (Popover Radix +
// refetch 5min/focus).
//
// Diferença de papel: o DataFreshnessIndicator responde "as BASES rodaram?"
// (pipeline); este painel responde "as DSPs estão ENTREGANDO bem?"
// (volume/negócio): imps de ontem vs média 7d por fonte, nº de campanhas
// entregando e — o detector de gargalo — campanhas ativas que entregavam
// na semana e zeraram ontem, clicáveis pra abrir o report.
//
// Dados: action=dsp_health (admin-gated), cacheado 5min no backend.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../../ui/cn";
import { getDspHealth } from "../../../lib/api";
import { SparklineV2 } from "../../components/SparklineV2";

const REFETCH_MS = 5 * 60 * 1000;

const DSP_COLORS = {
  DV360: "#4285F4",
  XANDR: "#8B5CF6",
  AMAZON: "#FF9900",
  STACKADAPT: "#14B8A6",
  YAHOO: "#D946EF",
};
const dspColor = (s) => DSP_COLORS[String(s || "").toUpperCase()] || "#3397B9";

const DSP_LABELS = {
  DV360: "DV360",
  XANDR: "Xandr",
  AMAZON: "Amazon",
  STACKADAPT: "StackAdapt",
  YAHOO: "Yahoo",
};
const dspLabel = (s) => DSP_LABELS[String(s || "").toUpperCase()] || s;

const TONE_CLASSES = {
  ok: { dot: "bg-success", text: "text-success" },
  warn: { dot: "bg-warning", text: "text-warning" },
  error: { dot: "bg-danger", text: "text-danger" },
  neutral: { dot: "bg-fg-subtle", text: "text-fg-subtle" },
};

const fmtCompact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
const fmtBrDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}` : "—";
};

function daysBehind(dateIso, refIso) {
  if (!dateIso || !refIso) return null;
  return Math.round(
    (new Date(`${refIso.slice(0, 10)}T00:00:00Z`) - new Date(`${dateIso.slice(0, 10)}T00:00:00Z`)) /
      86_400_000,
  );
}

// Tom por fonte: entregou no dia de referência (D-1) = ok; 2-3 dias sem
// entregar = warn; mais que isso = parada (error). Queda forte de volume
// (< 50% da média 7d) rebaixa pra warn mesmo entregando.
function sourceTone(s, referenceDate) {
  const behind = daysBehind(s.last_delivery, referenceDate);
  if (behind == null) return "neutral";
  if (behind > 3) return "error";
  if (behind > 0) return "warn";
  if (s.delta_pct != null && s.delta_pct < -50) return "warn";
  return "ok";
}

export function DspHealthPanel({ className, onOpenReport }) {
  const [state, setState] = useState({ loading: true, error: null, payload: null });
  const cancelRef = useRef({ cancelled: false });

  const fetchOnce = async () => {
    cancelRef.current.cancelled = false;
    try {
      const payload = await getDspHealth();
      if (cancelRef.current.cancelled) return;
      setState({ loading: false, error: null, payload });
    } catch (e) {
      if (cancelRef.current.cancelled) return;
      setState((prev) => ({ ...prev, loading: false, error: e }));
    }
  };

  useEffect(() => {
    const cancel = cancelRef.current;
    fetchOnce();
    const id = setInterval(fetchOnce, REFETCH_MS);
    const onFocus = () => {
      if (document.visibilityState === "visible") fetchOnce();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      cancel.cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const model = useMemo(() => {
    const p = state.payload;
    if (!p) return null;
    const sources = (p.sources || []).map((s) => ({
      ...s,
      tone: sourceTone(s, p.reference_date),
      spark: (p.daily || [])
        .filter((d) => d.source === s.source)
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((d) => d.impressions),
    }));
    const stoppedTotal = sources.reduce((a, s) => a + (s.stopped?.length || 0), 0);
    const worst = sources.some((s) => s.tone === "error")
      ? "error"
      : sources.some((s) => s.tone === "warn") || stoppedTotal > 0
        ? "warn"
        : sources.length
          ? "ok"
          : "neutral";
    return { sources, stoppedTotal, worst, referenceDate: p.reference_date };
  }, [state.payload]);

  const tone = TONE_CLASSES[model?.worst || "neutral"];
  const summary = !model
    ? "Consultando…"
    : model.worst === "ok"
      ? "DSPs entregando normalmente"
      : model.stoppedTotal > 0
        ? `${model.stoppedTotal} campanha${model.stoppedTotal > 1 ? "s" : ""} sem entrega ontem`
        : "Há fonte com atraso de entrega";

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Saúde das DSPs — ${summary}`}
          title={summary}
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
            <PulseIcon />
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
            "z-50 w-[360px] max-w-[calc(100vw-32px)]",
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
                Saúde das DSPs
              </span>
              {model?.referenceDate && (
                <span className="ml-auto text-[10.5px] text-fg-subtle font-mono">
                  ref. {fmtBrDate(model.referenceDate)}
                </span>
              )}
            </div>
            <p className={cn("mt-1 text-[12px] font-medium", tone.text)}>{summary}</p>
          </div>

          <div className="py-1 max-h-[420px] overflow-y-auto">
            {state.error ? (
              <p className="px-4 py-3 text-[12px] text-fg-subtle italic">
                Não foi possível consultar a saúde das DSPs.
              </p>
            ) : !model || (state.loading && model.sources.length === 0) ? (
              <p className="px-4 py-3 text-[12px] text-fg-subtle italic">Consultando…</p>
            ) : model.sources.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-fg-subtle italic">
                Nenhuma fonte com entrega na janela.
              </p>
            ) : (
              <ul>
                {model.sources.map((s) => {
                  const rc = TONE_CLASSES[s.tone];
                  return (
                    <li key={s.source} className="px-4 py-2.5 border-b border-border/40 last:border-0">
                      <div className="flex items-center gap-2.5">
                        <span
                          className="size-2 rounded-full shrink-0"
                          style={{ backgroundColor: dspColor(s.source) }}
                          aria-hidden
                        />
                        <span className="text-[12.5px] font-semibold text-fg flex-1">
                          {dspLabel(s.source)}
                        </span>
                        <span className={cn("size-1.5 rounded-full shrink-0", rc.dot)} />
                        <span className={cn("text-[11px] font-mono tabular-nums", rc.text)}>
                          {fmtBrDate(s.last_delivery)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-3 pl-[18px]">
                        <SparklineV2
                          values={s.spark}
                          stroke={dspColor(s.source)}
                          minValue={0}
                          width={110}
                          height={20}
                          ariaLabel={`Entrega 14d ${dspLabel(s.source)}`}
                        />
                        <div className="text-[11px] tabular-nums text-fg-muted whitespace-nowrap">
                          <span className="font-semibold text-fg">{fmtCompact.format(s.imps_d1)}</span>{" "}
                          imps
                          {s.delta_pct != null && (
                            <span
                              className={cn(
                                "ml-1.5 font-semibold",
                                s.delta_pct < -20
                                  ? "text-danger"
                                  : s.delta_pct < 0
                                    ? "text-warning"
                                    : "text-success",
                              )}
                            >
                              {s.delta_pct > 0 ? "+" : ""}
                              {s.delta_pct}%
                            </span>
                          )}
                          <span className="ml-1.5 text-fg-subtle">
                            · {s.tokens_d1} camp.
                          </span>
                        </div>
                      </div>
                      {(s.stopped?.length || 0) > 0 && (
                        <div className="mt-1.5 pl-[18px]">
                          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-danger">
                            ⚠ Sem entrega ontem
                          </div>
                          <ul className="mt-0.5 space-y-0.5">
                            {s.stopped.map((c) => (
                              <li key={`${s.source}-${c.short_token}`}>
                                <button
                                  type="button"
                                  onClick={() => onOpenReport?.(c.short_token)}
                                  className={cn(
                                    "text-[11.5px] text-fg-muted hover:text-fg hover:underline",
                                    "cursor-pointer text-left",
                                  )}
                                  title={`Abrir report ${c.short_token}`}
                                >
                                  <span className="font-medium text-fg">{c.client_name}</span>
                                  {" · "}
                                  {c.campaign_name}
                                  <span className="text-fg-subtle font-mono">
                                    {" "}
                                    (últ. {fmtBrDate(c.last_date)})
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="px-4 py-2 border-t border-border text-[10.5px] text-fg-subtle leading-snug">
            Volume entregue por fonte (consolidado) · referência{" "}
            <span className="font-medium">ontem</span> vs média 7d. Campanha
            listada = entregou na semana, zerou ontem e segue ativa.
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PulseIcon() {
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
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
