// src/v2/portal/PortalAnalytics.jsx
//
// Seção "Analytics" do Portal do Cliente — visão agregada e aprofundada da
// ativação do cliente com a HYPR. Client-safe (mesma régra do portal: zero dado
// interno). Tudo aqui é derivado do payload do portal (nível campanha; sem série
// diária), agregado por MÊS (start_date) e por core product / formato.
//
// Conteúdo:
//   1. Barra de filtros: Período (range) + Core Product + Formato
//   2. Strip de KPIs (reativo aos filtros)
//   3. Evolução mensal — investimento (barra) × impressões (linha)
//   4. Performance ao longo do tempo — CTR × VTR (linhas)
//   5. Mix por formato (donut, split preciso por d/v_client_budget) +
//      mix por core product (barras ranqueadas)
//   6. Brand lift mensal (relativo % + absoluto pp) — quando houver survey
//      conectado (dado vem do backend via prop `brandLift`)
//   7. Tabela agregada por campanha — ordenável
//
// Charts em recharts com cores resolvidas por tema (useThemeColors), mesma
// linguagem visual do report (DualChartV2/ChartCardV2).

import { useMemo, useState } from "react";
import {
  ComposedChart, Bar, Line, LineChart, XAxis, YAxis,
  CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";

import { useThemeColors, useChartNeutral } from "../hooks/useThemeColors";
import { useIsMobile } from "../hooks/useIsMobile";
import { ChartCardV2 } from "../components/ChartCardV2";
import { DateRangeFilterV2 } from "../components/DateRangeFilterV2";
import { MultiSelectDropdown } from "./PortalFilters";
import { ymd } from "../../shared/dateFilter";
import { cn } from "../../ui/cn";

import {
  formatBRL, formatPct, formatMonthLabel,
} from "../admin/lib/format";
import { formatInt, formatIntCompact } from "../admin/lib/pmpFormat";

// ── Helpers ────────────────────────────────────────────────────────────────
const num = (v) => Number(v) || 0;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const investedOf = (c) => num(c.d_client_budget) + num(c.v_client_budget);

const CORE_LABELS = { O2O: "O2O", OOH: "OOH / PDOOH", GROUNDFLOW: "Groundflow" };
const compactBrl = (v) =>
  v >= 1_000_000 ? `R$ ${(v / 1_000_000).toFixed(1).replace(".", ",")} mi`
  : v >= 1_000 ? `R$ ${Math.round(v / 1_000)} mil`
  : `R$ ${Math.round(v)}`;
const compactInt = (v) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1).replace(".", ",")}M`
  : v >= 1_000 ? `${Math.round(v / 1_000)}K`
  : String(Math.round(v));

export default function PortalAnalytics({ campaigns, accent, brandLift = null }) {
  const [period, setPeriod] = useState(null);
  const [periodPresetId, setPeriodPresetId] = useState("all");
  const [coreProducts, setCoreProducts] = useState([]);
  const [formats, setFormats] = useState([]);

  // Dedup por token (rename de line pode trazer o mesmo token 2x) + bounds.
  const { deduped, firstStart, lastEnd, coreOptions } = useMemo(() => {
    const seen = new Set();
    const out = [];
    let fs = null, le = null;
    const tactics = new Set();
    for (const c of campaigns || []) {
      const tok = (c.short_token || "").toUpperCase();
      if (tok && seen.has(tok)) continue;
      if (tok) seen.add(tok);
      out.push(c);
      if (c.start_date && (!fs || c.start_date < fs)) fs = c.start_date;
      if (c.end_date && (!le || c.end_date > le)) le = c.end_date;
      for (const t of c.tactics || []) tactics.add(t);
    }
    const order = ["O2O", "OOH", "GROUNDFLOW"];
    const coreOptions = [...tactics]
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
      .map((t) => ({ value: t, label: CORE_LABELS[t] || t }));
    return { deduped: out, firstStart: fs, lastEnd: le, coreOptions };
  }, [campaigns]);

  const filtered = useMemo(() => {
    return deduped.filter((c) => {
      if (period?.from && period?.to) {
        const from = ymd(period.from), to = ymd(period.to);
        const cs = c.start_date || "", ce = c.end_date || cs;
        if (!cs || cs > to || ce < from) return false;
      }
      if (coreProducts.length && !coreProducts.some((t) => (c.tactics || []).includes(t))) return false;
      if (formats.length && !formats.some((f) => (c.media || []).includes(f))) return false;
      return true;
    });
  }, [deduped, period, coreProducts, formats]);

  const filtersActive = !!period || coreProducts.length > 0 || formats.length > 0;
  const clearFilters = () => {
    setPeriod(null); setPeriodPresetId("all"); setCoreProducts([]); setFormats([]);
  };

  // ── Agregados ──────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    let invested = 0, impressions = 0, clicks = 0, completions = 0, dBudget = 0, vBudget = 0;
    const vtrs = [];
    for (const c of filtered) {
      invested += investedOf(c);
      dBudget += num(c.d_client_budget);
      vBudget += num(c.v_client_budget);
      impressions += num(c.viewable_impressions);
      clicks += num(c.clicks);
      completions += num(c.completions);
      if (c.vtr != null) vtrs.push(Number(c.vtr));
    }
    return {
      invested, impressions, clicks, completions, dBudget, vBudget,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      vtr: mean(vtrs),
      count: filtered.length,
    };
  }, [filtered]);

  const monthly = useMemo(() => {
    const map = new Map();
    for (const c of filtered) {
      const m = (c.start_date || "").slice(0, 7);
      if (!m) continue;
      if (!map.has(m)) map.set(m, { month: m, invested: 0, impressions: 0, clicks: 0, completions: 0, vtrs: [] });
      const e = map.get(m);
      e.invested += investedOf(c);
      e.impressions += num(c.viewable_impressions);
      e.clicks += num(c.clicks);
      e.completions += num(c.completions);
      if (c.vtr != null) e.vtrs.push(Number(c.vtr));
    }
    return [...map.values()]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((e) => ({
        ...e,
        label: formatMonthLabel(e.month, "short"),
        ctr: e.impressions > 0 ? (e.clicks / e.impressions) * 100 : null,
        vtr: e.vtrs.length ? mean(e.vtrs) : null,
      }));
  }, [filtered]);

  const coreMix = useMemo(() => {
    const map = new Map();
    for (const c of filtered) {
      const inv = investedOf(c);
      for (const t of c.tactics || []) {
        map.set(t, (map.get(t) || 0) + inv);
      }
    }
    const rows = [...map.entries()]
      .map(([t, invested]) => ({ tactic: t, label: CORE_LABELS[t] || t, invested }))
      .sort((a, b) => b.invested - a.invested);
    const max = rows.reduce((m, r) => Math.max(m, r.invested), 0);
    return rows.map((r) => ({ ...r, pct: max > 0 ? (r.invested / max) * 100 : 0 }));
  }, [filtered]);

  const formatMix = useMemo(() => {
    const rows = [
      { key: "DISPLAY", label: "Display", value: kpis.dBudget },
      { key: "VIDEO", label: "Vídeo", value: kpis.vBudget },
    ].filter((r) => r.value > 0);
    const total = rows.reduce((s, r) => s + r.value, 0);
    return { rows, total };
  }, [kpis]);

  const hasData = filtered.length > 0;

  return (
    <div className="space-y-6">
      {/* ── Filtros ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <DateRangeFilterV2
          value={period}
          presetId={periodPresetId}
          campaignStart={firstStart}
          campaignEnd={lastEnd}
          onChange={(r, pid) => { setPeriod(r); setPeriodPresetId(pid); }}
          triggerClassName="h-9 px-3 rounded-lg bg-canvas-deeper font-medium"
        />
        {coreOptions.length > 0 && (
          <MultiSelectDropdown
            label="Core product" allLabel="Todos os produtos"
            options={coreOptions} selected={coreProducts} onChange={setCoreProducts} accent={accent}
          />
        )}
        <MultiSelectDropdown
          label="Formato" allLabel="Todos os formatos"
          options={[{ value: "DISPLAY", label: "Display" }, { value: "VIDEO", label: "Vídeo" }]}
          selected={formats} onChange={setFormats} accent={accent}
        />
        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="ml-0.5 text-[12px] text-fg-muted hover:text-fg underline-offset-2 hover:underline transition-colors"
          >
            Limpar
          </button>
        )}
        <span className="ml-auto text-[12px] text-fg-subtle tabular-nums">
          {kpis.count} {kpis.count === 1 ? "campanha" : "campanhas"}
        </span>
      </div>

      {!hasData ? (
        <div className="rounded-2xl border border-border bg-canvas-elevated p-10 text-center">
          <p className="text-sm text-fg-muted">Nenhuma campanha com os filtros atuais.</p>
        </div>
      ) : (
        <>
          {/* ── KPIs ──────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiTile label="Investimento" value={compactBrl(kpis.invested)} title={formatBRL(kpis.invested)} accent />
            <KpiTile label="Impressões" value={formatIntCompact(kpis.impressions)} title={`${formatInt(kpis.impressions)} impressões visíveis`} sub="visíveis" />
            <KpiTile label="Cliques" value={formatIntCompact(kpis.clicks)} title={formatInt(kpis.clicks)} />
            <KpiTile label="CTR" value={formatPct(kpis.ctr, 2)} sub="médio" />
            <KpiTile label="VTR" value={formatPct(kpis.vtr, 1)} sub="vídeo" />
            <KpiTile label="Views 100%" value={formatIntCompact(kpis.completions)} title={`${formatInt(kpis.completions)} vídeos completos`} sub="vídeo completo" />
          </div>

          {/* ── Evolução mensal + Performance ─────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCardV2 title="Evolução mensal · investimento × impressões">
              <MonthlyInvestChart data={monthly} accent={accent} />
            </ChartCardV2>
            <ChartCardV2 title="Performance ao longo do tempo · CTR × VTR">
              <PerformanceChart data={monthly} accent={accent} />
            </ChartCardV2>
          </div>

          {/* ── Mix por formato + core product ────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCardV2 title="Mix por formato · investimento">
              <FormatDonut mix={formatMix} accent={accent} />
            </ChartCardV2>
            <ChartCardV2 title="Investimento por core product">
              <CoreProductBars rows={coreMix} accent={accent} />
            </ChartCardV2>
          </div>

          {/* ── Brand lift (condicional) ──────────────────────────────────── */}
          {Array.isArray(brandLift) && brandLift.length > 0 && (
            <ChartCardV2 title="Brand lift mensal · evolução">
              <BrandLiftSection monthly={brandLift} accent={accent} />
            </ChartCardV2>
          )}

          {/* ── Tabela agregada ───────────────────────────────────────────── */}
          <CampaignAnalyticsTable rows={filtered} accent={accent} />
        </>
      )}
    </div>
  );
}

// ── KPI tile (linguagem dos big numbers do portal) ──────────────────────────
function KpiTile({ label, value, sub, title, accent = false }) {
  return (
    <div
      className={cn("rounded-2xl p-4 min-w-0 border", !accent && "bg-canvas-elevated border-border")}
      style={accent ? {
        background: "color-mix(in srgb, var(--color-signature) 12%, var(--color-canvas-elevated))",
        borderColor: "color-mix(in srgb, var(--color-signature) 38%, transparent)",
      } : undefined}
    >
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-muted leading-none">{label}</div>
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

// ── Tooltip genérico estilizado ─────────────────────────────────────────────
function ChartTooltip({ active, payload, label, rows }) {
  const hypr = useThemeColors();
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: hypr.canvasElevated, border: `1px solid ${hypr.borderStrong}`,
      borderRadius: 8, padding: "8px 10px", fontSize: 12, color: hypr.fg, minWidth: 140,
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

// ── Evolução mensal: investimento (barra) × impressões (linha) ──────────────
function MonthlyInvestChart({ data, accent }) {
  const neutral = useChartNeutral();
  const hypr = useThemeColors();
  const isMobile = useIsMobile();
  if (!data.length) return null;
  const barSize = Math.min(isMobile ? 22 : 40, Math.max(10, Math.floor((isMobile ? 320 : 560) / data.length)));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={neutral.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: neutral.label, fontSize: 11 }} tickLine={false} axisLine={{ stroke: neutral.grid }} padding={{ left: 16, right: 16 }} />
        <YAxis yAxisId="left" tick={{ fill: neutral.label, fontSize: 10 }} tickLine={false} axisLine={false} width={48} tickFormatter={compactBrl} padding={{ top: 8 }} />
        <YAxis yAxisId="right" orientation="right" tick={{ fill: neutral.label, fontSize: 10 }} tickLine={false} axisLine={false} width={40} tickFormatter={compactInt} padding={{ top: 8 }} />
        <RTooltip cursor={{ fill: hypr.surfaceStrong }} content={(p) => (
          <ChartTooltip {...p} rows={(pl) => pl.map((x) => ({
            name: x.dataKey === "invested" ? "Investimento" : "Impressões",
            value: x.dataKey === "invested" ? formatBRL(x.value) : formatInt(x.value),
            color: x.dataKey === "invested" ? accent : hypr.fgMuted,
          }))} />
        )} />
        <Bar yAxisId="left" dataKey="invested" fill={accent} radius={[4, 4, 0, 0]} opacity={0.9} barSize={barSize} isAnimationActive={false} />
        <Line yAxisId="right" dataKey="impressions" type="monotone" stroke={hypr.fg} strokeWidth={2} dot={{ r: 3, fill: hypr.fg }} activeDot={{ r: 5 }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Performance: CTR × VTR (linhas, ambas %) ────────────────────────────────
function PerformanceChart({ data, accent }) {
  const neutral = useChartNeutral();
  const hypr = useThemeColors();
  if (!data.length) return null;
  const showDots = data.length <= 14;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={neutral.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: neutral.label, fontSize: 11 }} tickLine={false} axisLine={{ stroke: neutral.grid }} padding={{ left: 16, right: 16 }} />
        <YAxis yAxisId="ctr" tick={{ fill: neutral.label, fontSize: 10 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${Number(v).toFixed(1)}%`} padding={{ top: 8 }} />
        <YAxis yAxisId="vtr" orientation="right" tick={{ fill: neutral.label, fontSize: 10 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} padding={{ top: 8 }} />
        <RTooltip content={(p) => (
          <ChartTooltip {...p} rows={(pl) => pl.map((x) => ({
            name: x.dataKey === "ctr" ? "CTR" : "VTR",
            value: x.value == null ? "—" : `${Number(x.value).toFixed(2)}%`,
            color: x.dataKey === "ctr" ? accent : hypr.fgMuted,
          }))} />
        )} />
        <Line yAxisId="ctr" dataKey="ctr" name="CTR" type="monotone" stroke={accent} strokeWidth={2.2} dot={showDots ? { r: 3, fill: accent } : false} activeDot={{ r: 5 }} connectNulls isAnimationActive={false} />
        <Line yAxisId="vtr" dataKey="vtr" name="VTR" type="monotone" stroke={hypr.fgMuted} strokeWidth={2} strokeDasharray="5 4" dot={showDots ? { r: 3, fill: hypr.fgMuted } : false} activeDot={{ r: 5 }} connectNulls isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Mix por formato (donut) ─────────────────────────────────────────────────
function FormatDonut({ mix, accent }) {
  if (!mix.rows.length) return <EmptyChart />;
  const colors = { DISPLAY: accent, VIDEO: accent };
  const opacity = { DISPLAY: 1, VIDEO: 0.42 };
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <div className="relative shrink-0" style={{ width: 168, height: 168 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={mix.rows} dataKey="value" nameKey="label" cx="50%" cy="50%" innerRadius={54} outerRadius={80} paddingAngle={2} stroke="none" isAnimationActive={false}>
              {mix.rows.map((r) => (
                <Cell key={r.key} fill={colors[r.key]} fillOpacity={opacity[r.key]} />
              ))}
            </Pie>
            <RTooltip content={(p) => (
              <ChartTooltip {...p} rows={(pl) => pl.map((x) => ({
                name: x.name, value: formatBRL(x.value), color: accent,
              }))} />
            )} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Total</span>
          <span className="text-[15px] font-bold text-fg tabular-nums">{compactBrl(mix.total)}</span>
        </div>
      </div>
      <div className="flex-1 w-full space-y-2.5">
        {mix.rows.map((r) => {
          const pct = mix.total > 0 ? (r.value / mix.total) * 100 : 0;
          return (
            <div key={r.key} className="flex items-center gap-2.5">
              <span className="size-2.5 rounded-sm shrink-0" style={{ background: accent, opacity: opacity[r.key] }} aria-hidden />
              <span className="text-[13px] text-fg flex-1">{r.label}</span>
              <span className="text-[13px] text-fg-muted tabular-nums">{pct.toFixed(0)}%</span>
              <span className="text-[13px] font-semibold text-fg tabular-nums w-[88px] text-right">{compactBrl(r.value)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Mix por core product (barras ranqueadas) ────────────────────────────────
function CoreProductBars({ rows, accent }) {
  if (!rows.length) return <EmptyChart />;
  return (
    <div className="space-y-3.5 pt-1">
      {rows.map((r) => (
        <div key={r.tactic}>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-[13px] font-medium text-fg">{r.label}</span>
            <span className="text-[13px] font-semibold text-fg tabular-nums">{compactBrl(r.invested)}</span>
          </div>
          <div className="h-2 rounded-full bg-track overflow-hidden">
            <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, r.pct)}%`, background: accent }} />
          </div>
        </div>
      ))}
      <p className="text-[11px] text-fg-subtle pt-1">Uma campanha pode somar mais de um core product.</p>
    </div>
  );
}

// ── Brand lift mensal (relativo % + absoluto pp) ────────────────────────────
function BrandLiftSection({ monthly, accent }) {
  const neutral = useChartNeutral();
  const hypr = useThemeColors();
  const data = monthly.map((m) => ({ ...m, label: formatMonthLabel(m.month, "short") }));
  const showDots = data.length <= 14;
  return (
    <div className="space-y-5">
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={neutral.grid} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: neutral.label, fontSize: 11 }} tickLine={false} axisLine={{ stroke: neutral.grid }} padding={{ left: 16, right: 16 }} />
          <YAxis yAxisId="rel" tick={{ fill: neutral.label, fontSize: 10 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} padding={{ top: 8 }} />
          <YAxis yAxisId="abs" orientation="right" tick={{ fill: neutral.label, fontSize: 10 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${Number(v).toFixed(0)}pp`} padding={{ top: 8 }} />
          <RTooltip content={(p) => (
            <ChartTooltip {...p} rows={(pl) => pl.map((x) => ({
              name: x.dataKey === "liftRel" ? "Lift relativo" : "Lift absoluto",
              value: x.value == null ? "—" : (x.dataKey === "liftRel" ? `${Number(x.value).toFixed(1)}%` : `${Number(x.value).toFixed(1)} pp`),
              color: x.dataKey === "liftRel" ? accent : hypr.fgMuted,
            }))} />
          )} />
          <Line yAxisId="rel" dataKey="liftRel" name="Lift relativo" type="monotone" stroke={accent} strokeWidth={2.4} dot={showDots ? { r: 3, fill: accent } : false} activeDot={{ r: 5 }} connectNulls isAnimationActive={false} />
          <Line yAxisId="abs" dataKey="liftAbs" name="Lift absoluto" type="monotone" stroke={hypr.fgMuted} strokeWidth={2} strokeDasharray="5 4" dot={showDots ? { r: 3, fill: hypr.fgMuted } : false} activeDot={{ r: 5 }} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>

      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-surface-3 text-fg-muted">
              <Th className="text-left">Mês</Th>
              <Th className="text-right">Lift relativo</Th>
              <Th className="text-right">Lift absoluto</Th>
              <Th className="text-right">Respostas</Th>
            </tr>
          </thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.month} className="border-t border-border hover:bg-surface-strong transition-colors">
                <Td className="text-left text-fg">{formatMonthLabel(m.month, "long")}</Td>
                <Td className="text-right font-semibold" style={{ color: accent }}>{m.liftRel == null ? "—" : `${m.liftRel.toFixed(1)}%`}</Td>
                <Td className="text-right text-fg">{m.liftAbs == null ? "—" : `${m.liftAbs.toFixed(1)} pp`}</Td>
                <Td className="text-right text-fg-muted tabular-nums">{m.responses != null ? formatInt(m.responses) : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Tabela agregada por campanha (ordenável) ────────────────────────────────
const TABLE_COLS = [
  { key: "campaign_name", label: "Campanha", align: "left" },
  { key: "period", label: "Período", align: "left", sortable: false },
  { key: "invested", label: "Investimento", align: "right" },
  { key: "viewable_impressions", label: "Impressões", align: "right" },
  { key: "ctr", label: "CTR", align: "right" },
  { key: "vtr", label: "VTR", align: "right" },
];

function CampaignAnalyticsTable({ rows, accent }) {
  const [sortKey, setSortKey] = useState("invested");
  const [sortDir, setSortDir] = useState("desc");

  const sorted = useMemo(() => {
    const val = (c) => {
      if (sortKey === "invested") return investedOf(c);
      if (sortKey === "campaign_name") return (c.campaign_name || "").toLowerCase();
      return num(c[sortKey]);
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
    else { setSortKey(key); setSortDir(key === "campaign_name" ? "asc" : "desc"); }
  };

  const fmtRange = (c) => {
    const f = (d) => (d ? formatMonthLabel(d.slice(0, 7), "short") : "");
    const a = f(c.start_date), b = f(c.end_date);
    return a && b && a !== b ? `${a} – ${b}` : (a || b || "—");
  };

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-4 md:px-5 py-3.5 border-b border-border">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-signature">Desempenho por campanha</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-surface-3 text-fg-muted">
              {TABLE_COLS.map((col) => (
                <Th
                  key={col.key}
                  className={col.align === "right" ? "text-right" : "text-left"}
                  sortable={col.sortable !== false}
                  active={sortKey === col.key}
                  dir={sortDir}
                  onClick={col.sortable === false ? undefined : () => onSort(col.key)}
                >
                  {col.label}
                </Th>
              ))}
              <Th className="text-left">Mix</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c, i) => (
              <tr key={c.short_token || i} className="border-t border-border hover:bg-surface-strong transition-colors">
                <Td className="text-left">
                  <span className="font-medium text-fg line-clamp-1">{c.campaign_name || "—"}</span>
                </Td>
                <Td className="text-left text-fg-muted whitespace-nowrap">{fmtRange(c)}</Td>
                <Td className="text-right font-semibold text-fg tabular-nums">{compactBrl(investedOf(c))}</Td>
                <Td className="text-right text-fg tabular-nums">{formatIntCompact(num(c.viewable_impressions))}</Td>
                <Td className="text-right tabular-nums" style={{ color: accent }}>{c.ctr != null ? `${Number(c.ctr).toFixed(2)}%` : "—"}</Td>
                <Td className="text-right text-fg tabular-nums">{c.vtr != null ? `${Number(c.vtr).toFixed(1)}%` : "—"}</Td>
                <Td className="text-left">
                  <div className="flex flex-wrap gap-1">
                    {(c.media || []).map((m) => <MixChip key={m} label={m === "VIDEO" ? "Vídeo" : "Display"} />)}
                    {(c.tactics || []).map((t) => <MixChip key={t} label={CORE_LABELS[t] || t} soft />)}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MixChip({ label, soft }) {
  return (
    <span className={cn(
      "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide",
      soft ? "bg-surface-strong text-fg-muted" : "bg-signature-soft text-signature",
    )}>
      {label}
    </span>
  );
}

function Th({ children, className, sortable, active, dir, onClick }) {
  return (
    <th
      onClick={onClick}
      className={cn(
        "px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider whitespace-nowrap select-none",
        sortable && "cursor-pointer hover:text-fg",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortable && active && (
          <span className="text-signature" aria-hidden>{dir === "asc" ? "▲" : "▼"}</span>
        )}
      </span>
    </th>
  );
}

function Td({ children, className, style }) {
  return <td className={cn("px-3 py-2.5", className)} style={style}>{children}</td>;
}

function EmptyChart() {
  return (
    <div className="h-[168px] flex items-center justify-center">
      <p className="text-[12px] text-fg-subtle">Sem dados para os filtros atuais.</p>
    </div>
  );
}
