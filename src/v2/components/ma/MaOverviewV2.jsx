// src/v2/components/ma/MaOverviewV2.jsx
//
// Visão agregada da aba Max Attention: KPIs comparáveis entre formatos,
// comparativo peça a peça, sessões engajadas por dia (empilhado por formato)
// e a galeria de peças agrupada por formato.

import { fmt } from "../../../shared/format";
import {
  MA_FORMATS,
  MECHANIC_LABELS,
  engagedByDayAndFormat,
  foldFormatSeries,
  formatLabel,
  groupByFormat,
  isWaiting,
  keyMetric,
  sumMedia,
  widgetLabel,
} from "../../../shared/maMetrics";
import { cn } from "../../../ui/cn";
import { KpiCardV2 } from "../KpiCardV2";
import { CsvButton, HyprOnlyBadge, MaCard, PuzzleIcon } from "./maUi";
import { downloadCsv, keyMetricText, pct } from "./maFormat";
import { MaStackedDailyChartV2 } from "./MaStackedDailyChartV2";
import { MaThumbV2 } from "./MaThumbV2";


const SOURCE_NOTE = {
  dsp: "Entrega da DSP, só dos criativos Max Attention",
  served: "Carregamentos contados pela peça",
  measured: "Medidas pela peça",
  mixed: "DSP nas peças ligadas a criativos; nas demais, carregamentos da peça",
};

// Sem criativo da DSP ligado, a única medição de clique que existe é a da
// peça — ela entra no lugar (a coluna não fica vazia nem mistura as duas).
const clicksOf = (m) => (m?.deliverySource === "dsp" ? m.clicks : m?.ctaClicks);
const ctrOf = (m) => (m?.deliverySource === "dsp" ? m.ctr : m?.ctaCtr);

function Note({ children }) {
  return <span className="text-[11px] text-fg-subtle leading-snug">{children}</span>;
}

/* O que só a HYPR vê: a medição da própria peça ao lado da entrega da DSP.
 * Pro cliente, um número por métrica — entrega pela DSP, comportamento pela
 * peça — sem duas medições da mesma coisa lado a lado. */
function HyprNote({ children }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-subtle leading-snug">
      <HyprOnlyBadge />
      {children}
    </span>
  );
}

// `heroId`: peça sendo aberta pelo card; a miniatura dela ganha o
// view-transition-name que vira o preview no detalhe (MaxAttentionV2).
export function MaOverviewV2({ pieces, medias, formatColors, onOpenPiece, campaignName = "campanha", heroId = null, hypr = false }) {
  const list = pieces.map((p) => ({ p, m: medias.get(p.creative_id), km: keyMetric(p) }));
  const total = sumMedia(list.map((x) => x.m));
  const best = list.length > 1
    ? Math.max(...list.filter((x) => !isWaiting(x.p)).map((x) => x.m.engagement ?? -1))
    : null;
  const { rows: stackRows, formats } = foldFormatSeries(engagedByDayAndFormat(pieces), formatColors);
  const groups = groupByFormat(pieces);
  const exact = list.every((x) => x.m.exactPeople);

  // CSV do comparativo: números crus (Excel/Sheets), taxas com 2 casas. O do
  // cliente leva só a entrega da DSP e o comportamento; o da HYPR leva
  // também a medição da peça.
  const rate = (v) => (v == null ? "" : Number(v).toFixed(2));
  const keyVal = (km) => (km?.value == null ? "" : km.kind === "count" ? km.value : rate(km.value));
  const csv = () => {
    const head = ["Formato", "Peça", "Tamanho", "Impressões", "Imp. visíveis", "Viewability (%)", "Cliques", "CTR (%)", "Sessões engajadas", "Engajamento (%)", "Destaque do formato", "Valor do destaque"];
    const hyprHead = ["Fonte da entrega", "Imp. medidas pela peça", "Visíveis medidas pela peça", "Viewability da peça (%)", "Cliques em CTA (peça)", "CTR da peça (%)", "Sessões (peça)"];
    downloadCsv(
      `${campaignName} - max attention - comparativo`.replace(/[\\/:*?"<>|]+/g, " "),
      hypr ? [...head, ...hyprHead] : head,
      list.map(({ p, m, km }) => {
        if (isWaiting(p)) {
          const blank = [formatLabel(p.format), p.name, p.size || "", "", "", "", "", "", "", "", km?.label || "", ""];
          return hypr ? [...blank, "", "", "", "", "", "", ""] : blank;
        }
        // Sem DSP ligada, a entrega é a medição da peça (a única que existe).
        const row = [
          formatLabel(p.format), p.name, p.size || "",
          m.impressions, m.viewable, rate(m.viewability),
          clicksOf(m), rate(ctrOf(m)),
          m.engaged, rate(m.engagement), km?.label || "", keyVal(km),
        ];
        return hypr
          ? [...row, m.deliverySource === "dsp" ? "DSP" : "Peça", m.measured, m.pieceViewable, rate(m.pieceViewability), m.ctaClicks, rate(m.ctaCtr), m.sessions]
          : row;
      }),
    );
  };
  const clicksValue = total.clicks ?? total.ctaClicks;
  const ctrValue = total.clicks != null ? total.ctr : total.ctaCtr;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <KpiCardV2
          label="Impressões"
          value={fmt(total.impressions)}
          hint="Entrega da DSP dos criativos ligados às peças Max Attention, a mesma base da aba Display. A aba Display soma todos os criativos da campanha, inclusive os que não são Max Attention."
          note={
            <>
              <Note>{total.impressionsSource === "dsp" ? "Só as peças Max Attention · mesma base da aba Display" : SOURCE_NOTE[total.impressionsSource]}</Note>
              {hypr && <HyprNote>Carregadas pela peça: <b className="text-fg tabular-nums">{fmt(total.measured)}</b></HyprNote>}
            </>
          }
        />
        <KpiCardV2
          label="Viewability"
          value={pct(total.viewability, 1)}
          hint="Impressões visíveis ÷ impressões, pela DSP — a mesma conta da aba Display."
          note={
            <>
              <Note>Visíveis ÷ impressões</Note>
              {hypr && <HyprNote>Medida pela peça: <b className="text-fg tabular-nums">{pct(total.pieceViewability, 1)}</b></HyprNote>}
            </>
          }
        />
        <KpiCardV2
          label="Cliques"
          value={fmt(clicksValue)}
          hint={total.clicks != null
            ? "Cliques registrados pela DSP. CTR = cliques ÷ impressões visíveis, a mesma conta da aba Display."
            : "Cliques no CTA medidos pela peça (nenhuma peça está ligada a criativo da DSP)."}
          note={
            <>
              <Note>CTR <b className="text-fg tabular-nums">{pct(ctrValue)}</b></Note>
              {hypr && total.clicks != null && <HyprNote>Cliques no CTA da peça: <b className="text-fg tabular-nums">{fmt(total.ctaClicks)}</b></HyprNote>}
            </>
          }
        />
        <KpiCardV2
          label="Taxa de engajamento"
          value={pct(total.engagement)}
          accent
          hint="Pessoas que interagiram ÷ pessoas que viram a peça, medido pela peça. Interação: mexer no mapa, clicar em pin, raspar, trocar slide, responder, jogar, tocar num widget ou clicar."
          note={
            <>
              <Note>Interações medidas pela peça</Note>
              {hypr && <HyprNote>Base: <b className="text-fg tabular-nums">{fmt(total.sessions)}</b> {exact ? "pessoas" : "sessões (estimado)"}</HyprNote>}
            </>
          }
        />
        <KpiCardV2
          label="Pessoas que interagiram"
          value={fmt(total.engaged)}
          hint="Pessoas que fizeram ao menos uma interação ativa com a peça."
          note={<Note>Ao menos uma interação ativa</Note>}
        />
      </div>

      <MaCard
        title="Comparativo das peças"
        subtitle={list.length > 1 ? "Entrega pela DSP · engajamento medido pela peça · ★ maior engajamento" : "Entrega pela DSP · engajamento medido pela peça"}
        actions={<CsvButton onClick={csv} />}
      >
        <div className="overflow-x-auto -mx-4 md:-mx-5">
          <table className={cn("w-full text-xs", hypr ? "min-w-[1040px]" : "min-w-[860px]")}>
            <thead>
              <tr className="border-b border-border text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                <th className="px-4 md:px-5 py-2.5 text-left">Formato</th>
                <th className="px-3 py-2.5 text-left">Peça</th>
                <th className="px-3 py-2.5 text-right" title="Entrega da DSP, mesma base da aba Display">Impressões</th>
                <th className="px-3 py-2.5 text-right" title="Visíveis ÷ impressões, pela DSP">Viewability</th>
                {hypr && <th className="px-3 py-2.5 text-right text-warning" title="Só HYPR: medida pela própria peça, mesma regra em todas as DSPs">Viewab. peça</th>}
                <th className="px-3 py-2.5 text-right">Engajamento</th>
                <th className="px-3 py-2.5 text-right" title="Cliques da DSP">Cliques</th>
                <th className="px-3 py-2.5 text-right" title="Cliques ÷ impressões visíveis">CTR</th>
                {hypr && <th className="px-3 py-2.5 text-right text-warning" title="Só HYPR: cliques no CTA contados pela própria peça">CTA peça</th>}
                <th className="px-4 md:px-5 py-2.5 text-left">Destaque do formato</th>
              </tr>
            </thead>
            <tbody>
              {list.map(({ p, m, km }) => {
                const waiting = isWaiting(p);
                return (
                  <tr
                    key={p.creative_id}
                    onClick={() => onOpenPiece(p.creative_id)}
                    className={cn("border-b border-border/50 last:border-b-0 hover:bg-surface cursor-pointer", waiting && "opacity-60")}
                  >
                    <td className="px-4 md:px-5 py-2.5 whitespace-nowrap">
                      <span className="inline-flex items-center gap-2 font-semibold text-fg">
                        <span className="size-2 rounded-full" style={{ background: formatColors[p.format] }} aria-hidden />
                        {formatLabel(p.format)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenPiece(p.creative_id); }}
                        className="text-left text-fg hover:text-signature hover:underline underline-offset-4 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature rounded"
                      >
                        {p.name}{p.size ? ` · ${p.size}` : ""}
                      </button>
                    </td>
                    {waiting ? (
                      <td colSpan={hypr ? 8 : 6} className="px-3 py-2.5 text-fg-subtle italic">Aguardando a primeira impressão</td>
                    ) : (
                      <>
                        <td className="px-3 py-2.5 text-right tabular-nums text-fg">
                          {fmt(m.impressions)}
                          {m.deliverySource !== "dsp" && <span className="ml-1 text-fg-subtle" title="Sem criativo da DSP ligado: carregamentos contados pela peça">*</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-fg">{pct(m.viewability, 1)}</td>
                        {hypr && <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{pct(m.pieceViewability, 1)}</td>}
                        <td className="px-3 py-2.5 text-right tabular-nums text-fg whitespace-nowrap">
                          {best != null && m.engagement === best && <span className="text-warning mr-1" title="Maior engajamento">★</span>}
                          {pct(m.engagement)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-fg">{fmt(clicksOf(m))}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-fg">{pct(ctrOf(m))}</td>
                        {hypr && <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{fmt(m.ctaClicks)}</td>}
                        <td className="px-4 md:px-5 py-2.5 text-fg-muted whitespace-nowrap">
                          {km.label}: <b className="text-fg tabular-nums">{keyMetricText(km)}</b>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
            {list.length > 1 && (
              <tfoot>
                <tr className="border-t-2 border-border bg-surface font-semibold text-fg">
                  <td className="px-4 md:px-5 py-2.5">Total</td>
                  <td className="px-3 py-2.5 text-fg-muted">{list.length} peças</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmt(total.impressions)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{pct(total.viewability, 1)}</td>
                  {hypr && <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{pct(total.pieceViewability, 1)}</td>}
                  <td className="px-3 py-2.5 text-right tabular-nums">{pct(total.engagement)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmt(clicksValue)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{pct(ctrValue)}</td>
                  {hypr && <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{fmt(total.ctaClicks)}</td>}
                  <td className="px-4 md:px-5 py-2.5" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </MaCard>

      {stackRows.length > 0 && (
        <MaCard title="Pessoas que interagiram por dia" subtitle={formats.length > 1 ? "Empilhado por formato" : null}>
          <MaStackedDailyChartV2 rows={stackRows} formats={formats} colors={formatColors} />
        </MaCard>
      )}

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Peças por formato</h2>
          <span className="text-[11px] text-fg-subtle">Clique numa peça para ver o preview e as métricas completas</span>
        </div>
        {groups.every((g) => g.items.length === 1) ? (
          // Uma peça por formato: grade única (o card já diz o formato), sem
          // um cabeçalho por grupo ocupando a linha inteira.
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {groups.map((g) => (
              <PieceCard
                key={g.items[0].creative_id}
                piece={g.items[0]}
                media={medias.get(g.items[0].creative_id)}
                color={formatColors[g.format]}
                onOpen={() => onOpenPiece(g.items[0].creative_id, { fromCard: true })}
                hero={heroId === g.items[0].creative_id}
                showFormatDesc
              />
            ))}
          </div>
        ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.format}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
                <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-fg">
                  <span className="size-2.5 rounded-sm" style={{ background: formatColors[g.format] }} aria-hidden />
                  {g.label}
                </span>
                <span className="text-[11px] text-fg-subtle">
                  {g.items.length} {g.items.length === 1 ? "peça" : "peças"}
                  {MA_FORMATS[g.format]?.desc ? ` · ${MA_FORMATS[g.format].desc}` : ""}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {g.items.map((p) => (
                  <PieceCard
                    key={p.creative_id}
                    piece={p}
                    media={medias.get(p.creative_id)}
                    color={formatColors[p.format]}
                    onOpen={() => onOpenPiece(p.creative_id, { fromCard: true })}
                    hero={heroId === p.creative_id}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        )}
      </section>
    </div>
  );
}

function PieceCard({ piece, media, color, onOpen, showFormatDesc = false, hero = false }) {
  const waiting = isWaiting(piece);
  const km = keyMetric(piece);
  const widgets = piece.widgets || [];
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Abrir ${piece.name}`}
      className={cn(
        "group grid grid-cols-[96px_minmax(0,1fr)] gap-3 rounded-xl border border-border bg-surface-2 p-3 text-left",
        "hover:border-border-strong hover:bg-surface hover:-translate-y-px hover:shadow-md cursor-pointer",
        "transition-[background-color,border-color,box-shadow,translate] duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
      )}
    >
      <MaThumbV2
        format={piece.format}
        size={piece.size}
        color={color}
        className={cn("h-[96px]", waiting && "opacity-60")}
        style={hero ? { viewTransitionName: "ma-hero" } : undefined}
      />
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-fg truncate group-hover:text-signature">
          {piece.name}{piece.size ? ` · ${piece.size}` : ""}
        </div>
        <div
          className="text-[11px] text-fg-subtle truncate inline-flex items-center gap-1.5 max-w-full"
          title={showFormatDesc ? MA_FORMATS[piece.format]?.desc : undefined}
        >
          {showFormatDesc && <span className="size-2 rounded-full shrink-0" style={{ background: color }} aria-hidden />}
          <span className="truncate">
            {formatLabel(piece.format)}
            {piece.mechanic ? ` · mecânica ${MECHANIC_LABELS[piece.mechanic] || piece.mechanic}` : ""}
          </span>
        </div>
        {waiting ? (
          <div className="mt-3 text-[11px] text-fg-subtle italic">Aguardando a primeira impressão no período</div>
        ) : (
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Mini label="Engajamento" value={pct(media.engagement)} />
            <Mini label="Cliques" value={fmt(clicksOf(media))} />
            <Mini label={km.label} value={keyMetricText(km)} />
          </div>
        )}
        {widgets.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {widgets.map((w) => (
              <span key={w.id || w.type} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9.5px] font-semibold text-fg-muted">
                <PuzzleIcon className="size-2.5" />
                {widgetLabel(w.type)}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

function Mini({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-semibold text-fg tabular-nums truncate">{value}</div>
      <div className="text-[10px] text-fg-subtle truncate" title={label}>{label}</div>
    </div>
  );
}
