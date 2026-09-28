// src/v2/admin/pages/DoubleVerifyPage.jsx
//
// Seção DoubleVerify do admin: os Key Quality Indicators do Pinnacle
// (Viewable, Authentic Viewable, Authentic, Brand Suitable, Fraud/SIVT Free,
// In Geo) + o "At a Glance" (Filters, Blocks, Incidents), filtráveis por Brand
// Name e Campaign Name — o mesmo recorte do Pinnacle, sem sair do hub.
//
// Acesso: qualquer admin (@hypr.mobi), sem lista de editores — diferente do
// PMP Deals, aqui não há dado comercial de deal, só verificação de mídia.
//
// Um fetch por período (backend `dv_quality`, contagens Brand × Campaign × Dia
// do período e do anterior). Filtro e agregação rodam aqui, em memória — ver
// lib/dvQuality.js pra por que isso dá número exato.

import { useEffect, useMemo, useRef, useState } from "react";
import { AdminShell } from "../shell/AdminShell";
import { PageHeader, MetaDot, MetaStat } from "../shell/PageHeader";
import { SECTION_DV, viewMeta, buildNavCounts } from "../shell/navConfig";
import {
  FilterBar, FilterPanel, FilterOption, FilterPanelClear,
} from "../components/FilterBar";
import { PeriodPicker } from "../components/PeriodPicker";
import { PERIOD_PRESETS, resolvePeriod } from "../lib/period";
import {
  KQI_DEFS, GLANCE_DEFS, summarize, filterOptions,
  formatRate, formatDelta, formatCompact,
} from "../lib/dvQuality";
import { getDvQuality } from "../../../lib/api";
import { Button } from "../../../ui/Button";
import { Skeleton } from "../../../ui/Skeleton";
import { cn } from "../../../ui/cn";
import {
  TooltipProvider, Tooltip, TooltipTrigger, TooltipContent,
} from "../../../ui/Tooltip";
import "../../v2.css";

const DV_PRESETS = PERIOD_PRESETS.filter((p) => p.id !== "now");
const nf = new Intl.NumberFormat("pt-BR");

function fmtDay(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(-2)}`;
}

// ─── Página ──────────────────────────────────────────────────────────────
export default function DoubleVerifyPage({ user, onLogout, layout, onNavigateView }) {
  const meta = viewMeta(SECTION_DV, layout);
  const navCounts = useMemo(() => buildNavCounts({}), []);

  const [preset, setPreset] = useState("30d");
  const [custom, setCustom] = useState({ from: null, to: null });
  const { from, to } = resolvePeriod(preset, custom);

  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [reloadKey, setReloadKey] = useState(0);
  const refreshRef = useRef(false);

  const [brands, setBrands] = useState([]);       // índices em data.brands
  const [campaigns, setCampaigns] = useState([]); // índices em data.campaigns
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (preset === "custom" && (!from || !to)) return;
    let cancelled = false;
    const refresh = refreshRef.current;
    refreshRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- início de fetch
    setState((s) => ({ ...s, loading: true, error: null }));
    getDvQuality({ from, to, refresh })
      .then((data) => {
        if (cancelled) return;
        // Índices mudam a cada payload: filtro velho apontaria pra outra brand.
        setBrands([]);
        setCampaigns([]);
        setState({ loading: false, error: null, data });
      })
      .catch((error) => {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error }));
      });
    return () => { cancelled = true; };
  }, [preset, from, to, reloadKey]);

  const data = state.data;
  const summary = useMemo(
    () => (data ? summarize(data, { brands, campaigns }) : null),
    [data, brands, campaigns],
  );
  const options = useMemo(
    () => (data ? filterOptions(data, brands) : { brands: [], campaigns: [] }),
    [data, brands],
  );

  const onRefresh = () => { refreshRef.current = true; setReloadKey((k) => k + 1); };

  // ── Filtros ────────────────────────────────────────────────────────────
  const toggle = (list, setList, id) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const chipValue = (ids, labelOf) =>
    ids.length === 0 ? undefined
      : ids.length === 1 ? labelOf(ids[0])
      : `${labelOf(ids[0])} +${ids.length - 1}`;

  const brandLabel = (i) => data?.brands[i] ?? "";
  const campaignLabel = (i) => data?.campaigns[i]?.name ?? "";

  const onBrandsChange = (next) => {
    setBrands(next);
    // Campanha de brand que saiu do filtro vira seleção invisível — descarta.
    if (next.length && data) {
      const keep = new Set(next);
      setCampaigns((cs) => cs.filter((c) => keep.has(data.campaigns[c]?.brand)));
    }
  };

  const chips = data ? [
    {
      id: "brand",
      label: "Brand Name",
      align: "end",
      panelClassName: "w-[min(92vw,340px)]",
      value: chipValue(brands, brandLabel),
      panel: () => (
        <SearchablePanel
          title="Brand Name"
          items={options.brands}
          selected={brands}
          onToggle={(id) => onBrandsChange(brands.includes(id) ? brands.filter((x) => x !== id) : [...brands, id])}
          onClear={() => onBrandsChange([])}
          placeholder="Buscar brand…"
        />
      ),
    },
    {
      id: "campaign",
      label: "Campaign Name",
      align: "end",
      panelClassName: "w-[min(92vw,480px)]",
      value: chipValue(campaigns, campaignLabel),
      panel: () => (
        <SearchablePanel
          title="Campaign Name"
          items={options.campaigns}
          selected={campaigns}
          onToggle={(id) => toggle(campaigns, setCampaigns, id)}
          onClear={() => setCampaigns([])}
          placeholder="Buscar campanha…"
          showBrand={brands.length !== 1}
        />
      ),
    },
  ] : [];

  const active = [
    ...brands.map((i) => ({ id: `b${i}`, label: `Brand · ${brandLabel(i)}`, onClear: () => onBrandsChange(brands.filter((x) => x !== i)) })),
    ...campaigns.map((i) => ({ id: `c${i}`, label: `Campanha · ${campaignLabel(i)}`, onClear: () => setCampaigns(campaigns.filter((x) => x !== i)) })),
  ];

  const tableRows = useMemo(() => {
    if (!summary) return [];
    const q = search.trim().toLowerCase();
    if (!q) return summary.campaigns;
    return summary.campaigns.filter((c) =>
      c.name.toLowerCase().includes(q) || c.brand.toLowerCase().includes(q));
  }, [summary, search]);

  const firstLoad = state.loading && !data;

  return (
    <TooltipProvider delayDuration={150}>
      <AdminShell
        section={SECTION_DV}
        layout={layout}
        navCounts={navCounts}
        onNavigate={onNavigateView}
        viewLabel={meta?.label}
        tally={summary ? `${summary.campaigns.length} campanhas` : undefined}
        busy={state.loading && !!data}
        user={user}
        onLogout={onLogout}
        actions={
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={state.loading}>
            Atualizar
          </Button>
        }
      >
        <PageHeader
          eyebrow={`DoubleVerify · ${meta?.label || ""}`}
          title="Qualidade de mídia"
          meta={
            data ? (
              <>
                <span>{fmtDay(data.from)} → {fmtDay(data.to)}</span>
                <MetaDot />
                <span>vs. {fmtDay(data.prev_from)} → {fmtDay(data.prev_to)}</span>
                <MetaDot />
                <MetaStat value={data.brands.length} label="brands" />
                <MetaDot />
                <span>Fonte: DV Pinnacle · Standard · D-1</span>
              </>
            ) : (
              <span>Fonte: DV Pinnacle · Standard</span>
            )
          }
          actions={
            <PeriodPicker
              preset={preset}
              onPresetChange={setPreset}
              custom={custom}
              onCustomChange={setCustom}
              presets={DV_PRESETS}
            />
          }
        />

        {state.error && (
          <div role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-fg">
            <span className="font-semibold">Não foi possível carregar o DoubleVerify.</span>{" "}
            <span className="text-fg-muted">{state.error.message}</span>
          </div>
        )}

        {data && (
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Buscar na tabela de campanhas…"
            chips={chips}
            active={active}
            onClearAll={() => { setBrands([]); setCampaigns([]); }}
            resultLabel={summary ? `${nf.format(summary.totals.monitored_ads)} monitored ads no recorte` : undefined}
          />
        )}

        {firstLoad ? (
          <LoadingState />
        ) : summary ? (
          <div className={cn("space-y-4 mt-3 transition-opacity", state.loading && "opacity-60")}>
            {summary.totals.monitored_ads === 0 && summary.totals.requests === 0 ? (
              <EmptyState />
            ) : (
              <>
                <div className="grid gap-4 lg:grid-cols-[minmax(240px,300px)_1fr]">
                  <GlanceCard summary={summary} />
                  <KqiCard summary={summary} />
                </div>
                <CampaignTable rows={tableRows} />
              </>
            )}
          </div>
        ) : null}
      </AdminShell>
    </TooltipProvider>
  );
}

// ─── Painel de filtro com busca ──────────────────────────────────────────
function SearchablePanel({ title, items, selected, onToggle, onClear, placeholder, showBrand }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? items.filter((it) => it.label.toLowerCase().includes(t) || it.brand?.toLowerCase().includes(t)) : items;
  }, [items, q]);
  return (
    <FilterPanel
      title={title}
      maxHeight={340}
      footer={<FilterPanelClear onClear={onClear} disabled={!selected.length} />}
    >
      <input
        type="search"
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="mb-1.5 w-full h-8 px-2.5 rounded-md bg-surface border border-border text-[12.5px] text-fg placeholder:text-fg-subtle outline-none focus:border-signature"
      />
      {shown.length === 0 && (
        <div className="px-2 py-3 text-xs text-fg-subtle">Nada encontrado.</div>
      )}
      {shown.map((it) => (
        <FilterOption
          key={it.id}
          multi
          label={it.label}
          sub={showBrand ? it.brand : undefined}
          count={formatCompact(it.volume)}
          selected={selected.includes(it.id)}
          onSelect={() => onToggle(it.id)}
        />
      ))}
    </FilterPanel>
  );
}

// ─── Variação vs. período anterior ───────────────────────────────────────
// `higherIsBetter` decide a cor: nos KQIs subir é bom; em Blocks/Incidents
// subir é ruim. A seta e o texto carregam a direção sem depender da cor.
function Delta({ value, higherIsBetter = true }) {
  const d = formatDelta(value);
  if (!d) return <span className="text-[11px] text-fg-subtle" title="Sem dado no período anterior">sem histórico</span>;
  const good = d.dir === "flat" ? null : (d.dir === "up") === higherIsBetter;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums",
        good == null ? "text-fg-subtle" : good ? "text-success" : "text-danger",
      )}
    >
      <span aria-hidden="true">{d.dir === "up" ? "▲" : d.dir === "down" ? "▼" : "▬"}</span>
      <span className="sr-only">{d.dir === "up" ? "subiu" : d.dir === "down" ? "caiu" : "estável"}</span>
      {d.text}
    </span>
  );
}

// ─── At a Glance ─────────────────────────────────────────────────────────
function GlanceCard({ summary }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-bold text-fg mb-4">At a Glance</h2>
      <dl className="space-y-4">
        {GLANCE_DEFS.map((g) => {
          const rate = summary.rates[g.key];
          const den = summary.totals[g.den] || 0;
          return (
            <div key={g.key}>
              <dt className="text-xs text-fg-muted">{g.label}</dt>
              <dd className="flex items-baseline gap-2 flex-wrap">
                <span className="text-xl font-extrabold tabular-nums text-fg">
                  {rate == null ? "N/A" : formatRate(rate)}
                </span>
                {rate != null && <Delta value={summary.deltas[g.key]} higherIsBetter={false} />}
              </dd>
              <dd className="text-[11px] text-fg-subtle tabular-nums">
                {den ? `${formatCompact(den)} ${g.denLabel}` : `Sem ${g.denLabel.toLowerCase()} no período`}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

// ─── Key Quality Indicators ──────────────────────────────────────────────
function KqiCard({ summary }) {
  return (
    <section className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="p-5">
        <h2 className="text-sm font-bold text-fg mb-4">Key Quality Indicators</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-x-3 gap-y-5">
          {KQI_DEFS.map((k) => (
            <KqiRing
              key={k.key}
              label={k.label}
              rate={summary.rates[k.key]}
              delta={summary.deltas[k.key]}
              num={summary.totals[k.num] || 0}
              den={summary.totals[k.den] || 0}
              denLabel={k.den === "measured_impressions" ? "Measured Impressions" : "Monitored Ads"}
            />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 border-t border-border">
        <FooterStat label="Monitored Ads" value={summary.totals.monitored_ads} />
        <FooterStat label="Measured Impressions" value={summary.totals.measured_impressions} className="border-l border-border" />
      </div>
    </section>
  );
}

function FooterStat({ label, value, className }) {
  return (
    <div className={cn("px-5 py-3", className)}>
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="text-lg font-bold tabular-nums text-fg" title={nf.format(value)}>{formatCompact(value)}</div>
    </div>
  );
}

// Anel = medidor de uma taxa contra 100%. Um matiz só (signature): os seis
// anéis são a mesma grandeza, cor por KQI só inventaria identidade.
function KqiRing({ label, rate, delta, num, den, denLabel }) {
  const R = 34;
  const C = 2 * Math.PI * R;
  const pct = rate == null ? 0 : Math.max(0, Math.min(1, rate));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          className="flex flex-col items-center text-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-signature"
          aria-label={`${label}: ${formatRate(rate)}`}
        >
          <div className="relative size-[92px]">
            <svg viewBox="0 0 80 80" className="size-full -rotate-90" aria-hidden="true">
              <circle cx="40" cy="40" r={R} fill="none" strokeWidth="6" className="stroke-surface-strong" />
              {rate != null && (
                <circle
                  cx="40" cy="40" r={R} fill="none" strokeWidth="6" strokeLinecap="round"
                  className="stroke-signature transition-[stroke-dashoffset] duration-500"
                  strokeDasharray={C}
                  strokeDashoffset={C * (1 - pct)}
                />
              )}
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-lg font-extrabold tabular-nums text-fg leading-none">{formatRate(rate)}</span>
              {rate != null && <span className="mt-1"><Delta value={delta} /></span>}
            </div>
          </div>
          <div className="mt-2 text-xs font-semibold text-fg leading-tight">{label}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs tabular-nums">
          <div className="font-semibold mb-0.5">{label}</div>
          {den ? (
            <div>{nf.format(num)} de {nf.format(den)} {denLabel}</div>
          ) : (
            <div>Sem {denLabel.toLowerCase()} no recorte</div>
          )}
          <div className="text-fg-subtle mt-0.5">Variação em p.p. vs. período anterior</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Tabela por campanha ─────────────────────────────────────────────────
const TABLE_COLS = [
  { key: "monitored_ads", label: "Monitored Ads", kind: "count" },
  { key: "measured_impressions", label: "Measured Imps", kind: "count" },
  ...KQI_DEFS.map((k) => ({ key: k.key, label: k.label, kind: "rate" })),
  { key: "blocks", label: "Block Rate", kind: "rate" },
  { key: "incidents", label: "Incident Rate", kind: "rate" },
];

function cellValue(row, col) {
  return col.kind === "count" ? row.totals[col.key] : row.rates[col.key];
}

function CampaignTable({ rows }) {
  const [sort, setSort] = useState({ key: "monitored_ads", dir: "desc" });
  const sorted = useMemo(() => {
    const col = TABLE_COLS.find((c) => c.key === sort.key);
    const sign = sort.dir === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => {
      const va = col ? cellValue(a, col) : a.name;
      const vb = col ? cellValue(b, col) : b.name;
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va > vb ? 1 : va < vb ? -1 : 0) * sign;
    });
  }, [rows, sort]);

  const onSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));

  return (
    <section className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-fg">Por campanha</h2>
        <span className="text-[11px] text-fg-subtle">{rows.length} campanhas</span>
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left text-fg-muted">
              <th className="px-4 py-2 font-semibold min-w-[260px]">Campanha</th>
              {TABLE_COLS.map((c) => (
                <th key={c.key} className="px-3 py-2 font-semibold text-right whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => onSort(c.key)}
                    className="inline-flex items-center gap-1 cursor-pointer bg-transparent border-0 p-0 text-inherit font-inherit hover:text-fg"
                    aria-label={`Ordenar por ${c.label}`}
                  >
                    {c.label}
                    {sort.key === c.key && <span aria-hidden="true">{sort.dir === "desc" ? "↓" : "↑"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="border-t border-border hover:bg-surface-strong/50">
                <td className="px-4 py-2 max-w-[420px]">
                  <div className="font-semibold text-fg truncate" title={r.name}>{r.name}</div>
                  <div className="text-[11px] text-fg-subtle truncate">{r.brand}</div>
                </td>
                {TABLE_COLS.map((c) => {
                  const v = cellValue(r, c);
                  return (
                    <td key={c.key} className="px-3 py-2 text-right text-fg whitespace-nowrap">
                      {c.kind === "count" ? (v ? formatCompact(v) : "—") : formatRate(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={TABLE_COLS.length + 1} className="px-4 py-6 text-center text-fg-subtle">Nenhuma campanha no recorte.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Estados ─────────────────────────────────────────────────────────────
function LoadingState() {
  return (
    <div className="space-y-4 mt-3" aria-busy="true">
      <div className="grid gap-4 lg:grid-cols-[minmax(240px,300px)_1fr]">
        <Skeleton className="h-[280px] rounded-xl" />
        <Skeleton className="h-[280px] rounded-xl" />
      </div>
      <Skeleton className="h-[320px] rounded-xl" />
      <p className="text-xs text-fg-subtle">Gerando relatório no DoubleVerify — costuma levar de 5 a 20 segundos.</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-10 text-center">
      <div className="text-sm font-semibold text-fg">Sem dados do DoubleVerify no recorte</div>
      <div className="text-xs text-fg-muted mt-1">Troque o período ou limpe os filtros.</div>
    </div>
  );
}
