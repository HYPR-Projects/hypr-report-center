// src/v2/components/ma/MaPieceDetailV2.jsx
//
// Detalhe de uma peça Max Attention, em seções com título (padrões em
// maUi.jsx, grid de 12 colunas com divisões 4/8, 6/6 e 12):
//
//   Resumo        preview (4) · engajamento, entrega de mídia e funil (8)
//   Comportamento quebras nativas do formato (como interagiram, onde
//                 clicaram) e os blocos próprios (slides, revelação, vídeo,
//                 respostas, partidas)
//   Endereços     ranking + mapa (Tap to Map)
//   Widgets       um bloco por widget plugado; Loja mais próxima ganha seção
//                 própria com o ranking e o mapa
//   Por dia       engajamento da peça dia a dia
//
// A migalha volta ao menu do Max Attention; a troca de peça fica no seletor
// ao lado dela (não há mais trilho lateral).

import { useMemo, useState } from "react";
import { fmt } from "../../../shared/format";
import {
  MA_FORMATS,
  MECHANIC_LABELS,
  buildFunnel,
  formatBreakdowns,
  formatLabel,
  isWaiting,
  keyMetric,
  videoFunnel,
  widgetBlocks,
} from "../../../shared/maMetrics";
import { quickRead } from "../../../shared/maQuickRead";
import { cn } from "../../../ui/cn";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useThemeColors } from "../../hooks/useThemeColors";
import { ChipGroupV2 } from "../ChipGroupV2";
import { TrendChartV2 } from "../TrendChartV2";
import { MaAddressExplorerV2 } from "./MaAddressExplorerV2";
import { MaFunnelV2 } from "./MaFunnelV2";
import { MaPreviewV2 } from "./MaPreviewV2";
import { MaStackBarV2, SMALL_SAMPLE } from "./MaStackBarV2";
import { MaThumbV2 } from "./MaThumbV2";
import {
  CsvButton,
  HyprOnlyBadge,
  InfoTip,
  MaBadge,
  MaBarRows,
  MaCard,
  MaSection,
  MaStat,
  MaStatGroup,
} from "./maUi";
import { downloadCsv, keyMetricText, pct, pieceDisplay, resolveChartVar, secondsText } from "./maFormat";

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const sumParts = (parts) => (parts || []).reduce((s, p) => s + n(p.value), 0);

export function MaPieceDetailV2({
  piece,
  pieces,
  media,
  avgEngagement = null,
  formatColors,
  onSelect,
  onBack,
  canFilterFormat = false,
  campaignStart = null,
  isDemo = false,
  campaignName = "campanha",
  campaignTitle = null,
  heroId = null,
  hypr = false,
}) {
  const idx = pieces.findIndex((p) => p.creative_id === piece.creative_id);
  const prev = pieces[(idx - 1 + pieces.length) % pieces.length];
  const next = pieces[(idx + 1) % pieces.length];
  // Sentido da última troca de peça: o conteúdo desliza de onde o clique
  // "veio". null na montagem (entrada do menu é a View Transition).
  const [dir, setDir] = useState(null);
  const select = (id, d) => {
    if (id === piece.creative_id) return;
    const to = pieces.findIndex((p) => p.creative_id === id);
    setDir(d || (to < idx ? "prev" : "next"));
    onSelect(id);
  };
  const isLg = useMediaQuery("(min-width: 1024px)");
  const color = formatColors[piece.format];
  const km = keyMetric(piece);
  const waiting = isWaiting(piece);
  const funnel = buildFunnel(piece);
  const breakdowns = formatBreakdowns(piece);
  const widgets = widgetBlocks(piece);
  const display = pieceDisplay(piece, campaignTitle);
  const delta = avgEngagement != null && media.engagement != null && pieces.length > 1
    ? media.engagement - avgEngagement
    : null;
  const fileBase = `${campaignName} - ${piece.name}`.replace(/[\\/:*?"<>|]+/g, " ");
  const closeTo = widgets.filter((w) => w.kind === "close_to");
  const otherWidgets = widgets.filter((w) => w.kind !== "close_to");
  const dsp = media.deliverySource === "dsp";

  return (
    <div className="space-y-5 min-w-0">
      {/* Migalha + troca de peça. Ficam fora do bloco que desliza para não
          perderem o foco de quem navega com "próxima" repetido. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Você está em" className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-fg-subtle">
          <button type="button" onClick={() => onBack()} className="font-bold text-signature hover:underline underline-offset-4 cursor-pointer">
            Max Attention
          </button>
          <span aria-hidden>›</span>
          {canFilterFormat ? (
            <button type="button" onClick={() => onBack(piece.format)} className="font-bold text-signature hover:underline underline-offset-4 cursor-pointer">
              {formatLabel(piece.format)}
            </button>
          ) : (
            <span className="text-fg-muted">{formatLabel(piece.format)}</span>
          )}
          <span aria-hidden>›</span>
          <span className="font-semibold text-fg truncate max-w-[40ch]" aria-current="page">{display.crumb}</span>
        </nav>
        {pieces.length > 1 && (
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => select(prev.creative_id, "prev")} className="h-8 px-2.5 rounded-md border border-border text-fg-muted hover:text-fg cursor-pointer" aria-label="Peça anterior">←</button>
            <label className="sr-only" htmlFor="ma-piece-select">Peça</label>
            <select
              id="ma-piece-select"
              value={piece.creative_id}
              onChange={(e) => select(e.target.value)}
              className="h-8 max-w-[52vw] sm:max-w-[260px] rounded-md border border-border bg-surface-2 px-2 text-xs font-semibold text-fg cursor-pointer"
            >
              {pieces.map((p, i) => (
                <option key={p.creative_id} value={p.creative_id}>{`${i + 1} de ${pieces.length} · ${formatLabel(p.format)} · ${p.name}`}</option>
              ))}
            </select>
            <button type="button" onClick={() => select(next.creative_id, "next")} className="h-8 px-2.5 rounded-md border border-border text-fg-muted hover:text-fg cursor-pointer" aria-label="Próxima peça">→</button>
          </div>
        )}
      </div>

      <div
        key={piece.creative_id}
        className={cn("space-y-10", dir === "prev" && "slide-in-prev", dir === "next" && "slide-in-next")}
      >
        <PieceHeader piece={piece} display={display} color={color} waiting={waiting} />

        <MaSection
          title="Resumo"
          subtitle={dsp ? "Engajamento medido pela peça · entrega pela DSP" : "Engajamento e entrega medidos pela peça"}
        >
          <div className="grid gap-4 lg:grid-cols-12 items-start">
            <div className="lg:col-span-4 lg:sticky lg:top-[168px] order-last lg:order-none min-w-0">
              <MaPreviewV2
                piece={piece}
                color={color}
                campaignStart={campaignStart}
                isDemo={isDemo}
                hero={heroId === piece.creative_id}
                collapsible={!isLg}
              />
            </div>
            <div className="lg:col-span-8 space-y-4 min-w-0">
              {waiting ? (
                <MaCard title="Aguardando a primeira impressão">
                  <p className="text-[13px] text-fg-muted leading-relaxed">
                    A peça está vinculada à campanha e ainda não entregou no período. Os números aparecem aqui assim que ela entregar.
                  </p>
                </MaCard>
              ) : (
                <EngagementCard piece={piece} media={media} km={km} delta={delta} hypr={hypr} />
              )}
              <DeliveryCard media={media} hypr={hypr} />
              {!waiting && (
                <MaCard
                  title="Funil de engajamento"
                  subtitle={`Etapas do ${formatLabel(piece.format)} · em pessoas · % sobre a etapa anterior`}
                >
                  {funnel.source === "unavailable" ? (
                    <p className="text-[13px] text-fg-subtle">
                      O funil em pessoas está indisponível no momento para esta peça. As demais métricas seguem valendo; tente de novo em alguns minutos.
                    </p>
                  ) : (
                    <MaFunnelV2 steps={funnel.steps} subs={funnel.subs} baseAsPercent={!hypr} />
                  )}
                </MaCard>
              )}
            </div>
          </div>
        </MaSection>

        {!waiting && <Behavior piece={piece} media={media} breakdowns={breakdowns} hypr={hypr} fileBase={fileBase} />}

        {!waiting && piece.format === "tap-to-map" && <MapAddresses piece={piece} fileBase={fileBase} />}

        {!waiting && otherWidgets.length > 0 && (
          <MaSection title="Widgets" subtitle="Blocos plugados na peça · toque no widget conta como engajamento, não como clique da peça">
            <div className={cn("grid gap-4", otherWidgets.length > 1 && "md:grid-cols-2")}>
              {otherWidgets.map((w, i) => (
                <WidgetBlock
                  key={w.id || w.type}
                  w={w}
                  className={otherWidgets.length > 1 && otherWidgets.length % 2 === 1 && i === otherWidgets.length - 1 ? "md:col-span-2" : undefined}
                />
              ))}
            </div>
          </MaSection>
        )}

        {!waiting && closeTo.map((w) => <CloseToBlock key={w.id || w.type} w={w} fileBase={fileBase} />)}

        {!waiting && piece.daily?.length > 0 && <PieceTrend piece={piece} color={color} hypr={hypr} />}
      </div>
    </div>
  );
}

// ─── Cabeçalho ─────────────────────────────────────────────────────────

function PieceHeader({ piece, display, color, waiting }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      navigator.clipboard
        .writeText(display.technical)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        })
        .catch(() => {});
    } catch {
      /* clipboard indisponível: o nome continua selecionável */
    }
  };
  const meta = [
    waiting ? "Aguardando a primeira impressão" : null,
    display.formatInTitle ? null : formatLabel(piece.format),
    piece.size || null,
    piece.mechanic ? `mecânica ${MECHANIC_LABELS[piece.mechanic] || piece.mechanic}` : null,
    piece.survey_mode === "poll" ? "modo pesquisa" : null,
    piece.game_type ? `jogo ${piece.game_type}` : null,
    MA_FORMATS[piece.format]?.desc || null,
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-3 min-w-0">
      <MaThumbV2 format={piece.format} color={color} className="size-11 shrink-0 rounded-xl [&_svg]:size-5" />
      <div className="min-w-0">
        <h2 className="text-xl font-bold text-fg leading-tight">{display.title}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-subtle">
          {meta.map((m, i) => (
            <span key={m} className="inline-flex items-center gap-2">
              {i > 0 && <span aria-hidden>·</span>}
              {m}
            </span>
          ))}
          {display.technical && (
            <span className="inline-flex min-w-0 max-w-full items-center gap-2">
              {meta.length > 0 && <span aria-hidden>·</span>}
              <button
                type="button"
                onClick={copy}
                title="Copiar o nome da peça"
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 font-mono text-[11px] hover:text-fg cursor-pointer"
              >
                <span className="truncate">{display.technical}</span>
                {copied ? <span className="font-sans font-semibold text-success">copiado</span> : <CopyIcon />}
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Resumo ────────────────────────────────────────────────────────────

/** Três números de apoio: quantos interagiram + o que é profundo no formato. */
function supportStats(piece, media, km) {
  const s = piece.steps || {};
  const engaged = n(media.engaged);
  const out = [{ key: "engaged", label: "Pessoas que interagiram", value: fmt(media.engaged), note: "ao menos uma interação ativa" }];
  if (piece.format === "tap-to-map" && piece.steps) {
    const explored = n(s.map_interaction);
    const acts = [["pin", n(s.pin_click)], ["rota", n(s.cta_directions)], ["WhatsApp", n(s.cta_whatsapp)], ["site", n(s.cta_website)]];
    const total = acts.reduce((a, [, v]) => a + v, 0);
    out.push({
      key: "map",
      label: "Exploraram o mapa",
      value: fmt(explored),
      note: engaged > 0 ? `${pct((explored / engaged) * 100, 0)} de quem interagiu` : null,
    });
    out.push({
      key: "actions",
      label: "Ações no mapa",
      value: fmt(total),
      note: acts.filter(([, v]) => v > 0).map(([l, v]) => `${fmt(v)} ${l}`).join(" · ") || "pin, rota, WhatsApp ou site",
    });
    return out;
  }
  out.push({ key: "km", label: km.label, value: keyMetricText(km), note: "destaque do formato" });
  out.push({
    key: "click",
    label: "Clicaram",
    value: fmt(media.clickSessions),
    note: engaged > 0 && media.clickSessions != null ? `${pct((n(media.clickSessions) / engaged) * 100, 1)} de quem interagiu` : "pessoas que clicaram na peça",
  });
  return out;
}

function EngagementCard({ piece, media, km, delta, hypr }) {
  const viewed = n(piece.steps?.viewable);
  const ofViewed = piece.steps && viewed > 0 && n(media.engaged) <= viewed ? (n(media.engaged) / viewed) * 100 : null;
  const read = quickRead(piece, media);
  const stats = supportStats(piece, media, km);
  return (
    <MaCard
      title="Engajamento"
      subtitle={hypr && !media.exactPeople ? "Medido pela peça · sessões (estimado)" : "Medido pela peça · pessoas no período"}
      actions={
        <InfoTip label="Como a taxa é calculada">
          Taxa de engajamento = pessoas que interagiram ÷ sessões em que a peça carregou. No funil, a etapa
          “Interagiu” usa como base quem viu a peça (metade dela na tela por 1 s), por isso o percentual ali é maior.
        </InfoTip>
      }
      footer={
        read ? (
          <div className="flex w-full items-start gap-2 text-[13px] leading-relaxed text-fg-muted">
            <BulbIcon />
            <p><b>Leitura rápida:</b> {read}</p>
          </div>
        ) : null
      }
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 pb-4 mb-4 border-b border-border/70">
        <MaStat size="xl" label="Taxa de engajamento" value={pct(media.engagement)} />
        <div className="text-xs text-fg-subtle leading-relaxed sm:text-right">
          <div>
            {hypr
              ? `${fmt(media.engaged)} de ${fmt(media.sessions)} ${media.exactPeople ? "pessoas" : "sessões (estimado)"}`
              : "das sessões em que a peça carregou"}
          </div>
          {ofViewed != null && (
            <div><b className="font-semibold text-fg tabular-nums">{pct(ofViewed, 1)}</b> de quem viu a peça</div>
          )}
          {delta != null && (
            <div className="mt-1.5">
              <MaBadge tone={delta >= 0 ? "good" : "bad"} title="Engajamento da peça menos o da campanha">
                {delta >= 0 ? "▲" : "▼"} {fmt(Math.abs(delta), 2)} p.p. vs. média das peças
              </MaBadge>
            </div>
          )}
        </div>
      </div>
      <MaStatGroup cols={3}>
        {stats.map((s) => <MaStat key={s.key} size="m" label={s.label} value={s.value} note={s.note} />)}
      </MaStatGroup>
    </MaCard>
  );
}

function DeliveryCard({ media, hypr }) {
  const dsp = media.deliverySource === "dsp";
  return (
    <MaCard
      title="Entrega de mídia"
      subtitle={dsp ? "Mesma base da aba Display" : "Medida pela própria peça"}
      actions={<MaBadge>{dsp ? "Base DSP" : "Base peça"}</MaBadge>}
      footer={
        !dsp && hypr ? (
          <span>Sem criativo da DSP ligado: o cliente vê a medição da própria peça. Ligue a peça ao criativo da DSP em “Gerenciar peças” para usar a base da aba Display.</span>
        ) : null
      }
    >
      <MaStatGroup cols={5}>
        <MaStat size="s" label="Impressões" value={fmt(media.impressions)} />
        <MaStat size="s" label="Imp. visíveis" value={fmt(media.viewable)} />
        <MaStat size="s" label="Viewability" value={pct(media.viewability, 1)} />
        <MaStat size="s" label={dsp ? "Cliques" : "Cliques no CTA"} value={fmt(dsp ? media.clicks : media.ctaClicks)} />
        <MaStat size="s" label="CTR" value={pct(dsp ? media.ctr : media.ctaCtr)} />
      </MaStatGroup>
      {hypr && dsp && (
        <div className="mt-4 pt-4 border-t border-border/70">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-fg-muted">Medido pela própria peça</span>
            <HyprOnlyBadge />
          </div>
          <MaStatGroup cols={4}>
            <MaStat size="s" label="Carregamentos" value={fmt(media.measured)} />
            <MaStat size="s" label="Visíveis" value={fmt(media.pieceViewable)} />
            <MaStat size="s" label="Viewability" value={pct(media.pieceViewability, 1)} />
            <MaStat size="s" label="Cliques no CTA" value={fmt(media.ctaClicks)} note={`CTR ${pct(media.ctaCtr)}`} />
          </MaStatGroup>
          <p className="mt-3 text-xs leading-snug text-fg-subtle">
            A peça conta todo carregamento e todo toque no CTA, com a mesma regra em qualquer DSP; a DSP filtra tráfego inválido e mede do seu jeito. O cliente não vê este bloco.
          </p>
        </div>
      )}
    </MaCard>
  );
}

// ─── Comportamento ─────────────────────────────────────────────────────

function SmallSample({ what = "no período" }) {
  return (
    <>
      <MaBadge tone="warn">Amostra pequena</MaBadge>
      <span>Menos de {SMALL_SAMPLE} cliques {what}; os percentuais ainda não indicam preferência.</span>
    </>
  );
}

const HAS_EXTRAS = {
  carrossel: (p) => !!p.carousel,
  scratch: (p) => !!p.scratch,
  freeform: (p) => !!videoFunnel(p),
  survey: (p) => !!p.survey,
  play: (p) => !!p.game,
};

function Behavior({ piece, media, breakdowns, hypr, fileBase }) {
  const cards = [];
  if (piece.format === "tap-to-map") {
    const byKey = Object.fromEntries(breakdowns.map((b) => [b.key, b]));
    const inter = byKey.interactions;
    if (inter?.parts.length) {
      cards.push({
        key: "interactions",
        title: "Como as pessoas interagiram",
        subtitle: "Pessoas por ação · uma pessoa pode fazer mais de uma",
        footer: n(media.engaged) > 0 ? <span>% sobre as {fmt(media.engaged)} pessoas que interagiram</span> : null,
        body: <MaStackBarV2 parts={inter.parts} list unit="pessoas" shareBase={n(media.engaged)} />,
      });
    }
    const surface = byKey.cta_surface?.parts || [];
    const buttons = byKey.cta_button?.parts || [];
    if (surface.length || buttons.length) {
      const clicks = sumParts(surface);
      const btn = sumParts(buttons);
      const smallBtn = btn > 0 && btn < SMALL_SAMPLE;
      const small = smallBtn || (clicks > 0 && clicks < SMALL_SAMPLE);
      cards.push({
        key: "clicks",
        title: "Onde clicaram",
        subtitle: "Participação no total de cliques do período",
        footer: small ? <SmallSample what={smallBtn ? "nos botões de loja" : "no período"} /> : null,
        body: (
          <>
            {surface.length > 0 ? (
              <MaStackBarV2 parts={surface} unit="cliques" percentOnly={!hypr} />
            ) : (
              <p className="text-[13px] text-fg-subtle">Sem cliques registrados no período.</p>
            )}
            {buttons.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border/70">
                <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-fg-subtle">Botões de loja</div>
                <MaStackBarV2 parts={buttons} unit="cliques" percentOnly={!hypr} />
              </div>
            )}
          </>
        ),
      });
    }
  } else {
    for (const b of breakdowns) {
      if (!b.parts.length) continue;
      const total = sumParts(b.parts);
      cards.push({
        key: b.key,
        title: b.title,
        subtitle: b.subtitle || (b.unit ? `Participação no total de ${b.unit}` : null),
        footer: b.unit === "cliques" && total > 0 && total < SMALL_SAMPLE ? <SmallSample /> : null,
        body: <MaStackBarV2 parts={b.parts} unit={b.unit} list={b.list} percentOnly={!hypr && b.unit === "cliques"} />,
      });
    }
  }
  const hasExtras = !!HAS_EXTRAS[piece.format]?.(piece);
  if (!cards.length && !hasExtras) return null;
  return (
    <MaSection title="Comportamento" subtitle="O que as pessoas fizeram na peça">
      {cards.length > 0 && (
        <div className={cn("grid gap-4 items-stretch", cards.length > 1 && "md:grid-cols-2")}>
          {cards.map((c, i) => (
            <MaCard
              key={c.key}
              title={c.title}
              subtitle={c.subtitle}
              footer={c.footer}
              className={cards.length > 1 && cards.length % 2 === 1 && i === cards.length - 1 ? "md:col-span-2" : undefined}
            >
              {c.body}
            </MaCard>
          ))}
        </div>
      )}
      {hasExtras && <FormatExtras piece={piece} fileBase={fileBase} />}
    </MaSection>
  );
}

function FormatExtras({ piece, fileBase }) {
  switch (piece.format) {
    case "carrossel":
      return <Slides piece={piece} />;
    case "scratch":
      return <Reveal piece={piece} />;
    case "freeform":
      return <Video piece={piece} />;
    case "survey":
      return <Survey piece={piece} fileBase={fileBase} />;
    case "play":
      return <Game piece={piece} />;
    default:
      return null;
  }
}

function Slides({ piece }) {
  const c = piece.carousel;
  const slides = [...(c?.top_slides || [])].sort((a, b) => a.index - b.index);
  const navSessions = c?.navSessions || piece.steps?.nav || 0;
  if (!c) return null;
  const perSession = navSessions > 0 ? c.slideChanges / navSessions : null;
  return (
    <MaCard
      title="Desempenho por slide"
      subtitle={`${fmt(c.slideChanges)} trocas de slide${perSession ? ` · ${fmt(perSession, 1)} por pessoa que navegou` : ""}`}
      footer={<span>O slide inicial aparece para todo mundo; ele só conta como chegada quando a pessoa volta para ele.</span>}
    >
      {slides.length ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
          {slides.map((s, i) => (
            <div key={s.index} className="rounded-lg border border-border p-3 min-w-0">
              <MaStat
                size="s"
                label={`Slide ${s.index + 1}`}
                value={fmt(s.views)}
                note={s.index === 0 ? "voltas ao slide inicial" : "chegadas"}
              />
              <div className="mt-1 text-xs font-semibold text-fg truncate" title={s.label}>{s.label || "Sem nome"}</div>
              {s.index > 0 && navSessions > 0 && (
                <>
                  <div className="mt-2 h-1 rounded-full bg-track overflow-hidden" aria-hidden>
                    <div className="bar-grow-x h-full bg-signature rounded-full" style={{ width: `${Math.min(100, (s.views / navSessions) * 100)}%`, "--i": i }} />
                  </div>
                  <div className="mt-1 text-[11px] text-fg-subtle tabular-nums">{pct((s.views / navSessions) * 100, 1)} de quem navegou</div>
                </>
              )}
              <div className="mt-2 text-xs text-fg-muted">Cliques <b className="text-fg tabular-nums">{fmt(s.clicks)}</b></div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-fg-subtle">Sem navegação registrada no período.</p>
      )}
    </MaCard>
  );
}

function Reveal({ piece }) {
  const sc = piece.scratch;
  if (!sc) return null;
  const s = piece.steps || {};
  const started = piece.mechanic === "tilt" && s.tilt_activated > 0 ? s.tilt_activated : (s.scratch_started || sc.scratchedSessions);
  const done = s.scratch_completed || sc.revealedSessions;
  return (
    <MaCard
      title="Revelação"
      footer={<span>Clicar na capa antes de revelar é um atalho opcional: aparece em “Cliques por superfície”, fora do funil.</span>}
    >
      <MaStatGroup cols={3}>
        <MaStat label="Revelaram, de quem começou" value={pct(started > 0 ? (done / started) * 100 : null, 1)} />
        <MaStat label="Tempo médio até revelar" value={secondsText(sc.avgTimeToCompleteMs)} />
        <MaStat label="Mecânica da peça" value={MECHANIC_LABELS[piece.mechanic] || piece.mechanic || "—"} />
      </MaStatGroup>
    </MaCard>
  );
}

function Video({ piece }) {
  const v = videoFunnel(piece);
  if (!v) return null;
  return (
    <MaCard title="Vídeo da peça" subtitle="Marcos de reprodução, por impressão">
      {v.unmute > 0 && (
        <p className="mb-3 text-xs text-fg-subtle">Tiraram do mudo: <b className="text-fg tabular-nums">{fmt(v.unmute)}</b></p>
      )}
      <MaFunnelV2 steps={v.steps} unitLabel="reproduções" />
    </MaCard>
  );
}

function Survey({ piece, fileBase }) {
  const sv = piece.survey;
  if (!sv) return null;
  const opts = sv.top_options || [];
  const total = opts.reduce((s, o) => s + (o.answers || 0), 0);
  const csv = () =>
    downloadCsv(
      `${fileBase} - respostas.csv`,
      ["Resposta", "Respostas", "Participação (%)", "Cliques"],
      opts.map((o) => [o.label, o.answers, total ? ((o.answers / total) * 100).toFixed(1) : "", o.clicks]),
    );
  const rows = [...opts]
    .sort((a, b) => (b.answers || 0) - (a.answers || 0))
    .map((o) => ({
      key: o.label,
      label: o.label || "Sem rótulo",
      valueText: pct(total ? (o.answers / total) * 100 : null, 1),
      shareText: `${fmt(o.clicks)} cliq.`,
      shareHint: "Cliques a partir desta resposta",
      width: total ? (o.answers / total) * 100 : 0,
    }));
  return (
    <MaCard
      title="Respostas"
      subtitle={`Tempo médio até responder: ${secondsText(sv.avgTimeToAnswerMs)}`}
      actions={opts.length ? <CsvButton onClick={csv} /> : null}
      footer={opts.length ? <span>{fmt(total)} respostas no período · à direita, cliques a partir de cada resposta</span> : null}
    >
      {opts.length ? <MaBarRows rows={rows} label="Respostas" /> : <p className="text-[13px] text-fg-subtle">Sem respostas no período.</p>}
    </MaCard>
  );
}

function Game({ piece }) {
  const g = piece.game;
  if (!g) return null;
  return (
    <MaCard title="Partidas">
      <MaStatGroup cols={6}>
        <MaStat size="s" label="Jogaram" value={fmt(g.playedSessions)} />
        <MaStat size="s" label="Terminaram" value={fmt(g.completedSessions)} />
        <MaStat size="s" label="Pontuação média" value={g.avgScore == null ? "—" : fmt(g.avgScore, 1)} />
        <MaStat size="s" label="Tempo de jogo" value={secondsText(g.avgPlayTimeMs)} />
        <MaStat size="s" label="Jogaram de novo" value={fmt(g.replays)} />
        <MaStat
          size="s"
          label="Venceram o desafio"
          value={g.challengePlayed > 0 ? pct((g.challengeWonSessions / g.challengePlayed) * 100, 1) : "—"}
        />
      </MaStatGroup>
    </MaCard>
  );
}

// ─── Endereços (Tap to Map) ────────────────────────────────────────────

function MapAddresses({ piece, fileBase }) {
  const pins = piece.top_pins;
  const items = useMemo(
    () =>
      (pins || []).map((p, i) => {
        const cta = n(p.cta_clicks);
        const accept = p.views > 0 ? ((n(p.pin_clicks) + cta) / p.views) * 100 : null;
        const actions = [
          [n(p.pin_clicks), "pin"],
          [n(p.by_button?.directions), "rota"],
          [n(p.by_button?.whatsapp), "WhatsApp"],
          [n(p.by_button?.website), "site"],
        ]
          .filter(([v]) => v > 0)
          .map(([v, l]) => `${fmt(v)} ${l}`)
          .join(" · ");
        return {
          key: `pin-${i}`,
          name: p.name || "Endereço sem nome",
          lat: p.lat,
          lng: p.lng,
          primary: n(p.views),
          rateText: accept == null ? "—" : `${pct(accept, 1)} aceite`,
          actions: actions || null,
          accept,
          raw: p,
          popupRows: [["Exibições", fmt(p.views)], ["Ações", fmt(n(p.pin_clicks) + cta)], ["Aceite", pct(accept, 1)]],
        };
      }),
    [pins],
  );
  if (!items.length) return null;
  const csv = () =>
    downloadCsv(
      `${fileBase} - enderecos.csv`,
      ["Endereço", "Exibições", "Cliques no pin", "Cliques em CTA", "Como chegar", "WhatsApp", "Site", "Aceite (%)"],
      items.map(({ raw: p, accept }) => [p.name, p.views, p.pin_clicks, p.cta_clicks, p.by_button?.directions || 0, p.by_button?.whatsapp || 0, p.by_button?.website || 0, accept == null ? "" : accept.toFixed(1)]),
    );
  return (
    <MaAddressExplorerV2
      title="Endereços"
      subtitle={`${fmt(items.length)} ${items.length === 1 ? "endereço" : "endereços"} · onde a peça mostrou a loja mais próxima`}
      items={items}
      primaryLabel="Exibições"
      onCsv={csv}
      footnote="Aceite = (cliques no pin + CTA) ÷ exibições."
    />
  );
}

// ─── Widgets ───────────────────────────────────────────────────────────

function WidgetBlock({ w, className }) {
  if (w.kind === "display") {
    return (
      <MaCard title={w.label} subtitle="Só exibição" className={className}>
        <MaStatGroup cols={2}>
          <MaStat label="Exibições do widget" value={fmt(w.views)} />
          <MaStat label="Das impressões medidas" value={pct(w.ofMeasured, 1)} />
        </MaStatGroup>
      </MaCard>
    );
  }
  if (w.kind === "calendar") {
    return (
      <MaCard title={w.label} subtitle="Adicionar o evento à agenda" className={className}>
        <MaStatGroup cols={4}>
          <MaStat size="s" label="Exibições" value={fmt(w.views)} />
          <MaStat size="s" label="Tocaram em adicionar" value={fmt(w.taps)} />
          <MaStat size="s" label="Baixaram o evento" value={fmt(w.opens)} />
          <MaStat size="s" label="Taxa de toque" value={pct(w.tapRate)} />
        </MaStatGroup>
      </MaCard>
    );
  }
  return (
    <MaCard title={w.label} subtitle="Toques e ações finais no widget" className={className}>
      <MaStatGroup cols={4}>
        <MaStat size="s" label="Exibições" value={fmt(w.views)} />
        <MaStat size="s" label="Toques" value={fmt(w.taps)} note={`${fmt(w.tapSessions)} pessoas`} />
        <MaStat size="s" label="Ações finais" value={fmt(w.conversions)} />
        <MaStat size="s" label="Taxa de toque" value={pct(w.tapRate)} />
      </MaStatGroup>
    </MaCard>
  );
}

function CloseToBlock({ w, fileBase }) {
  const found = w.precise + w.approx;
  const addresses = w.addresses;
  const items = useMemo(
    () =>
      (addresses || []).map((a, i) => ({
        key: `ct-${i}`,
        name: a.name || a.address || "Endereço sem nome",
        address: a.name ? a.address : null,
        lat: a.lat,
        lng: a.lng,
        primary: n(a.identified),
        rateText: a.conversion == null ? "—" : `${pct(a.conversion, 1)} conv.`,
        actions: [[n(a.directions), "rota"], [n(a.website), "site"]].filter(([v]) => v > 0).map(([v, l]) => `${fmt(v)} ${l}`).join(" · ") || null,
        raw: a,
        popupRows: [["Identificado", fmt(a.identified)], ["Cliques", fmt(a.clicks)]],
      })),
    [addresses],
  );
  const top = [...items].sort((a, b) => b.primary - a.primary)[0];
  const csv = () =>
    downloadCsv(
      `${fileBase} - loja mais proxima.csv`,
      ["Endereço", "Logradouro", "Identificado", "Cliques", "Rota", "Site", "Conversão (%)"],
      items.map(({ raw: a }) => [a.name || a.address, a.address, a.identified, a.clicks, a.directions, a.website, a.conversion == null ? "" : a.conversion.toFixed(1)]),
    );
  return (
    <div className="space-y-10">
      <MaSection title={w.label} subtitle="Widget que localiza a pessoa e mostra a loja mais próxima · toque conta como engajamento, não como clique da peça">
        <MaCard
          title="Uso do widget"
          subtitle="Do toque à rota ou site"
          footer={<span>Identificado = vezes que o endereço foi o mais próximo da pessoa. Conversão = cliques no endereço ÷ identificações.</span>}
        >
          <MaStatGroup cols={4}>
            <MaStat label="Toques" value={fmt(w.taps)} note={`${fmt(w.tapSessions)} pessoas · taxa ${pct(w.tapRate)}`} />
            <MaStat label="Endereços identificados" value={fmt(found)} note={w.taps ? `${pct((found / w.taps) * 100, 1)} dos toques` : null} />
            <MaStat label="Abriram rota ou site" value={fmt(w.conversions)} note={`Rota ${fmt(w.redirectMap)} · site ${fmt(w.redirectUrl)}`} />
            <MaStat label="Mais identificado" value={top ? top.name : "—"} note={top ? `${fmt(top.primary)} identificações` : null} />
          </MaStatGroup>
          <div className="mt-5 pt-5 border-t border-border/70 grid gap-6 md:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-fg-subtle">Funil do widget</div>
              <MaFunnelV2 steps={w.funnel} />
            </div>
            {found > 0 && (
              <div className="min-w-0">
                <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-fg-subtle">Como a localização foi obtida</div>
                <MaStackBarV2
                  parts={[
                    { label: "GPS (preciso)", value: w.precise },
                    { label: "IP (aproximado)", value: w.approx },
                  ]}
                  unit="identificações"
                />
                {w.approxWarning && (
                  <p className="mt-3 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs leading-snug text-fg-muted">
                    {pct(w.approxShare, 0)} das identificações vieram do IP. Nesses casos o endereço mostrado é o mais próximo do centro da região da pessoa, não da rua dela.
                  </p>
                )}
              </div>
            )}
          </div>
        </MaCard>
      </MaSection>
      {items.length > 0 && (
        <MaAddressExplorerV2
          title="Lojas identificadas"
          subtitle={`${fmt(items.length)} ${items.length === 1 ? "endereço" : "endereços"} · ${w.label}`}
          items={items}
          primaryLabel="Identificado"
          onCsv={csv}
          footnote="Conversão = cliques ÷ identificações."
        />
      )}
    </div>
  );
}

// ─── Série diária da peça ──────────────────────────────────────────────

// `hyprOnly`: série da medição da peça que competiria com a entrega da DSP
// (impressões, cliques no CTA) — fora do report do cliente.
const PIECE_METRICS = {
  engaged_sessions: { label: "Pessoas que interagiram" },
  pin_clicks: { label: "Cliques em pin" },
  cta_clicks: { label: "Cliques em CTA", hyprOnly: true },
  impressions: { label: "Impressões medidas", hyprOnly: true },
};

function PieceTrend({ piece, color, hypr: hyprView = false }) {
  const hypr = useThemeColors();
  const available = Object.keys(PIECE_METRICS).filter(
    (k) => (k !== "pin_clicks" || piece.format === "tap-to-map") && (hyprView || !PIECE_METRICS[k].hyprOnly),
  );
  const [metric, setMetric] = useState("engaged_sessions");
  const m = available.includes(metric) ? metric : available[0];
  return (
    <MaSection
      title="Por dia"
      subtitle="Evolução no período · horário de Brasília"
      tools={
        available.length > 1 ? (
          <ChipGroupV2
            label="Métrica da série diária"
            options={available.map((k) => ({ value: k, label: PIECE_METRICS[k].label }))}
            value={m}
            onChange={setMetric}
          />
        ) : null
      }
    >
      <MaCard title={`${PIECE_METRICS[m].label} por dia`} subtitle="Medido pela peça, dia a dia">
        <TrendChartV2
          data={piece.daily}
          dataKey={m}
          label={PIECE_METRICS[m].label}
          kind="bar"
          color={resolveChartVar(color, hypr)}
          height={200}
        />
      </MaCard>
    </MaSection>
  );
}

// ─── Ícones ────────────────────────────────────────────────────────────

function CopyIcon() {
  return (
    <svg className="size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function BulbIcon() {
  return (
    <svg className="mt-0.5 size-4 shrink-0 text-signature" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
    </svg>
  );
}
