import { useState } from "react";
import { Bar } from "recharts";
import { C } from "../shared/theme";
import { fmt } from "../shared/format";
import BarChart from "../components/BarChart";
import KpiCard from "../components/KpiCard";
import PdoohMap from "./PdoohMap";

const PdoohDashboard = ({ data, onClear }) => {
  const [mapMetric, setMapMetric] = useState("impressions");
  const rows = data.rows;

  const totalImpressions = rows.reduce((s,r)=>s+(Number(r["IMPRESSIONS"])||0),0);
  const totalPlays       = rows.reduce((s,r)=>s+(Number(r["PLAYS"])||0),0);
  const uniqueCities     = new Set(rows.map(r=>r["CITY"]).filter(Boolean)).size;
  const uniqueOwners     = new Set(rows.map(r=>r["MEDIA_OWNER"]).filter(Boolean)).size;

  const byDate={};
rows.forEach(r=>{
  let d=r["DATE"]||r["Date"]||"";
  d=String(d).trim();
  // Converte número serial do Excel para data
  if(/^\d+$/.test(d)){
    const dt=new Date(Date.UTC(1899,11,30)+Number(d)*86400000);
    d=dt.toISOString().slice(0,10);
  }
  // Converte DD/MM/YYYY para YYYY-MM-DD
  if(/^\d{2}\/\d{2}\/\d{4}$/.test(d)){
    const [dd,mm,yyyy]=d.split("/");
    d=`${yyyy}-${mm}-${dd}`;
  }
  if(!d||d==="NaN-Na")return;
  if(!byDate[d])byDate[d]={date:d,impressions:0,plays:0};
  byDate[d].impressions+=Number(r["IMPRESSIONS"])||0;
  byDate[d].plays+=Number(r["PLAYS"])||0;
});
  const chartData=Object.values(byDate).sort((a,b)=>a.date>b.date?1:-1);
  const hasGeo = rows.some(r=>Number(r["LATITUDE"]||r["LAT"]||0)!==0);
  const byCity={};
  rows.forEach(r=>{
    const c=r["CITY"]||"Outras";
    const lat=Number(r["LATITUDE"]||r["LAT"]||0);
    const lng=Number(r["LONGITUDE"]||r["LNG"]||r["LON"]||r["LONG"]||0);
    if(!byCity[c])byCity[c]={city:c,impressions:0,plays:0,lat,lng};
    byCity[c].impressions+=Number(r["IMPRESSIONS"])||0;
    byCity[c].plays+=Number(r["PLAYS"])||0;
  });
  const cityData=Object.values(byCity).sort((a,b)=>b.impressions-a.impressions).slice(0,10);

  // Pontos para heatmap — só cidades com lat/lng válidos
  const mapPoints = rows
  .filter(r=>{
    const lat=Number(r["LATITUDE"]||r["LAT"]||0);
    const lng=Number(r["LONGITUDE"]||r["LNG"]||r["LON"]||r["LONG"]||0);
    return lat!==0&&lng!==0;
  })
  .map(r=>[
    Number(r["LATITUDE"]||r["LAT"]),
    Number(r["LONGITUDE"]||r["LNG"]||r["LON"]||r["LONG"]),
    mapMetric==="impressions"?Number(r["IMPRESSIONS"]||0):Number(r["PLAYS"]||0)
  ]);
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:11,color:C.muted}}>Atualizado em: {new Date(data.uploadedAt).toLocaleString("pt-BR")}</div>
        <button onClick={onClear} style={{background:C.dark3,color:C.muted,border:"none",padding:"6px 14px",borderRadius:8,cursor:"pointer",fontSize:12}}>🔄 Trocar arquivo</button>
      </div>

      {/* KPI Cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12,marginBottom:24}}>
        <KpiCard label="Impressões"   value={fmt(totalImpressions)}/>
        <KpiCard label="Plays"        value={fmt(totalPlays)} color={C.blue}/>
        <KpiCard label="Cidades"      value={uniqueCities} color={C.yellow}/>
        <KpiCard label="Media Owners" value={uniqueOwners}/>
      </div>

      {/* Gráficos diários */}
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
  <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
    <div style={{fontSize:13,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Impressões Diárias</div>
    <BarChart data={chartData} xKey="date" yKey="impressions" color={C.blue}
      formatter={(v)=>Number(v).toLocaleString("pt-BR")}/>
  </div>
  <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
    <div style={{fontSize:13,fontWeight:700,color:C.yellow,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Plays Diários</div>
    <BarChart data={chartData} xKey="date" yKey="plays" color={C.yellow}
      formatter={(v)=>Number(v).toLocaleString("pt-BR")}/>
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
  const ownerData=Object.values(byOwner).sort((a,b)=>b.impressions-a.impressions);
  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
      <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
        <div style={{fontSize:13,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Impressões por Media Owner</div>
        <BarChart data={ownerData} xKey="owner" yKey="impressions" color={C.blue}
          formatter={(v)=>Number(v).toLocaleString("pt-BR")} rotateX={true} height={200}/>
      </div>
      <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
        <div style={{fontSize:13,fontWeight:700,color:C.yellow,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Plays por Media Owner</div>
        <BarChart data={ownerData} xKey="owner" yKey="plays" color={C.yellow}
          formatter={(v)=>Number(v).toLocaleString("pt-BR")} rotateX={true} height={200}/>
      </div>
    </div>
  );
})()}

      {/* Mapa Heatmap */}
      <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20,marginBottom:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:1}}>Mapa de Calor</div>
          {hasGeo ? (
            <div style={{display:"flex",gap:8}}>
              {["impressions","plays"].map(m=>(
                <button key={m} onClick={()=>setMapMetric(m)} style={{
                  background:mapMetric===m?C.blue:C.dark3,
                  color:mapMetric===m?C.white:C.muted,
                  border:"none",padding:"6px 14px",borderRadius:8,
                  cursor:"pointer",fontSize:12,fontWeight:600,
                  transition:"all 0.2s"
                }}>{m==="impressions"?"Impressões":"Plays"}</button>
              ))}
            </div>
          ) : (
            <span style={{fontSize:11,color:C.muted}}>⚠️ Adicione colunas LATITUDE e LONGITUDE no arquivo para ativar o mapa</span>
          )}
        </div>
        {hasGeo
          ? <PdoohMap points={mapPoints} metric={mapMetric}/>
          : <div style={{height:200,display:"flex",alignItems:"center",justifyContent:"center",color:C.muted,fontSize:13,flexDirection:"column",gap:8}}>
              <span style={{fontSize:32}}>🗺️</span>
              <span>O arquivo não possui colunas de geolocalização</span>
              <span style={{fontSize:11}}>Adicione as colunas LATITUDE e LONGITUDE para visualizar o mapa</span>
            </div>
        }
      </div>

      {/* Top Cidades */}
      <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
        <div style={{fontSize:13,fontWeight:700,color:C.muted,marginBottom:16,textTransform:"uppercase",letterSpacing:1}}>Top Cidades</div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>
              <th style={{color:C.muted,fontWeight:600,fontSize:12,textAlign:"left",paddingBottom:8}}>Cidade</th>
              <th style={{color:C.muted,fontWeight:600,fontSize:12,textAlign:"left",paddingBottom:8}}>Impressões</th>
              <th style={{color:C.muted,fontWeight:600,fontSize:12,textAlign:"left",paddingBottom:8}}>Plays</th>
            </tr></thead>
            <tbody>{cityData.map((c,i)=>(
              <tr key={i} style={{borderTop:`1px solid ${C.dark3}`}}>
                <td style={{fontWeight:600,padding:"10px 0"}}>{c.city}</td>
                <td style={{padding:"10px 0"}}>{fmt(c.impressions)}</td>
                <td style={{padding:"10px 0"}}>{fmt(c.plays)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// ── Pacing Bar ────────────────────────────────────────────────────────────────

export default PdoohDashboard;
