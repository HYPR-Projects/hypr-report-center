// src/v2/components/MaxAttentionSummaryCardV2.jsx
//
// Card "Max Attention" do Resumo por mídia (Visão Geral). Mesma moldura dos
// cards de Display e Vídeo, com as métricas comparáveis de todas as peças
// vinculadas: taxa de engajamento em destaque, sessões engajadas, cliques
// em CTA (da peça), viewability e CTR (da DSP, mesma régua da aba Display).
// Busca pelo mesmo cache da aba
// (useMaReport), então abrir a aba depois não refaz a requisição.

import { useMemo } from "react";
import { fmt, fmtCompact } from "../../shared/format";
import { dspDeliveryByPiece, pieceMedia, sumMedia } from "../../shared/maMetrics";
import { ymd } from "../../shared/dateFilter";
import { Card, CardBody } from "../../ui/Card";
import { Skeleton } from "../../ui/Skeleton";
import { cn } from "../../ui/cn";
import { useMaReport } from "../hooks/useMaReport";
import { TweenedValueV2 } from "./TweenedValueV2";

const pct = (v, d = 2) => (v == null ? "—" : `${fmt(v, d)}%`);

export function MaxAttentionSummaryCardV2({
  token,
  view = null,
  range = null,
  links = [],
  detail = null,
  layout = "stacked",
  onNavigate = null,
  className,
}) {
  const { status, data } = useMaReport({ token, view, range, enabled: links.length > 0 });
  const pieces = data?.pieces || [];
  // Mesma régua da aba: entrega pela DSP dos criativos ligados às peças.
  const from = range?.from ? ymd(range.from) : null;
  const to = range?.to ? ymd(range.to) : null;
  const dspLinks = data?.links?.length ? data.links : links;
  const dsp = useMemo(
    () => dspDeliveryByPiece(dspLinks, detail || [], from && to ? { from, to } : null),
    [dspLinks, detail, from, to],
  );
  const total = sumMedia(pieces.map((p) => pieceMedia(p, dsp.get(p.creative_id))));
  const count = links.length;

  const cells = [
    { label: "Sessões engajadas", value: fmtCompact(total.engaged) },
    { label: "Cliques em CTA", value: fmtCompact(total.ctaClicks) },
    { label: "Viewability", value: pct(total.viewability, 1) },
    total.ctr != null
      ? { label: "CTR", value: pct(total.ctr), accent: true }
      : { label: "CTR da peça", value: pct(total.ctaCtr), accent: true },
  ];

  const link = onNavigate ? (
    <button
      type="button"
      onClick={() => onNavigate("max-attention")}
      className="text-xs font-semibold text-signature hover:underline underline-offset-4 whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature rounded"
    >
      Ver Max Attention →
    </button>
  ) : null;

  const unavailable = status === "error" || (status === "ready" && (!data?.configured || !pieces.length));

  return (
    <Card className={cn("h-full", className)}>
      <CardBody className="p-0 h-full flex flex-col">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2 text-[13px] font-semibold text-fg">
            <SparkIcon />
            Max Attention
          </div>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-surface-strong text-[11px] tabular-nums text-fg-muted whitespace-nowrap">
            <span className="font-semibold text-fg mr-1">{count}</span>
            {count === 1 ? "peça" : "peças"}
          </span>
        </div>

        {status === "loading" || status === "idle" ? (
          <div className="px-5 py-4 space-y-3">
            <Skeleton className="h-7 w-28" />
            <div className="grid grid-cols-2 gap-3">
              {cells.map((c) => <Skeleton key={c.label} className="h-9" />)}
            </div>
          </div>
        ) : unavailable ? (
          <div className="px-5 py-6 text-[12px] text-fg-subtle leading-snug">
            {status === "ready" && data?.configured && !pieces.length
              ? "Peças vinculadas ainda sem medição no período."
              : "Métricas das peças indisponíveis no momento."}
          </div>
        ) : layout === "stacked" ? (
          <>
            <div className="px-5 pt-4 pb-3">
              <span className="text-[26px] font-semibold tabular-nums leading-none text-signature">
                <TweenedValueV2 value={pct(total.engagement)} />
              </span>
              <div className="text-[11px] text-fg-muted mt-1.5">Taxa de engajamento</div>
            </div>
            <div className="grid grid-cols-2 border-t border-border/60">
              {cells.map((c, i) => (
                <div
                  key={c.label}
                  className={cn(
                    "px-5 py-3 min-w-0",
                    i % 2 === 1 && "border-l border-border/60",
                    i >= 2 && "border-t border-border/60",
                  )}
                >
                  <div className={cn("text-[18px] font-semibold tabular-nums leading-tight truncate", c.accent ? "text-signature" : "text-fg")}>
                    <TweenedValueV2 value={c.value} />
                  </div>
                  <div className="text-[11px] text-fg-muted mt-1.5 truncate">{c.label}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-5 divide-y md:divide-y-0 md:divide-x divide-border/60">
            {[{ label: "Taxa de engajamento", value: pct(total.engagement), accent: true }, ...cells].map((c) => (
              <div key={c.label} className="px-5 py-4 min-w-0">
                <div className={cn("text-[22px] font-semibold tabular-nums leading-tight truncate", c.accent ? "text-signature" : "text-fg")}>
                  <TweenedValueV2 value={c.value} />
                </div>
                <div className="text-[11px] text-fg-muted mt-1.5 truncate">{c.label}</div>
              </div>
            ))}
          </div>
        )}

        {link && <div className="mt-auto px-5 py-3 border-t border-border/60">{link}</div>}
      </CardBody>
    </Card>
  );
}

function SparkIcon() {
  return (
    <svg className="size-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  );
}
