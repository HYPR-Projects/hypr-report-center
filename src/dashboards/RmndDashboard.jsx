import { useState, useMemo } from "react";
import { C } from "../shared/theme";
import { fmt, fmtP2, fmtR } from "../shared/format";
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

const RmndDashboard = ({ data, onClear, isDark = true }) => {
  const allRows = data.rows;

  // Min/max derivados das próprias rows (não há campaign info aqui)
  const dateBounds = useMemo(() => {
    let min = null, max = null;
    allRows.forEach(r => {
      const d = getRowDate(r, ["Date", "DATE", "date"]);
      if (!d) return;
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    });
    return {
      min: min ? parseYmd(min) : null,
      max: max ? parseYmd(max) : null,
    };
  }, [allRows]);

  const [range, setRangeState] = useState(() => readRangeFromUrl("rmnd"));
  const setRange = (r) => {
    setRangeState(r);
    writeRangeToUrl(r, "rmnd");
  };

  // Filtra rows por range. Se sem filtro, usa tudo.
  const rows = useMemo(() => {
    if (!range) return allRows;
    return allRows.filter(r => {
      const d = getRowDate(r, ["Date", "DATE", "date"]);
      return d && inRange(d, range);
    });
  }, [allRows, range]);

  const get = (r,k) => { for(const key of Object.keys(r)){ if(key.includes(k)) return Number(r[key])||0; } return 0; };
  const totalImpressions = rows.reduce((s,r)=>s+(Number(r["Impressions"])||0),0);
  const totalClicks      = rows.reduce((s,r)=>s+(Number(r["Clicks"])||0),0);
  const totalSpend       = rows.reduce((s,r)=>s+(Number(r["Spend"])||0),0);
  const totalSales       = rows.reduce((s,r)=>s+get(r,"14 Day Total Sales"),0);
  const totalOrders      = rows.reduce((s,r)=>s+get(r,"14 Day Total Orders"),0);
  const totalUnits       = rows.reduce((s,r)=>s+get(r,"14 Day Total Units"),0);
  const avgTicket        = totalOrders>0?totalSales/totalOrders:0;
  const avgCTR           = totalImpressions>0?(totalClicks/totalImpressions)*100:0;
  const roas             = totalSpend>0?totalSales/totalSpend:0;

  const byDate={};
  rows.forEach(r=>{
    const d = getRowDate(r, ["Date", "DATE", "date"]);
    if (!d) return;
    if(!byDate[d])byDate[d]={date:d,spend:0,sales:0,impressions:0};
    byDate[d].spend      +=Number(r["Spend"])||0;
    byDate[d].sales      +=get(r,"14 Day Total Sales");
    byDate[d].impressions+=Number(r["Impressions"])||0;
  });
  const chartData=Object.values(byDate).sort((a,b)=>a.date>b.date?1:-1);

  const fmtTooltip=(value,name)=>{
    if(name==="spend"||name==="sales") return [`R$ ${Number(value).toFixed(2).replace(".",",")}`,name==="spend"?"Spend":"Vendas"];
    return [value,name];
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:12}}>
        <div style={{fontSize:11,color:C.muted}}>Atualizado em: {new Date(data.uploadedAt).toLocaleString("pt-BR")}</div>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          {range && (
            <span style={{fontSize:12,color:C.muted}}>
              {rows.length} de {allRows.length} linhas · {daysInRange(range)}d
            </span>
          )}
          <DateRangeFilter
            value={range}
            onChange={setRange}
            minDate={dateBounds.min}
            maxDate={dateBounds.max}
            isDark={isDark}
          />
          {onClear && (
            <button onClick={onClear} style={{background:C.dark3,color:C.muted,border:"none",padding:"6px 14px",borderRadius:8,cursor:"pointer",fontSize:12}}>🔄 Trocar arquivo</button>
          )}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(100px,1fr))",gap:12,marginBottom:24}}>
        <KpiCard label="Impressões"   value={fmt(totalImpressions)}/>
        <KpiCard label="Cliques"      value={fmt(totalClicks)}/>
        <KpiCard label="CTR"          value={fmtP2(avgCTR)} color={C.blue}/>
        <KpiCard label="ROAS"         value={roas.toFixed(2)+"x"} color={C.blue}/>
        <KpiCard label="Vendas 14d" value={fmtR(totalSales)} color={C.green} fontSize={16}/>
        <KpiCard label="Pedidos"      value={fmt(totalOrders)}/>
        <KpiCard label="Unidades"     value={fmt(totalUnits)}/>
        <KpiCard label="Ticket Médio" value={fmtR(avgTicket)}/>
      </div>
      {rows.length === 0 ? (
        <div style={{textAlign:"center",padding:48,color:C.muted,background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12}}>
          Nenhuma linha encontrada no período selecionado.
        </div>
      ) : (
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
          <div style={{fontSize:13,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Spend Diário</div>
          <BarChart data={chartData} xKey="date" yKey="spend" color={C.blue} formatter={fmtTooltip}/>
        </div>
        <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
          <div style={{fontSize:13,fontWeight:700,color:C.green,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Vendas Diárias (14d)</div>
          <BarChart data={chartData} xKey="date" yKey="sales" color={C.green} formatter={fmtTooltip}/>
        </div>
      </div>
      )}
    </div>
  );
};

export default RmndDashboard;
