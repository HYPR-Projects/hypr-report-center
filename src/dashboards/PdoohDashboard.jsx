import { useState, useMemo, useRef } from "react";
import { Bar } from "recharts";
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
import BarChart from "../components/BarChart";
import KpiCard from "../components/KpiCard";
import DateRangeFilter from "../components/DateRangeFilter";
import PdoohMapLibre from "./PdoohMapLibre";
import PdoohSiteTable from "./PdoohSiteTable";
import { aggregateSites } from "./pdoohSites";

const PdoohDashboard = ({ data, onClear, isDark = true }) => {
  const [mapMetric, setMapMetric] = useState("impressions");
  const [mapMode, setMapMode] = useState("heat");
  const [mapFocus, setMapFocus] = useState(null);
  const mapCardRef = useRef(null);
  const allRows = data.rows;

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

  const [range, setRangeState] = useState(() => readRangeFromUrl("pdooh"));
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
  const totalImpressions = Math.round(rows.reduce((s,r)=>s+(Number(r["IMPRESSIONS"])||0),0));
  const totalPlays       = rows.reduce((s,r)=>s+(Number(r["PLAYS"])||0),0);
  const uniqueCities     = new Set(rows.map(r=>r["CITY"]).filter(Boolean)).size;
  const uniqueOwners     = new Set(rows.map(r=>r["MEDIA_OWNER"]).filter(Boolean)).size;

  const byDate={};
  rows.forEach(r=>{
    const d = getRowDate(r, ["DATE", "Date", "date"]);
    if (!d) return;
    if(!byDate[d])byDate[d]={date:d,impressions:0,plays:0};
    byDate[d].impressions+=Number(r["IMPRESSIONS"])||0;
    byDate[d].plays+=Number(r["PLAYS"])||0;
  });
  // Arredonda impressões agregadas pra inteiro antes de mandar pro chart.
  const chartData=Object.values(byDate).map(d=>({...d, impressions: Math.round(d.impressions)})).sort((a,b)=>a.date>b.date?1:-1);
  const byCity={};
  rows.forEach(r=>{
    const c=r["CITY"]||"Outras";
    if(!byCity[c])byCity[c]={city:c,impressions:0,plays:0};
    byCity[c].impressions+=Number(r["IMPRESSIONS"])||0;
    byCity[c].plays+=Number(r["PLAYS"])||0;
  });
  const cityData=Object.values(byCity).map(c=>({...c, impressions: Math.round(c.impressions)})).sort((a,b)=>b.impressions-a.impressions).slice(0,10);

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

  // Tokens de tema derivados de isDark
  const bg2    = isDark ? C.dark2 : "#FFFFFF";
  const bg3    = isDark ? C.dark3 : "#EEF1F7";
  const bdr    = isDark ? C.dark3 : "#DDE2EC";
  const text   = isDark ? C.white : "#1C262F";
  const muted  = isDark ? C.muted : "#6B7A8D";
  const theme  = { bg2, bg3, bdr, text, muted };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:12}}>
        <div style={{fontSize:11,color:muted}}>Atualizado em: {fmtDateTimeBR(data.uploadedAt, { suffix: true }) || "—"}</div>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          {range && (
            <span style={{fontSize:12,color:muted}}>
              {rows.length} de {allRows.length} linhas · {daysInRange(range)}d
            </span>
          )}
          <DateRangeFilter
            value={range}
            onChange={setRange}
            minDate={dateInfo.min}
            maxDate={dateInfo.max}
            availableDates={dateInfo.available}
            isDark={isDark}
          />
          {onClear && (
            <button onClick={onClear} style={{background:bg3,color:muted,border:`1px solid ${bdr}`,padding:"6px 14px",borderRadius:8,cursor:"pointer",fontSize:12}}>🔄 Trocar arquivo</button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12,marginBottom:24}}>
        <KpiCard label="Impressões"   value={fmt(totalImpressions)} theme={theme}/>
        <KpiCard label="Plays"        value={fmt(totalPlays)} color={C.blue} theme={theme}/>
        <KpiCard label="Cidades"      value={uniqueCities} color={C.yellow} theme={theme}/>
        <KpiCard label="Media Owners" value={uniqueOwners} theme={theme}/>
      </div>

      {rows.length === 0 ? (
        <div style={{textAlign:"center",padding:48,color:muted,background:bg2,border:`1px solid ${bdr}`,borderRadius:12}}>
          Nenhuma linha encontrada no período selecionado.
        </div>
      ) : (<>
      {/* Gráficos diários */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
        <div style={{background:bg2,border:`1px solid ${bdr}`,borderRadius:12,padding:20}}>
          <div style={{fontSize:13,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Impressões Diárias</div>
          <BarChart data={chartData} xKey="date" yKey="impressions" color={C.blue}
            formatter={(v)=>Number(v).toLocaleString("pt-BR")} theme={theme}/>
        </div>
        <div style={{background:bg2,border:`1px solid ${bdr}`,borderRadius:12,padding:20}}>
          <div style={{fontSize:13,fontWeight:700,color:C.yellow,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Plays Diários</div>
          <BarChart data={chartData} xKey="date" yKey="plays" color={C.yellow}
            formatter={(v)=>Number(v).toLocaleString("pt-BR")} theme={theme}/>
        </div>
      </div>

      {/* Gráficos por Media Owner */}
      {(() => {
        const byOwner={};
        rows.forEach(r=>{
          const o=r["MEDIA_OWNER"]||"Outros";
          if(!byOwner[o])byOwner[o]={owner:o,impressions:0,plays:0};
          byOwner[o].impressions+=Number(r["IMPRESSIONS"])||0;
          byOwner[o].plays+=Number(r["PLAYS"])||0;
        });
        const ownerData=Object.values(byOwner).map(o=>({...o, impressions: Math.round(o.impressions)})).sort((a,b)=>b.impressions-a.impressions);
        return (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
            <div style={{background:bg2,border:`1px solid ${bdr}`,borderRadius:12,padding:20}}>
              <div style={{fontSize:13,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Impressões por Media Owner</div>
              <BarChart data={ownerData} xKey="owner" yKey="impressions" color={C.blue}
                formatter={(v)=>Number(v).toLocaleString("pt-BR")} rotateX={true} height={200} theme={theme}/>
            </div>
            <div style={{background:bg2,border:`1px solid ${bdr}`,borderRadius:12,padding:20}}>
              <div style={{fontSize:13,fontWeight:700,color:C.yellow,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Plays por Media Owner</div>
              <BarChart data={ownerData} xKey="owner" yKey="plays" color={C.yellow}
                formatter={(v)=>Number(v).toLocaleString("pt-BR")} rotateX={true} height={200} theme={theme}/>
            </div>
          </div>
        );
      })()}

      {/* Mapa de Entrega (calor | pontos) */}
      <div ref={mapCardRef} style={{background:bg2,border:`1px solid ${bdr}`,borderRadius:12,padding:20,marginBottom:16,scrollMarginTop:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,gap:12,flexWrap:"wrap"}}>
          <div style={{fontSize:13,fontWeight:700,color:muted,textTransform:"uppercase",letterSpacing:1}}>Mapa de Entrega</div>
          {hasGeo ? (
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              <div style={{display:"flex",gap:8}}>
                {[["heat","Calor"],["points","Pontos"]].map(([v,label])=>(
                  <button key={v} onClick={()=>setMapMode(v)} style={{
                    background:mapMode===v?C.blue:bg3,
                    color:mapMode===v?"#fff":muted,
                    border:`1px solid ${mapMode===v?C.blue:bdr}`,
                    padding:"6px 14px",borderRadius:8,
                    cursor:"pointer",fontSize:12,fontWeight:600,
                    transition:"all 0.2s"
                  }}>{label}</button>
                ))}
              </div>
              <div style={{display:"flex",gap:8}}>
                {["impressions","plays"].map(m=>(
                  <button key={m} onClick={()=>setMapMetric(m)} style={{
                    background:mapMetric===m?C.blue:bg3,
                    color:mapMetric===m?"#fff":muted,
                    border:`1px solid ${mapMetric===m?C.blue:bdr}`,
                    padding:"6px 14px",borderRadius:8,
                    cursor:"pointer",fontSize:12,fontWeight:600,
                    transition:"all 0.2s"
                  }}>{m==="impressions"?"Impressões":"Plays"}</button>
                ))}
              </div>
            </div>
          ) : (
            <span style={{fontSize:11,color:muted}}>⚠️ Adicione colunas LATITUDE e LONGITUDE no arquivo para ativar o mapa</span>
          )}
        </div>
        {hasGeo
          ? <PdoohMapLibre sites={sites} metric={mapMetric} mode={mapMode} isDark={isDark} focus={mapFocus}/>
          : <div style={{height:200,display:"flex",alignItems:"center",justifyContent:"center",color:muted,fontSize:13,flexDirection:"column",gap:8}}>
              <span aria-hidden="true" style={{fontSize:32}}>🗺️</span>
              <span>O arquivo não possui colunas de geolocalização</span>
              <span style={{fontSize:11}}>Adicione as colunas LATITUDE e LONGITUDE para visualizar o mapa</span>
            </div>
        }
      </div>

      {/* Top Cidades */}
      <div style={{background:bg2,border:`1px solid ${bdr}`,borderRadius:12,padding:20}}>
        <div style={{fontSize:13,fontWeight:700,color:muted,marginBottom:16,textTransform:"uppercase",letterSpacing:1}}>Top Cidades</div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>
              <th style={{color:muted,fontWeight:600,fontSize:12,textAlign:"left",paddingBottom:8}}>Cidade</th>
              <th style={{color:muted,fontWeight:600,fontSize:12,textAlign:"left",paddingBottom:8}}>Impressões</th>
              <th style={{color:muted,fontWeight:600,fontSize:12,textAlign:"left",paddingBottom:8}}>Plays</th>
            </tr></thead>
            <tbody>{cityData.map((c,i)=>(
              <tr key={i} style={{borderTop:`1px solid ${bdr}`}}>
                <td style={{fontWeight:600,padding:"10px 0",color:text}}>{c.city}</td>
                <td style={{padding:"10px 0",color:text}}>{fmt(c.impressions)}</td>
                <td style={{padding:"10px 0",color:text}}>{fmt(c.plays)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      {/* Performance por Endereço (SITE) */}
      <PdoohSiteTable sites={sites} theme={theme} onSiteClick={hasGeo ? handleSiteClick : undefined}/>
      </>)}
    </div>
  );
};

// ── Pacing Bar ────────────────────────────────────────────────────────────────

export default PdoohDashboard;
