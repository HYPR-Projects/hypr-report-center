import { C } from "../shared/theme";
import { fmt, fmtP2, fmtR } from "../shared/format";
import BarChart from "../components/BarChart";
import KpiCard from "../components/KpiCard";

const RmndDashboard = ({ data, onClear }) => {
  const rows=data.rows;
  const get=(r,k)=>{for(const key of Object.keys(r)){if(key.includes(k))return Number(r[key])||0;}return 0;};
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
    let d=r["Date"]||r["DATE"]||"";
    if(typeof d==="number"){
      // Converte serial do Excel para data
      const excelEpoch=new Date(1899,11,30);
      const dt=new Date(excelEpoch.getTime()+d*86400000);
      d=dt.toISOString().slice(0,10);
    } else {
      d=String(d).slice(0,10);
    }
    if(!d||d==="NaN-Na")return;
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
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:11,color:C.muted}}>Atualizado em: {new Date(data.uploadedAt).toLocaleString("pt-BR")}</div>
        <button onClick={onClear} style={{background:C.dark3,color:C.muted,border:"none",padding:"6px 14px",borderRadius:8,cursor:"pointer",fontSize:12}}>🔄 Trocar arquivo</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(100px,1fr))",gap:12,marginBottom:24}}>
        <KpiCard label="Impressões"   value={fmt(totalImpressions)}/>
        <KpiCard label="Cliques"      value={fmt(totalClicks)}/>
        <KpiCard label="CTR"          value={fmtP2(avgCTR)} color={C.blue}/>
        <KpiCard label="ROAS"         value={roas.toFixed(2)+"x"} color={C.blue}/>
        <KpiCard label="Vendas 14d" value={fmtR(totalSales)} color={C.green} fontSize={16}/>        <KpiCard label="Pedidos"      value={fmt(totalOrders)}/>
        <KpiCard label="Unidades"     value={fmt(totalUnits)}/>
        <KpiCard label="Ticket Médio" value={fmtR(avgTicket)}/>
      </div>
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
    </div>
  );
};

// ── PDOOH Dashboard ───────────────────────────────────────────────────────────
// ── PDOOH Dashboard ───────────────────────────────────────────────────────────

export default RmndDashboard;
