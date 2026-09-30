// src/v2/admin/pages/DspAnalyticsPage.jsx
//
// Analytics › Saúde das DSPs. Performance e custo de todas as campanhas por
// DSP (DV360, Yahoo, Amazon, StackAdapt; Xandr DSP no histórico), com
// recortes por formato, ABS, survey, cliente, campanha, IO e line.
//
// Existe pra acompanhar a evolução das DSPs mês a mês e ter argumento de
// investimento. O popover "Saúde das DSPs" do rail segue como alarme de
// volume D-1; esta página é a análise.
//
// Um fetch por período (backend `dsp_analytics`: série diária, período
// anterior e lines agregadas). Todo o resto roda em memória
// (lib/dspAnalytics.js), então qualquer filtro reage na hora e KPIs, cards,
// gráfico e tabelas sempre somam as mesmas linhas. Única ida extra ao
// servidor: a série diária quando o filtro é por line.

import { useMemo, useRef, useState, useEffect } from "react";
import { AdminShell } from "../shell/AdminShell";
import { PageHeader, MetaDot, MetaStat } from "../shell/PageHeader";
import { SECTION_ANALYTICS, viewMeta, buildNavCounts } from "../shell/navConfig";
import { FilterBar, FilterPanel, FilterOption, FilterPanelClear } from "../components/FilterBar";
import { PeriodPicker } from "../components/PeriodPicker";
import { Switch } from "../components/AbsToggle";
import { ANALYTICS_PERIOD_PRESETS, resolvePeriod } from "../lib/period";
import {
  decodePayload, decodeLineDaily, DEFAULT_FILTERS, filterRows, hasLineFilter, aggregate,
  buildTimeseries, buildMonthly, autoGranularity, enrichLines, buildScorecards, buildAbsCost,
  buildFormatMatrix, buildDataQuality, buildFilterOptions, pruneFilters, sparkBySource,
} from "../lib/dspAnalytics";
import { getDspAnalytics, getDspAnalyticsLineDaily } from "../../../lib/api";
import { sortSources, dspLabel } from "../../../shared/dspMeta";
import { SegmentedControlV2 } from "../../components/SegmentedControlV2";
import { Button } from "../../../ui/Button";
import { Skeleton } from "../../../ui/Skeleton";
import { TooltipProvider } from "../../../ui/Tooltip";
import { cn } from "../../../ui/cn";
import {
  KpiGrid, DspScorecards, AbsCostCard, FormatMatrix, DataQualityCard,
} from "../components/dspAnalytics/DspSummaryCards";
import { DspEvolutionChart } from "../components/dspAnalytics/DspEvolutionChart";
import { DspLinesTable } from "../components/dspAnalytics/DspLinesTable";
import { DspMonthlyTable } from "../components/dspAnalytics/DspMonthlyTable";
import { downloadDspAnalyticsXlsx } from "../lib/dspAnalyticsExport";
import { fmtDay, fmtCompact } from "../components/dspAnalytics/dspFormat";
import "../../v2.css";

const MEDIA_OPTIONS = [
  { value: "all", label: "Todos" },
  { value: "DISPLAY", label: "Display" },
  { value: "VIDEO", label: "Vídeo" },
];
const ABS_OPTIONS = [
  { value: "all", label: "Todos" },
  { value: "abs", label: "Com ABS" },
  { value: "noabs", label: "Sem ABS" },
];

export default function DspAnalyticsPage({ user, onLogout, layout, onNavigateView, onOpenReport }) {
  const meta = viewMeta(SECTION_ANALYTICS, layout);
  const navCounts = useMemo(() => buildNavCounts({}), []);

  // ── Período ────────────────────────────────────────────────────────────
  const [preset, setPreset] = useState("30d");
  const [custom, setCustom] = useState({ from: null, to: null });
  const { from, to } = resolvePeriod(preset, custom);
  const [granularity, setGranularity] = useState(null); // null = automática

  // ── Fetch principal ────────────────────────────────────────────────────
  // Resultado carimbado com a chave que o produziu: loading é DERIVADO
  // (res.key !== key) em vez de setState síncrono no effect.
  const [reloadKey, setReloadKey] = useState(0);
  const refreshRef = useRef(false);
  const ready = preset !== "custom" || (from && to);
  const fetchKey = `${from}|${to}|${reloadKey}`;
  const [res, setRes] = useState(null); // { key, data, error }

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const refresh = refreshRef.current;
    refreshRef.current = false;
    getDspAnalytics({ from, to, refresh })
      .then((payload) => { if (!cancelled) setRes({ key: fetchKey, data: decodePayload(payload), error: null }); })
      .catch((error) => { if (!cancelled) setRes((r) => ({ key: fetchKey, data: r?.data || null, error })); });
    return () => { cancelled = true; };
  }, [from, to, ready, fetchKey]);

  const loading = ready && res?.key !== fetchKey;
  const data = res?.data || null;
  const error = res?.key === fetchKey ? res.error : null;

  // ── Filtros ────────────────────────────────────────────────────────────
  const [rawFilters, setFilters] = useState(DEFAULT_FILTERS);
  // Troca de período muda o universo: seleção que não existe mais é podada
  // na leitura (sem effect), e reaparece se o período voltar.
  const filters = useMemo(
    () => (data ? pruneFilters(rawFilters, data.lines) : rawFilters),
    [rawFilters, data],
  );
  const setF = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const toggleIn = (key, value) => setFilters((f) => ({
    ...f, [key]: f[key].includes(value) ? f[key].filter((x) => x !== value) : [...f[key], value],
  }));

  const [search, setSearch] = useState("");
  const [metric, setMetric] = useState("imp");
  const [mode, setMode] = useState("source");
  const [lineTab, setLineTab] = useState("volume");
  const [flagFilter, setFlagFilter] = useState(null);
  const linesRef = useRef(null);

  const effGranularity = granularity || autoGranularity(data?.from || from, data?.to || to);
  const lineScoped = hasLineFilter(filters);

  // ── Série diária das lines filtradas ───────────────────────────────────
  const lineReq = useMemo(
    () => (lineScoped && data ? { from: data.from, to: data.to, keys: filters.lines.slice(0, 50) } : null),
    [lineScoped, data, filters.lines],
  );
  const lineFetchKey = lineReq ? `${lineReq.from}|${lineReq.to}|${lineReq.keys.join(",")}` : null;
  const [lineRes, setLineRes] = useState(null); // { key, rows, error }
  useEffect(() => {
    if (!lineReq) return;
    let cancelled = false;
    const key = `${lineReq.from}|${lineReq.to}|${lineReq.keys.join(",")}`;
    getDspAnalyticsLineDaily(lineReq)
      .then((p) => { if (!cancelled) setLineRes({ key, rows: decodeLineDaily(p), error: null }); })
      .catch((e) => { if (!cancelled) setLineRes({ key, rows: [], error: e }); });
    return () => { cancelled = true; };
  }, [lineReq]);
  const lineDaily = lineRes?.key === lineFetchKey ? lineRes : null;

  // ── Modelo ─────────────────────────────────────────────────────────────
  const model = useMemo(() => {
    if (!data) return null;
    const lines = filterRows(data.lines, filters);
    const totals = aggregate(lines);
    const prev = lineScoped ? null : aggregate(filterRows(data.prev, filters));

    let seriesRows;
    if (lineScoped) {
      const byKey = new Map(data.lines.map((l) => [l.key, l]));
      seriesRows = (lineDaily?.rows || [])
        .filter((r) => byKey.has(r.key))
        .map((r) => ({ ...r, s: byKey.get(r.key).s, m: byKey.get(r.key).m }));
    } else {
      seriesRows = filterRows(data.series, filters);
    }
    const chartSources = sortSources([...new Set(seriesRows.map((r) => r.s))]);
    return {
      lines,
      enriched: enrichLines(lines),
      totals,
      prev,
      buckets: buildTimeseries(seriesRows, data.dates, effGranularity),
      chartSources,
      spark: sparkBySource(seriesRows, data.dates),
      seriesRows,
      cards: buildScorecards(lines, data.sources),
      absCost: buildAbsCost(filterRows(data.lines, filters, { abs: true })),
      matrix: buildFormatMatrix(lines),
      quality: buildDataQuality(lines, data.landings, data.to),
      options: buildFilterOptions(data.lines, filters),
    };
  }, [data, filters, lineScoped, lineDaily, effGranularity]);

  // Mês a mês segue a métrica do gráfico; separado do modelo pra trocar de
  // métrica não refazer o resto.
  const monthly = useMemo(
    () => (model ? buildMonthly(model.seriesRows, data.dates, metric) : null),
    [model, data, metric],
  );

  const [exporting, setExporting] = useState(false);
  const onExport = async () => {
    if (!model || exporting) return;
    setExporting(true);
    try {
      await downloadDspAnalyticsXlsx({ lines: model.enriched, cards: model.cards, from: data.from, to: data.to });
    } finally {
      setExporting(false);
    }
  };

  const onRefresh = () => { refreshRef.current = true; setReloadKey((k) => k + 1); };
  const onPresetChange = (p) => { setPreset(p); setGranularity(null); };
  const onCustomChange = (c) => { setCustom(c); setGranularity(null); };
  const showFlag = (flag) => {
    setLineTab("flags");
    setFlagFilter(flag);
    linesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // ── Chips de filtro ────────────────────────────────────────────────────
  const opts = model?.options;
  const labelOf = (list, id) => list?.find((o) => o.id === id)?.label ?? id;
  const chipValue = (ids, list) =>
    ids.length === 0 ? undefined
      : ids.length === 1 ? labelOf(list, ids[0])
      : `${labelOf(list, ids[0])} +${ids.length - 1}`;

  const sourceOptions = (data?.sources || []).map((s) => ({ id: s, label: dspLabel(s) }));

  const chips = data ? [
    {
      id: "dsp", label: "DSP", align: "start",
      value: chipValue(filters.sources, sourceOptions),
      panel: () => (
        <FilterPanel title="DSP" footer={<FilterPanelClear onClear={() => setF({ sources: [] })} disabled={!filters.sources.length} />}>
          {sourceOptions.map((o) => (
            <FilterOption key={o.id} multi label={o.label} selected={filters.sources.includes(o.id)} onSelect={() => toggleIn("sources", o.id)} />
          ))}
        </FilterPanel>
      ),
    },
    searchableChip("client", "Cliente", "clients", opts?.clients, "Buscar cliente…", 340),
    searchableChip("campaign", "Campanha", "campaigns", opts?.campaigns, "Buscar campanha ou token…", 420),
    searchableChip("io", "IO / Campaign DSP", "ios", opts?.ios, "Buscar IO…", 420),
    searchableChip("line", "Line", "lines", opts?.lines, "Buscar line…", 520),
  ] : [];

  function searchableChip(id, label, key, items, placeholder, width) {
    return {
      id, label, align: "end",
      panelClassName: `w-[min(92vw,${width}px)]`,
      value: chipValue(filters[key], items),
      panel: () => (
        <SearchablePanel
          title={label}
          items={items || []}
          selected={filters[key]}
          onToggle={(v) => toggleIn(key, v)}
          onClear={() => setF({ [key]: [] })}
          placeholder={placeholder}
          note={key === "lines" ? "Com line selecionada o gráfico busca a série diária dela (até 50)." : null}
        />
      ),
    };
  }

  const active = [
    ...filters.sources.map((s) => ({ id: `s${s}`, label: `DSP · ${dspLabel(s)}`, onClear: () => toggleIn("sources", s) })),
    ...(filters.media !== "all" ? [{ id: "media", label: `Formato · ${filters.media === "VIDEO" ? "Vídeo" : "Display"}`, onClear: () => setF({ media: "all" }) }] : []),
    ...(filters.abs !== "all" ? [{ id: "abs", label: filters.abs === "abs" ? "Com ABS" : "Sem ABS", onClear: () => setF({ abs: "all" }) }] : []),
    ...(!filters.includeSurvey ? [{ id: "sv", label: "Sem survey", onClear: () => setF({ includeSurvey: true }) }] : []),
    ...filters.clients.map((c) => ({ id: `c${c}`, label: `Cliente · ${c}`, onClear: () => toggleIn("clients", c) })),
    ...filters.campaigns.map((c) => ({ id: `k${c}`, label: `Campanha · ${labelOf(opts?.campaigns, c)}`, onClear: () => toggleIn("campaigns", c) })),
    ...filters.ios.map((c) => ({ id: `i${c}`, label: `IO · ${c || "(sem IO)"}`, onClear: () => toggleIn("ios", c) })),
    ...filters.lines.map((c) => ({ id: `l${c}`, label: `Line · ${labelOf(opts?.lines, c)}`, onClear: () => toggleIn("lines", c) })),
  ];

  const firstLoad = loading && !data;
  const empty = model && model.totals.imp === 0 && model.totals.cost === 0;

  return (
    <TooltipProvider delayDuration={150}>
      <AdminShell
        section={SECTION_ANALYTICS}
        layout={layout}
        navCounts={navCounts}
        onNavigate={onNavigateView}
        viewLabel={meta?.label}
        tally={model ? `${model.lines.length} lines` : undefined}
        busy={loading && !!data}
        user={user}
        onLogout={onLogout}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={onExport} disabled={!model || exporting}>
              {exporting ? "Exportando…" : "Exportar XLSX"}
            </Button>
            <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
              Atualizar
            </Button>
          </>
        }
      >
        <PageHeader
          eyebrow={`Analytics · ${meta?.label || ""}`}
          title="Saúde das DSPs"
          meta={
            data ? (
              <>
                <span>{fmtDay(data.from)} → {fmtDay(data.to)}</span>
                <MetaDot />
                <span>vs. {fmtDay(data.prevFrom)} → {fmtDay(data.prevTo)}</span>
                <MetaDot />
                <MetaStat value={data.sources.length} label="DSPs" />
                <MetaDot />
                <span>Consolidado diário · D-1 · custo em BRL com fees</span>
              </>
            ) : (
              <span>Consolidado diário · D-1</span>
            )
          }
          actions={
            <PeriodPicker
              preset={preset}
              onPresetChange={onPresetChange}
              custom={custom}
              onCustomChange={onCustomChange}
              presets={ANALYTICS_PERIOD_PRESETS}
            />
          }
        />

        {error && (
          <div role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-fg">
            <span className="font-semibold">Não foi possível carregar o analytics das DSPs.</span>{" "}
            <span className="text-fg-muted">{error.message}</span>
          </div>
        )}

        {data && (
          <>
            <FilterBar
              search={search}
              onSearchChange={setSearch}
              searchPlaceholder="Buscar line, campanha, cliente ou IO na tabela…"
              chips={chips}
              active={active}
              onClearAll={() => setFilters(DEFAULT_FILTERS)}
              resultLabel={model ? `${fmtCompact(model.totals.imp)} imps · ${model.lines.length} lines no recorte` : undefined}
            />
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
              <ControlGroup label="Formato">
                <SegmentedControlV2 label="Formato" options={MEDIA_OPTIONS} value={filters.media} onChange={(v) => setF({ media: v })} />
              </ControlGroup>
              <ControlGroup label="ABS">
                <SegmentedControlV2 label="ABS" options={ABS_OPTIONS} value={filters.abs} onChange={(v) => setF({ abs: v })} />
              </ControlGroup>
              <label className="inline-flex items-center gap-2 text-xs text-fg-muted cursor-pointer select-none">
                <Switch
                  checked={filters.includeSurvey}
                  onClick={() => setF({ includeSurvey: !filters.includeSurvey })}
                />
                <span>Incluir survey/controle</span>
              </label>
            </div>
          </>
        )}

        {firstLoad ? (
          <LoadingState />
        ) : model ? (
          <div className={cn("space-y-4 mt-4 transition-opacity", loading && "opacity-60")}>
            {empty ? (
              <EmptyState />
            ) : (
              <>
                <KpiGrid totals={model.totals} prev={model.prev} noDelta={lineScoped} />
                <DspScorecards
                  cards={model.cards}
                  spark={model.spark}
                  freshness={model.quality.freshness}
                  selected={filters.sources}
                  onToggleSource={(s) => toggleIn("sources", s)}
                />
                <DspEvolutionChart
                  buckets={model.buckets}
                  sources={model.chartSources}
                  metric={metric}
                  onMetricChange={setMetric}
                  granularity={effGranularity}
                  onGranularityChange={setGranularity}
                  mode={mode}
                  onModeChange={setMode}
                  filename={`saude-dsps-${metric}-${data.from}-${data.to}`}
                  lineScoped={lineScoped}
                />
                <DspMonthlyTable monthly={monthly} metric={metric} />
                <AbsCostCard rows={model.absCost} absClients={data.absClients} />
                <FormatMatrix rows={model.matrix} absMode={filters.abs} />
                <div ref={linesRef} className="scroll-mt-24">
                  <DspLinesTable
                    lines={model.enriched}
                    tab={lineTab}
                    onTabChange={(t) => { setLineTab(t); if (t !== "flags") setFlagFilter(null); }}
                    search={search}
                    onOpenReport={onOpenReport}
                    flagFilter={flagFilter}
                    onFlagFilterChange={setFlagFilter}
                  />
                </div>
                <DataQualityCard quality={model.quality} onShowFlag={showFlag} />
              </>
            )}
          </div>
        ) : null}
      </AdminShell>
    </TooltipProvider>
  );
}

function ControlGroup({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <span className="lbl-section">{label}</span>
      {children}
    </div>
  );
}

// ─── Painel de filtro com busca ──────────────────────────────────────────
function SearchablePanel({ title, items, selected, onToggle, onClear, placeholder, note }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = t
      ? items.filter((it) => String(it.label).toLowerCase().includes(t)
          || String(it.id).toLowerCase().includes(t)
          || it.sub?.toLowerCase().includes(t))
      : items;
    return list.slice(0, 200);
  }, [items, q]);
  return (
    <FilterPanel
      title={title}
      maxHeight={360}
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
      {note && <div className="px-2 pb-1.5 text-[11px] text-fg-subtle">{note}</div>}
      {shown.length === 0 && <div className="px-2 py-3 text-xs text-fg-subtle">Nada encontrado.</div>}
      {shown.map((it) => (
        <FilterOption
          key={it.id}
          multi
          label={it.label || "(sem nome)"}
          sub={it.sub}
          count={fmtCompact(it.volume)}
          selected={selected.includes(it.id)}
          onSelect={() => onToggle(it.id)}
        />
      ))}
      {items.length > shown.length && !q && (
        <div className="px-2 py-2 text-[11px] text-fg-subtle">Mostrando as 200 maiores. Busque para achar as demais.</div>
      )}
    </FilterPanel>
  );
}

// ─── Estados ─────────────────────────────────────────────────────────────
function LoadingState() {
  return (
    <div className="space-y-4 mt-4" aria-busy="true">
      <Skeleton className="h-[170px] rounded-xl" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[260px] rounded-xl" />)}
      </div>
      <Skeleton className="h-[380px] rounded-xl" />
      <p className="text-xs text-fg-subtle">Somando a entrega de todas as DSPs no período…</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-10 text-center">
      <div className="text-sm font-semibold text-fg">Sem entrega no recorte</div>
      <div className="text-xs text-fg-muted mt-1">Troque o período ou limpe os filtros.</div>
    </div>
  );
}
