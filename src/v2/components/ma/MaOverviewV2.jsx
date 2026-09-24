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
import { CsvButton, MaCard, PuzzleIcon } from "./maUi";
import { downloadCsv, keyMetricText, pct } from "./maFormat";
import { MaStackedDailyChartV2 } from "./MaStackedDailyChartV2";
import { MaThumbV2 } from "./MaThumbV2";


const SOURCE_NOTE = {
  dsp: "Entrega da DSP, mesma base da aba Display",
  served: "Carregamentos contados pela peça",
  measured: "Medidas pela peça",
  mixed: "DSP nas peças ligadas a criativos; nas demais, carregamentos da peça",
};

function Note({ children }) {
  return <span className="text-[11px] text-fg-subtle leading-snug">{children}</span>;
}

export function MaOverviewV2({ pieces, medias, formatColors, onOpenPiece, campaignName = "campanha" }) {
  const list = pieces.map((p) => ({ p, m: medias.get(p.creative_id), km: keyMetric(p) }));
  const total = sumMedia(list.map((x) => x.m));
  const best = list.length > 1
    ? Math.max(...list.filter((x) => !isWaiting(x.p)).map((x) => x.m.engagement ?? -1))
    : null;
  const { rows: stackRows, formats } = foldFormatSeries(engagedByDayAndFormat(pieces), formatColors);
  const groups = groupByFormat(pieces);
  const exact = list.every((x) => x.m.exactPeople);

  // CSV do comparativo: números crus (Excel/Sheets), taxas com 2 casas.
  const rate = (v) => (v == null ? "" : Number(v).toFixed(2));
  const csv = () =>
    downloadCsv(
      `${campaignName} - max attention - comparativo`.replace(/[\\/:*?"<>|]+/g, " "),
      ["Formato", "Peça", "Tamanho", "Impressões", "Imp. medidas pela peça", "Viewability (%)", "Sessões", "Sessões engajadas", "Engajamento (%)", "Cliques em CTA", "CTR da peça (%)", "Destaque do formato", "Valor do destaque"],
      list.map(({ p, m, km }) =>
        isWaiting(p)
          ? [formatLabel(p.format), p.name, p.size || "", "", "", "", "", "", "", "", "", km?.label || "", ""]
          : [formatLabel(p.format), p.name, p.size || "", m.impressions, m.measured, rate(m.viewability), m.sessions, m.engaged, rate(m.engagement), m.ctaClicks, rate(m.ctr), km?.label || "", km?.value == null ? "" : km.kind === "count" ? km.value : rate(km.value)],
      ),
    );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCardV2
          label="Impressões"
          value={fmt(total.impressions)}
          hint="Entrega das peças vinculadas. Quando a peça está ligada ao criativo da DSP, é a impressão da DSP; senão, os carregamentos contados pela própria peça. As taxas ao lado usam as impressões medidas pela peça."
          note={<Note>{SOURCE_NOTE[total.impressionsSource]}. Medidas pela peça: <b className="text-fg tabular-nums">{fmt(total.measured)}</b></Note>}
        />
        <KpiCardV2
          label="Viewability"
          value={pct(total.viewability, 1)}
          hint="Impressões visíveis ÷ impressões medidas. Visível = ao menos 50% da peça na tela por 1 segundo contínuo, medido pela própria peça."
          note={<Note>Visíveis ÷ medidas pela peça</Note>}
        />
        <KpiCardV2
          label="Sessões"
          value={fmt(total.sessions)}
          hint="Pessoas (sessões distintas) que carregaram a peça no período."
          note={<Note>{exact ? "Pessoas que carregaram a peça" : "Estimativa: soma diária de pessoas"}</Note>}
        />
        <KpiCardV2
          label="Taxa de engajamento"
          value={pct(total.engagement)}
          accent
          hint="Sessões com interação ativa ÷ sessões. Interação ativa: mexer no mapa, clicar em pin, raspar, trocar slide, responder, jogar, tocar num widget ou clicar."
          note={<Note>Sessões com interação ÷ sessões</Note>}
        />
        <KpiCardV2
          label="Sessões engajadas"
          value={fmt(total.engaged)}
          hint="Pessoas que fizeram ao menos uma interação ativa com a peça."
          note={<Note>Pessoas que interagiram</Note>}
        />
        <KpiCardV2
          label="Cliques em CTA"
          value={fmt(total.ctaClicks)}
          hint="Cliques que levam ao destino do anunciante. CTR da peça = cliques em CTA ÷ impressões medidas pela peça (outra base que o CTR da aba Display, que divide pelas imp. visíveis da DSP). Toques em widget não entram."
          note={<Note>CTR da peça <b className="text-fg tabular-nums">{pct(total.ctr)}</b></Note>}
        />
      </div>

      <MaCard
        title="Comparativo das peças"
        subtitle={list.length > 1 ? "Mesmas métricas para todos os formatos · ★ maior engajamento" : "Métricas comparáveis da peça"}
        actions={<CsvButton onClick={csv} />}
      >
        <div className="overflow-x-auto -mx-4 md:-mx-5">
          <table className="w-full text-xs min-w-[860px]">
            <thead>
              <tr className="border-b border-border text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                <th className="px-4 md:px-5 py-2.5 text-left">Formato</th>
                <th className="px-3 py-2.5 text-left">Peça</th>
                <th className="px-3 py-2.5 text-right">Impressões</th>
                <th className="px-3 py-2.5 text-right">Viewability</th>
                <th className="px-3 py-2.5 text-right">Engajamento</th>
                <th className="px-3 py-2.5 text-right">Cliques em CTA</th>
                <th className="px-3 py-2.5 text-right">CTR</th>
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
                      <td colSpan={6} className="px-3 py-2.5 text-fg-subtle italic">Aguardando a primeira impressão</td>
                    ) : (
                      <>
                        <td className="px-3 py-2.5 text-right tabular-nums text-fg">{fmt(m.impressions)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-fg">{pct(m.viewability, 1)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-fg whitespace-nowrap">
                          {best != null && m.engagement === best && <span className="text-warning mr-1" title="Maior engajamento">★</span>}
                          {pct(m.engagement)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-fg">{fmt(m.ctaClicks)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-fg">{pct(m.ctr)}</td>
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
                  <td className="px-3 py-2.5 text-right tabular-nums">{pct(total.engagement)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmt(total.ctaClicks)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{pct(total.ctr)}</td>
                  <td className="px-4 md:px-5 py-2.5" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </MaCard>

      {stackRows.length > 0 && (
        <MaCard title="Sessões engajadas por dia" subtitle={formats.length > 1 ? "Empilhado por formato" : null}>
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
                onOpen={() => onOpenPiece(g.items[0].creative_id)}
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
                    onOpen={() => onOpenPiece(p.creative_id)}
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

function PieceCard({ piece, media, color, onOpen, showFormatDesc = false }) {
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
        "hover:border-border-strong hover:bg-surface cursor-pointer transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
      )}
    >
      <MaThumbV2 format={piece.format} size={piece.size} color={color} className={cn("h-[96px]", waiting && "opacity-60")} />
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
            <Mini label="Cliques CTA" value={fmt(media.ctaClicks)} />
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
