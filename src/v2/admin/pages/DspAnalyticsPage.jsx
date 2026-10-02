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
// gráfico e tabelas sempre somam as mesmas linhas. Idas extras ao servidor:
// a série diária quando o filtro é por line, e o filtro de criativo (abaixo
// da line, não cabe no payload): a lista de criativos carrega quando o chip
// abre, e a seleção refaz o payload recortado no servidor, no mesmo formato.

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
  buildFormatMatrix, buildDataQuality, buildFilterOptions, pruneFilters, sparkBySource, buildTactics,
  decodeCreatives, buildCreativeOptions, hasCreativeFilter, MAX_CREATIVES,
  selectAllState, toggleSelectAll,
} from "../lib/dspAnalytics";
import { getDspAnalytics, getDspAnalyticsLineDaily, getDspAnalyticsCreatives } from "../../../lib/api";
import { sortSources, dspLabel } from "../../../shared/dspMeta";
import { sortTactics, chartTacticKey, tacticLabel } from "../../../shared/tacticMeta";
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
import { DspTacticsCard } from "../components/dspAnalytics/DspTacticsCard";
import { FormatIcon } from "../components/dspAnalytics/FormatBadge";
import { downloadDspAnalyticsXlsx } from "../lib/dspAnalyticsExport";
import { fmtDay, fmtCompact } from "../components/dspAnalytics/dspFormat";
import "../../v2.css";

const withIcon = (media, text) => (
  <span className="inline-flex items-center gap-1.5">
    <FormatIcon media={media} className="size-3.5" />
    {text}
  </span>
);
const MEDIA_OPTIONS = [
  { value: "all", label: "Todos" },
  { value: "DISPLAY", label: withIcon("DISPLAY", "Display") },
  { value: "VIDEO", label: withIcon("VIDEO", "Vídeo") },
];
// O filtro de line busca a série diária de até 50 lines (backend
// MAX_LINE_KEYS); o "Selecionar tudo" respeita o mesmo teto.
const MAX_LINES = 50;
// Toques seguidos no filtro de criativo viram UMA ida ao servidor.
const CREATIVE_DEBOUNCE_MS = 700;
const clip = (t, n = 64) => (t && t.length > n ? `${t.slice(0, n - 1)}…` : t);

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

  const baseLoading = ready && res?.key !== fetchKey;
  const baseData = res?.data || null;
  const baseError = res?.key === fetchKey ? res.error : null;

  // ── Filtros ────────────────────────────────────────────────────────────
  const [rawFilters, setFilters] = useState(DEFAULT_FILTERS);

  // ── Opções do filtro de criativo (sob demanda) ─────────────────────────
  // Só busca depois que o chip abre (ou com criativo já selecionado): é uma
  // varredura a mais do consolidado que a maioria das visitas não usa.
  const [wantCreatives, setWantCreatives] = useState(false);
  const crOptKey = ready && (wantCreatives || rawFilters.creatives.length > 0) ? fetchKey : null;
  const [crOptRes, setCrOptRes] = useState(null); // { key, data, error }
  useEffect(() => {
    if (!crOptKey) return;
    let cancelled = false;
    getDspAnalyticsCreatives({ from, to })
      .then((p) => { if (!cancelled) setCrOptRes({ key: crOptKey, data: decodeCreatives(p), error: null }); })
      .catch((error) => { if (!cancelled) setCrOptRes({ key: crOptKey, data: null, error }); });
    return () => { cancelled = true; };
  }, [crOptKey, from, to]);
  const creativeOpts = crOptRes?.key === crOptKey ? crOptRes.data : null;
  const creativeOptsLoading = !!crOptKey && crOptRes?.key !== crOptKey;
  const creativeOptsError = crOptRes?.key === crOptKey ? crOptRes.error : null;

  // Troca de período muda o universo: seleção que não existe mais é podada
  // na leitura (sem effect), e reaparece se o período voltar. A poda é
  // contra o payload SEM recorte de criativo, senão a seleção de campanha
  // sumiria só porque o criativo escolhido não roda nela.
  const filters = useMemo(
    () => (baseData ? pruneFilters(rawFilters, baseData.lines, creativeOpts) : rawFilters),
    [rawFilters, baseData, creativeOpts],
  );

  // ── Payload recortado por criativo ─────────────────────────────────────
  const creativeScoped = hasCreativeFilter(filters);
  // Ordenado: a mesma seleção em outra ordem é o mesmo recorte (e o mesmo
  // cache no backend, que também ordena).
  const crIds = [...filters.creatives].sort().join(",");
  const [crDebounced, setCrDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setCrDebounced(crIds), crIds ? CREATIVE_DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [crIds]);
  const crFetchKey = creativeScoped && crDebounced && baseData ? `${fetchKey}|${crDebounced}` : null;
  const crRefreshRef = useRef(false);
  const [crRes, setCrRes] = useState(null); // { key, data, error }
  useEffect(() => {
    if (!crFetchKey) return;
    let cancelled = false;
    const refresh = crRefreshRef.current;
    crRefreshRef.current = false;
    getDspAnalytics({ from, to, refresh, creatives: crDebounced.split(",") })
      .then((p) => { if (!cancelled) setCrRes({ key: crFetchKey, data: decodePayload(p), error: null }); })
      .catch((error) => { if (!cancelled) setCrRes((r) => ({ key: crFetchKey, data: r?.data || null, error })); });
    return () => { cancelled = true; };
  }, [crFetchKey, from, to, crDebounced]);

  // Com criativo, a página toda lê o payload recortado. Enquanto ele não
  // chega, mostra o último (ou o sem recorte) esmaecido. Se o recorte falha,
  // os blocos somem: número sem recorte com o chip de criativo ativo engana.
  const crPending = creativeScoped && (crDebounced !== crIds || crRes?.key !== crFetchKey);
  const crError = creativeScoped && !crPending ? crRes?.error || null : null;
  const data = creativeScoped ? (crRes?.data || baseData) : baseData;
  const loading = baseLoading || crPending;
  const error = baseError || crError;
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
  const lineCreatives = creativeScoped ? crDebounced : "";
  const lineReq = useMemo(
    () => (lineScoped && data
      ? { from: data.from, to: data.to, keys: filters.lines.slice(0, 50), creatives: lineCreatives ? lineCreatives.split(",") : [] }
      : null),
    [lineScoped, data, filters.lines, lineCreatives],
  );
  const lineFetchKey = lineReq ? `${lineReq.from}|${lineReq.to}|${lineReq.keys.join(",")}|${lineReq.creatives.join(",")}` : null;
  const [lineRes, setLineRes] = useState(null); // { key, rows, error }
  useEffect(() => {
    if (!lineReq) return;
    let cancelled = false;
    const key = `${lineReq.from}|${lineReq.to}|${lineReq.keys.join(",")}|${lineReq.creatives.join(",")}`;
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
        .map((r) => ({ ...r, s: byKey.get(r.key).s, m: byKey.get(r.key).m, tactic: byKey.get(r.key).tactic }));
    } else {
      seriesRows = filterRows(data.series, filters);
    }
    const byTactic = mode === "tactic";
    const chartSources = byTactic
      ? sortTactics([...new Set(seriesRows.map((r) => chartTacticKey(r.tactic)))])
      : sortSources([...new Set(seriesRows.map((r) => r.s))]);
    const enriched = enrichLines(lines);
    return {
      lines,
      enriched,
      tactics: buildTactics(enriched),
      totals,
      prev,
      buckets: buildTimeseries(seriesRows, data.dates, effGranularity, byTactic ? "tactic" : "source"),
      chartSources,
      spark: sparkBySource(seriesRows, data.dates),
      seriesRows,
      cards: buildScorecards(lines, data.sources),
      absCost: buildAbsCost(filterRows(data.lines, filters, { abs: true })),
      matrix: buildFormatMatrix(lines),
      quality: buildDataQuality(lines, data.landings, data.to),
      options: buildFilterOptions(data.lines, filters),
    };
  }, [data, filters, lineScoped, lineDaily, effGranularity, mode]);

  // Lista de criativos cruzada com as lines SEM recorte: respeita os outros
  // filtros e não some com as irmãs do criativo já escolhido.
  const creativeOptions = useMemo(
    () => (baseData ? buildCreativeOptions(creativeOpts, baseData.lines, filters) : []),
    [creativeOpts, baseData, filters],
  );

  // Mês a mês segue a métrica do gráfico; separado do modelo pra trocar de
  // métrica não refazer o resto.
  const monthly = useMemo(
    () => (model ? buildMonthly(model.seriesRows, data.dates, metric, mode === "tactic" ? "tactic" : "source") : null),
    [model, data, metric, mode],
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

  const onRefresh = () => {
    refreshRef.current = true;
    crRefreshRef.current = true;
    setReloadKey((k) => k + 1);
  };
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

  // Do payload sem recorte: com criativo ativo, o recortado só tem as DSPs
  // em que ele rodou, e trocar de DSP ficaria impossível.
  const sourceOptions = (baseData?.sources || []).map((s) => ({ id: s, label: dspLabel(s) }));

  const chips = data ? [
    {
      id: "dsp", label: "DSP", align: "start",
      value: chipValue(filters.sources, sourceOptions),
      panel: () => (
        <FilterPanel title="DSP" footer={<FilterPanelClear onClear={() => setF({ sources: [] })} disabled={!filters.sources.length} />}>
          {sourceOptions.map((o) => (
            <FilterOption
              key={o.id} multi label={o.label}
              selected={filters.sources.includes(o.id)}
              onSelect={() => toggleIn("sources", o.id)}
              onOnly={onlyOf("sources", o.id)}
            />
          ))}
        </FilterPanel>
      ),
    },
    searchableChip("client", "Cliente", "clients", opts?.clients, "Buscar cliente…", 340),
    searchableChip("campaign", "Campanha", "campaigns", opts?.campaigns, "Buscar campanha ou token…", 420),
    searchableChip("tactic", "Tática", "tactics", opts?.tactics, "Buscar tática…", 320),
    searchableChip("io", "IO / Campaign DSP", "ios", opts?.ios, "Buscar IO…", 420),
    searchableChip("line", "Line", "lines", opts?.lines, "Buscar line…", 520),
    {
      id: "creative", label: "Criativo", align: "end",
      panelClassName: "w-[min(92vw,560px)]",
      value: chipValue(filters.creatives, creativeOptions),
      panel: () => (
        <SearchablePanel
          title="Criativo"
          items={creativeOptions}
          selected={filters.creatives}
          onToggle={(v) => toggleIn("creatives", v)}
          onClear={() => setF({ creatives: [] })}
          onSet={(ids) => setF({ creatives: ids })}
          max={MAX_CREATIVES}
          onMount={() => setWantCreatives(true)}
          loading={creativeOptsLoading}
          error={creativeOptsError}
          placeholder="Buscar criativo (nome ou parte dele)…"
          note={`Recorta no servidor a entrega desses criativos (até ${MAX_CREATIVES}). Lista respeita os outros filtros.`}
        />
      ),
    },
  ] : [];

  // "apenas": troca a seleção pelo item. Some quando ele já é o único.
  const onlyOf = (key, id) => (filters[key].length === 1 && filters[key][0] === id
    ? undefined
    : () => setF({ [key]: [id] }));

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
          onSet={(ids) => setF({ [key]: ids })}
          max={key === "lines" ? MAX_LINES : undefined}
          placeholder={placeholder}
          note={key === "lines" ? "Com line selecionada o gráfico busca a série diária dela (até 50)." : null}
        />
      ),
    };
  }

  // Seleção grande (o "Selecionar tudo" da busca) vira UM chip; a lista de
  // cada item está no painel. Até `upTo`, um chip por item.
  const group = (key, one, many, verb, labelFn, upTo = 3) => {
    const ids = filters[key];
    if (ids.length === 0) return [];
    if (ids.length > upTo) {
      return [{ id: `g${key}`, label: `${many} · ${ids.length} ${verb}`, onClear: () => setF({ [key]: [] }) }];
    }
    return ids.map((c) => ({ id: `${key}:${c}`, label: `${one} · ${labelFn(c)}`, onClear: () => toggleIn(key, c) }));
  };

  const active = [
    ...filters.sources.map((s) => ({ id: `s${s}`, label: `DSP · ${dspLabel(s)}`, onClear: () => toggleIn("sources", s) })),
    ...(filters.media !== "all" ? [{ id: "media", label: `Formato · ${filters.media === "VIDEO" ? "Vídeo" : "Display"}`, onClear: () => setF({ media: "all" }) }] : []),
    ...(filters.abs !== "all" ? [{ id: "abs", label: filters.abs === "abs" ? "Com ABS" : "Sem ABS", onClear: () => setF({ abs: "all" }) }] : []),
    ...(!filters.includeSurvey ? [{ id: "sv", label: "Sem survey", onClear: () => setF({ includeSurvey: true }) }] : []),
    ...group("clients", "Cliente", "Clientes", "selecionados", (c) => c),
    ...group("campaigns", "Campanha", "Campanhas", "selecionadas", (c) => labelOf(opts?.campaigns, c)),
    ...group("tactics", "Tática", "Táticas", "selecionadas", (c) => tacticLabel(c)),
    ...group("ios", "IO", "IOs", "selecionados", (c) => c || "(sem IO)"),
    ...group("lines", "Line", "Lines", "selecionadas", (c) => labelOf(opts?.lines, c)),
    // Nomes de criativo da mesma peça só diferem no fim (formato), então
    // a partir de dois já viram um chip só.
    ...group("creatives", "Criativo", "Criativos", "selecionados", (c) => clip(labelOf(creativeOptions, c)), 1),
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
        ) : crError ? null : model ? (
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
                <DspTacticsCard
                  rows={model.tactics}
                  selected={filters.tactics}
                  onToggleTactic={(t) => toggleIn("tactics", t)}
                />
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
function SearchablePanel({
  title, items, selected, onToggle, onClear, placeholder, note,
  onSet, max, onMount, loading, error,
}) {
  const [q, setQ] = useState("");
  // onMount: o painel de criativo pede a lista quando abre.
  const mountRef = useRef(onMount);
  useEffect(() => { mountRef.current?.(); }, []);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t
      ? items.filter((it) => String(it.label).toLowerCase().includes(t)
          || String(it.id).toLowerCase().includes(t)
          || it.sub?.toLowerCase().includes(t))
      : items;
  }, [items, q]);
  const shown = useMemo(() => matches.slice(0, 200), [matches]);
  // "Selecionar tudo" da busca, como no Excel: marca/desmarca todos os
  // resultados (não só os 200 desenhados), até o teto do filtro. Sem busca
  // não aparece: nada marcado já é "tudo".
  const searching = q.trim().length > 0;
  const matchIds = useMemo(() => matches.map((it) => it.id), [matches]);
  const allState = selectAllState(selected, matchIds);
  const capped = max != null && allState !== "all" && selected.length + matchIds.filter((id) => !selected.includes(id)).length > max;
  const only = (id) => (selected.length === 1 && selected[0] === id ? undefined : () => onSet([id]));
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
      {searching && matchIds.length > 0 && (
        <div className="mb-1 border-b border-border pb-1">
          <FilterOption
            multi
            label={`Selecionar tudo da busca (${matchIds.length})`}
            sub={capped ? `Limite de ${max} no filtro: entram os de maior volume` : undefined}
            selected={allState === "all"}
            indeterminate={allState === "some"}
            onSelect={() => onSet(toggleSelectAll(selected, matchIds, max ?? Infinity))}
          />
        </div>
      )}
      {error && <div className="px-2 py-3 text-xs text-danger">Não foi possível carregar: {error.message}</div>}
      {loading && !error && <div className="px-2 py-3 text-xs text-fg-subtle">Carregando…</div>}
      {!loading && !error && shown.length === 0 && <div className="px-2 py-3 text-xs text-fg-subtle">Nada encontrado.</div>}
      {shown.map((it) => (
        <FilterOption
          key={it.id}
          multi
          label={it.label || "(sem nome)"}
          sub={it.sub}
          count={fmtCompact(it.volume)}
          selected={selected.includes(it.id)}
          onSelect={() => onToggle(it.id)}
          onOnly={only(it.id)}
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
