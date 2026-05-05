// src/dashboards/RmndDashboard.jsx
//
// Dashboard RMND · Amazon Ads (formato amazon-ads-2026, schema V2).
//
// Recebe `data` no shape produzido pelo RmndUploadModal:
//   { version: 2, format: "amazon-ads-2026", filters, rows: [...], uploadedAt }
//
// Cada row tem: date, adProduct (Sponsored Products | Amazon DSP), campaign,
// adGroup, asin, sku, productName, purchases, sales, units, atc, ctSales,
// vtSales. NÃO há impressões nem cliques nem spend (decisão do PO).
//
// Layout (vertical, top → bottom):
//   1. Header com range filter
//   2. Hero KPI Vendas + 3 KPIs (Compras, Unidades, ATC) com sparklines
//   3. Funil ATC → Compras
//   4. 2 cards: Mix por canal (donut SP vs DSP) | CT vs VT split
//   5. Tendência diária (stacked bar CT + VT + linha Compras)
//   6. Top Produtos (tabela com ASIN + nome truncado)
//   7. Tabela agregada por dia
//
// Bases salvas no formato antigo (sem `format`) caem num banner pedindo
// pra fazer upload do novo formato.

import { useMemo, useState } from "react";
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Legend,
} from "recharts";
import { fmt, fmtR, fmtCompact, fmtP2 } from "../shared/format";
import {
  readRangeFromUrl, writeRangeToUrl, parseYmd, daysInRange, ymd,
} from "../shared/dateFilter";
import { truncateProductName } from "../shared/rmndParse";
import DateRangeFilter from "../components/DateRangeFilter";
import { KpiCardV2 } from "../v2/components/KpiCardV2";
import { HeroKpiCardV2 } from "../v2/components/HeroKpiCardV2";
import { SparklineV2 } from "../v2/components/SparklineV2";
import { Card, CardHeader, CardBody } from "../ui/Card";

const CH_COLORS = {
  signature: "var(--color-signature)",
  signatureLight: "var(--color-signature-light)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  fg: "var(--color-fg)",
  fgMuted: "var(--color-fg-muted)",
  border: "var(--color-border)",
};

const RmndDashboard = ({ data, onClear, onEdit }) => {
  const isV2Format = data?.format === "amazon-ads-2026";

  if (!isV2Format) {
    return <LegacyBaseBanner data={data} onEdit={onEdit} onClear={onClear} />;
  }

  return <RmndV2Dashboard data={data} onClear={onClear} onEdit={onEdit} />;
};

export default RmndDashboard;

// ─── Banner pra bases salvas no formato antigo ───────────────────────────────
function LegacyBaseBanner({ data, onEdit, onClear }) {
  return (
    <div className="rounded-xl border border-warning/40 bg-warning-soft p-6 text-fg">
      <div className="flex items-start gap-3">
        <span className="text-2xl">⚠</span>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-bold mb-1">Base RMND no formato antigo</h3>
          <p className="text-sm text-fg-muted leading-snug mb-3">
            Esta base foi enviada antes da migração pro novo relatório do Amazon Ads.
            Suba o arquivo no formato atual pra desbloquear o dashboard novo
            (vendas, ATC, CT/VT, top produtos).
          </p>
          <div className="flex gap-2">
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="px-4 py-2 rounded-lg bg-signature text-on-signature text-sm font-semibold hover:bg-signature-hover transition-colors cursor-pointer"
              >
                Subir novo arquivo
              </button>
            )}
            {onClear && (
              <button
                type="button"
                onClick={onClear}
                className="px-4 py-2 rounded-lg border border-border bg-surface text-fg-muted text-sm hover:bg-surface-strong transition-colors cursor-pointer"
              >
                Limpar base
              </button>
            )}
          </div>
          <p className="text-xs text-fg-subtle mt-3">
            {data?.rows?.length || 0} linhas · enviado em{" "}
            {data?.uploadedAt ? new Date(data.uploadedAt).toLocaleString("pt-BR") : "data desconhecida"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard V2 ────────────────────────────────────────────────────────────
function RmndV2Dashboard({ data, onClear, onEdit }) {
  const allRows = data.rows || [];

  // Datas disponíveis
  const dateInfo = useMemo(() => {
    const dates = new Set();
    for (const r of allRows) if (r.date) dates.add(r.date);
    const sorted = [...dates].sort();
    return {
      available: sorted,
      min: sorted.length ? parseYmd(sorted[0]) : null,
      max: sorted.length ? parseYmd(sorted[sorted.length - 1]) : null,
    };
  }, [allRows]);

  const [range, setRangeState] = useState(() => readRangeFromUrl("rmnd"));
  const setRange = (r) => {
    setRangeState(r);
    writeRangeToUrl(r, "rmnd");
  };

  const rows = useMemo(() => {
    if (!range) return allRows;
    const from = ymd(range.from);
    const to = ymd(range.to);
    return allRows.filter((r) => r.date >= from && r.date <= to);
  }, [allRows, range]);

  const totals = useMemo(() => {
    const acc = {
      sales: 0, purchases: 0, units: 0, atc: 0,
      ctSales: 0, vtSales: 0,
      spSales: 0, dspSales: 0,
    };
    for (const r of rows) {
      acc.sales     += r.sales;
      acc.purchases += r.purchases;
      acc.units     += r.units;
      acc.atc       += r.atc;
      acc.ctSales   += r.ctSales;
      acc.vtSales   += r.vtSales;
      if (r.adProduct === "Amazon DSP") acc.dspSales += r.sales;
      else                               acc.spSales  += r.sales;
    }
    return acc;
  }, [rows]);

  const avgTicket = totals.purchases > 0 ? totals.sales / totals.purchases : 0;
  const atcToPurchaseRate = totals.atc > 0 ? (totals.purchases / totals.atc) * 100 : 0;

  // Série diária (uma chave por dia, agregando todas as métricas)
  const daily = useMemo(() => {
    const byDate = new Map();
    for (const r of rows) {
      let d = byDate.get(r.date);
      if (!d) {
        d = { date: r.date, sales: 0, purchases: 0, units: 0, atc: 0, ctSales: 0, vtSales: 0 };
        byDate.set(r.date, d);
      }
      d.sales     += r.sales;
      d.purchases += r.purchases;
      d.units     += r.units;
      d.atc       += r.atc;
      d.ctSales   += r.ctSales;
      d.vtSales   += r.vtSales;
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [rows]);

  // Sparklines (últimos 14 pontos)
  const sparkLast = (key) => daily.slice(-14).map((d) => d[key] || 0);

  // Mix por canal
  const channelMix = useMemo(() => [
    { name: "Sponsored Products", value: totals.spSales,  color: CH_COLORS.signature },
    { name: "Amazon DSP",         value: totals.dspSales, color: CH_COLORS.signatureLight },
  ], [totals]);
  const totalChannel = channelMix.reduce((s, c) => s + c.value, 0);

  // Top produtos
  const topProducts = useMemo(() => {
    const byKey = new Map();
    for (const r of rows) {
      const key = r.asin || r.sku || r.productName || "—";
      let p = byKey.get(key);
      if (!p) {
        p = { key, asin: r.asin, sku: r.sku, name: r.productName,
              sales: 0, units: 0, purchases: 0, atc: 0 };
        byKey.set(key, p);
      }
      p.sales     += r.sales;
      p.units     += r.units;
      p.purchases += r.purchases;
      p.atc       += r.atc;
    }
    return [...byKey.values()].sort((a, b) => b.sales - a.sales);
  }, [rows]);

  const [showAllProducts, setShowAllProducts] = useState(false);
  const visibleProducts = showAllProducts ? topProducts : topProducts.slice(0, 10);

  const ctVtTotal = totals.ctSales + totals.vtSales;
  const ctPct = ctVtTotal > 0 ? (totals.ctSales / ctVtTotal) * 100 : 0;
  const vtPct = ctVtTotal > 0 ? (totals.vtSales / ctVtTotal) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* ─── Header ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-fg-subtle">
          Atualizado em {data.uploadedAt ? new Date(data.uploadedAt).toLocaleString("pt-BR") : "—"}
          {data.filters?.adGroups?.length ? (
            <> · {data.filters.adGroups.length} grupo(s) selecionado(s)</>
          ) : null}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {range && (
            <span className="text-xs text-fg-muted">
              {fmt(rows.length)} de {fmt(allRows.length)} linhas · {daysInRange(range)}d
            </span>
          )}
          <DateRangeFilter
            value={range}
            onChange={setRange}
            minDate={dateInfo.min}
            maxDate={dateInfo.max}
            availableDates={dateInfo.available}
            isDark
          />
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="px-3 py-1.5 rounded-lg border border-border bg-surface text-xs text-fg-muted hover:bg-surface-strong transition-colors cursor-pointer"
            >
              ⚙ Editar base
            </button>
          )}
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              className="px-3 py-1.5 rounded-lg border border-border bg-surface text-xs text-fg-muted hover:bg-surface-strong transition-colors cursor-pointer"
            >
              🔄 Trocar arquivo
            </button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-12 text-center text-fg-muted">
          Nenhuma linha encontrada no período selecionado.
        </div>
      ) : (
        <>
          {/* ─── 1. Hero KPI + auxiliares ───────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
            <div className="md:col-span-2">
              <HeroKpiCardV2
                icon={<CartIcon />}
                label="Vendas Totais"
                value={fmtR(totals.sales)}
                sparklineValues={sparkLast("sales")}
              />
            </div>
            <KpiCardV2
              label="Compras"
              value={fmt(totals.purchases)}
              hint="Quantidade total de pedidos atribuídos no período."
              sparkline={
                <SparklineV2
                  values={sparkLast("purchases")}
                  stroke={CH_COLORS.signature}
                  fillOpacity={0.18}
                  height={24}
                  width={140}
                />
              }
            />
            <KpiCardV2
              label="Unidades vendidas"
              value={fmt(totals.units)}
              hint="Soma de unidades vendidas por todos os produtos do período."
              sparkline={
                <SparklineV2
                  values={sparkLast("units")}
                  stroke={CH_COLORS.signature}
                  fillOpacity={0.18}
                  height={24}
                  width={140}
                />
              }
            />
            <KpiCardV2
              label="Adicionar ao carrinho"
              value={fmt(totals.atc)}
              hint="ATC (Add To Cart) — interesse forte mesmo quando não converte em compra."
              sparkline={
                <SparklineV2
                  values={sparkLast("atc")}
                  stroke={CH_COLORS.signature}
                  fillOpacity={0.18}
                  height={24}
                  width={140}
                />
              }
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SoftStat label="Ticket Médio"      value={fmtR(avgTicket)} />
            <SoftStat label="ATC → Compra"      value={fmtP2(atcToPurchaseRate)} />
            <SoftStat label="Vendas via Clique" value={fmtR(totals.ctSales)} />
            <SoftStat label="Vendas via Display" value={fmtR(totals.vtSales)} />
          </div>

          {/* ─── 2. Funil ───────────────────────────────────────────── */}
          <FunnelCard atc={totals.atc} purchases={totals.purchases} units={totals.units} avgTicket={avgTicket} />

          {/* ─── 3. Mix por canal + CT vs VT ────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChannelMixCard data={channelMix} total={totalChannel} />
            <CtVtSplitCard
              ctSales={totals.ctSales}
              vtSales={totals.vtSales}
              ctPct={ctPct}
              vtPct={vtPct}
            />
          </div>

          {/* ─── 4. Tendência diária ────────────────────────────────── */}
          <DailyTrendCard daily={daily} />

          {/* ─── 5. Top Produtos ────────────────────────────────────── */}
          <TopProductsTable
            products={visibleProducts}
            totalCount={topProducts.length}
            showAll={showAllProducts}
            onToggle={() => setShowAllProducts((s) => !s)}
          />

          {/* ─── 6. Tabela agregada por dia ─────────────────────────── */}
          <DailyAggregateTable daily={daily} />
        </>
      )}
    </div>
  );
}

// ─── Soft stat (KPI menor sem fundo) ─────────────────────────────────────────
function SoftStat({ label, value }) {
  return (
    <div className="rounded-lg border border-border bg-transparent px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle mb-1">{label}</div>
      <div className="text-lg font-bold tabular-nums text-fg">{value}</div>
    </div>
  );
}

// ─── Funil ATC → Compras ─────────────────────────────────────────────────────
function FunnelCard({ atc, purchases, units, avgTicket }) {
  const conv = atc > 0 ? (purchases / atc) * 100 : 0;
  return (
    <Card>
      <CardHeader title="Funil de conversão" subtitle="Do interesse à compra" />
      <CardBody>
        <div className="flex flex-col md:flex-row items-stretch gap-3 md:gap-2">
          <FunnelStage
            label="Adições ao Carrinho"
            value={fmt(atc)}
            sub="ATC"
            color="signature-light"
          />
          <FunnelArrow rate={conv} />
          <FunnelStage
            label="Compras Concluídas"
            value={fmt(purchases)}
            sub={`${fmt(units)} unidades`}
            color="signature"
            primary
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-fg-muted">
          <span>
            Ticket médio: <span className="font-bold text-fg tabular-nums">{fmtR(avgTicket)}</span>
          </span>
          {atc > 0 && (
            <span>
              {fmt(atc / Math.max(purchases, 1), 1)} ATCs por compra
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function FunnelStage({ label, value, sub, color, primary = false }) {
  return (
    <div
      className={`flex-1 rounded-xl border p-4 ${
        primary
          ? "border-signature/40 bg-signature-soft"
          : "border-border bg-surface"
      }`}
    >
      <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">{label}</div>
      <div
        className={`text-3xl font-bold leading-tight tabular-nums mt-1 ${
          primary ? "text-signature" : "text-fg"
        }`}
      >
        {value}
      </div>
      <div className="text-xs text-fg-muted mt-1">{sub}</div>
    </div>
  );
}

function FunnelArrow({ rate }) {
  return (
    <div className="flex md:flex-col flex-row items-center justify-center md:px-2 py-2 md:py-0 gap-1">
      <div className="text-[10px] font-bold text-fg-subtle uppercase tracking-widest">conversão</div>
      <div className="text-2xl font-bold text-signature tabular-nums">{fmtP2(rate)}</div>
      <svg width="36" height="20" viewBox="0 0 36 20" className="text-fg-subtle hidden md:block" aria-hidden>
        <path d="M0 10 H30 M22 4 L30 10 L22 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg width="20" height="36" viewBox="0 0 20 36" className="text-fg-subtle md:hidden" aria-hidden>
        <path d="M10 0 V30 M4 22 L10 30 L16 22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// ─── Mix por canal (donut) ──────────────────────────────────────────────────
function ChannelMixCard({ data, total }) {
  const hasData = total > 0;
  return (
    <Card className="h-full">
      <CardHeader title="Mix por canal" subtitle="Vendas R$ por tipo de mídia Amazon" />
      <CardBody>
        {!hasData ? (
          <div className="text-sm text-fg-muted py-6 text-center">Sem vendas no período.</div>
        ) : (
          <div className="flex items-center gap-4">
            <div className="w-36 h-36 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={42}
                    outerRadius={64}
                    paddingAngle={2}
                    stroke="none"
                  >
                    {data.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-surface-2)",
                      border: "1px solid var(--color-border-strong)",
                      borderRadius: 8,
                      fontSize: 12,
                      color: CH_COLORS.fg,
                    }}
                    formatter={(value, name) => [fmtR(value), name]}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 min-w-0 space-y-3">
              {data.map((d) => {
                const pct = total > 0 ? (d.value / total) * 100 : 0;
                return (
                  <div key={d.name}>
                    <div className="flex items-center gap-2 text-xs text-fg mb-1">
                      <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: d.color }} />
                      <span className="font-semibold truncate" title={d.name}>{d.name}</span>
                      <span className="ml-auto tabular-nums font-bold text-fg-muted">{fmtP2(pct)}</span>
                    </div>
                    <div className="text-sm font-bold tabular-nums text-fg">{fmtR(d.value)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ─── CT vs VT ───────────────────────────────────────────────────────────────
function CtVtSplitCard({ ctSales, vtSales, ctPct, vtPct }) {
  const total = ctSales + vtSales;
  return (
    <Card className="h-full">
      <CardHeader
        title="Vendas por origem"
        subtitle="Clique × visualização (halo do display)"
      />
      <CardBody>
        {total === 0 ? (
          <div className="text-sm text-fg-muted py-6 text-center">Sem vendas no período.</div>
        ) : (
          <>
            <div className="flex h-10 rounded-lg overflow-hidden border border-border bg-surface">
              <div
                className="bg-signature flex items-center justify-end pr-3 text-xs font-bold text-on-signature transition-all"
                style={{ width: `${Math.max(ctPct, 4)}%` }}
                title={`Clique: ${fmtR(ctSales)}`}
              >
                {ctPct >= 8 ? `${fmtP2(ctPct)}` : ""}
              </div>
              <div
                className="flex items-center justify-start pl-3 text-xs font-bold transition-all"
                style={{
                  width: `${Math.max(vtPct, 4)}%`,
                  background: "var(--color-signature-light)",
                  color: "var(--color-canvas)",
                }}
                title={`Visualização: ${fmtR(vtSales)}`}
              >
                {vtPct >= 8 ? `${fmtP2(vtPct)}` : ""}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-4">
              <div>
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold text-fg-subtle mb-1">
                  <span className="w-2 h-2 rounded-sm bg-signature" />
                  Clique (CT)
                </div>
                <div className="text-lg font-bold tabular-nums text-fg">{fmtR(ctSales)}</div>
                <div className="text-[11px] text-fg-muted mt-0.5">
                  Quem clicou no anúncio e comprou.
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold text-fg-subtle mb-1">
                  <span className="w-2 h-2 rounded-sm" style={{ background: "var(--color-signature-light)" }} />
                  Visualização (VT)
                </div>
                <div className="text-lg font-bold tabular-nums text-fg">{fmtR(vtSales)}</div>
                <div className="text-[11px] text-fg-muted mt-0.5">
                  Comprou após ver o anúncio sem clicar (efeito halo).
                </div>
              </div>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

// ─── Tendência diária ───────────────────────────────────────────────────────
function DailyTrendCard({ daily }) {
  const pretty = (d) => d.slice(5).split("-").reverse().join("/");
  const chartData = daily.map((d) => ({
    date: pretty(d.date),
    rawDate: d.date,
    "Vendas via Clique": d.ctSales,
    "Vendas via Display": d.vtSales,
    Compras: d.purchases,
  }));
  return (
    <Card>
      <CardHeader title="Tendência diária" subtitle="Vendas por origem (R$) e compras" />
      <CardBody className="pl-2">
        <div className="w-full" style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CH_COLORS.border} vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: CH_COLORS.fgMuted, fontSize: 10 }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                yAxisId="left"
                tick={{ fill: CH_COLORS.fgMuted, fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => fmtCompact(v)}
                width={56}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fill: CH_COLORS.fgMuted, fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => fmtCompact(v)}
                width={40}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border-strong)",
                  borderRadius: 8,
                  fontSize: 12,
                  color: CH_COLORS.fg,
                }}
                formatter={(value, name) => name === "Compras" ? [fmt(value), name] : [fmtR(value), name]}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                iconType="square"
              />
              <Bar yAxisId="left" dataKey="Vendas via Clique"   stackId="sales" fill={CH_COLORS.signature}      radius={[0, 0, 0, 0]} />
              <Bar yAxisId="left" dataKey="Vendas via Display"  stackId="sales" fill={CH_COLORS.signatureLight} radius={[3, 3, 0, 0]} />
              <Line yAxisId="right" dataKey="Compras" type="monotone" stroke={CH_COLORS.warning} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Top Produtos ───────────────────────────────────────────────────────────
function TopProductsTable({ products, totalCount, showAll, onToggle }) {
  if (!products.length) return null;
  const hasMore = totalCount > 10;
  return (
    <Card>
      <CardHeader
        title="Top produtos"
        subtitle={`${fmt(totalCount)} produtos no período · ordenado por vendas`}
      />
      <CardBody className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left w-10">#</th>
                <th className="px-4 py-3 text-left">Produto</th>
                <th className="px-4 py-3 text-left">ASIN</th>
                <th className="px-4 py-3 text-right">Vendas</th>
                <th className="px-4 py-3 text-right">Unidades</th>
                <th className="px-4 py-3 text-right">Compras</th>
                <th className="px-4 py-3 text-right">Ticket</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p, i) => {
                const ticket = p.purchases > 0 ? p.sales / p.purchases : 0;
                return (
                  <tr key={p.key} className="border-b border-border last:border-0 hover:bg-surface transition-colors">
                    <td className="px-4 py-3 text-fg-subtle tabular-nums">{i + 1}</td>
                    <td className="px-4 py-3 text-fg max-w-[420px]">
                      <div className="truncate" title={p.name || "—"}>
                        {truncateProductName(p.name, 80) || <span className="text-fg-subtle italic">sem nome</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-fg-muted">
                      {p.asin || <span className="text-fg-subtle">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums text-fg">{fmtR(p.sales)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-fg-muted">{fmt(p.units)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-fg-muted">{fmt(p.purchases)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-fg-muted">{fmtR(ticket)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {hasMore && (
          <button
            type="button"
            onClick={onToggle}
            className="w-full px-4 py-3 text-xs font-semibold text-signature hover:bg-surface transition-colors border-t border-border cursor-pointer"
          >
            {showAll ? "▴ Ver só os 10 primeiros" : `▾ Ver todos os ${fmt(totalCount)} produtos`}
          </button>
        )}
      </CardBody>
    </Card>
  );
}

// ─── Tabela agregada por dia ────────────────────────────────────────────────
function DailyAggregateTable({ daily }) {
  if (!daily.length) return null;
  const reversed = [...daily].reverse(); // mais recente primeiro
  return (
    <Card>
      <CardHeader title="Detalhe diário" subtitle="Métricas agregadas por data" />
      <CardBody className="p-0">
        <div className="overflow-x-auto max-h-[480px]">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle border-b border-border bg-surface-2 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3 text-left">Data</th>
                <th className="px-4 py-3 text-right">Vendas</th>
                <th className="px-4 py-3 text-right">Compras</th>
                <th className="px-4 py-3 text-right">Unidades</th>
                <th className="px-4 py-3 text-right">ATC</th>
                <th className="px-4 py-3 text-right">Vendas Clique</th>
                <th className="px-4 py-3 text-right">Vendas Display</th>
              </tr>
            </thead>
            <tbody>
              {reversed.map((d) => (
                <tr key={d.date} className="border-b border-border last:border-0 hover:bg-surface transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-fg">{d.date.split("-").reverse().join("/")}</td>
                  <td className="px-4 py-3 text-right font-bold tabular-nums text-fg">{fmtR(d.sales)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-fg-muted">{fmt(d.purchases)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-fg-muted">{fmt(d.units)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-fg-muted">{fmt(d.atc)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-fg-muted">{fmtR(d.ctSales)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-fg-muted">{fmtR(d.vtSales)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Ícone do hero ──────────────────────────────────────────────────────────
function CartIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
    </svg>
  );
}
