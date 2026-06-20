// src/v2/admin/components/PmpAnalytics.jsx
//
// Aba "Analytics" do PMP Deals — camada visual/estratégica sobre as entregas
// dos deals (Xandr Curate), complementar à tabela. NÃO substitui a Lista: dá
// uma leitura executiva (big numbers + evolução + mix + tendência).
//
// Fontes de dados (ambas já reais, sem métrica inventada):
//   • `lines`      — lista enriquecida (pmp_lines_enriched) com totais lifetime,
//                    PI, status, cliente, campanha, bid type, etc.
//   • `timeseries` — série DIÁRIA por line (pmp_lines_timeseries) → uma row por
//                    (line_id, day). É o que permite volumetria diária/mensal e
//                    comparação com o período anterior.
//
// Régua de consistência: os filtros (cliente/campanha/status/bid) reduzem o
// CONJUNTO DE LINES; o filtro de período reduz a JANELA DE DIAS. As séries e os
// big numbers somam só as rows das lines sobreviventes dentro da janela — então
// tudo (KPIs, gráficos, tabela) reage junto e de forma coerente.
//
// Métricas de entrega (receita/margem/imps/cliques/custo) refletem o PERÍODO
// selecionado. PI é valor de CONTRATO (não janela) e a "% entregue" é acumulada
// (margem lifetime ÷ PI) — rotulada como tal pra não confundir com a janela.

import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";

import { useThemeColors, useChartNeutral } from "../../hooks/useThemeColors";
import { useIsMobile } from "../../hooks/useIsMobile";
import { ChartCardV2 } from "../../components/ChartCardV2";
import { DateRangeFilterV2 } from "../../components/DateRangeFilterV2";
import { ymd, parseYmd, buildPresets } from "../../../shared/dateFilter";
import { cn } from "../../../ui/cn";
import { formatMonthLabel } from "../lib/format";
import {
  formatBRL, formatBRLCompact, formatInt, formatIntCompact, formatRatioPct,
  effectiveStatus, statusPillClass, bidTypeLabel, pctEntrega,
} from "../lib/pmpFormat";

// ── Helpers ──────────────────────────────────────────────────────────────────
const num = (v) => Number(v) || 0;

// Meta de entrega de margem (régua do time: margem ÷ PI ≥ 85% = verde).
// Marcada como referência nas barras do card "Realizado vs. contratado"
// quando a métrica é Margem. Ver pctDeliveryClass em pmpFormat.
const MARGIN_TARGET = 0.85;
const MONTH_ABBR = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

// "DD/MM" pra eixo diário (a partir de "YYYY-MM-DD").
function dayLabel(d) {
  const [, m, day] = String(d).split("-");
  return `${day}/${m}`;
}
function dayLong(d) {
  const [y, m, day] = String(d).split("-");
  return `${day} ${MONTH_ABBR[Number(m) - 1] || m} ${String(y).slice(-2)}`;
}

// Cores de status alinhadas aos pills (tailwind-400). Usadas no donut (recharts
// precisa de cor literal, não classe utilitária).
const STATUS_COLOR = {
  Andamento:  "#38bdf8",
  Finalizado: "#34d399",
  Revisão:    "#fbbf24",
  Pausado:    "#a78bfa",
  Cancelado:  "#fb7185",
  Pendente:   "#94a3b8",
};

export default function PmpAnalytics({ lines = [], timeseries = [], tsStatus = "idle", onRetry }) {
  const hypr = useThemeColors();
  const accent = hypr.signature || "#22d3ee";

  // ── Filtros ───────────────────────────────────────────────────────────────
  // Default: últimos 30 dias (janela operacional útil que já habilita a
  // comparação com os 30 dias anteriores). Diário por padrão.
  const [period, setPeriod] = useState(() => {
    const p = buildPresets(new Date()).find((x) => x.id === "last30");
    return p?.range || null;
  });
  const [periodPresetId, setPeriodPresetId] = useState("last30");
  const [customers, setCustomers] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [bidTypes, setBidTypes] = useState([]);
  const [granularity, setGranularity] = useState("day"); // "day" | "month"

  // Card "Realizado vs. contratado": métrica exibida e dimensão de agrupamento.
  const [cmpMetric, setCmpMetric] = useState("revenue"); // "revenue" | "margin"
  const [cmpDim, setCmpDim] = useState("customer");      // "customer" | "campaign"

  // Opções de filtro derivadas das lines.
  const { customerOpts, campaignOpts, statusOpts, bidOpts } = useMemo(() => {
    const c = new Set(), ca = new Set(), st = new Set(), bd = new Set();
    for (const l of lines) {
      if (l.customer) c.add(l.customer);
      if (l.campaign_name) ca.add(l.campaign_name);
      st.add(effectiveStatus(l));
      if (l.bid_type) bd.add(l.bid_type);
    }
    const sort = (arr) => [...arr].sort((a, b) => a.localeCompare(b, "pt-BR"));
    return {
      customerOpts: sort(c),
      campaignOpts: sort(ca),
      statusOpts: sort(st),
      bidOpts: [...bd].map((v) => ({ value: v, label: bidTypeLabel(v) || v })),
    };
  }, [lines]);

  // Lines que passam nos filtros de dimensão → conjunto de line_ids ativos.
  const filteredLines = useMemo(() => {
    return lines.filter((l) => {
      if (customers.length && !customers.includes(l.customer)) return false;
      if (campaigns.length && !campaigns.includes(l.campaign_name)) return false;
      if (statuses.length && !statuses.includes(effectiveStatus(l))) return false;
      if (bidTypes.length && !bidTypes.includes(l.bid_type)) return false;
      return true;
    });
  }, [lines, customers, campaigns, statuses, bidTypes]);

  const lineIds = useMemo(() => new Set(filteredLines.map((l) => l.line_id)), [filteredLines]);

  // Janela de datas (ymd) do filtro de período.
  const fromYmd = period?.from ? ymd(period.from) : null;
  const toYmd = period?.to ? ymd(period.to) : null;

  // Rows da série dentro do conjunto de lines + janela de período.
  const tsFiltered = useMemo(() => {
    return timeseries.filter((r) => {
      if (!lineIds.has(r.line_id)) return false;
      if (fromYmd && r.day < fromYmd) return false;
      if (toYmd && r.day > toYmd) return false;
      return true;
    });
  }, [timeseries, lineIds, fromYmd, toYmd]);

  // Bounds do calendário a partir da série disponível.
  const dataBounds = useMemo(() => {
    let lo = null, hi = null;
    for (const r of timeseries) {
      if (lo == null || r.day < lo) lo = r.day;
      if (hi == null || r.day > hi) hi = r.day;
    }
    return { lo, hi };
  }, [timeseries]);

  // ── Agregados do período ────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    let revenue = 0, margin = 0, cost = 0, imps = 0, viewable = 0, clicks = 0;
    const ids = new Set();
    for (const r of tsFiltered) {
      revenue += num(r.curator_revenue);
      margin += num(r.curator_margin);
      cost += num(r.curator_total_cost);
      imps += num(r.imps);
      viewable += num(r.viewable_imps);
      clicks += num(r.clicks);
      ids.add(r.line_id);
    }
    return {
      revenue, margin, cost, imps, viewable, clicks,
      deals: ids.size,
      marginPct: revenue > 0 ? margin / revenue : null,
      ecpm: imps > 0 ? (revenue / imps) * 1000 : null,
      ctr: imps > 0 ? clicks / imps : null,
    };
  }, [tsFiltered]);

  // PI contratado (dedup por grupo — membros compartilham o mesmo PI) + %
  // entregue acumulada (margem lifetime ÷ PI). Independe da janela.
  const contract = useMemo(() => {
    const piByKey = new Map();
    const marginByKey = new Map();
    for (const l of filteredLines) {
      const key = l.group_id || `l:${l.line_id}`;
      if (l.pi_brl != null && !piByKey.has(key)) piByKey.set(key, num(l.pi_brl));
      if (l.group_id) {
        if (!marginByKey.has(key)) marginByKey.set(key, num(l.group_curator_margin));
      } else {
        marginByKey.set(key, num(l.curator_margin));
      }
    }
    const pi = [...piByKey.values()].reduce((s, v) => s + v, 0);
    // só soma margem das chaves que têm PI (pra % fazer sentido)
    let lifeMargin = 0;
    for (const [k, m] of marginByKey) if (piByKey.has(k)) lifeMargin += m;
    return { pi, pctEntregue: pi > 0 ? lifeMargin / pi : null, dealsWithPi: piByKey.size };
  }, [filteredLines]);

  // Comparação com o período imediatamente anterior (mesma duração). Só quando
  // há janela finita selecionada.
  const prev = useMemo(() => {
    if (!period?.from || !period?.to) return null;
    const fromD = parseYmd(fromYmd), toD = parseYmd(toYmd);
    const days = Math.round((toD - fromD) / 86400000) + 1;
    const prevToD = new Date(fromD); prevToD.setDate(prevToD.getDate() - 1);
    const prevFromD = new Date(prevToD); prevFromD.setDate(prevFromD.getDate() - (days - 1));
    const pf = ymd(prevFromD), pt = ymd(prevToD);
    let revenue = 0, margin = 0, imps = 0;
    for (const r of timeseries) {
      if (!lineIds.has(r.line_id)) continue;
      if (r.day < pf || r.day > pt) continue;
      revenue += num(r.curator_revenue);
      margin += num(r.curator_margin);
      imps += num(r.imps);
    }
    return { revenue, margin, imps, label: `${dayLong(pf)} – ${dayLong(pt)}` };
  }, [timeseries, lineIds, period, fromYmd, toYmd]);

  const delta = (cur, base) => (base != null && base > 0 ? (cur - base) / base : null);

  // ── Séries temporais (dia ou mês) ─────────────────────────────────────────
  const series = useMemo(() => {
    const map = new Map();
    for (const r of tsFiltered) {
      const k = granularity === "month" ? r.day.slice(0, 7) : r.day;
      let e = map.get(k);
      if (!e) { e = { key: k, revenue: 0, margin: 0, cost: 0, imps: 0, clicks: 0 }; map.set(k, e); }
      e.revenue += num(r.curator_revenue);
      e.margin += num(r.curator_margin);
      e.cost += num(r.curator_total_cost);
      e.imps += num(r.imps);
      e.clicks += num(r.clicks);
    }
    return [...map.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((e) => ({ ...e, label: granularity === "month" ? formatMonthLabel(e.key, "short") : dayLabel(e.key) }));
  }, [tsFiltered, granularity]);

  // Mix por status (receita no período; fatias por status workflow efetivo).
  // count = nº de deals que ENTREGARAM no período naquele status (consistente
  // com a receita, que também é do período).
  const byStatus = useMemo(() => {
    const lineToStatus = new Map(filteredLines.map((l) => [l.line_id, effectiveStatus(l)]));
    const rev = new Map(), ids = new Map();
    for (const r of tsFiltered) {
      const s = lineToStatus.get(r.line_id);
      if (!s) continue;
      rev.set(s, (rev.get(s) || 0) + num(r.curator_revenue));
      if (!ids.has(s)) ids.set(s, new Set());
      ids.get(s).add(r.line_id);
    }
    const rows = [...rev.entries()]
      .map(([status, revenue]) => ({ status, revenue, count: ids.get(status)?.size || 0 }))
      .filter((r) => r.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);
    const total = rows.reduce((s, r) => s + r.revenue, 0);
    return { rows, total };
  }, [tsFiltered, filteredLines]);

  // Realizado vs. contratado (acumulado): por cliente OU por campanha, compara
  // o que já foi gerado (lifetime) contra o PI total contratado. PI é valor de
  // contrato — não tem janela —, então este card é SEMPRE acumulado e ignora o
  // filtro de período (os filtros de dimensão continuam valendo). Régua de
  // dedupe igual ao resto do PMP: lines do mesmo group_id compartilham o mesmo
  // PI (conta 1×) e usam group_curator_* já agregado; solos usam curator_*.
  const contractRows = useMemo(() => {
    const seenKey = new Set();      // (bucket, group-key) já contabilizado
    const buckets = new Map();      // nome → { pi, revenue, margin }
    for (const l of filteredLines) {
      const name = (cmpDim === "campaign"
        ? (l.campaign_name || l.line_name)
        : l.customer) || "—";
      const groupKey = l.group_id ? `g:${l.group_id}` : `l:${l.line_id}`;
      const dedupKey = `${name}|${groupKey}`;
      if (seenKey.has(dedupKey)) continue;  // membro do mesmo grupo já somado
      seenKey.add(dedupKey);

      const pi = num(l.pi_brl);
      if (pi <= 0) continue;                // sem PI não há "contratado" a comparar
      const revenue = l.group_id ? num(l.group_curator_revenue) : num(l.curator_revenue);
      const margin  = l.group_id ? num(l.group_curator_margin)  : num(l.curator_margin);

      let b = buckets.get(name);
      if (!b) { b = { name, pi: 0, revenue: 0, margin: 0 }; buckets.set(name, b); }
      b.pi += pi;
      b.revenue += revenue;
      b.margin += margin;
    }
    return [...buckets.values()].map((b) => ({
      ...b,
      pctRevenue: b.pi > 0 ? b.revenue / b.pi : null,
      pctMargin:  b.pi > 0 ? b.margin  / b.pi : null,
    }));
  }, [filteredLines, cmpDim]);

  // Tabela: por deal, métricas do período + status + % entregue acumulada.
  // Só deals que ENTREGARAM no período (revenue ou imps > 0) — alinhado aos
  // gráficos/big numbers, que também são por período. Lines sem entrega na
  // janela viram ruído de zeros e contradizem o "deals entregando".
  const tableRows = useMemo(() => {
    const per = new Map();
    for (const r of tsFiltered) {
      let e = per.get(r.line_id);
      if (!e) { e = { revenue: 0, margin: 0, imps: 0, clicks: 0 }; per.set(r.line_id, e); }
      e.revenue += num(r.curator_revenue);
      e.margin += num(r.curator_margin);
      e.imps += num(r.imps);
      e.clicks += num(r.clicks);
    }
    return filteredLines
      .map((l) => {
        const p = per.get(l.line_id) || { revenue: 0, margin: 0, imps: 0, clicks: 0 };
        return {
          line: l,
          revenue: p.revenue,
          margin: p.margin,
          imps: p.imps,
          marginPct: p.revenue > 0 ? p.margin / p.revenue : null,
          pctEntregue: pctEntrega(l),
        };
      })
      .filter((r) => r.revenue > 0 || r.imps > 0)
      .sort((a, b) => b.revenue - a.revenue);
  }, [tsFiltered, filteredLines]);

  const filtersActive = !!period || customers.length || campaigns.length || statuses.length || bidTypes.length;
  const clearFilters = () => {
    setPeriod(null); setPeriodPresetId("all");
    setCustomers([]); setCampaigns([]); setStatuses([]); setBidTypes([]);
  };

  // ── Estados de carregamento / vazio ────────────────────────────────────────
  if (tsStatus === "loading" || tsStatus === "idle") {
    return (
      <div className="rounded-2xl border border-border bg-canvas-elevated p-12 flex flex-col items-center justify-center gap-3">
        <span className="size-5 rounded-full border-2 border-current border-t-transparent animate-spin text-signature" aria-hidden />
        <p className="text-sm text-fg-muted">Carregando série de entregas…</p>
      </div>
    );
  }
  if (tsStatus === "error") {
    return (
      <div className="rounded-2xl border border-border bg-canvas-elevated p-12 text-center">
        <p className="text-sm text-fg-muted mb-3">Não foi possível carregar a série de entregas.</p>
        {onRetry && (
          <button onClick={onRetry} className="text-[13px] font-medium text-signature hover:underline underline-offset-2">
            Tentar de novo
          </button>
        )}
      </div>
    );
  }

  const hasData = tsFiltered.length > 0;

  return (
    <div className="space-y-6">
      {/* ── Barra de filtros ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <DateRangeFilterV2
          value={period}
          presetId={periodPresetId}
          campaignStart={dataBounds.lo}
          campaignEnd={dataBounds.hi}
          onChange={(r, pid) => { setPeriod(r); setPeriodPresetId(pid); }}
          triggerClassName="h-9 px-3 rounded-lg bg-canvas-deeper font-medium"
        />
        {customerOpts.length > 1 && (
          <MultiFilter label="Cliente" allLabel="Todos os clientes" options={customerOpts} selected={customers} onChange={setCustomers} accent={accent} />
        )}
        {campaignOpts.length > 1 && (
          <MultiFilter label="Campanha" allLabel="Todas as campanhas" options={campaignOpts} selected={campaigns} onChange={setCampaigns} accent={accent} />
        )}
        {statusOpts.length > 1 && (
          <MultiFilter label="Status" allLabel="Todos os status" options={statusOpts} selected={statuses} onChange={setStatuses} accent={accent} />
        )}
        {bidOpts.length > 1 && (
          <MultiFilter label="Bid" allLabel="Todos os tipos" options={bidOpts} selected={bidTypes} onChange={setBidTypes} accent={accent} />
        )}
        {filtersActive ? (
          <button type="button" onClick={clearFilters}
                  className="ml-0.5 text-[12px] text-fg-muted hover:text-fg underline-offset-2 hover:underline transition-colors">
            Limpar
          </button>
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          <Segmented
            value={granularity}
            onChange={setGranularity}
            options={[{ value: "day", label: "Diário" }, { value: "month", label: "Mensal" }]}
          />
          <span className="text-[12px] text-fg-subtle tabular-nums hidden sm:inline">
            {kpis.deals} {kpis.deals === 1 ? "deal" : "deals"}
          </span>
        </div>
      </div>

      {!hasData ? (
        <div className="rounded-2xl border border-border bg-canvas-elevated p-10 text-center">
          <p className="text-sm text-fg-muted">Nenhuma entrega para os filtros atuais.</p>
          <p className="text-[12px] text-fg-subtle mt-1.5">Ajuste o período ou os filtros de dimensão.</p>
        </div>
      ) : (
        <>
          {/* ── Big numbers ────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiTile label="Receita" value={formatBRLCompact(kpis.revenue)} title={formatBRL(kpis.revenue)}
                     accent delta={prev ? delta(kpis.revenue, prev.revenue) : null} deltaTitle={prev?.label} />
            <KpiTile label="Margem HYPR" value={formatBRLCompact(kpis.margin)} title={formatBRL(kpis.margin)}
                     sub={kpis.marginPct != null ? `${formatRatioPct(kpis.marginPct, 1)} margem` : null}
                     delta={prev ? delta(kpis.margin, prev.margin) : null} deltaTitle={prev?.label} />
            <KpiTile label="Impressões" value={formatIntCompact(kpis.imps)} title={`${formatInt(kpis.imps)} impressões`}
                     delta={prev ? delta(kpis.imps, prev.imps) : null} deltaTitle={prev?.label} />
            <KpiTile label="eCPM" value={kpis.ecpm != null ? formatBRL(kpis.ecpm) : "—"} sub="receita / mil imps" />
            <KpiTile label="Deals entregando" value={formatInt(kpis.deals)}
                     sub={`de ${filteredLines.length} no filtro`} />
            <KpiTile label="PI contratado" value={formatBRLCompact(contract.pi)} title={formatBRL(contract.pi)}
                     sub={contract.pctEntregue != null ? `${formatRatioPct(contract.pctEntregue, 0)} entregue (acum.)` : "sem PI vinculado"} />
          </div>

          {/* ── Evolução: receita × margem | volume × cliques ──────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCardV2 title={`Evolução de entrega · ${granularity === "month" ? "mensal" : "diária"}`}
                         downloadable filename="pmp-evolucao-financeira">
              <EvolutionChart data={series} accent={accent} mode="money" />
            </ChartCardV2>
            <ChartCardV2 title={`Volume entregue · ${granularity === "month" ? "mensal" : "diário"}`}
                         downloadable filename="pmp-volume">
              <EvolutionChart data={series} accent={accent} mode="volume" />
            </ChartCardV2>
          </div>

          {/* ── Mix por cliente + status ───────────────────────────────────── */}
          {/* items-start: cada card abraça seu conteúdo (donut não estica e fica
              com vazio interno quando há poucos status). */}
          <div className="grid grid-cols-1 lg:grid-cols-2 lg:items-start gap-4">
            <ChartCardV2
              title={`Realizado vs. contratado · ${cmpDim === "campaign" ? "campanha" : "cliente"}`}
              actions={
                <div className="flex items-center gap-2 flex-wrap justify-start sm:justify-end w-full sm:w-auto">
                  <Segmented
                    value={cmpMetric}
                    onChange={setCmpMetric}
                    options={[{ value: "revenue", label: "Receita" }, { value: "margin", label: "Margem" }]}
                  />
                  <Segmented
                    value={cmpDim}
                    onChange={setCmpDim}
                    options={[{ value: "customer", label: "Cliente" }, { value: "campaign", label: "Campanha" }]}
                  />
                </div>
              }
            >
              <ContractProgress rows={contractRows} metric={cmpMetric} accent={accent} />
            </ChartCardV2>
            <ChartCardV2 title="Receita por status · período">
              <StatusDonut data={byStatus} />
            </ChartCardV2>
          </div>

          {/* ── Tabela por deal ────────────────────────────────────────────── */}
          <DealsTable rows={tableRows} accent={accent} />

          <p className="text-[11px] text-fg-subtle">
            Métricas de entrega (receita, margem, impressões, eCPM) refletem o período selecionado.
            PI é o valor de contrato e a % entregue é acumulada (gerado ÷ PI), independente do período —
            por isso o card “Realizado vs. contratado” soma o gerado lifetime e ignora o filtro de período
            (os filtros de cliente, campanha, status e bid continuam valendo).
            {prev && <> Variações comparam com o período anterior de mesma duração.</>}
          </p>
        </>
      )}
    </div>
  );
}

// ── KPI tile com delta de tendência ──────────────────────────────────────────
function KpiTile({ label, value, sub, title, accent = false, delta = null, deltaTitle }) {
  return (
    <div
      className={cn("rounded-2xl p-4 min-w-0 border", !accent && "bg-canvas-elevated border-border")}
      style={accent ? {
        background: "color-mix(in srgb, var(--color-signature) 12%, var(--color-canvas-elevated))",
        borderColor: "color-mix(in srgb, var(--color-signature) 38%, transparent)",
      } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-muted leading-none">{label}</div>
        {delta != null && <Delta value={delta} title={deltaTitle} />}
      </div>
      <div
        className={cn("mt-2.5 text-[21px] sm:text-[24px] font-bold leading-none tabular-nums truncate", accent ? "text-signature" : "text-fg")}
        title={title}
      >
        {value}
      </div>
      {sub && <div className="mt-1.5 text-[11px] text-fg-subtle leading-none">{sub}</div>}
    </div>
  );
}

// Badge de variação % vs período anterior.
function Delta({ value, title }) {
  if (value == null || !isFinite(value)) return null;
  const pct = value * 100;
  const flat = Math.abs(pct) < 0.5;
  const up = pct > 0;
  const cls = flat ? "text-fg-subtle" : up ? "text-emerald-400" : "text-rose-400";
  const arrow = flat ? "→" : up ? "▲" : "▼";
  const txt = `${up && !flat ? "+" : ""}${pct.toFixed(flat ? 0 : 0)}%`;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums shrink-0", cls)}
          title={title ? `vs ${title}` : undefined}>
      <span aria-hidden>{arrow}</span>{flat ? "0%" : txt}
    </span>
  );
}

// ── Segmented control (Diário / Mensal) ──────────────────────────────────────
function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex gap-0.5 p-0.5 rounded-lg bg-canvas-deeper border border-border">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} type="button" onClick={() => onChange(o.value)}
                  className={cn(
                    "px-3 h-7 rounded-md text-[12px] font-medium transition-colors",
                    active ? "bg-canvas-elevated text-fg shadow-sm" : "text-fg-muted hover:text-fg",
                  )}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Tooltip estilizado ────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label, rows }) {
  const hypr = useThemeColors();
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: hypr.canvasElevated, border: `1px solid ${hypr.borderStrong}`,
      borderRadius: 8, padding: "8px 10px", fontSize: 12, color: hypr.fg, minWidth: 150,
    }}>
      <div style={{ color: hypr.fgMuted, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {rows(payload).map((r, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
          <span style={{ color: r.color || hypr.fgMuted }}>{r.name}</span>
          <span style={{ color: hypr.fg, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function MoneyAxisTick({ x, y, payload, fill }) {
  return (
    <text x={x} y={y} dy={3} dx={-2} textAnchor="end" fill={fill} fontSize={10}
          style={{ fontVariantNumeric: "tabular-nums" }}>
      {formatBRLCompact(payload.value)}
    </text>
  );
}

// ── Gráfico de evolução (barra + linha) ──────────────────────────────────────
// mode "money"  → barra Receita + linha Margem (eixo BRL único).
// mode "volume" → barra Impressões + linha Cliques (eixos separados).
function EvolutionChart({ data, accent, mode }) {
  const neutral = useChartNeutral();
  const hypr = useThemeColors();
  const isMobile = useIsMobile();
  if (!data.length) return <EmptyChart />;
  const barSize = Math.min(isMobile ? 18 : 34, Math.max(4, Math.floor((isMobile ? 320 : 600) / data.length)));
  const money = mode === "money";
  // Cliques só ganham eixo/linha quando existem no período — deals de display
  // PMP costumam ter 0 clique, e uma linha achatada em zero é peso morto.
  const hasClicks = !money && data.some((d) => num(d.clicks) > 0);

  return (
    <ResponsiveContainer width="100%" height={252}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={neutral.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: neutral.label, fontSize: 10 }} tickLine={false}
               axisLine={{ stroke: neutral.grid }} minTickGap={20} padding={{ left: 10, right: 10 }} />
        {money ? (
          <YAxis tick={<MoneyAxisTick fill={neutral.label} />} tickLine={false} axisLine={false} width={66} padding={{ top: 8 }} />
        ) : (
          <>
            <YAxis yAxisId="left" tick={{ fill: neutral.label, fontSize: 10 }} tickLine={false} axisLine={false}
                   width={44} tickFormatter={formatIntCompact} padding={{ top: 8 }} />
            {hasClicks && (
              <YAxis yAxisId="right" orientation="right" tick={{ fill: neutral.label, fontSize: 10 }} tickLine={false}
                     axisLine={false} width={40} tickFormatter={formatIntCompact} padding={{ top: 8 }} />
            )}
          </>
        )}
        <RTooltip cursor={{ fill: hypr.surfaceStrong }} content={(p) => (
          <ChartTooltip {...p} rows={(pl) => pl.map((x) => {
            if (money) return { name: x.dataKey === "revenue" ? "Receita" : "Margem", value: formatBRL(x.value), color: x.dataKey === "revenue" ? accent : hypr.fg };
            return { name: x.dataKey === "imps" ? "Impressões" : "Cliques", value: formatInt(x.value), color: x.dataKey === "imps" ? accent : hypr.fg };
          })} />
        )} />
        {money ? (
          <>
            <Bar dataKey="revenue" fill={accent} radius={[3, 3, 0, 0]} opacity={0.9} barSize={barSize} isAnimationActive={false} />
            <Line dataKey="margin" type="monotone" stroke={hypr.fg} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </>
        ) : (
          <>
            <Bar yAxisId="left" dataKey="imps" fill={accent} radius={[3, 3, 0, 0]} opacity={0.9} barSize={barSize} isAnimationActive={false} />
            {hasClicks && (
              <Line yAxisId="right" dataKey="clicks" type="monotone" stroke={hypr.fg} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            )}
          </>
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Realizado vs. contratado (barras de progresso, com scroll interno) ───────
// Compara o gerado lifetime (receita ou margem) contra o PI contratado, por
// cliente ou campanha. A barra representa o % atingido do PI; over-delivery
// (≥ 100%) é sinalizado em verde, com a barra cheia. Lista rola por dentro do
// card pra caber todos os itens sem esticar a tela.
function ContractProgress({ rows, metric, accent }) {
  const isRevenue = metric === "revenue";
  const sorted = useMemo(() => {
    const val = (r) => (isRevenue ? r.revenue : r.margin);
    return [...rows].sort((a, b) => val(b) - val(a));
  }, [rows, isRevenue]);

  if (!sorted.length) {
    return (
      <div className="h-[200px] flex flex-col items-center justify-center gap-1 text-center">
        <p className="text-[12px] text-fg-subtle">Nenhum item com PI contratado nos filtros atuais.</p>
        <p className="text-[11px] text-fg-subtle/70">A comparação precisa de um PI vinculado.</p>
      </div>
    );
  }

  // Consolidado do conjunto exibido (linha-resumo no topo).
  const totPi = sorted.reduce((s, r) => s + r.pi, 0);
  const totVal = sorted.reduce((s, r) => s + (isRevenue ? r.revenue : r.margin), 0);
  const totPct = totPi > 0 ? totVal / totPi : null;
  const metricLabel = isRevenue ? "Receita gerada" : "Margem gerada";
  // Marca a meta de 85% nas barras só no modo Margem (régua de % entrega).
  const showTarget = !isRevenue;

  return (
    <div className="pt-1">
      {/* Resumo consolidado — empilha em telas estreitas (flex-wrap). */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pb-2.5 mb-2.5 border-b border-border/70">
        <span className="text-[11px] uppercase tracking-wider text-fg-muted">
          {metricLabel} · {sorted.length} {sorted.length === 1 ? "item" : "itens"}
        </span>
        <span className="text-[12px] tabular-nums text-fg-muted">
          <span className="font-semibold text-fg">{formatBRLCompact(totVal)}</span>
          {" de "}{formatBRLCompact(totPi)}
          {totPct != null && <span className="text-fg-subtle"> · {formatRatioPct(totPct, 1)}</span>}
        </span>
      </div>

      {/* Legenda da meta — só no modo Margem, alinhada ao tracinho das barras. */}
      {showTarget && (
        <div className="flex items-center gap-1.5 -mt-1 mb-3 text-[11px] text-fg-subtle">
          <span className="inline-block w-px h-3 bg-fg/50 shrink-0" aria-hidden />
          Mínimo ideal · {formatRatioPct(MARGIN_TARGET, 0)} da margem contratada
        </div>
      )}

      <div className="max-h-[420px] overflow-y-auto scrollbar-thin pr-1 -mr-1 space-y-3.5">
        {sorted.map((r) => {
          const value = isRevenue ? r.revenue : r.margin;
          const pct = isRevenue ? r.pctRevenue : r.pctMargin;
          const ratio = pct ?? 0;
          const over = ratio >= 1;
          const width = Math.max(2, Math.min(100, ratio * 100));
          return (
            <div key={r.name}>
              {/* Linha 1: nome + % (só o % à direita pra nunca espremer o nome
                  no mobile). O detalhe em R$ vai pra linha própria abaixo. */}
              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <span className="text-[13px] font-medium text-fg truncate min-w-0" title={r.name}>{r.name}</span>
                <span className={cn("text-[13px] font-semibold tabular-nums shrink-0", over ? "text-emerald-400" : "text-fg")}>
                  {over && <span aria-hidden>▲ </span>}{formatRatioPct(ratio, 1)}
                </span>
              </div>
              <div className="relative">
                <div className="h-2 rounded-full bg-track overflow-hidden">
                  <div className="h-full rounded-full transition-[width] duration-500"
                       style={{ width: `${width}%`, background: over ? "var(--color-emerald-500, #10b981)" : accent }} />
                </div>
                {/* Tracinho da meta de 85% (margem). Fica por cima da barra,
                    fora do overflow-hidden pra cruzar o trilho inteiro. */}
                {showTarget && (
                  <span className="absolute top-1/2 -translate-y-1/2 w-px h-3.5 bg-fg/50 rounded-full pointer-events-none"
                        style={{ left: `${MARGIN_TARGET * 100}%` }}
                        aria-hidden title="Mínimo ideal: 85%" />
                )}
              </div>
              <div className="mt-1 text-[11.5px] tabular-nums text-fg-subtle"
                   title={`${formatBRL(value)} de ${formatBRL(r.pi)}`}>
                <span className="text-fg-muted font-medium">{formatBRLCompact(value)}</span>
                {" de "}{formatBRLCompact(r.pi)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Receita por status (donut) ────────────────────────────────────────────────
function StatusDonut({ data }) {
  if (!data.rows.length) return <EmptyChart />;
  const colorOf = (s) => STATUS_COLOR[s] || "#94a3b8";
  return (
    <div className="flex flex-col sm:flex-row items-center gap-6 sm:gap-8 py-1">
      <div className="relative shrink-0" style={{ width: 188, height: 188 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data.rows} dataKey="revenue" nameKey="status" cx="50%" cy="50%"
                 innerRadius={62} outerRadius={92} paddingAngle={2} stroke="none" isAnimationActive={false}>
              {data.rows.map((r) => <Cell key={r.status} fill={colorOf(r.status)} />)}
            </Pie>
            <RTooltip content={(p) => (
              <ChartTooltip {...p} rows={(pl) => pl.map((x) => {
                const pctv = data.total > 0 ? (x.value / data.total) * 100 : 0;
                return { name: x.name, value: `${formatBRLCompact(x.value)} · ${pctv.toFixed(0)}%`, color: colorOf(x.name) };
              })} />
            )} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Receita</span>
          <span className="text-[17px] font-bold text-fg tabular-nums">{formatBRLCompact(data.total)}</span>
          <span className="text-[10px] text-fg-subtle mt-0.5">{data.rows.length} {data.rows.length === 1 ? "status" : "status"}</span>
        </div>
      </div>
      <div className="flex-1 w-full self-center divide-y divide-border/70">
        {data.rows.map((r) => {
          const pct = data.total > 0 ? (r.revenue / data.total) * 100 : 0;
          return (
            <div key={r.status} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="size-2.5 rounded-sm shrink-0" style={{ background: colorOf(r.status) }} aria-hidden />
              <span className="text-[13px] text-fg flex-1 min-w-0 truncate">
                {r.status}
                <span className="text-fg-subtle"> · {r.count} {r.count === 1 ? "deal" : "deals"}</span>
              </span>
              <span className="text-[13px] text-fg-muted tabular-nums w-10 text-right">{pct.toFixed(0)}%</span>
              <span className="text-[13px] font-semibold text-fg tabular-nums w-[92px] text-right">{formatBRLCompact(r.revenue)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Tabela por deal (ordenável) ───────────────────────────────────────────────
const DEAL_COLS = [
  { key: "customer", label: "Cliente", align: "left" },
  { key: "campaign", label: "Campanha", align: "left", sortable: false },
  { key: "status", label: "Status", align: "left", sortable: false },
  { key: "revenue", label: "Receita", align: "right" },
  { key: "margin", label: "Margem", align: "right" },
  { key: "marginPct", label: "Margem %", align: "right" },
  { key: "pctEntregue", label: "% entregue", align: "right" },
];

function DealsTable({ rows, accent }) {
  const [sortKey, setSortKey] = useState("revenue");
  const [sortDir, setSortDir] = useState("desc");
  const [expanded, setExpanded] = useState(false);

  const sorted = useMemo(() => {
    const val = (r) => {
      if (sortKey === "customer") return (r.line.customer || "").toLowerCase();
      if (sortKey === "marginPct") return r.marginPct ?? -1;
      if (sortKey === "pctEntregue") return r.pctEntregue ?? -1;
      return num(r[sortKey]);
    };
    const arr = [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === "string") return va.localeCompare(vb, "pt-BR");
      return va - vb;
    });
    return sortDir === "desc" ? arr.reverse() : arr;
  }, [rows, sortKey, sortDir]);

  const onSort = (key) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "customer" ? "asc" : "desc"); }
  };

  const visible = expanded ? sorted : sorted.slice(0, 12);

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-4 md:px-5 py-3.5 border-b border-border flex items-center justify-between gap-3">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-signature">Desempenho por deal · período</h3>
        <span className="text-[11px] text-fg-subtle tabular-nums">{rows.length} {rows.length === 1 ? "deal" : "deals"} com entrega</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-surface-3 text-fg-muted">
              {DEAL_COLS.map((c) => (
                <Th key={c.key} className={c.align === "right" ? "text-right" : "text-left"}
                    sortable={c.sortable !== false} active={sortKey === c.key} dir={sortDir}
                    onClick={c.sortable === false ? undefined : () => onSort(c.key)}>
                  {c.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const st = effectiveStatus(r.line);
              return (
                <tr key={r.line.line_id} className="border-t border-border hover:bg-surface-strong transition-colors">
                  <Td className="text-left"><span className="font-medium text-fg line-clamp-1">{r.line.customer || "—"}</span></Td>
                  <Td className="text-left text-fg-muted"><span className="line-clamp-1 max-w-[280px]">{r.line.campaign_name || r.line.line_name || "—"}</span></Td>
                  <Td className="text-left">
                    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border whitespace-nowrap", statusPillClass(st))}>{st}</span>
                  </Td>
                  <Td className="text-right font-semibold text-fg tabular-nums">{formatBRLCompact(r.revenue)}</Td>
                  <Td className="text-right text-fg tabular-nums">{formatBRLCompact(r.margin)}</Td>
                  <Td className="text-right tabular-nums" style={{ color: accent }}>{r.marginPct != null ? formatRatioPct(r.marginPct, 0) : "—"}</Td>
                  <Td className="text-right text-fg tabular-nums">{r.pctEntregue != null ? formatRatioPct(r.pctEntregue, 0) : "—"}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 12 && (
        <div className="px-4 md:px-5 py-2.5 border-t border-border text-right">
          <button type="button" onClick={() => setExpanded((v) => !v)}
                  className="text-[12px] font-medium text-fg-muted hover:text-fg underline-offset-2 hover:underline transition-colors">
            {expanded ? "Ver menos" : `Ver todos (${rows.length})`}
          </button>
        </div>
      )}
    </div>
  );
}

function Th({ children, className, sortable, active, dir, onClick }) {
  return (
    <th onClick={onClick}
        className={cn("px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider whitespace-nowrap select-none",
                      sortable && "cursor-pointer hover:text-fg", className)}>
      <span className="inline-flex items-center gap-1">
        {children}
        {sortable && active && <span className="text-signature" aria-hidden>{dir === "asc" ? "▲" : "▼"}</span>}
      </span>
    </th>
  );
}

function Td({ children, className, style }) {
  return <td className={cn("px-3 py-2.5", className)} style={style}>{children}</td>;
}

function EmptyChart() {
  return (
    <div className="h-[200px] flex items-center justify-center">
      <p className="text-[12px] text-fg-subtle">Sem dados para os filtros atuais.</p>
    </div>
  );
}

// ── Multi-select (popover com busca) ──────────────────────────────────────────
function MultiFilter({ label, allLabel, options, selected, onChange, accent }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const opts = useMemo(
    () => options.map((o) => (typeof o === "string" ? { value: o, label: o } : o)),
    [options],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? opts.filter((o) => o.label.toLowerCase().includes(q)) : opts;
  }, [opts, query]);

  const isAll = selected.length === 0;
  const summary = isAll
    ? allLabel
    : selected.length === 1
      ? (opts.find((o) => o.value === selected[0])?.label || selected[0])
      : `${selected.length} selecionados`;

  const toggle = (v) => {
    if (selected.includes(v)) onChange(selected.filter((x) => x !== v));
    else onChange([...selected, v]);
  };

  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
      <Popover.Trigger asChild>
        <button type="button"
                className={cn(
                  "inline-flex items-center justify-between gap-2 h-9 pl-3 pr-2.5 min-w-[150px]",
                  "rounded-lg bg-canvas-deeper border text-sm cursor-pointer transition-colors",
                  "hover:bg-surface-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                  isAll ? "border-border text-fg" : "border-signature/50 text-fg",
                )}>
          <span className={cn("truncate", !isAll && "font-medium")}>{summary}</span>
          {!isAll && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums shrink-0"
                  style={{ background: "color-mix(in srgb, var(--color-signature) 20%, transparent)", color: accent }}>
              {selected.length}
            </span>
          )}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
               strokeLinecap="round" strokeLinejoin="round" className="text-fg-subtle shrink-0"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} align="start" collisionPadding={16}
                         className={cn("z-50 w-[280px] max-w-[calc(100vw-32px)] rounded-lg border border-border bg-canvas-elevated shadow-lg overflow-hidden",
                                       "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out focus-visible:outline-none")}>
          <div className="px-3 pt-3 pb-2 border-b border-border">
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Buscar ${label.toLowerCase()}…`} autoFocus
                   className="w-full h-8 px-2.5 rounded-md bg-surface border border-border text-xs text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature" />
          </div>
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border text-[11px]">
            <button type="button" onClick={() => onChange(opts.map((o) => o.value))} disabled={selected.length === opts.length}
                    className="text-fg-muted hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed">Selecionar tudo</button>
            <button type="button" onClick={() => onChange([])} disabled={isAll}
                    className="text-fg-muted hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed">Limpar</button>
          </div>
          <div className="max-h-[260px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12px] text-fg-subtle">Nada encontrado</div>
            ) : filtered.map((o) => {
              const on = selected.includes(o.value);
              return (
                <button key={o.value} type="button" onClick={() => toggle(o.value)}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-surface-strong transition-colors">
                  <span className={cn("size-4 rounded border flex items-center justify-center shrink-0", on ? "border-signature" : "border-border")}
                        style={on ? { background: accent } : undefined}>
                    {on && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--color-canvas)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>}
                  </span>
                  <span className="truncate text-fg">{o.label}</span>
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
