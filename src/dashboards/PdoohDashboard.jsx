import { useState, useMemo, useRef } from "react";
import { C } from "../shared/theme";
import { fmt, fmtDateTimeBR } from "../shared/format";
import {
  readRangeFromUrl,
  writeRangeToUrl,
  inRange,
  parseYmd,
  getRowDate,
  daysInRange,
} from "../shared/dateFilter";
import DateRangeFilter from "../components/DateRangeFilter";
import PdoohMapLibre from "./PdoohMapLibre";
import PdoohSiteTable from "./PdoohSiteTable";
import { aggregateSites } from "./pdoohSites";
import { Card } from "../ui/Card";
import { KpiCardV2 } from "../v2/components/KpiCardV2";
import { SegmentedControlV2 } from "../v2/components/SegmentedControlV2";
import { TrendChartV2 } from "../v2/components/TrendChartV2";

// Aba PDOOH (dentro do UploadTab): KPIs, impressões e plays por dia, por
// media owner, mapa de entrega (calor | pontos), top cidades e performance
// por endereço. Componentes V2; o mapa e a tabela de endereços continuam os
// mesmos.
//
// Período: com `externalRange` (período global do report), obedece a ele e
// não mostra filtro próprio. Sem ele, mantém o filtro de datas da aba.
//
// `isAdmin`: o card do mapa sem geolocalização mostrava ao CLIENTE a
// instrução interna "Adicione colunas LATITUDE e LONGITUDE no arquivo". Pro
// cliente, sem coordenadas o card simplesmente não aparece; o admin continua
// vendo a instrução pra corrigir a base.
const PdoohDashboard = ({ data, onClear, isDark = true, isAdmin = false, externalRange }) => {
  const [mapMetric, setMapMetric] = useState("impressions");
  const [mapMode, setMapMode] = useState("heat");
  const [mapFocus, setMapFocus] = useState(null);
  const mapCardRef = useRef(null);
  const allRows = useMemo(() => data.rows || [], [data.rows]);

  const dateInfo = useMemo(() => {
    const dates = new Set();
    allRows.forEach(r => {
      const d = getRowDate(r, ["DATE", "Date", "date"]);
      if (d) dates.add(d);
    });
    const sorted = [...dates].sort();
    return {
      available: sorted,
      min: sorted.length ? parseYmd(sorted[0]) : null,
      max: sorted.length ? parseYmd(sorted[sorted.length - 1]) : null,
    };
  }, [allRows]);

  const controlled = externalRange !== undefined;
  const [innerRange, setRangeState] = useState(() => (controlled ? null : readRangeFromUrl("pdooh")));
  const range = controlled ? externalRange : innerRange;
  const setRange = (r) => {
    setRangeState(r);
    writeRangeToUrl(r, "pdooh");
  };

  const rows = useMemo(() => {
    if (!range) return allRows;
    return allRows.filter(r => {
      const d = getRowDate(r, ["DATE", "Date", "date"]);
      return d && inRange(d, range);
    });
  }, [allRows, range]);

  // IMPRESSIONS é fracionário no PDOOH (audience-weighted), mas pra exibir
  // sempre arredondamos pra inteiro — não faz sentido mostrar "2.133,495 imp".
  const totalImpressions = Math.round(rows.reduce((s, r) => s + (Number(r["IMPRESSIONS"]) || 0), 0));
  const totalPlays = rows.reduce((s, r) => s + (Number(r["PLAYS"]) || 0), 0);
  const uniqueCities = new Set(rows.map(r => r["CITY"]).filter(Boolean)).size;
  const uniqueOwners = new Set(rows.map(r => r["MEDIA_OWNER"]).filter(Boolean)).size;

  const byDate = {};
  rows.forEach(r => {
    const d = getRowDate(r, ["DATE", "Date", "date"]);
    if (!d) return;
    if (!byDate[d]) byDate[d] = { date: d, impressions: 0, plays: 0 };
    byDate[d].impressions += Number(r["IMPRESSIONS"]) || 0;
    byDate[d].plays += Number(r["PLAYS"]) || 0;
  });
  const chartData = Object.values(byDate)
    .map(d => ({ ...d, impressions: Math.round(d.impressions) }))
    .sort((a, b) => (a.date > b.date ? 1 : -1));

  const byCity = {};
  rows.forEach(r => {
    const c = r["CITY"] || "Outras";
    if (!byCity[c]) byCity[c] = { city: c, impressions: 0, plays: 0 };
    byCity[c].impressions += Number(r["IMPRESSIONS"]) || 0;
    byCity[c].plays += Number(r["PLAYS"]) || 0;
  });
  const cityData = Object.values(byCity)
    .map(c => ({ ...c, impressions: Math.round(c.impressions) }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10);

  const byOwner = {};
  rows.forEach(r => {
    const o = r["MEDIA_OWNER"] || "Outros";
    if (!byOwner[o]) byOwner[o] = { owner: o, impressions: 0, plays: 0 };
    byOwner[o].impressions += Number(r["IMPRESSIONS"]) || 0;
    byOwner[o].plays += Number(r["PLAYS"]) || 0;
  });
  const ownerData = Object.values(byOwner)
    .map(o => ({ ...o, impressions: Math.round(o.impressions) }))
    .sort((a, b) => b.impressions - a.impressions);

  // Agregação por endereço (SITE) — alimenta o mapa E a tabela de performance,
  // com a mesma chave, pra ligar clique na linha ↔ ponto no mapa.
  const sites = useMemo(() => aggregateSites(rows), [rows]);
  const hasGeo = sites.some(s => s.lat !== 0 && s.lng !== 0);

  // Clique numa linha da tabela → muda pra visão de pontos, rola até o mapa
  // e voa até o endereço (o ts força re-focus em cliques repetidos no mesmo local)
  const handleSiteClick = (site) => {
    setMapMode("points");
    setMapFocus({ key: site.key, ts: Date.now() });
    mapCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Tema da tabela de endereços (componente legado, recebe cores prontas).
  const siteTheme = {
    bg2: isDark ? C.dark2 : "#FFFFFF",
    bg3: isDark ? C.dark3 : "#EEF1F7",
    bdr: isDark ? C.dark3 : "#DDE2EC",
    text: isDark ? C.white : "#1C262F",
    muted: isDark ? C.muted : "#6B7A8D",
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-fg-subtle">
          Atualizado em {fmtDateTimeBR(data.uploadedAt, { suffix: true }) || "—"}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {range && (
            <span className="text-xs text-fg-muted tabular-nums">
              {fmt(rows.length)} de {fmt(allRows.length)} linhas · {daysInRange(range)}d
            </span>
          )}
          {!controlled && (
            <DateRangeFilter
              value={range}
              onChange={setRange}
              minDate={dateInfo.min}
              maxDate={dateInfo.max}
              availableDates={dateInfo.available}
              isDark={isDark}
            />
          )}
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              className="px-3 py-1.5 rounded-lg border border-border bg-surface text-xs text-fg-muted hover:bg-surface-strong transition-colors cursor-pointer"
            >
              Trocar arquivo
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCardV2 label="Impressões" value={fmt(totalImpressions)} hint="Impressões ponderadas por audiência, arredondadas." />
        <KpiCardV2 label="Plays" value={fmt(totalPlays)} accent hint="Exibições do anúncio nas telas." />
        <KpiCardV2 label="Cidades" value={fmt(uniqueCities)} />
        <KpiCardV2 label="Media owners" value={fmt(uniqueOwners)} />
      </div>

      {rows.length === 0 ? (
        <Card className="p-12 text-center text-sm text-fg-muted">
          {controlled
            ? "Sem dados de PDOOH no período selecionado. Ajuste o período na barra do report."
            : "Nenhuma linha encontrada no período selecionado."}
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartBox title="Impressões por dia">
              <TrendChartV2 data={chartData} dataKey="impressions" label="Impressões" kind="bar" height={190} />
            </ChartBox>
            <ChartBox title="Plays por dia">
              <TrendChartV2 data={chartData} dataKey="plays" label="Plays" kind="bar" height={190} />
            </ChartBox>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartBox title="Impressões por media owner">
              <HBarList rows={ownerData} labelKey="owner" valueKey="impressions" />
            </ChartBox>
            <ChartBox title="Plays por media owner">
              <HBarList rows={[...ownerData].sort((a, b) => b.plays - a.plays)} labelKey="owner" valueKey="plays" />
            </ChartBox>
          </div>

          {(hasGeo || isAdmin) && (
            <Card ref={mapCardRef} className="p-4 md:p-5 scroll-mt-40">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">Mapa de entrega</h3>
                {hasGeo ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <SegmentedControlV2
                      label="Visão do mapa"
                      options={[{ value: "heat", label: "Calor" }, { value: "points", label: "Pontos" }]}
                      value={mapMode}
                      onChange={setMapMode}
                    />
                    <SegmentedControlV2
                      label="Métrica do mapa"
                      options={[{ value: "impressions", label: "Impressões" }, { value: "plays", label: "Plays" }]}
                      value={mapMetric}
                      onChange={setMapMetric}
                    />
                  </div>
                ) : (
                  <span className="text-[11px] text-warning">
                    Adicione as colunas LATITUDE e LONGITUDE no arquivo para ativar o mapa (aviso só para admin).
                  </span>
                )}
              </div>
              {hasGeo ? (
                <PdoohMapLibre sites={sites} metric={mapMetric} mode={mapMode} isDark={isDark} focus={mapFocus} />
              ) : (
                <div className="grid h-[200px] place-items-center text-center text-sm text-fg-muted">
                  O arquivo não possui colunas de geolocalização.
                </div>
              )}
            </Card>
          )}

          <Card className="p-4 md:p-5">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted mb-3">Top cidades</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                    <th className="py-2 pr-3 text-left">Cidade</th>
                    <th className="py-2 px-3 text-right">Impressões</th>
                    <th className="py-2 pl-3 text-right">Plays</th>
                  </tr>
                </thead>
                <tbody>
                  {cityData.map((c) => (
                    <tr key={c.city} className="border-b border-border/50 last:border-b-0">
                      <td className="py-2.5 pr-3 font-semibold text-fg">{c.city}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-fg">{fmt(c.impressions)}</td>
                      <td className="py-2.5 pl-3 text-right tabular-nums text-fg">{fmt(c.plays)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Performance por Endereço (SITE) */}
          <PdoohSiteTable sites={sites} theme={siteTheme} onSiteClick={hasGeo ? handleSiteClick : undefined} />
        </>
      )}
    </div>
  );
};

function ChartBox({ title, children }) {
  return (
    <Card className="p-4 md:p-5 min-w-0">
      <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted mb-3">{title}</h3>
      {children}
    </Card>
  );
}

// Barras horizontais de uma série (uma cor), valor sempre em texto.
function HBarList({ rows, labelKey, valueKey, limit = 10 }) {
  const data = rows.slice(0, limit);
  const max = Math.max(...data.map((r) => r[valueKey] || 0), 1);
  if (!data.length) return <p className="text-sm text-fg-subtle">Sem dados.</p>;
  return (
    <div className="grid gap-2">
      {data.map((r) => (
        <div key={r[labelKey]} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_5rem] items-center gap-3">
          <span className="text-[12px] text-fg truncate" title={r[labelKey]}>{r[labelKey]}</span>
          <div className="h-3 rounded-r-[4px] bg-track overflow-hidden">
            <div className="h-full rounded-r-[4px] bg-chart-s1" style={{ width: `${Math.max(1, ((r[valueKey] || 0) / max) * 100)}%` }} />
          </div>
          <span className="text-right text-[11px] font-semibold text-fg tabular-nums">{fmt(r[valueKey])}</span>
        </div>
      ))}
      {rows.length > limit && <p className="text-[11px] text-fg-subtle">+{rows.length - limit} media owners menores.</p>}
    </div>
  );
}

export default PdoohDashboard;
