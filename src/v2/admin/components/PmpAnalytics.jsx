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

import { Fragment, useMemo, useState } from "react";
import { fmt } from "../../../shared/format";
import * as Popover from "@radix-ui/react-popover";
import {
  ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";

import { Tooltip, TooltipTrigger, TooltipContent } from "../../../ui/Tooltip";
import { CountBadge } from "../../../ui/CountBadge";
import { useThemeColors, useChartNeutral } from "../../hooks/useThemeColors";
import { useIsMobile } from "../../hooks/useIsMobile";
import { ChartCardV2 } from "../../components/ChartCardV2";
import { DateRangeFilterV2 } from "../../components/DateRangeFilterV2";
import { ymd, parseYmd, buildPresets } from "../../../shared/dateFilter";
import { cn } from "../../../ui/cn";
import { formatMonthLabel } from "../lib/format";
import {
  formatBRL, formatBRLCompact, formatInt, formatIntCompact, formatRatioPct,
  effectiveStatus, statusPillClass, bidTypeLabel, pctEntrega, resolveGroupPi,
  buildDeliveryKeyResolver, lineKey, METRIC,
} from "../lib/pmpFormat";
import { buildMonthlyLedger } from "../lib/pmpCampaign";

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

  // Casamento série × line pelo par (fonte, line_id) — um line_id do Xandr
  // pode colidir com um dealMetaId da PubMatic. `rowKey` resolve a chave da
  // row (e devolve null quando a row é ambígua num backend antigo, sem fonte).
  const lineIds = useMemo(() => new Set(filteredLines.map(lineKey)), [filteredLines]);
  const rowKey = useMemo(() => buildDeliveryKeyResolver(lines), [lines]);

  // Janela de datas (ymd) do filtro de período.
  const fromYmd = period?.from ? ymd(period.from) : null;
  const toYmd = period?.to ? ymd(period.to) : null;

  // Rows da série dentro do conjunto de lines + janela de período.
  // `_k` (chave resolvida) viaja junto pra não recalcular em cada agregação.
  const tsFiltered = useMemo(() => {
    const out = [];
    for (const r of timeseries) {
      const k = rowKey(r);
      if (!k || !lineIds.has(k)) continue;
      if (fromYmd && r.day < fromYmd) continue;
      if (toYmd && r.day > toYmd) continue;
      out.push(r._k === k ? r : { ...r, _k: k });
    }
    return out;
  }, [timeseries, lineIds, rowKey, fromYmd, toYmd]);

  // Mesma filtragem por dimensão, SEM janela de período — base da tabela
  // mensal (que é lifetime por design, ver MonthlyLedger).
  const tsAllPeriods = useMemo(() => {
    const out = [];
    for (const r of timeseries) {
      const k = rowKey(r);
      if (!k || !lineIds.has(k)) continue;
      out.push(r._k === k ? r : { ...r, _k: k });
    }
    return out;
  }, [timeseries, lineIds, rowKey]);

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
      ids.add(r._k);
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
    // Canceladas fora do contratado — mesma régua dos KPIs da página, que já
    // as ignoravam. Sem isso, o "PI contratado" do Analytics ficava maior que
    // o "Total PI" das outras abas com os mesmos filtros.
    for (const l of filteredLines) {
      if (effectiveStatus(l) === "Cancelado") continue;
      const key = l.group_id ? `g:${l.group_id}` : `l:${lineKey(l)}`;
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
    for (const r of tsAllPeriods) {
      if (r.day < pf || r.day > pt) continue;
      revenue += num(r.curator_revenue);
      margin += num(r.curator_margin);
      imps += num(r.imps);
    }
    return { revenue, margin, imps, label: `${dayLong(pf)} – ${dayLong(pt)}` };
  }, [tsAllPeriods, period, fromYmd, toYmd]);

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
    const lineToStatus = new Map(filteredLines.map((l) => [lineKey(l), effectiveStatus(l)]));
    const rev = new Map(), ids = new Map();
    for (const r of tsFiltered) {
      const s = lineToStatus.get(r._k);
      if (!s) continue;
      rev.set(s, (rev.get(s) || 0) + num(r.curator_revenue));
      if (!ids.has(s)) ids.set(s, new Set());
      ids.get(s).add(r._k);
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
    // 1ª passada: junta membros por unidade-de-conta (grupo ou line solta)
    // dentro de cada bucket. O PI do grupo pode morar em QUALQUER membro
    // (só quem tem Command vinculado tem pi_brl), então não dá pra decidir
    // "tem PI?" olhando só o primeiro membro encontrado.
    const units = new Map();  // dedupKey → { name, members: [] }
    for (const l of filteredLines) {
      if (effectiveStatus(l) === "Cancelado") continue;
      const name = (cmpDim === "campaign"
        ? (l.campaign_name || l.line_name)
        : l.customer) || "—";
      const groupKey = l.group_id ? `g:${l.group_id}` : `l:${lineKey(l)}`;
      const dedupKey = `${name}|${groupKey}`;
      let u = units.get(dedupKey);
      if (!u) { u = { name, members: [] }; units.set(dedupKey, u); }
      u.members.push(l);
    }
    // 2ª passada: 1 contribuição por unidade — PI do primeiro membro com PI,
    // gerado do group_curator_* (grupo, já agregado) ou curator_* (solo).
    const buckets = new Map();      // nome → { pi, revenue, margin }
    for (const { name, members } of units.values()) {
      const first = members[0];
      const pi = num(first.group_id ? resolveGroupPi(members) : first.pi_brl);
      if (pi <= 0) continue;                // sem PI não há "contratado" a comparar
      const revenue = first.group_id ? num(first.group_curator_revenue) : num(first.curator_revenue);
      const margin  = first.group_id ? num(first.group_curator_margin)  : num(first.curator_margin);

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
      let e = per.get(r._k);
      if (!e) { e = { revenue: 0, margin: 0, imps: 0, clicks: 0 }; per.set(r._k, e); }
      e.revenue += num(r.curator_revenue);
      e.margin += num(r.curator_margin);
      e.imps += num(r.imps);
      e.clicks += num(r.clicks);
    }
    return filteredLines
      .map((l) => {
        const p = per.get(lineKey(l)) || { revenue: 0, margin: 0, imps: 0, clicks: 0 };
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

  // ── Fechamento mensal ──────────────────────────────────────────────────────
  // Entrada de PI × consumo de receita/margem, mês a mês. É LIFETIME de
  // propósito (ignora o filtro de período, respeita os de dimensão): serve pra
  // controle financeiro — "quanto entrou de contrato em julho × quanto foi
  // consumido em julho" —, e um PI de julho costuma ser consumido também em
  // agosto. Filtrar por período esconderia exatamente a defasagem que a tabela
  // existe pra mostrar.
  const ledger = useMemo(
    () => buildMonthlyLedger({ lines: filteredLines, tsRows: tsAllPeriods }),
    [filteredLines, tsAllPeriods],
  );

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
        <>
          <div className="rounded-2xl border border-border bg-canvas-elevated p-10 text-center">
            <p className="text-sm text-fg-muted">Nenhuma entrega no período selecionado.</p>
            <p className="text-[12px] text-fg-subtle mt-1.5">Ajuste o período ou os filtros de dimensão.</p>
          </div>
          {/* O fechamento mensal é acumulado — continua valendo mesmo quando a
              janela escolhida não teve entrega, e é justamente aí que ele
              responde "então em que mês isso rodou?". */}
          <MonthlyLedger ledger={ledger} accent={accent} />
        </>
      ) : (
        <>
          {/* ── Big numbers ────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiTile label={METRIC.revenue.label} value={formatBRLCompact(kpis.revenue)} title={formatBRL(kpis.revenue)}
                     accent delta={prev ? delta(kpis.revenue, prev.revenue) : null} deltaTitle={prev?.label} />
            <KpiTile label="Margem HYPR" value={formatBRLCompact(kpis.margin)} title={formatBRL(kpis.margin)}
                     sub={kpis.marginPct != null ? `${formatRatioPct(kpis.marginPct, 1)} margem` : null}
                     delta={prev ? delta(kpis.margin, prev.margin) : null} deltaTitle={prev?.label} />
            <KpiTile label={METRIC.imps.label} value={formatIntCompact(kpis.imps)} title={`${formatInt(kpis.imps)} impressões`}
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

          {/* ── Fechamento mensal (entrada de PI × consumo) ────────────────── */}
          <MonthlyLedger ledger={ledger} accent={accent} />

          {/* ── Mix por cliente + status ───────────────────────────────────── */}
          {/* items-start: cada card abraça seu conteúdo (donut não estica e fica
              com vazio interno quando há poucos status). */}
          <div className="grid grid-cols-1 lg:grid-cols-2 lg:items-start gap-4">
            <ChartCardV2
              title={
                <span className="inline-flex items-center gap-2 flex-wrap">
                  {`Realizado vs. contratado · ${cmpDim === "campaign" ? "campanha" : "cliente"}`}
                  {/* Selo de clareza: este card é SEMPRE lifetime (gerado ÷ PI
                      contratado). PI é valor de contrato, não tem janela — então
                      ele não reage ao filtro de período (só aos de dimensão).
                      Sem o selo, parecia "travado" enquanto se mexe no período. */}
                  <span
                    className="normal-case tracking-normal font-medium text-[10px] leading-none px-1.5 py-1 rounded-md bg-surface-strong text-fg-subtle border border-border whitespace-nowrap"
                    title="Comparação acumulada (gerado lifetime ÷ PI contratado). PI é valor de contrato, por isso este card não filtra por período — só por cliente, campanha, status e bid."
                  >
                    acumulado · ignora período
                  </span>
                </span>
              }
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
            Métricas de entrega (Receita Bruta, Margem HYPR, impressões, eCPM) refletem o período selecionado.
            PI é o valor de contrato e a % de entrega é acumulada (gerado ÷ PI), independente do período —
            por isso “Fechamento mensal” e “Realizado vs. contratado” somam o gerado lifetime e ignoram o
            filtro de período (os filtros de cliente, campanha, status e bid continuam valendo).
            No fechamento mensal, entrada de PI e consumo são coortes distintas: o contrato de um mês
            costuma ser entregue ao longo dos meses seguintes.
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
  const txt = `${up ? "+" : ""}${fmt(pct, 0)}%`;
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

// ── Fechamento mensal: entrada de PI × consumo ───────────────────────────────
//
// A tabela de controle financeiro do time. Duas coortes DIFERENTES lado a lado,
// de propósito:
//
//   ENTRADA — o PI que entrou na carteira naquele mês (contrato fechado).
//   CONSUMO — receita/margem efetivamente entregues DENTRO daquele mês, venham
//             de contratos de qualquer mês.
//
// Elas não batem e não devem bater: um PI fechado em julho costuma ser
// consumido em julho E agosto. É essa defasagem que a tabela existe pra
// mostrar — por isso a última coluna se chama "consumo ÷ entrada" (termômetro
// de ritmo do mês) e nunca "% de entrega do PI", que é outra conta.
function MonthlyLedger({ ledger, accent }) {
  const [copied, setCopied] = useState(false);
  // Meses abertos na quebra por DSP. Fechado por padrão: o agregado é a
  // leitura principal, a fonte é o detalhe.
  const [expanded, setExpanded] = useState(() => new Set());
  const { rows, totals } = ledger;
  const multiSource = (totals.bySource || []).length > 1;

  const toggle = (month) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(month)) next.delete(month); else next.add(month);
    return next;
  });

  const copyTsv = async () => {
    const head = ["Mês", "PI entrado", "PIs", "Receita no mês (safra)", "Margem no mês (safra)",
                  "Em aberto", "% em aberto", "Receita Bruta (caixa)", "Margem HYPR (caixa)"];
    const body = [];
    for (const r of rows) {
      body.push([formatMonthLabel(r.month, "short"), r.pi.toFixed(2), r.piCount,
                 r.cohortRevenue.toFixed(2), r.cohortMargin.toFixed(2),
                 r.open.toFixed(2), r.openPct != null ? (r.openPct * 100).toFixed(1) : "",
                 r.revenue.toFixed(2), r.margin.toFixed(2)]);
      // Quebra por DSP vai junto no clipboard — quem cola no Sheets quer o
      // detalhe tanto quanto quem expande na tela.
      if (multiSource) {
        for (const s of r.bySource) {
          body.push([`  ${SOURCE_LABEL[s.source] || s.source}`, "", "",
                     s.cohortRevenue.toFixed(2), s.cohortMargin.toFixed(2), "", "",
                     s.revenue.toFixed(2), s.margin.toFixed(2)]);
        }
      }
    }
    const tsv = [head, ...body].map((l) => l.join("\t")).join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard bloqueado — silencioso, o usuário ainda tem o Exportar */ }
  };

  // Cabeçalho de 2 níveis: a coluna só faz sentido se estiver claro de QUAL
  // coorte ela fala. `top` do 2º nível = altura do 1º (h-6 = 24px).
  // Cabeçalho fixo precisa ser OPACO: com tinta translúcida (bg-signature/7%)
  // o conteúdo rolado vazava por baixo dele. A separação entre as duas coortes
  // fica por conta do rótulo colorido + uma borda vertical que desce a tabela
  // inteira (DIV), que é mais legível que fundo tingido de qualquer forma.
  const G1 = "bg-surface-3";          // safra do mês
  const G2 = "bg-surface-3";          // caixa do mês
  const DIV = "border-l border-border";   // divisor safra | caixa

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-4 md:px-5 py-3.5 border-b border-border flex items-start md:items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-signature flex items-center gap-2 flex-wrap">
            Fechamento mensal
            <span className="normal-case tracking-normal font-medium text-[10px] leading-none px-1.5 py-1 rounded-md bg-surface-strong text-fg-subtle border border-border whitespace-nowrap"
                  title="Entrada e consumo são acumulados por mês e não reagem ao filtro de período (os filtros de cliente, campanha, status e bid continuam valendo).">
              acumulado · ignora período
            </span>
          </h3>
          <p className="text-[11px] text-fg-subtle mt-1">
            <span className="text-fg-muted">Safra</span> = o PI que entrou no mês, e o que ele mesmo consumiu
            <span className="mx-1.5">·</span>
            <span className="text-fg-muted">Caixa</span> = tudo que foi entregue no mês, de qualquer safra
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {multiSource && (
            <div className="flex items-center gap-2 pr-2 mr-1 border-r border-border">
              {totals.bySource.map((s) => (
                <span key={s.source} className="inline-flex items-center gap-1.5 text-[11px] text-fg-muted"
                      title={`${SOURCE_LABEL[s.source] || s.source}: ${formatBRL(s.revenue)} de Receita Bruta no acumulado`}>
                  <span className="w-2 h-2 rounded-sm" style={{ background: SOURCE_COLOR[s.source] || accent }} />
                  {SOURCE_LABEL[s.source] || s.source}
                  <span className="tabular-nums text-fg">{formatBRLCompact(s.revenue)}</span>
                </span>
              ))}
            </div>
          )}
          <button type="button" onClick={copyTsv}
                  className="h-7 px-2.5 rounded-md border border-border bg-canvas-deeper text-[12px] font-medium text-fg-muted hover:text-fg hover:bg-surface-strong transition-colors">
            {copied ? "Copiado ✓" : "Copiar"}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-5 py-10 text-center text-[12px] text-fg-subtle">
          Sem PI nem entrega para os filtros atuais.
        </div>
      ) : (
        <div className="max-h-[440px] overflow-auto scrollbar-thin">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-fg-subtle">
                <th className="sticky top-0 z-20 bg-surface-3 h-6" />
                <th colSpan={5} className={cn("sticky top-0 z-20 h-6 px-3 text-left text-[9.5px] font-bold uppercase tracking-widest text-signature", G1)}>
                  Safra do mês · o PI que entrou
                </th>
                <th colSpan={2} className={cn("sticky top-0 z-20 h-6 px-3 text-left text-[9.5px] font-bold uppercase tracking-widest text-fg-muted", G2, DIV)}>
                  Caixa do mês · todas as safras
                </th>
              </tr>
              <tr className="text-fg-muted">
                <Th className="text-left sticky top-6 z-20 bg-surface-3">Mês</Th>
                <Th className={cn("text-right sticky top-6 z-20", G1)}>PI entrado</Th>
                <Th className={cn("text-right sticky top-6 z-20", G1)}>Consumido no mês</Th>
                <Th className={cn("text-right sticky top-6 z-20", G1)}>Margem no mês</Th>
                <Th className={cn("text-right sticky top-6 z-20", G1)}>Em aberto</Th>
                <Th className={cn("text-left w-[132px] sticky top-6 z-20", G1)}>Ciclo do PI</Th>
                <Th className={cn("text-right sticky top-6 z-20", G2, DIV)}>{METRIC.revenue.label}</Th>
                <Th className={cn("text-right sticky top-6 z-20", G2)}>{METRIC.margin.label}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const open = expanded.has(r.month);
                const canExpand = multiSource && r.bySource.length > 0;
                return (
                  <Fragment key={r.month}>
                    <tr className={cn("border-t border-border transition-colors",
                                      open ? "bg-surface-strong" : "hover:bg-surface-strong")}>
                      <Td className="text-left whitespace-nowrap">
                        <button type="button"
                                onClick={canExpand ? () => toggle(r.month) : undefined}
                                disabled={!canExpand}
                                aria-expanded={canExpand ? open : undefined}
                                className={cn("inline-flex items-center gap-1.5 text-left rounded-sm",
                                              canExpand && "cursor-pointer hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature")}>
                          {canExpand
                            ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                                   strokeLinecap="round" strokeLinejoin="round"
                                   className={cn("text-fg-subtle transition-transform shrink-0", open && "rotate-90")} aria-hidden>
                                <path d="m9 18 6-6-6-6" />
                              </svg>
                            : <span className="w-[10px] shrink-0" aria-hidden />}
                          <span>
                            <span className="font-medium text-fg">{formatMonthLabel(r.month, "short")}</span>
                            {r.campaigns > 0 && (
                              <span className="text-fg-subtle text-[11px]"> · {r.campaigns} {r.campaigns === 1 ? "campanha" : "campanhas"}</span>
                            )}
                          </span>
                        </button>
                        {canExpand && r.revenue > 0 && (
                          <SourceMixBar bySource={r.bySource} total={r.revenue} accent={accent} />
                        )}
                      </Td>
                      <Td className="text-right font-semibold text-fg tabular-nums">
                        {r.pi > 0
                          ? <EntriesHover row={r} mode="pi">{formatBRLCompact(r.pi)}</EntriesHover>
                          : <span className="text-fg-subtle">—</span>}
                        {r.piCount > 0 && (
                          <div className="text-[10.5px] text-fg-subtle font-normal">
                            {r.piCount} {r.piCount === 1 ? "PI" : "PIs"}
                          </div>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {r.pi > 0 ? (
                          <>
                            <div className="text-fg" title={formatBRL(r.cohortRevenue)}>
                              <EntriesHover row={r} mode="inMonth">{formatBRLCompact(r.cohortRevenue)}</EntriesHover>
                            </div>
                            <div className="text-[10.5px] text-fg-subtle">{formatRatioPct(r.cohortPct, 0)} do PI</div>
                          </>
                        ) : <span className="text-fg-subtle">—</span>}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {r.pi > 0
                          ? <span className="text-emerald-600 dark:text-emerald-400" title={formatBRL(r.cohortMargin)}>
                              <EntriesHover row={r} mode="marginInMonth">{formatBRLCompact(r.cohortMargin)}</EntriesHover>
                            </span>
                          : <span className="text-fg-subtle">—</span>}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {r.pi > 0 ? (
                          <>
                            <div className={cn("font-semibold", r.open > 0 ? "text-amber-600 dark:text-amber-300" : "text-fg-subtle")}
                                 title={`PI − Receita Bruta já entregue por essa safra = ${formatBRL(r.open)}`}>
                              {r.open > 0
                                ? <EntriesHover row={r} mode="open">{formatBRLCompact(r.open)}</EntriesHover>
                                : "quitado"}
                            </div>
                            {r.open > 0 && (
                              <div className="text-[10.5px] text-fg-subtle">{formatRatioPct(r.openPct, 0)} do PI</div>
                            )}
                          </>
                        ) : <span className="text-fg-subtle">—</span>}
                      </Td>
                      <Td className="text-left">
                        {r.pi > 0
                          ? <CycleBar row={r} accent={accent} />
                          : <span className="text-fg-subtle text-[11px]">—</span>}
                      </Td>
                      <Td className={cn("text-right text-fg tabular-nums", DIV)} title={formatBRL(r.revenue)}>
                        {r.revenue > 0 ? formatBRLCompact(r.revenue) : <span className="text-fg-subtle">—</span>}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {r.margin > 0 ? (
                          <>
                            <div className="font-semibold text-emerald-600 dark:text-emerald-400" title={formatBRL(r.margin)}>{formatBRLCompact(r.margin)}</div>
                            {r.marginPct != null && <div className="text-[10.5px] text-fg-subtle font-normal">{formatRatioPct(r.marginPct, 0)} margem</div>}
                          </>
                        ) : <span className="text-fg-subtle">—</span>}
                      </Td>
                    </tr>

                    {open && r.bySource.map((s) => (
                      <tr key={`${r.month}:${s.source}`} className="border-t border-border/40 bg-canvas-deeper/40">
                        <Td className="text-left whitespace-nowrap pl-8">
                          <span className="inline-flex items-center gap-1.5 text-[12px] text-fg-muted">
                            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: SOURCE_COLOR[s.source] || accent }} />
                            {SOURCE_LABEL[s.source] || s.source}
                          </span>
                        </Td>
                        {/* PI não se divide por DSP: ele é do flight, e um flight
                            pode misturar fontes sob o mesmo contrato. */}
                        <Td className="text-right text-fg-subtle" title="PI é do contrato (flight), que pode cobrir mais de um DSP — por isso não se divide por fonte.">
                          <span className="text-[11px]">não se divide</span>
                        </Td>
                        <Td className="text-right text-fg-muted tabular-nums" title={formatBRL(s.cohortRevenue)}>
                          {s.cohortRevenue > 0 ? formatBRLCompact(s.cohortRevenue) : <span className="text-fg-subtle">—</span>}
                        </Td>
                        <Td className="text-right text-fg-muted tabular-nums" title={formatBRL(s.cohortMargin)}>
                          {s.cohortMargin > 0 ? formatBRLCompact(s.cohortMargin) : <span className="text-fg-subtle">—</span>}
                        </Td>
                        <Td />
                        <Td />
                        <Td className={cn("text-right text-fg-muted tabular-nums", DIV)} title={formatBRL(s.revenue)}>
                          {s.revenue > 0 ? formatBRLCompact(s.revenue) : <span className="text-fg-subtle">—</span>}
                        </Td>
                        <Td className="text-right text-fg-muted tabular-nums" title={formatBRL(s.margin)}>
                          {s.margin > 0 ? formatBRLCompact(s.margin) : <span className="text-fg-subtle">—</span>}
                        </Td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
            {/* Total grudado no rodapé: rolando 20+ meses, é a linha que dá
                escala pro que está na tela. `sticky` vai nas células (não no
                <tr>), que é onde o browser respeita. */}
            <tfoot>
              <tr className="font-semibold">
                <Td className={cn(FOOT, "text-left text-fg-muted text-[11px] uppercase tracking-wider")}>Total · {rows.length} {rows.length === 1 ? "mês" : "meses"}</Td>
                <Td className={cn(FOOT, "text-right text-fg tabular-nums")} title={formatBRL(totals.pi)}>
                  <EntriesHover row={totals} mode="pi" monthLabel="todo o período">{formatBRLCompact(totals.pi)}</EntriesHover>
                  <div className="text-[10.5px] text-fg-subtle font-normal">{totals.piCount} PIs</div>
                </Td>
                <Td className={cn(FOOT, "text-right text-fg tabular-nums")} title={formatBRL(totals.cohortRevenue)}>
                  <EntriesHover row={totals} mode="inMonth" monthLabel="todo o período">{formatBRLCompact(totals.cohortRevenue)}</EntriesHover>
                  <div className="text-[10.5px] text-fg-subtle font-normal">{formatRatioPct(totals.cohortPct, 0)} do PI</div>
                </Td>
                <Td className={cn(FOOT, "text-right text-emerald-600 dark:text-emerald-400 tabular-nums")} title={formatBRL(totals.cohortMargin)}>
                  <EntriesHover row={totals} mode="marginInMonth" monthLabel="todo o período">{formatBRLCompact(totals.cohortMargin)}</EntriesHover>
                </Td>
                <Td className={cn(FOOT, "text-right tabular-nums")} title={`Total ainda a receber: ${formatBRL(totals.open)}`}>
                  <span className={totals.open > 0 ? "text-amber-600 dark:text-amber-300" : "text-fg-subtle"}>
                    {totals.open > 0
                      ? <EntriesHover row={totals} mode="open" monthLabel="todo o período">{formatBRLCompact(totals.open)}</EntriesHover>
                      : formatBRLCompact(totals.open)}
                  </span>
                  <div className="text-[10.5px] text-fg-subtle font-normal">{formatRatioPct(totals.openPct, 0)} do PI</div>
                </Td>
                <Td className={FOOT}><CycleBar row={totals} accent={accent} /></Td>
                <Td className={cn(FOOT, DIV, "text-right text-fg tabular-nums")} title={formatBRL(totals.revenue)}>{formatBRLCompact(totals.revenue)}</Td>
                <Td className={cn(FOOT, "text-right text-emerald-600 dark:text-emerald-400 tabular-nums")} title={formatBRL(totals.margin)}>
                  {formatBRLCompact(totals.margin)}
                  {totals.marginPct != null && <div className="text-[10.5px] text-fg-subtle font-normal">{formatRatioPct(totals.marginPct, 0)} margem</div>}
                </Td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="px-4 md:px-5 py-2.5 border-t border-border flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] text-fg-subtle">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-1.5 rounded-full" style={{ background: accent }} aria-hidden /> consumido no próprio mês
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-1.5 rounded-full" style={{ background: accent, opacity: 0.4 }} aria-hidden /> consumido depois
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-1.5 rounded-full bg-amber-500/60" aria-hidden /> em aberto
        </span>
        <span className="ml-auto">
          Em aberto = PI − Receita Bruta já entregue por aquela safra.
        </span>
      </div>
    </div>
  );
}

const FOOT = "sticky bottom-0 z-20 bg-surface-3 border-t-2 border-border";

// ── Hover: quais PIs entraram naquele mês ────────────────────────────────────
const HOVER_MAX = 8;
const NO_ENTRIES = [];

// Cada coluna da SAFRA é uma soma de PIs — o hover abre a soma. Um componente
// só serve as quatro: muda o valor em foco, o título e o filtro; a lista de
// `entries` (um item por flight com PI) é a mesma.
const HOVER_MODES = {
  pi: {
    title: (m) => `PIs que entraram em ${m}`,
    value: (e) => e.pi,
    tone: "text-fg",
    keep: () => true,
    footer: "Total do mês",
  },
  inMonth: {
    title: (m) => `Consumido dentro de ${m}`,
    value: (e) => e.revenueInMonth,
    sub: (e) => (e.pi > 0 ? `${formatRatioPct(e.revenueInMonth / e.pi, 0)} do PI de ${formatBRLCompact(e.pi)}` : null),
    tone: "text-fg",
    keep: (e) => e.revenueInMonth > 0.01,
    footer: "Receita no mês",
    empty: "Nenhum PI dessa safra entregou dentro do próprio mês.",
  },
  marginInMonth: {
    title: (m) => `Margem HYPR dentro de ${m}`,
    value: (e) => e.marginInMonth,
    sub: (e) => (e.revenueInMonth > 0 ? `${formatRatioPct(e.marginInMonth / e.revenueInMonth, 0)} de margem` : null),
    tone: "text-emerald-600 dark:text-emerald-400",
    keep: (e) => e.marginInMonth > 0.01,
    footer: "Margem no mês",
    empty: "Nenhum PI dessa safra entregou dentro do próprio mês.",
  },
  open: {
    title: (m) => `Em aberto de ${m}`,
    value: (e) => e.open,
    sub: (e) => `entregue ${formatBRLCompact(e.revenueLife)} de ${formatBRLCompact(e.pi)}`,
    tone: "text-amber-600 dark:text-amber-300",
    keep: (e) => e.open > 0.01,
    footer: "Total em aberto",
    empty: "Todos os PIs dessa safra já entregaram o contratado.",
  },
};

/**
 * Hover das colunas de safra. `row` pode ser uma linha de mês OU a linha de
 * total — nesta, `entries` é a união de todos os meses, e o título fala do
 * acumulado. Portalizado (Radix) porque a tabela rola por dentro: no fluxo,
 * o card seria cortado pelo overflow do quadrante.
 */
function EntriesHover({ row, mode = "pi", monthLabel, children }) {
  const cfg = HOVER_MODES[mode];
  // Constante de módulo (e não `|| []`): array novo a cada render invalidaria
  // o useMemo abaixo sempre.
  const all = row.entries || NO_ENTRIES;
  const kept = useMemo(
    () => all.filter(cfg.keep).sort((a, b) => cfg.value(b) - cfg.value(a)),
    [all, cfg],
  );
  if (!all.length) return children;

  const shown = kept.slice(0, HOVER_MAX);
  const rest = kept.length - shown.length;
  const restSum = kept.slice(HOVER_MAX).reduce((s, e) => s + cfg.value(e), 0);
  const total = kept.reduce((s, e) => s + cfg.value(e), 0);
  const label = monthLabel || formatMonthLabel(row.month, "long");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* <button> em vez de <span>: o Radix abre no foco também, então o
            resumo fica acessível por teclado. */}
        <button type="button"
                className="tabular-nums underline decoration-dotted decoration-fg-subtle/50 underline-offset-4 hover:decoration-signature focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature rounded-sm cursor-help">
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-[400px] p-0 overflow-hidden">
        <div className="px-3 py-2 border-b border-border bg-surface-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-signature">
            {cfg.title(label)}
          </div>
          <div className="text-[11px] text-fg-subtle mt-0.5 tabular-nums">
            {kept.length} de {all.length} {all.length === 1 ? "PI" : "PIs"}
            {row.campaigns != null && (
              <>
                <span className="mx-1.5">·</span>
                {row.campaigns} {row.campaigns === 1 ? "campanha" : "campanhas"}
              </>
            )}
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-fg-subtle text-center">{cfg.empty}</div>
        ) : (
          <ul className="py-1 max-h-[340px] overflow-y-auto scrollbar-thin">
            {shown.map((e) => (
              <li key={e.key} className="flex items-baseline gap-3 px-3 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-fg truncate" title={e.name}>{e.name}</span>
                  <span className="block text-[10.5px] text-fg-subtle truncate">
                    {e.customer || "sem cliente"}
                    {e.token && <span className="font-mono text-signature ml-1.5">{e.token}</span>}
                    {e.lines > 1 && <span className="ml-1.5">· {e.lines} lines</span>}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className={cn("block text-[12.5px] font-semibold tabular-nums", cfg.tone)}>
                    {formatBRL(cfg.value(e))}
                  </span>
                  {cfg.sub?.(e) && (
                    <span className="block text-[10px] text-fg-subtle tabular-nums">{cfg.sub(e)}</span>
                  )}
                </span>
              </li>
            ))}
            {rest > 0 && (
              <li className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-[11px] text-fg-subtle">
                <span>+ {rest} {rest === 1 ? "outro PI" : "outros PIs"}</span>
                <span className="tabular-nums">{formatBRL(restSum)}</span>
              </li>
            )}
          </ul>
        )}
        {shown.length > 0 && (
          <div className="flex items-baseline justify-between gap-3 px-3 py-2 border-t border-border bg-surface-3">
            <span className="text-[10px] font-bold uppercase tracking-widest text-fg-muted">{cfg.footer}</span>
            <span className={cn("text-[13px] font-bold tabular-nums", cfg.tone)}>{formatBRL(total)}</span>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// Cores por fonte de curadoria — alinhadas ao SourceChip da lista (PubMatic
// índigo). Recharts/inline style precisam de cor literal.
const SOURCE_LABEL = { xandr: "Xandr", pubmatic: "PubMatic" };
const SOURCE_COLOR = { xandr: "#38bdf8", pubmatic: "#818cf8" };

// Mix de DSP da linha: barrinha 100% da Receita Bruta do mês. Só aparece
// quando há mais de uma fonte no dataset — com uma fonte só seria uma barra
// cheia dizendo nada.
function SourceMixBar({ bySource, total, accent }) {
  if (!(total > 0)) return null;
  return (
    <div className="mt-1 flex h-1 w-[92px] rounded-full overflow-hidden bg-track" aria-hidden
         title={bySource.map((s) => `${SOURCE_LABEL[s.source] || s.source}: ${formatBRL(s.revenue)}`).join(" · ")}>
      {bySource.map((s) => (
        <span key={s.source}
              style={{ width: `${(s.revenue / total) * 100}%`, background: SOURCE_COLOR[s.source] || accent }} />
      ))}
    </div>
  );
}

// Ciclo do PI: o que aconteceu com o contrato daquele mês, em 100% da barra.
//   cheio       → consumido no próprio mês
//   translúcido → consumido nos meses seguintes
//   âmbar       → ainda em aberto
// É o termômetro do que a HYPR tem a receber por safra.
function CycleBar({ row, accent }) {
  const inMonth = Math.max(0, row.barInMonth || 0);
  const later = Math.max(0, row.barLater || 0);
  const open = Math.max(0, 1 - inMonth - later);
  const over = (row.overCount || 0) > 0;
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex h-2 w-[92px] rounded-full overflow-hidden bg-amber-500/25">
        {inMonth > 0 && <span style={{ width: `${inMonth * 100}%`, background: accent }} />}
        {later > 0 && <span style={{ width: `${later * 100}%`, background: accent, opacity: 0.4 }} />}
        {open > 0 && <span style={{ width: `${open * 100}%` }} className="bg-amber-500/60" />}
      </div>
      {over && (
        <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"
              title={`${row.overCount} ${row.overCount === 1 ? "PI entregou" : "PIs entregaram"} mais que o contratado`}>▲</span>
      )}
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
                return { name: x.name, value: `${formatBRLCompact(x.value)} · ${fmt(pctv, 0)}%`, color: colorOf(x.name) };
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
      {/* min-w-0: sem isso o filho flex não encolhe abaixo do conteúdo e a
          legenda (donut 188px + colunas fixas) estourava a viewport em
          larguras médias — a página inteira ganhava scroll horizontal. */}
      <div className="flex-1 min-w-0 w-full self-center divide-y divide-border/70">
        {data.rows.map((r) => {
          const pct = data.total > 0 ? (r.revenue / data.total) * 100 : 0;
          return (
            <div key={r.status} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="size-2.5 rounded-sm shrink-0" style={{ background: colorOf(r.status) }} aria-hidden />
              <span className="text-[13px] text-fg flex-1 min-w-0 truncate">
                {r.status}
                <span className="text-fg-subtle"> · {r.count} {r.count === 1 ? "deal" : "deals"}</span>
              </span>
              <span className="text-[13px] text-fg-muted tabular-nums w-10 text-right">{fmt(pct, 0)}%</span>
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
  { key: "revenue", label: "Receita Bruta", align: "right" },
  { key: "margin", label: "Margem HYPR", align: "right" },
  { key: "marginPct", label: "Margem %", align: "right" },
  { key: "pctEntregue", label: "% Entrega", align: "right" },
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
                <tr key={lineKey(r.line)} className="border-t border-border hover:bg-surface-strong transition-colors">
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
          {!isAll && <CountBadge value={selected.length} tone="onSignature" />}
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
