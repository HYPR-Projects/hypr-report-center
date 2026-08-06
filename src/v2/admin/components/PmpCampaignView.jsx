// src/v2/admin/components/PmpCampaignView.jsx
//
// Visão POR CAMPANHA da carteira PMP — a camada entre "cliente" e "line".
//
// Cada card é uma campanha (ver lib/pmpCampaign.js pra régua de identidade) e
// responde, sem precisar abrir nada:
//
//   • quanto foi contratado           → PI
//   • quanto já entrou de faturamento → Receita Bruta   (+ % do PI)
//   • quanto sobrou pra HYPR          → Margem HYPR     (+ % do PI e % da receita)
//   • quanto custou                   → Custo
//   • em que ritmo está               → última entrega + status
//
// Abrindo, a campanha se abre em FLIGHTS (1 PI cada) e, dentro deles, nas
// lines. Campanha de um flight só pula o nível intermediário — que seria uma
// caixa repetindo o mesmo PI do cabeçalho.

import { memo, useMemo, useState } from "react";
import { cn } from "../../../ui/cn";
import {
  formatBRL, formatInt, formatRatioPct,
  formatLastDelivery, statusPillClass, pctDeliveryClass, pctBarColor,
  METRIC,
} from "../lib/pmpFormat";
import {
  campaignTotals, sortCampaigns,
  CAMPAIGN_SITUATIONS, CAMPAIGN_CYCLES,
} from "../lib/pmpCampaign";
import { PmpLineRow, PmpLineRowHeader, SourceChip } from "./PmpComponents";

const MONTH_ABBR = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

/** "Jun/26 → Ago/26" (ou "Jun/26" quando começa e termina no mesmo mês). */
function formatPeriod(from, to) {
  const fmt = (d) => {
    if (!d || String(d).length < 7) return null;
    const [y, m] = String(d).split("-");
    const label = MONTH_ABBR[Number(m) - 1];
    return label ? `${label}/${y.slice(-2)}` : null;
  };
  const a = fmt(from), b = fmt(to);
  if (!a && !b) return null;
  if (!b || a === b) return a;
  if (!a) return b;
  return `${a} → ${b}`;
}

/**
 * Barra de recorte da Carteira: dois eixos independentes com contagem por
 * bucket. Vale pros dois agrupamentos (cliente e campanha) — o recorte é de
 * CAMPANHA, e a visão por cliente mostra só os clientes que sobraram.
 */
export function PmpCarteiraFilters({ situation, cycle, onSituation, onCycle, counts }) {
  const active = situation !== "all" || cycle !== "all";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <ChipGroup label="Situação" options={CAMPAIGN_SITUATIONS} value={situation}
                 counts={counts.situation} onChange={onSituation} />
      <span className="hidden md:inline w-px h-5 bg-border" aria-hidden />
      <ChipGroup label="Ciclo" options={CAMPAIGN_CYCLES} value={cycle}
                 counts={counts.cycle} onChange={onCycle} />
      {active && (
        <button type="button" onClick={() => { onSituation("all"); onCycle("all"); }}
                className="text-[11.5px] text-fg-muted hover:text-fg underline-offset-2 hover:underline">
          Limpar recorte
        </button>
      )}
    </div>
  );
}

function ChipGroup({ label, options, value, counts, onChange }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle hidden sm:inline shrink-0">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((o) => {
          const on = o.value === value;
          const n = counts?.[o.value] ?? 0;
          // Bucket vazio continua clicável só quando já está ativo (pra o user
          // conseguir sair dele); senão vira ruído desabilitado.
          const empty = n === 0 && !on;
          return (
            <button key={o.value} type="button" title={o.hint}
                    disabled={empty}
                    onClick={() => onChange(o.value)}
                    aria-pressed={on}
                    className={cn(
                      "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-[12px] font-medium transition-colors",
                      on ? "border-signature/50 bg-signature/10 text-signature"
                         : empty ? "border-border/60 bg-surface/40 text-fg-subtle/50 cursor-not-allowed"
                                 : "border-border bg-surface text-fg-muted hover:text-fg hover:bg-surface-strong",
                    )}>
              <span>{o.label}</span>
              <span className={cn("tabular-nums text-[10.5px] px-1 rounded",
                                  on ? "bg-signature/20" : "text-fg-subtle")}>
                {n}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PmpCampaignView({ campaigns, onLineClick, onLinkClick, sortBy = "revenue" }) {
  // Controle de expandir/recolher em massa. `epoch` força o accordion a
  // re-sincronizar com o comando global sem virar estado controlado (cada card
  // continua dono do seu toggle depois).
  const [bulk, setBulk] = useState(null); // { open: bool, epoch: number }
  const sorted = useMemo(() => sortCampaigns(campaigns, sortBy), [campaigns, sortBy]);
  const totals = useMemo(() => campaignTotals(campaigns), [campaigns]);

  if (!campaigns.length) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-canvas-elevated px-6 py-16 text-center">
        <div className="text-fg-muted text-sm">Nenhuma campanha corresponde aos filtros.</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap px-1">
        <p className="text-[11.5px] text-fg-muted tabular-nums">
          <span className="font-semibold text-fg">{totals.campaigns}</span>
          {totals.campaigns === 1 ? " campanha" : " campanhas"}
          <span className="mx-1.5 text-fg-subtle">·</span>
          {totals.lines} {totals.lines === 1 ? "line" : "lines"}
          {totals.live > 0 && (
            <>
              <span className="mx-1.5 text-fg-subtle">·</span>
              <span className="text-emerald-500 dark:text-emerald-400">{totals.live} no ar</span>
            </>
          )}
        </p>
        <div className="flex items-center gap-2 text-[11px]">
          <button type="button" onClick={() => setBulk({ open: true, epoch: Date.now() })}
                  className="text-fg-muted hover:text-fg underline-offset-2 hover:underline">
            Expandir tudo
          </button>
          <span className="text-fg-subtle">·</span>
          <button type="button" onClick={() => setBulk({ open: false, epoch: Date.now() })}
                  className="text-fg-muted hover:text-fg underline-offset-2 hover:underline">
            Recolher tudo
          </button>
        </div>
      </div>

      {sorted.map((c, i) => (
        <PmpCampaignAccordion key={c.key} campaign={c} bulk={bulk}
                              defaultOpen={i === 0 && sorted.length <= 3}
                              onLineClick={onLineClick} onLinkClick={onLinkClick} />
      ))}
    </div>
  );
}

function CampaignAccordionInner({ campaign: c, defaultOpen = false, bulk, onLineClick, onLinkClick }) {
  const [open, setOpen] = useState(defaultOpen);
  const [bulkEpoch, setBulkEpoch] = useState(null);
  // Aplica o comando global (expandir/recolher tudo) uma vez por clique,
  // durante o render — sem effect, sem piscar.
  if (bulk && bulk.epoch !== bulkEpoch) {
    setBulkEpoch(bulk.epoch);
    if (open !== bulk.open) setOpen(bulk.open);
  }

  const period = formatPeriod(c.startDate, c.endDate);
  const lastDeliv = formatLastDelivery(c.hoursSinceLastDelivery);
  const hasPi = c.pi > 0;
  const multiFlight = c.flights.length > 1;

  return (
    <section className={cn(
      "rounded-xl border border-border bg-canvas-elevated overflow-hidden transition-shadow",
      open && "shadow-sm",
    )}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              className="w-full text-left px-5 md:px-6 py-4 md:py-5 hover:bg-surface/30 transition-colors">
        {/* Linha 1 — identidade */}
        <div className="flex items-start gap-3">
          <Chevron open={open} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-[15px] font-semibold text-fg truncate max-w-full" title={c.name}>
                {c.name}
              </h3>
              <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border whitespace-nowrap",
                                  statusPillClass(c.status))}>
                {c.status}
              </span>
              {c.liveCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-emerald-500 dark:text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgb(52,211,153)]" />
                  {c.liveCount} no ar
                </span>
              )}
              {c.sources.map((s) => <SourceChip key={s} source={s} showXandr />)}
            </div>
            {/* Nome cru do deal quando o título foi derivado — o operador
                precisa conseguir casar o card com o Xandr/PubMatic. */}
            {c.rawName && (
              <div className="mt-0.5 font-mono text-[10.5px] text-fg-subtle/80 truncate" title={c.rawName}>
                {c.rawName}
              </div>
            )}
            <div className="mt-1 text-[11.5px] text-fg-subtle flex items-center gap-1.5 flex-wrap">
              <span className="font-medium text-fg-muted">{c.customer || "sem cliente"}</span>
              {c.agency && <><Dot />{c.agency}</>}
              {period && <><Dot />{period}</>}
              <Dot />
              {c.lines.length} {c.lines.length === 1 ? "line" : "lines"}
              {multiFlight && <><Dot />{c.flights.length} flights</>}
              {c.tokens.map((t) => (
                <span key={t} className="font-mono text-[10px] text-signature bg-signature/10 px-1.5 py-0.5 rounded">{t}</span>
              ))}
            </div>
          </div>
          <div className="hidden sm:block text-right shrink-0">
            <div className="text-[10px] uppercase tracking-widest text-fg-subtle font-semibold">Última entrega</div>
            <div className="text-[12.5px] font-semibold text-fg tabular-nums mt-0.5">{lastDeliv || "—"}</div>
          </div>
        </div>

        {/* Linha 2 — big numbers da campanha */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-5 gap-y-3">
          <Stat label={METRIC.pi.label} title={METRIC.pi.hint}
                value={hasPi ? formatBRL(c.pi) : "—"}
                sub={multiFlight && hasPi ? `${c.flightsWithPi} de ${c.flights.length} flights` : null} />
          <Stat label={METRIC.revenue.label} title={METRIC.revenue.hint} value={formatBRL(c.revenue)} />
          <Stat label={METRIC.margin.label} title={METRIC.margin.hint}
                value={formatBRL(c.margin)} valueClass="text-emerald-600 dark:text-emerald-400"
                sub={c.marginPct != null ? `${formatRatioPct(c.marginPct, 0)} da receita` : null} />
          <Stat label={METRIC.cost.label} title={METRIC.cost.hint}
                value={formatBRL(c.cost)} valueClass="text-fg-muted" />
          <Stat label={METRIC.imps.label} title={METRIC.imps.hint}
                value={formatInt(c.imps)} valueClass="text-fg-muted"
                sub={c.ecpm != null ? `eCPM ${formatBRL(c.ecpm)}` : null} />
          <Stat label="% Entrega" title="Margem HYPR ÷ PI · Receita Bruta ÷ PI"
                value={c.pctMargin != null ? formatRatioPct(c.pctMargin, 0) : "—"}
                valueClass={c.pctMargin == null ? "text-fg" : pctDeliveryClass(c.pctMargin).replace(/bg-\S+/g, "").trim()}
                sub={c.pctRev != null ? `${formatRatioPct(c.pctRev, 0)} em receita` : null} />
        </div>

        {/* Linha 3 — entrega vs. contratado */}
        {hasPi ? (
          <div className="mt-4 space-y-2">
            <ProgressRow label="Margem HYPR" value={c.margin} total={c.pi} ratio={c.pctMargin} tone="margin" />
            <ProgressRow label="Receita Bruta" value={c.revenue} total={c.pi} ratio={c.pctRev} tone="revenue" />
          </div>
        ) : (
          <div className="mt-4 px-3 py-2 rounded-md border border-dashed border-amber-500/30 bg-amber-500/5 text-[11px] text-amber-700 dark:text-amber-300">
            Sem PI vinculado — não dá pra medir entrega contra contrato.
          </div>
        )}

        {/* Avisos de integridade do contrato */}
        {(c.linesWithoutPi > 0 || c.piMismatch) && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {c.linesWithoutPi > 0 && (
              <Warning title="Lines dentro de um flight que não declaram PI. O PI do flight é o de um único membro — se estas lines são de outro contrato, o % de entrega fica inflado.">
                {c.linesWithoutPi} {c.linesWithoutPi === 1 ? "line sem PI próprio" : "lines sem PI próprio"}
              </Warning>
            )}
            {c.piMismatch && (
              <Warning title="Membros do mesmo flight declaram valores de PI diferentes. O total usa o primeiro valor encontrado — confira o PI no drawer das lines.">
                PI divergente entre membros
              </Warning>
            )}
          </div>
        )}
      </button>

      {open && (
        <div className="border-t border-border/40 bg-surface/20 px-3 py-3 space-y-3">
          {multiFlight
            ? c.flights.map((f) => (
                <FlightBlock key={f.key} flight={f} onLineClick={onLineClick} onLinkClick={onLinkClick} />
              ))
            : <LineList lines={c.flights[0]?.lines || []} onLineClick={onLineClick} onLinkClick={onLinkClick} />}
        </div>
      )}
    </section>
  );
}

export const PmpCampaignAccordion = memo(CampaignAccordionInner);

function FlightBlock({ flight: f, onLineClick, onLinkClick }) {
  return (
    <div className="rounded-lg border border-signature/25 bg-signature/[0.03] overflow-hidden">
      <div className="flex items-center gap-3 flex-wrap px-4 py-2.5 border-b border-signature/15">
        <span className="text-[9px] uppercase tracking-[0.16em] font-semibold text-signature shrink-0">
          {f.kind === "group" ? "Flight · 1 PI" : "Flight"}
        </span>
        <span className="text-[12.5px] font-medium text-fg truncate min-w-0" title={f.name}>{f.name}</span>
        {f.token && (
          <span className="font-mono text-[10px] text-signature bg-signature/10 px-1.5 py-0.5 rounded shrink-0">{f.token}</span>
        )}
        <div className="ml-auto flex items-center gap-4 text-[11.5px] tabular-nums shrink-0">
          <span className="text-fg-subtle">{f.lines.length} {f.lines.length === 1 ? "line" : "lines"}</span>
          <span className="text-fg-muted">PI <span className="font-semibold text-fg">{f.pi != null ? formatBRL(f.pi) : "—"}</span></span>
          <span className="hidden sm:inline text-fg-muted">Receita <span className="font-semibold text-fg">{formatBRL(f.revenue)}</span></span>
          <span className="text-fg-muted">Margem <span className="font-semibold text-emerald-600 dark:text-emerald-400">{formatBRL(f.margin)}</span></span>
          {f.pi > 0 && (
            <span className={cn("px-1.5 py-0.5 rounded font-semibold", pctDeliveryClass(f.margin / f.pi))}>
              {formatRatioPct(f.margin / f.pi, 0)}
            </span>
          )}
        </div>
      </div>
      <LineList lines={f.lines} onLineClick={onLineClick} onLinkClick={onLinkClick} bare />
    </div>
  );
}

// Lista de lines dentro da campanha. `hidePi` porque PI/% entrega vivem no
// nível do flight (compartilhados) — repetir por line induziria a somar o
// mesmo contrato N vezes.
function LineList({ lines, onLineClick, onLinkClick, bare = false }) {
  if (!lines.length) return null;
  return (
    <div className={cn("overflow-hidden", !bare && "rounded-lg border border-border/60 bg-canvas-elevated")}>
      <div className="overflow-x-auto scrollbar-hidden">
        <div className="md:min-w-[920px]">
          <PmpLineRowHeader hidePi />
        </div>
        <div className="md:min-w-[920px] divide-y divide-border/30">
          {lines.map((l) => (
            <PmpLineRow key={`${l.source || "xandr"}:${l.line_id}`} line={l}
                        onClick={onLineClick} onLinkClick={onLinkClick}
                        compact hidePi />
          ))}
        </div>
      </div>
    </div>
  );
}

function ProgressRow({ label, value, total, ratio, tone }) {
  const r = ratio ?? 0;
  const over = r >= 1;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-[11px] text-fg-muted">
          <span className={cn("font-medium tabular-nums",
            tone === "margin" ? "text-emerald-600 dark:text-emerald-400" : "text-sky-600 dark:text-sky-400")}>
            {formatBRL(value)}
          </span>
          <span className="text-fg-subtle"> de </span>
          <span className="tabular-nums">{formatBRL(total)}</span>
          <span className="text-fg-subtle ml-1.5">· {label}</span>
        </span>
        <span className={cn("text-[12.5px] font-bold tabular-nums shrink-0",
                            pctDeliveryClass(ratio).replace(/bg-\S+/g, "").trim() || "text-fg")}>
          {over && <span aria-hidden>▲ </span>}{formatRatioPct(ratio, 0)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-track overflow-hidden">
        <div className={cn("h-full rounded-full transition-[width] duration-500", pctBarColor(ratio))}
             style={{ width: `${Math.max(1.5, Math.min(100, r * 100))}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value, sub, valueClass, title }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[9px] uppercase tracking-widest text-fg-subtle font-semibold">{label}</div>
      <div className={cn("text-[14px] font-semibold tabular-nums truncate mt-0.5", valueClass || "text-fg")}
           title={typeof value === "string" ? value : undefined}>
        {value}
      </div>
      {sub && <div className="text-[10.5px] text-fg-subtle truncate mt-0.5">{sub}</div>}
    </div>
  );
}

function Warning({ children, title }) {
  return (
    <span title={title}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10.5px] font-medium border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </svg>
      {children}
    </span>
  );
}

function Dot() {
  return <span className="text-fg-subtle/60" aria-hidden>·</span>;
}

function Chevron({ open }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
         strokeLinecap="round" strokeLinejoin="round"
         className={cn("mt-1 text-fg-subtle transition-transform shrink-0", open && "rotate-90")} aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
