// src/v2/components/ma/MaPieceDetailV2.jsx
//
// Detalhe de uma peça Max Attention. Três camadas, cada uma com selo:
//   Mídia  → entrega (impressões da DSP quando vinculada, medidas, viewability,
//            cliques em CTA e CTR da peça)
//   Peça   → funil em pessoas, superfícies/controles e os blocos próprios do
//            formato (endereços + mapa, slides, revelação, vídeo, respostas,
//            partidas)
//   Widget → um bloco por widget plugado (Loja mais próxima, calendário,
//            produtos, widgets só de exibição)
// Fecha com o engajamento da peça por dia.

import { useState } from "react";
import { useSlidingThumb } from "../../../ui/useSlidingThumb";
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
import { cn } from "../../../ui/cn";
import { ChipGroupV2 } from "../ChipGroupV2";
import { TrendChartV2 } from "../TrendChartV2";
import { MaAddressMapV2 } from "./MaAddressMapV2";
import { MaFunnelV2 } from "./MaFunnelV2";
import { MaPreviewV2 } from "./MaPreviewV2";
import { MaStackBarV2 } from "./MaStackBarV2";
import { MaThumbV2 } from "./MaThumbV2";
import { CsvButton, HyprOnlyBadge, LayerBadge, MaCard } from "./maUi";
import { downloadCsv, keyMetricText, pct, resolveChartVar, secondsText } from "./maFormat";
import { useThemeColors } from "../../hooks/useThemeColors";

export function MaPieceDetailV2({
  piece,
  pieces,
  media,
  avgEngagement = null,
  formatColors,
  onSelect,
  onBack,
  campaignStart = null,
  isDemo = false,
  campaignName = "campanha",
  heroId = null,
  hypr = false,
}) {
  const idx = pieces.findIndex((p) => p.creative_id === piece.creative_id);
  const prev = pieces[(idx - 1 + pieces.length) % pieces.length];
  const next = pieces[(idx + 1) % pieces.length];
  // Sentido da última troca de peça: o conteúdo desliza de onde o clique
  // "veio". null na montagem (entrada da grade é a View Transition).
  const [dir, setDir] = useState(null);
  const select = (id, d) => {
    if (id === piece.creative_id) return;
    const to = pieces.findIndex((p) => p.creative_id === id);
    setDir(d || (to < idx ? "prev" : "next"));
    onSelect(id);
  };
  // Destaque do trilho desliza entre as peças (lista vertical: twoAxis).
  const {
    containerRef: railRef,
    setItemRef: setRailItemRef,
    thumbStyle: railThumbStyle,
  } = useSlidingThumb(idx, pieces.length, { twoAxis: true });
  const color = formatColors[piece.format];
  const km = keyMetric(piece);
  const waiting = isWaiting(piece);
  const funnel = buildFunnel(piece);
  const breakdowns = formatBreakdowns(piece);
  const widgets = widgetBlocks(piece);
  const delta = avgEngagement != null && media.engagement != null && pieces.length > 1
    ? media.engagement - avgEngagement
    : null;
  const fileBase = `${campaignName} - ${piece.name}`.replace(/[\\/:*?"<>|]+/g, " ");

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      {/* Trilho de peças (desktop) */}
      <nav aria-label="Peças da campanha" className="hidden lg:block">
        <div ref={railRef} className="sticky top-[168px] space-y-1">
          <span
            aria-hidden
            className="absolute top-0 left-0 rounded-md bg-signature-soft pointer-events-none motion-reduce:!transition-none"
            style={railThumbStyle}
          />
          <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-fg-subtle">Peças da campanha</div>
          <button
            type="button"
            onClick={onBack}
            className="w-full text-left px-2 py-1.5 rounded-md text-xs font-semibold text-signature hover:bg-surface cursor-pointer"
          >
            ← Todas as peças
          </button>
          {pieces.map((p, i) => (
            <button
              key={p.creative_id}
              ref={setRailItemRef(i)}
              type="button"
              onClick={() => select(p.creative_id)}
              aria-current={p.creative_id === piece.creative_id ? "true" : undefined}
              className={cn(
                "relative w-full grid grid-cols-[40px_minmax(0,1fr)] items-center gap-2 px-2 py-1.5 rounded-md text-left cursor-pointer transition-colors",
                p.creative_id !== piece.creative_id && "hover:bg-surface",
              )}
            >
              <MaThumbV2 format={p.format} color={formatColors[p.format]} className="h-8 [&_svg]:size-4" />
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold text-fg truncate">{p.name}</span>
                <span className="block text-[10.5px] text-fg-subtle truncate">
                  {formatLabel(p.format)}{p.size ? ` · ${p.size}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      </nav>

      <div className="space-y-5 min-w-0">
        {/* Migalhas + navegação */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button type="button" onClick={onBack} className="font-semibold text-signature hover:underline underline-offset-4 cursor-pointer">
            Max Attention
          </button>
          <span className="text-fg-subtle" aria-hidden>›</span>
          <span className="text-fg-muted">{formatLabel(piece.format)}</span>
          <span className="text-fg-subtle" aria-hidden>›</span>
          <span className="font-semibold text-fg truncate max-w-[40ch]">{piece.name}{piece.size ? ` · ${piece.size}` : ""}</span>
          {pieces.length > 1 && (
            <span className="ml-auto flex items-center gap-1.5">
              <label className="lg:hidden sr-only" htmlFor="ma-piece-select">Peça</label>
              <select
                id="ma-piece-select"
                value={piece.creative_id}
                onChange={(e) => select(e.target.value)}
                className="lg:hidden h-8 max-w-[52vw] rounded-md border border-border bg-canvas-deeper px-2 text-xs text-fg"
              >
                {pieces.map((p) => (
                  <option key={p.creative_id} value={p.creative_id}>{p.name}</option>
                ))}
              </select>
              <button type="button" onClick={() => select(prev.creative_id, "prev")} className="h-8 px-2.5 rounded-md border border-border text-fg-muted hover:text-fg cursor-pointer" aria-label="Peça anterior">
                ←<span className="hidden sm:inline"> anterior</span>
              </button>
              <button type="button" onClick={() => select(next.creative_id, "next")} className="h-8 px-2.5 rounded-md border border-border text-fg-muted hover:text-fg cursor-pointer" aria-label="Próxima peça">
                <span className="hidden sm:inline">próxima </span>→
              </button>
            </span>
          )}
        </div>

        {/* Tudo abaixo das migalhas troca junto com a peça: remonta pela key e
            desliza no sentido do clique. As migalhas e os botões ficam fora
            pra não perderem o foco de quem navega com "próxima" repetido. */}
        <div
          key={piece.creative_id}
          className={cn("space-y-5", dir === "prev" && "slide-in-prev", dir === "next" && "slide-in-next")}
        >
        {/* Preview + camada Mídia */}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <MaPreviewV2 piece={piece} color={color} campaignStart={campaignStart} isDemo={isDemo} hero={heroId === piece.creative_id} />
          <div className="space-y-4 min-w-0">
            <div>
              <h2 className="text-lg font-bold text-fg leading-tight">{piece.name}{piece.size ? ` · ${piece.size}` : ""}</h2>
              <p className="text-[12px] text-fg-subtle mt-0.5">
                {formatLabel(piece.format)}
                {piece.mechanic ? ` · mecânica ${MECHANIC_LABELS[piece.mechanic] || piece.mechanic}` : ""}
                {piece.survey_mode === "poll" ? " · modo pesquisa" : ""}
                {piece.game_type ? ` · jogo ${piece.game_type}` : ""}
                {MA_FORMATS[piece.format]?.desc ? ` · ${MA_FORMATS[piece.format].desc}` : ""}
              </p>
            </div>

            {waiting && (
              <div className="rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[12px] text-fg-muted">
                Aguardando a primeira impressão no período. A peça está vinculada à campanha; os números aparecem assim que ela entregar.
              </div>
            )}

            <MaCard layer="midia" title="Entrega" subtitle={media.deliverySource === "dsp" ? "Pela DSP, mesma base da aba Display" : "Medida pela peça"}>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-3 divide-border/60 sm:divide-x">
                <Stat label="Impressões" value={fmt(media.impressions)} />
                <Stat label="Imp. visíveis" value={fmt(media.viewable)} className="sm:pl-4" />
                <Stat label="Viewability" value={pct(media.viewability, 1)} className="sm:pl-4" />
                {media.deliverySource === "dsp" ? (
                  <Stat label={`Cliques · CTR ${pct(media.ctr)}`} value={fmt(media.clicks)} className="sm:pl-4" />
                ) : (
                  <Stat label={`Cliques · CTR ${pct(media.ctaCtr)}`} value={fmt(media.ctaClicks)} className="sm:pl-4" />
                )}
              </div>
              {hypr && media.deliverySource === "dsp" && (
                <div className="mt-4 pt-3 border-t border-border/60">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-muted">Medido pela própria peça</span>
                    <HyprOnlyBadge />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-3 divide-border/60 sm:divide-x">
                    <Stat label="Carregamentos medidos" value={fmt(media.measured)} />
                    <Stat label="Visíveis" value={fmt(media.pieceViewable)} className="sm:pl-4" />
                    <Stat label="Viewability da peça" value={pct(media.pieceViewability, 1)} className="sm:pl-4" />
                    <Stat label={`Cliques no CTA · CTR ${pct(media.ctaCtr)}`} value={fmt(media.ctaClicks)} className="sm:pl-4" />
                  </div>
                  <p className="mt-2 text-[11px] leading-snug text-fg-subtle">
                    A peça conta todo carregamento e todo toque no CTA, com a mesma regra em qualquer DSP; a DSP filtra tráfego inválido e mede do seu jeito. O cliente não vê este bloco.
                  </p>
                </div>
              )}
              {media.deliverySource !== "dsp" && (
                <p className="mt-3 text-[11px] leading-snug text-fg-subtle">
                  {hypr
                    ? "Sem criativo da DSP ligado: o cliente vê a medição da própria peça. Ligue a peça ao criativo da DSP em \"Gerenciar peças\" para usar a base da aba Display."
                    : "Medido pela própria peça."}
                </p>
              )}
            </MaCard>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <SmallKpi
                label="Taxa de engajamento"
                value={pct(media.engagement)}
                accent
                note={hypr
                  ? `${fmt(media.engaged)} de ${fmt(media.sessions)} ${media.exactPeople ? "pessoas" : "sessões (estimado)"}`
                  : `${fmt(media.engaged)} pessoas interagiram`}
              />
              <SmallKpi label={km.label} value={keyMetricText(km)} note="Métrica-chave do formato" />
              {delta != null ? (
                <SmallKpi
                  label="Vs. média das peças"
                  value={`${delta >= 0 ? "▲" : "▼"} ${fmt(Math.abs(delta), 2)} p.p.`}
                  note="Engajamento da peça menos o da campanha"
                  tone={delta >= 0 ? "good" : "bad"}
                />
              ) : (
                <SmallKpi label="Sessões engajadas" value={fmt(media.engaged)} note="Pessoas que interagiram" />
              )}
            </div>
          </div>
        </div>

        {/* Camada Peça */}
        {!waiting && (
          <MaCard layer="peca" title="Funil de engajamento" subtitle={`Etapas nativas do ${formatLabel(piece.format)}`}>
            {funnel.source === "unavailable" ? (
              <p className="text-[12px] text-fg-subtle">
                O funil em pessoas está indisponível no momento para esta peça. As demais métricas seguem valendo; tente de novo em alguns minutos.
              </p>
            ) : (
              <MaFunnelV2 steps={funnel.steps} subs={funnel.subs} baseAsPercent={!hypr} />
            )}
          </MaCard>
        )}

        {!waiting && breakdowns.length > 0 && (
          <div className={cn("grid gap-4", breakdowns.length > 1 && "md:grid-cols-2")}>
            {breakdowns.map((b, i) => (
              <MaCard
                key={b.key}
                title={b.title}
                subtitle={b.subtitle}
                className={breakdowns.length > 1 && breakdowns.length % 2 === 1 && i === breakdowns.length - 1 ? "md:col-span-2" : undefined}
              >
                <MaStackBarV2 parts={b.parts} unit={b.unit} list={b.list} percentOnly={!hypr && b.unit === "cliques"} />
              </MaCard>
            ))}
          </div>
        )}

        {!waiting && <FormatExtras piece={piece} fileBase={fileBase} />}

        {/* Camada Widget */}
        {!waiting && widgets.map((w) => <WidgetBlock key={w.id || w.type} w={w} fileBase={fileBase} />)}

        {!waiting && piece.daily?.length > 0 && <PieceTrend piece={piece} color={color} hypr={hypr} />}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, className }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[18px] font-semibold text-fg tabular-nums leading-tight truncate">{value}</div>
      <div className="text-[11px] text-fg-subtle mt-1 leading-snug">{label}</div>
    </div>
  );
}

function SmallKpi({ label, value, note, accent = false, tone = null }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2 p-3.5 min-w-0">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-muted truncate" title={label}>{label}</div>
      <div
        className={cn(
          "mt-1.5 text-xl font-bold tabular-nums leading-tight truncate",
          tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : accent ? "text-signature" : "text-fg",
        )}
      >
        {value}
      </div>
      {note && <div className="mt-1 text-[11px] text-fg-subtle leading-snug">{note}</div>}
    </div>
  );
}

// ─── Blocos próprios de cada formato ───────────────────────────────────

function FormatExtras({ piece, fileBase }) {
  switch (piece.format) {
    case "tap-to-map":
      return <MapAddresses piece={piece} fileBase={fileBase} />;
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

function useExpandable(rows, initial = 10) {
  const [open, setOpen] = useState(false);
  const canExpand = rows.length > initial;
  return { visible: open || !canExpand ? rows : rows.slice(0, initial), canExpand, open, toggle: () => setOpen((v) => !v) };
}

function MapAddresses({ piece, fileBase }) {
  const pins = (piece.top_pins || []).map((p, i) => ({ ...p, name: p.name || "Endereço sem nome", key: `pin-${i}` }));
  const [focus, setFocus] = useState(null);
  const { visible, canExpand, open, toggle } = useExpandable(pins);
  if (!pins.length) return null;
  const accept = (p) => (p.views > 0 ? ((p.pin_clicks + p.cta_clicks) / p.views) * 100 : null);
  const points = pins.map((p) => ({
    key: p.key,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    weight: p.pin_clicks + p.cta_clicks,
    rows: [["Exibições", fmt(p.views)], ["Pin", fmt(p.pin_clicks)], ["CTA", fmt(p.cta_clicks)]],
  }));
  const csv = () =>
    downloadCsv(
      `${fileBase} - enderecos.csv`,
      ["Endereço", "Exibições", "Cliques no pin", "Cliques em CTA", "Como chegar", "WhatsApp", "Site", "Aceite (%)"],
      pins.map((p) => [p.name, p.views, p.pin_clicks, p.cta_clicks, p.by_button?.directions || 0, p.by_button?.whatsapp || 0, p.by_button?.website || 0, accept(p) == null ? "" : accept(p).toFixed(1)]),
    );
  return (
    <MaCard title="Top endereços" subtitle="Onde as pessoas interagiram" actions={<CsvButton onClick={csv} />}>
      <div className="grid gap-4 xl:grid-cols-2">
        <MaAddressMapV2 points={points} focusKey={focus} onFocus={setFocus} />
        <div className="overflow-x-auto min-w-0">
          <table className="w-full text-xs min-w-[520px]">
            <thead>
              <tr className="border-b border-border text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                <th className="py-2 pr-2 text-left">Endereço</th>
                <th className="py-2 px-2 text-right">Exibições</th>
                <th className="py-2 px-2 text-right">Pin</th>
                <th className="py-2 px-2 text-right">Rota</th>
                <th className="py-2 px-2 text-right">WhatsApp</th>
                <th className="py-2 px-2 text-right">Site</th>
                <th className="py-2 pl-2 text-right">Aceite</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p, i) => (
                <tr
                  key={p.key}
                  onClick={() => setFocus(p.key)}
                  className={cn("border-b border-border/50 last:border-b-0 cursor-pointer hover:bg-surface", focus === p.key && "bg-signature-soft")}
                >
                  <td className="py-2 pr-2 text-fg font-semibold">{i + 1}. {p.name}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{fmt(p.views)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{fmt(p.pin_clicks)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{fmt(p.by_button?.directions || 0)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{fmt(p.by_button?.whatsapp || 0)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{fmt(p.by_button?.website || 0)}</td>
                  <td className="py-2 pl-2 text-right tabular-nums">{pct(accept(p), 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {canExpand && (
            <button type="button" onClick={toggle} className="mt-2 text-xs font-semibold text-signature hover:underline underline-offset-4 cursor-pointer">
              {open ? "Mostrar só os 10 primeiros" : `Mostrar os ${pins.length} endereços`}
            </button>
          )}
        </div>
      </div>
      <p className="mt-3 text-[11px] leading-snug text-fg-subtle">
        Exibições = vezes que o endereço apareceu como loja mais próxima. Aceite = (cliques no pin + cliques em CTA) ÷ exibições. Clique numa linha para ver no mapa.
      </p>
    </MaCard>
  );
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
    >
      {slides.length ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
          {slides.map((s, i) => (
            <div key={s.index} className="rounded-lg border border-border p-3 min-w-0">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-subtle">Slide {s.index + 1}</div>
              <div className="text-[12px] font-semibold text-fg truncate mt-0.5" title={s.label}>{s.label || "Sem nome"}</div>
              <div className="mt-2 text-lg font-bold text-fg tabular-nums">{fmt(s.views)}</div>
              <div className="text-[10.5px] text-fg-subtle">{s.index === 0 ? "voltas ao slide inicial" : "chegadas"}</div>
              {s.index > 0 && navSessions > 0 && (
                <>
                  <div className="mt-2 h-1.5 rounded-full bg-track overflow-hidden">
                    <div className="bar-grow-x h-full bg-signature rounded-full" style={{ width: `${Math.min(100, (s.views / navSessions) * 100)}%`, "--i": i }} />
                  </div>
                  <div className="mt-1 text-[10.5px] text-fg-subtle tabular-nums">{pct((s.views / navSessions) * 100, 1)} de quem navegou</div>
                </>
              )}
              <div className="mt-2 text-[11px] text-fg-muted">Cliques <b className="text-fg tabular-nums">{fmt(s.clicks)}</b></div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-fg-subtle">Sem navegação registrada no período.</p>
      )}
      <p className="mt-3 text-[11px] leading-snug text-fg-subtle">
        O slide inicial aparece para todo mundo; ele só conta como chegada quando a pessoa volta para ele.
      </p>
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
    <MaCard title="Revelação">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Stat label="revelaram, de quem começou" value={pct(started > 0 ? (done / started) * 100 : null, 1)} />
        <Stat label="tempo médio até revelar" value={secondsText(sc.avgTimeToCompleteMs)} />
        <Stat label="mecânica da peça" value={MECHANIC_LABELS[piece.mechanic] || piece.mechanic || "—"} />
      </div>
      <p className="mt-3 text-[11px] leading-snug text-fg-subtle">
        Clicar na capa antes de revelar é um atalho opcional: aparece em "Cliques por superfície", fora do funil.
      </p>
    </MaCard>
  );
}

function Video({ piece }) {
  const v = videoFunnel(piece);
  if (!v) return null;
  return (
    <MaCard title="Vídeo da peça" subtitle="Marcos de reprodução, por impressão">
      <MaFunnelV2 steps={v.steps} unitLabel="reproduções" />
      {v.unmute > 0 && (
        <p className="mt-2 text-[11px] text-fg-subtle">Tiraram do mudo: <b className="text-fg tabular-nums">{fmt(v.unmute)}</b></p>
      )}
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
  return (
    <MaCard
      title="Respostas"
      subtitle={`Tempo médio até responder: ${secondsText(sv.avgTimeToAnswerMs)}`}
      actions={opts.length ? <CsvButton onClick={csv} /> : null}
    >
      {opts.length ? (
        <div className="grid gap-2">
          {opts.map((o, i) => (
            <div key={o.label} className="grid grid-cols-[minmax(0,1fr)_auto_4.5rem] sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_5rem_4.5rem] items-center gap-x-3 gap-y-1">
              <span className="text-[12px] text-fg truncate" title={o.label}>{o.label || "Sem rótulo"}</span>
              <div className="h-2.5 rounded-full bg-track overflow-hidden order-last col-span-3 sm:order-none sm:col-span-1">
                <div className="bar-grow-x h-full rounded-full bg-signature" style={{ width: `${total ? (o.answers / total) * 100 : 0}%`, "--i": i }} />
              </div>
              <span className="text-[12px] font-semibold text-fg tabular-nums text-right">{pct(total ? (o.answers / total) * 100 : null, 1)}</span>
              <span className="text-[11px] text-fg-subtle tabular-nums text-right" title="Cliques a partir desta resposta">{fmt(o.clicks)} cliq.</span>
            </div>
          ))}
          <p className="text-[11px] text-fg-subtle">{fmt(total)} respostas no período.</p>
        </div>
      ) : (
        <p className="text-[12px] text-fg-subtle">Sem respostas no período.</p>
      )}
    </MaCard>
  );
}

function Game({ piece }) {
  const g = piece.game;
  if (!g) return null;
  return (
    <MaCard title="Partidas">
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        <Stat label="jogaram" value={fmt(g.playedSessions)} />
        <Stat label="terminaram a partida" value={fmt(g.completedSessions)} />
        <Stat label="pontuação média" value={g.avgScore == null ? "—" : fmt(g.avgScore, 1)} />
        <Stat label="tempo médio de jogo" value={secondsText(g.avgPlayTimeMs)} />
        <Stat label="jogaram de novo" value={fmt(g.replays)} />
        <Stat
          label="venceram o desafio"
          value={g.challengePlayed > 0 ? pct((g.challengeWonSessions / g.challengePlayed) * 100, 1) : "—"}
        />
      </div>
    </MaCard>
  );
}

// ─── Camada Widget ─────────────────────────────────────────────────────

function WidgetBlock({ w, fileBase }) {
  if (w.kind === "display") {
    return (
      <MaCard layer="widget" title={w.label} subtitle="Só exibição">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Stat label="exibições do widget" value={fmt(w.views)} />
          <Stat label="das impressões medidas pela peça" value={pct(w.ofMeasured, 1)} />
        </div>
      </MaCard>
    );
  }
  if (w.kind === "calendar") {
    return (
      <MaCard layer="widget" title={w.label} subtitle="Toque no widget conta como engajamento, não como clique da peça">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="exibições" value={fmt(w.views)} />
          <Stat label="tocaram em adicionar" value={fmt(w.taps)} />
          <Stat label="baixaram o evento" value={fmt(w.opens)} />
          <Stat label="taxa de toque" value={pct(w.tapRate)} />
        </div>
      </MaCard>
    );
  }
  if (w.kind === "close_to") return <CloseToBlock w={w} fileBase={fileBase} />;
  return (
    <MaCard layer="widget" title={w.label} subtitle="Toque no widget conta como engajamento, não como clique da peça">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="exibições" value={fmt(w.views)} />
        <Stat label={`toques · ${fmt(w.tapSessions)} pessoas`} value={fmt(w.taps)} />
        <Stat label="ações finais" value={fmt(w.conversions)} />
        <Stat label="taxa de toque" value={pct(w.tapRate)} />
      </div>
    </MaCard>
  );
}

function CloseToBlock({ w, fileBase }) {
  const [focus, setFocus] = useState(null);
  const addrs = w.addresses.map((a, i) => ({ ...a, name: a.name || a.address || "Endereço sem nome", key: `ct-${i}` }));
  const { visible, canExpand, open, toggle } = useExpandable(addrs);
  const found = w.precise + w.approx;
  const top = addrs[0];
  const csv = () =>
    downloadCsv(
      `${fileBase} - loja mais proxima.csv`,
      ["Endereço", "Logradouro", "Identificado", "Cliques", "Rota", "Site", "Conversão (%)"],
      addrs.map((a) => [a.name, a.address, a.identified, a.clicks, a.directions, a.website, a.conversion == null ? "" : a.conversion.toFixed(1)]),
    );
  const points = addrs.map((a) => ({
    key: a.key,
    name: a.name,
    subtitle: a.address,
    lat: a.lat,
    lng: a.lng,
    weight: a.identified,
    rows: [["Identificado", fmt(a.identified)], ["Cliques", fmt(a.clicks)]],
  }));
  return (
    <MaCard layer="widget" title={w.label} subtitle="Botão que localiza a pessoa e mostra a loja mais próxima" actions={addrs.length ? <CsvButton onClick={csv} /> : null}>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
        <SmallKpi label="Toques" value={fmt(w.taps)} note={`${fmt(w.tapSessions)} pessoas · taxa de toque ${pct(w.tapRate)}`} />
        <SmallKpi label="Endereços identificados" value={fmt(found)} note={w.taps ? `${pct((found / w.taps) * 100, 1)} dos toques` : null} />
        <SmallKpi label="Abriram rota ou site" value={fmt(w.conversions)} note={`Rota ${fmt(w.redirectMap)} · site ${fmt(w.redirectUrl)}`} />
        <SmallKpi label="Mais identificado" value={top ? top.name : "—"} note={top ? `${fmt(top.identified)} identificações` : null} />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-widest text-fg-muted mb-2">Funil do widget</div>
          <MaFunnelV2 steps={w.funnel} />
          {found > 0 && (
            <div className="mt-4">
              <div className="text-[11px] font-bold uppercase tracking-widest text-fg-muted mb-2">Como a localização foi obtida</div>
              <MaStackBarV2
                parts={[
                  { label: "GPS (preciso)", value: w.precise },
                  { label: "IP (aproximado)", value: w.approx },
                ]}
                unit="identificações"
              />
            </div>
          )}
          {w.approxWarning && (
            <p className="mt-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[11px] leading-snug text-fg-muted">
              {pct(w.approxShare, 0)} das identificações vieram do IP. Nesses casos o endereço mostrado é o mais próximo do centro da região da pessoa, não da rua dela.
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <MaAddressMapV2 points={points} focusKey={focus} onFocus={setFocus} height={260} />
        </div>
      </div>
      {addrs.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs min-w-[560px]">
            <thead>
              <tr className="border-b border-border text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                <th className="py-2 pr-2 text-left">Endereço</th>
                <th className="py-2 px-2 text-right">Identificado</th>
                <th className="py-2 px-2 text-right">Cliques</th>
                <th className="py-2 px-2 text-right">Rota</th>
                <th className="py-2 px-2 text-right">Site</th>
                <th className="py-2 pl-2 text-right">Conversão</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a, i) => (
                <tr
                  key={a.key}
                  onClick={() => setFocus(a.key)}
                  className={cn("border-b border-border/50 last:border-b-0 cursor-pointer hover:bg-surface", focus === a.key && "bg-signature-soft")}
                >
                  <td className="py-2 pr-2">
                    <div className="font-semibold text-fg">{i + 1}. {a.name}</div>
                    {a.address && <div className="text-[10.5px] text-fg-subtle">{a.address}</div>}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums">{fmt(a.identified)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{fmt(a.clicks)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{fmt(a.directions)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{fmt(a.website)}</td>
                  <td className="py-2 pl-2 text-right tabular-nums">{pct(a.conversion, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {canExpand && (
            <button type="button" onClick={toggle} className="mt-2 text-xs font-semibold text-signature hover:underline underline-offset-4 cursor-pointer">
              {open ? "Mostrar só os 10 primeiros" : `Mostrar os ${addrs.length} endereços`}
            </button>
          )}
        </div>
      )}
      <p className="mt-3 text-[11px] leading-snug text-fg-subtle">
        Identificado = vezes que o endereço foi o mais próximo da pessoa. Conversão = cliques no endereço ÷ identificações. Toque no widget conta como engajamento e não entra nos cliques em CTA da peça.
      </p>
    </MaCard>
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
    <MaCard
      title="Por dia"
      actions={
        <ChipGroupV2
          label="Métrica da série diária"
          options={available.map((k) => ({ value: k, label: PIECE_METRICS[k].label }))}
          value={m}
          onChange={setMetric}
        />
      }
    >
      <TrendChartV2
        data={piece.daily}
        dataKey={m}
        label={PIECE_METRICS[m].label}
        kind="bar"
        color={resolveChartVar(color, hypr)}
        height={200}
      />
      <div className="mt-2 flex items-center gap-2 text-[11px] text-fg-subtle">
        <LayerBadge kind="peca" /> Medido pela peça, dia a dia (horário de Brasília).
      </div>
    </MaCard>
  );
}

