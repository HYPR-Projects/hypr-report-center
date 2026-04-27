import { useState, useEffect, useMemo } from "react";
import { Line } from "recharts";
import { API_URL } from "../shared/config";
import { C } from "../shared/theme";
import { fmt, fmtP, fmtP2, fmtR } from "../shared/format";
import { gaEvent, gaPageView } from "../shared/analytics";
import { enrichDetailCosts } from "../shared/enrichDetail";
import { adminAuthHeaders } from "../shared/auth";
import GlobalStyle from "../components/GlobalStyle";
import Spinner from "../components/Spinner";
import HyprLogo from "../components/HyprLogo";
import KpiCard from "../components/KpiCard";
import Tabs from "../components/Tabs";
import CollapsibleTable from "../components/CollapsibleTable";
import PerfTable from "../components/PerfTable";
import PacingBar from "../components/PacingBar";
import MediaSummary from "../components/MediaSummary";
import DualChart from "../components/DualChart";
import DetailTable from "../components/DetailTable";
import MultiLineSelect from "../components/MultiLineSelect";
import TabChat from "../components/TabChat";
import UploadTab from "../dashboards/UploadTab";
import SurveyTab from "../dashboards/SurveyTab";

const ClientDashboard = ({ token, isAdmin, adminJwt }) => {
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);
  const [mainTab,setMainTab]=useState("Visão Geral");
  const [dispTab,setDispTab]=useState("O2O");
  const [vidTab,setVidTab]=useState("O2O");
  const [dispLines,setDispLines]=useState([]);  // [] = todos
  const [vidLines,setVidLines]=useState([]);    // [] = todos
  // Alcance & Frequência — campos manuais preenchidos pelo admin
  const [alcance,setAlcance]=useState("");
  const [frequencia,setFrequencia]=useState("");
  const [editingAfReach,setEditingAfReach]=useState(false);
  const [savingAf,setSavingAf]=useState(false);
  const [isDarkClient,setIsDarkClient]=useState(true);
  const cbg   = isDarkClient ? C.dark  : "#F4F6FA";
  const cbg2  = isDarkClient ? C.dark2 : "#FFFFFF";
  const cbg3  = isDarkClient ? C.dark3 : "#EEF1F7";
  const cbdr  = isDarkClient ? C.dark3 : "#DDE2EC";
  const ctext = isDarkClient ? C.white : "#1C262F";
  const cmuted= isDarkClient ? C.muted : "#6B7A8D";
  const cTheme = { bg:cbg, bg2:cbg2, bg3:cbg3, bdr:cbdr, text:ctext, muted:cmuted };
  // Salvar alcance & frequência
  const saveAf = async () => {
    setSavingAf(true);
    try {
      await fetch(`${API_URL}?action=save_af`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminAuthHeaders(adminJwt) },
        body: JSON.stringify({ short_token: token, alcance: alcance.trim(), frequencia: frequencia.trim() }),
      });
      setEditingAfReach(false);
    } catch(e) { alert("Erro ao salvar: " + e.message); }
    finally { setSavingAf(false); }
  };

  const cardStyle = { background:cbg2, border:`1px solid ${cbdr}`, borderRadius:12, padding:20 };

  useEffect(()=>{
    fetch(`${API_URL}?token=${token}`)
      .then(r=>{
        if(!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d=>{
        if(!d.campaign) throw new Error("Campanha não encontrada");
        setData(d);setLoading(false);
        if(d.alcance!=null)   setAlcance(String(d.alcance));
        if(d.frequencia!=null) setFrequencia(String(d.frequencia));
        gaPageView(`/report/${token}`, token);
      })
      .catch(e=>{setError("Erro ao carregar dados: "+e.message);setLoading(false);});
  },[token]);

  // Agregações derivadas de `data`. Tudo aqui rodava a cada render do componente
  // (incluindo cliques em tabs, digitação no chat, etc.). Em campanhas com
  // detail grande, enrichDetailCosts é O(n*m) e era o gargalo principal.
  // Memoizando, esse trabalho roda 1x quando data chega e fica em cache até
  // o próximo fetch. Hooks precisam vir antes de early returns — daí estar aqui.
  const aggregates = useMemo(() => {
    if (!data || !data.campaign) return null;
    const noSurvey = r => !/survey/i.test(r.line_name||"");
    const totals = (data.totals||[]).filter(noSurvey);
    const daily0  = (data.daily||[]).filter(noSurvey);
    const detail0 = (data.detail||[]).filter(noSurvey);
    const daily  = daily0;
    const detail = enrichDetailCosts(detail0, totals);
    const chartDisplay = daily.filter(r=>r.media_type==="DISPLAY").map(r=>({...r,ctr:r.viewable_impressions>0?(r.clicks||0)/r.viewable_impressions*100:0}));
    const chartVideo   = daily.filter(r=>r.media_type==="VIDEO").map(r=>{
      const v100 = r.video_view_100||r.completions||r.viewable_video_view_100_complete||0;
      const vi   = r.viewable_impressions||0;
      return {...r, video_view_100: v100, completions: v100, vtr: vi>0 ? v100/vi*100 : 0};
    });

    const enrich = (rows) => rows.map(r=>({
      ...r,
      ctr: r.impressions>0?(r.clicks/r.impressions)*100:null,
      vcr: r.impressions>0?((r.viewable_video_view_100_complete||0)/r.impressions)*100:null,
      // Usar pacing do backend diretamente — já calculado com datas reais por frente
      pacing: r.pacing ?? null,
      rentabilidade: r.deal_cpm_amount>0?((r.deal_cpm_amount-(r.effective_cpm_amount||0))/r.deal_cpm_amount)*100
        :r.deal_cpcv_amount>0?((r.deal_cpcv_amount-(r.effective_cpcv_amount||0))/r.deal_cpcv_amount)*100:null,
      custo_efetivo: r.effective_total_cost,
      custo_efetivo_over: r.effective_cost_with_over,
      completions: r.viewable_video_view_100_complete ?? r.completions,
    }));

    const display = enrich(totals.filter(t=>t.media_type==="DISPLAY"));
    const video   = enrich(totals.filter(t=>t.media_type==="VIDEO"));

    const totalImpressions=totals.reduce((s,t)=>s+(t.viewable_impressions||0),0);
    const totalCusto=totals.reduce((s,t)=>s+(t.effective_total_cost||0),0);
    const totalCustoOver=totals.reduce((s,t)=>s+(t.effective_cost_with_over||0),0);

    return {
      totals, daily0, detail0, detail,
      chartDisplay, chartVideo,
      display, video,
      totalImpressions, totalCusto, totalCustoOver,
    };
  }, [data]);

  if(loading) return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:C.dark}}><GlobalStyle/><div style={{textAlign:"center"}}><Spinner size={48}/><p style={{marginTop:20,color:C.muted,fontSize:14}}>Carregando dados...</p></div></div>;
  if(error||!data||!aggregates) return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:C.dark}}><GlobalStyle/><p style={{color:C.red}}>{error||"Campanha não encontrada."}</p></div>;

  const camp   = data.campaign;
  const {
    totals, daily0, detail0, detail,
    chartDisplay, chartVideo,
    display, video,
    totalImpressions, totalCusto, totalCustoOver,
  } = aggregates;
  const mainTabs=["Visão Geral","Display","Video","RMND","PDOOH", "VIDEO LOOM","SURVEY"];
  const tacticTabs=["O2O","OOH"];

  return (
    <div style={{minHeight:"100vh",width:"100%",background:cbg,transition:"background 0.3s"}}>
      <GlobalStyle/>
      {!isDarkClient && <style>{`body{background:${cbg}!important;color:${ctext}!important;}`}</style>}
      <div style={{background:cbg2,borderBottom:`1px solid ${cbdr}`,padding:"0 32px",height:64,display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",transition:"background 0.3s"}}>
        <HyprLogo height={26} isDark={isDarkClient}/>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <button
            onClick={()=>setIsDarkClient(v=>!v)}
            title={isDarkClient?"Modo claro":"Modo escuro"}
            style={{width:36,height:36,borderRadius:9,border:`1px solid ${cbdr}`,background:cbg3,color:ctext,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.2s"}}
          >{isDarkClient?"☀️":"🌙"}</button>
          <div style={{fontSize:12,color:cmuted}}>Atualizado em {camp.updated_at?.slice(0,16).replace("T"," ")}</div>
        </div>
      </div>
      <div style={{width:"100%",maxWidth:1400,margin:"0 auto",padding:"40px 24px",background:cbg,transition:"background 0.3s"}} className="fade-in">
        <div style={{marginBottom:28,display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
      <div>
        <div style={{fontSize:12,color:C.blue,textTransform:"uppercase",letterSpacing:2,marginBottom:6}}>{camp.client_name}</div>
        <h1 style={{fontSize:26,fontWeight:900,color:ctext}}>{camp.campaign_name}</h1>
        <p style={{color:cmuted,fontSize:14,marginTop:6}}>{camp.start_date} → {camp.end_date} · <span style={{color:C.blue}}>Token: {camp.short_token}</span></p>
      </div>
        {data.logo&&(
    <img src={data.logo} alt="logo" style={{height:60,objectFit:"contain",maxWidth:220,marginTop:4,filter:isDarkClient?"none":"invert(1)"}}/>
  )}
</div>

        <Tabs tabs={mainTabs} active={mainTab} onChange={(tab)=>{ setMainTab(tab); gaEvent("tab_click", { tab_name: tab, report_token: token }); }} theme={cTheme}/>

        {mainTab==="Visão Geral"&&(
          <div style={{display:"flex",flexDirection:"column",gap:16}}>

            {/* KPI Cards */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:8}}>
              <KpiCard label="Budget Total"        value={fmtR(camp.budget_contracted)} theme={cTheme}/>
              {display.length>0&&<KpiCard label="CPM Neg." value={fmtR(camp.cpm_negociado)} theme={cTheme}/>}
              {video.length>0&&<KpiCard label="CPCV Neg." value={fmtR(camp.cpcv_negociado)} theme={cTheme}/>}
              <KpiCard label="Imp. Visíveis" value={fmt(totalImpressions)} theme={cTheme}/>
              {video.length>0&&<KpiCard label="Views 100%" value={fmt(totals.reduce((s,t)=>s+(t.completions||0),0))} theme={cTheme}/>}
              <KpiCard label="Custo Efetivo" value={fmtR(totalCusto)} color={C.blue} theme={cTheme}/>
              <KpiCard label="Custo Ef. + Over" value={fmtR(totalCustoOver)} color={C.blue} theme={cTheme}/>
            </div>

            {/* Pacing Display */}
{display.length>0&&(
  <PacingBar
    theme={cTheme}
    label="Pacing Display"
    pacing={(()=>{
      const contracted=display.reduce((s,r)=>s+(r.contracted_o2o_display_impressions||0)+(r.contracted_ooh_display_impressions||0),0);
      const bonus=display.reduce((s,r)=>s+(r.bonus_o2o_display_impressions||0)+(r.bonus_ooh_display_impressions||0),0);
      const totalNeg=contracted+bonus;
      const delivered=display.reduce((s,r)=>s+(r.viewable_impressions||0),0);
      if(!camp.start_date||!camp.end_date||!totalNeg)return 0;
      const [sy,sm,sd]=camp.start_date.split("-").map(Number);
      const [ey,em,ed]=camp.end_date.split("-").map(Number);
      const start=new Date(sy,sm-1,sd),end=new Date(ey,em-1,ed),now=new Date();
      if(now>end)return delivered/totalNeg*100;
      const total=(end-start)/864e5+1,elapsed=now<start?0:now>end?total:Math.floor((now-start)/864e5);
      const expected=totalNeg*(elapsed/total);
      return expected>0?(delivered/expected*100):0;
    })()}
    budget={display.reduce((s,r)=>s+(r.o2o_display_budget||0)+(r.ooh_display_budget||0),0)}
    cost={display.reduce((s,r)=>s+(r.effective_total_cost||0),0)}
  />
)}
{video.length>0&&(
  <PacingBar
    theme={cTheme}
    label="Pacing Video"
    pacing={video[0]?.pacing||0}
    budget={video.reduce((s,r)=>s+(r.o2o_video_budget||0)+(r.ooh_video_budget||0),0)}
    cost={video.reduce((s,r)=>s+(r.effective_total_cost||0),0)}
  />
)}

            {/* Display + Video summaries */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:12}}>
              <MediaSummary rows={totals} type="DISPLAY" theme={cTheme} detail0={detail0} camp={camp}/>
              <MediaSummary rows={totals} type="VIDEO" theme={cTheme} detail0={detail0} camp={camp}/>
            </div>

            {/* Display chart: Imp. Visíveis x CTR */}
            {chartDisplay.length>0&&(
              <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
                <div style={{fontSize:12,fontWeight:600,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Display — Imp. Visíveis × CTR Diário</div>
                <DualChart data={chartDisplay} xKey="date" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
              </div>
            )}

            {/* Video chart: Views 100% x VTR */}
            {chartVideo.length>0&&(
              <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
                <div style={{fontSize:12,fontWeight:600,color:C.darkMuted,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Video — Views 100% × VTR Diário</div>
                <DualChart data={chartVideo} xKey="date" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
              </div>
            )}

            {/* Detail table */}
            <CollapsibleTable title="Tabela Consolidada" theme={cTheme}>
              <DetailTable detail={detail} campaignName={camp.campaign_name}/>
            </CollapsibleTable>


            {/* ── Alcance & Frequência ── */}
            <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
                <div style={{fontSize:12,fontWeight:700,color:C.blue,textTransform:"uppercase",letterSpacing:1}}>Alcance & Frequência</div>
                {isAdmin&&!editingAfReach&&(
                  <button onClick={()=>setEditingAfReach(true)} style={{background:"none",border:`1px solid ${cbdr}`,color:cmuted,borderRadius:7,padding:"5px 12px",cursor:"pointer",fontSize:12,fontWeight:600}}>✏️ Editar</button>
                )}
                {isAdmin&&editingAfReach&&(
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>setEditingAfReach(false)} style={{background:"none",border:`1px solid ${cbdr}`,color:cmuted,borderRadius:7,padding:"5px 12px",cursor:"pointer",fontSize:12}}>Cancelar</button>
                    <button onClick={saveAf} disabled={savingAf} style={{background:C.blue,color:"#fff",border:"none",borderRadius:7,padding:"5px 14px",cursor:"pointer",fontSize:12,fontWeight:700,opacity:savingAf?0.6:1}}>{savingAf?"Salvando...":"✓ Salvar"}</button>
                  </div>
                )}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12}}>
                {/* Alcance */}
                <div style={{background:cbg3,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Alcance</div>
                  {isAdmin&&editingAfReach
                    ? <input value={alcance} onChange={e=>setAlcance(e.target.value)} placeholder="Ex: 1.250.000" style={{width:"100%",background:cbg2,border:`1px solid ${C.blue}60`,borderRadius:7,padding:"8px 12px",color:ctext,fontSize:16,fontWeight:800,outline:"none"}}/>
                    : <div style={{fontSize:22,fontWeight:800,color:ctext}}>{alcance||"—"}</div>
                  }
                </div>
                {/* Frequência */}
                <div style={{background:cbg3,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Frequência</div>
                  {isAdmin&&editingAfReach
                    ? <input value={frequencia} onChange={e=>setFrequencia(e.target.value)} placeholder="Ex: 3.2x" style={{width:"100%",background:cbg2,border:`1px solid ${C.blue}60`,borderRadius:7,padding:"8px 12px",color:ctext,fontSize:16,fontWeight:800,outline:"none"}}/>
                    : <div style={{fontSize:22,fontWeight:800,color:ctext}}>{frequencia||"—"}</div>
                  }
                </div>
              </div>
              {!isAdmin&&!alcance&&!frequencia&&(
                <p style={{fontSize:12,color:cmuted,marginTop:12,opacity:0.7}}>Dados de alcance e frequência serão disponibilizados em breve.</p>
              )}
            </div>

            <TabChat token={token} tabName="Visão Geral" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={cTheme}/>

          </div>
        )}

         {mainTab==="Display"&&(<div>
    <Tabs tabs={tacticTabs} active={dispTab} onChange={(t)=>{setDispTab(t);setDispLines([]);}} small theme={cTheme}/>
    {(()=>{
      const rows = totals.filter(r=>r.media_type==="DISPLAY" && r.tactic_type===dispTab);
      const detailAll = detail0.filter(r=>r.media_type==="DISPLAY" && r.line_name?.toLowerCase().includes(dispTab.toLowerCase()));
      const dailyAll  = daily0.filter(r=>r.media_type==="DISPLAY" && r.line_name?.toLowerCase().includes(dispTab.toLowerCase()));
      // Lines disponíveis para o dropdown
      const lineNames=["ALL",...[...new Set(detailAll.map(r=>r.line_name).filter(Boolean))].sort()];
      // detail/daily filtrados pela line — para impressões, cliques, gráficos, tabela
      const detail = dispLines.length===0 ? detailAll : detailAll.filter(r=>dispLines.includes(r.line_name));
      const daily = (()=>{
          const m={};
          detail.forEach(r=>{
            if(!r.date)return;
            if(!m[r.date])m[r.date]={date:r.date,viewable_impressions:0,clicks:0};
            m[r.date].viewable_impressions+=Number(r.viewable_impressions)||0;
            m[r.date].clicks+=Number(r.clicks)||0;
          });
          return Object.values(m).sort((a,b)=>a.date>b.date?1:-1).map(r=>({...r,ctr:r.viewable_impressions>0?r.clicks/r.viewable_impressions*100:0}));
        })();
      // Gráfico por audiência — sempre do total
      const getAudience = (ln) => { const p=(ln||"").split("_"); return p.length>=2?p[p.length-2]:"N/A"; };
      const byAudience=Object.values(detailAll.reduce((acc,r)=>{
        const k=getAudience(r.line_name);
        if(/survey/i.test(k)||k==="N/A")return acc;
        if(!acc[k])acc[k]={audience:k,viewable_impressions:0,clicks:0};
        acc[k].viewable_impressions+=r.viewable_impressions||0;
        acc[k].clicks+=r.clicks||0;
        return acc;
      },{})).map(r=>({...r,ctr:r.viewable_impressions>0?r.clicks/r.viewable_impressions*100:0}));
      // KPIs filtrados
      const sumD = k => detail.reduce((s,r)=>s+(r[k]||0),0);
      const cost=rows.reduce((s,r)=>s+(r.effective_total_cost||0),0);
      const impr=sumD("impressions"), vi=sumD("viewable_impressions"), clks=sumD("clicks");
      const ctr=vi>0?clks/vi*100:0;
      // Métricas contratuais — sempre do TOTAL
      const sumDAll = k => detailAll.reduce((s,r)=>s+(r[k]||0),0);
      const viAll=sumDAll("viewable_impressions");
      const budget=rows.reduce((s,r)=>s+(dispTab==="O2O"?(r.o2o_display_budget||0):(r.ooh_display_budget||0)),0);
      const cpmNeg=rows[0]?.deal_cpm_amount||0;
      const [sy2,sm2,sd2]=camp.start_date.split("-").map(Number);
      const [ey2,em2,ed2]=camp.end_date.split("-").map(Number);
      const start2=new Date(sy2,sm2-1,sd2),end2=new Date(ey2,em2-1,ed2),today2=new Date();
      const contracted2=dispTab==="O2O"?(rows[0]?.contracted_o2o_display_impressions||0):(rows[0]?.contracted_ooh_display_impressions||0);
      const bonus2=dispTab==="O2O"?(rows[0]?.bonus_o2o_display_impressions||0):(rows[0]?.bonus_ooh_display_impressions||0);
      const totalNeg2=contracted2+bonus2;
      const tDays=(end2-start2)/864e5+1, eDays=today2<start2?0:today2>end2?tDays:Math.floor((today2-start2)/864e5);
      const budgetPropDisp=today2>end2?budget:budget/tDays*eDays;
      // CPM Efetivo, Rentabilidade e Pacing sempre sobre total (não filtrado por audiência)
      const cpmEf=cpmNeg>0?Math.min(viAll>0?budgetPropDisp/viAll*1000:0,cpmNeg):0;
      const cpc=clks>0?cpmEf/1000*(viAll/clks):0;
      const rentab=cpmNeg>0?(cpmNeg-cpmEf)/cpmNeg*100:0;
      const deliveredAll=sumDAll("viewable_impressions");
      const expected2=totalNeg2*(eDays/tDays);
      const pac=totalNeg2>0?(today2>end2?deliveredAll/totalNeg2*100:expected2>0?deliveredAll/expected2*100:0):0;
      const pacBase=Math.min(pac,100), pacOver=Math.max(0,pac-100);
      const bySize=Object.values(detail.reduce((acc,r)=>{
        const k=r.creative_size||"N/A";
        if(!acc[k])acc[k]={size:k,viewable_impressions:0,clicks:0};
        acc[k].viewable_impressions+=r.viewable_impressions||0;
        acc[k].clicks+=r.clicks||0;
        return acc;
      },{})).map(r=>({...r,ctr:r.viewable_impressions>0?r.clicks/r.viewable_impressions*100:0}));
      return (
        <div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20,padding:"10px 16px",background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10}}>
              <span style={{fontSize:12,color:cmuted,fontWeight:600,textTransform:"uppercase",letterSpacing:1,flexShrink:0}}>Line Item:</span>
              <MultiLineSelect lines={lineNames} selected={dispLines} onChange={setDispLines} theme={cTheme}/>
              {dispLines.length>0&&<button onClick={()=>setDispLines([])} style={{background:"none",border:`1px solid ${cbdr}`,color:cmuted,borderRadius:7,padding:"5px 12px",cursor:"pointer",fontSize:12,flexShrink:0}}>✕ Limpar</button>}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20}}>
            {[
              {l:"Budget Contratado",v:fmtR(budget)},
              {l:"Imp. Contratadas",v:fmt(dispTab==="O2O"?(rows[0]?.contracted_o2o_display_impressions||0):(rows[0]?.contracted_ooh_display_impressions||0))},
              {l:"Imp. Bonus",v:fmt(dispTab==="O2O"?(rows[0]?.bonus_o2o_display_impressions||0):(rows[0]?.bonus_ooh_display_impressions||0))},
              {l:"CPM Negociado",v:fmtR(cpmNeg)},
            ].map(({l,v})=>(
              <div key={l} style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>{l}</div>
                <div style={{fontSize:18,fontWeight:800,marginTop:4,color:ctext}}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20}}>
            {[
              {l:"Impressões",        v:fmt(impr)},
              {l:"Imp. Visíveis",     v:fmt(vi)},
              {l:"CPM Efetivo",       v:fmtR(cpmEf), blue:true},
              {l:"Rentabilidade",     v:fmtP(rentab), color:rentab>0?C.blue:rentab<0?C.red:C.white},
              {l:"Cliques",           v:fmt(clks)},
              {l:"CTR",               v:fmtP2(ctr)},
              {l:"CPC",               v:fmtR(cpc)},
            ].map(({l,v,blue,color})=>(
              <div key={l} style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>{l}</div>
                <div style={{fontSize:18,fontWeight:800,marginTop:4,color:color||(blue?C.blue:ctext)}}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:"16px 20px",marginBottom:20}}>
            {(()=>{const barC=pac>=100?"#2ECC71":pac>=70?"#F1C40F":"#E74C3C";const overC=isDarkClient?"#C5EAF6":"#246C84";return(<>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontSize:12,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>Pacing {dispTab}</span>
              <span style={{fontSize:13,fontWeight:700,color:pac>100?overC:barC}}>{fmt(pac,1)}%{pac>100&&` ⚡ Over de ${fmt(pac-100,1)}%`}</span>
            </div>
            <div style={{height:8,background:isDarkClient?C.dark3:"#E2E8F0",borderRadius:4,overflow:"hidden"}}>
              <div style={{display:"flex",height:"100%"}}>
                <div style={{width:`${pacBase}%`,background:barC,borderRadius:4,transition:"width 0.8s"}}/>
                {pacOver>0&&<div style={{width:`${Math.min(pacOver,20)}%`,background:overC,borderRadius:4}}/>}
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
              <span style={{fontSize:11,color:cmuted}}>Investido: {fmtR(cost)}</span>
              <span style={{fontSize:11,color:cmuted}}>Budget: {fmtR(budget)}</span>
            </div>
            </>);})()}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20}}>
            <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
              <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Entrega × CTR Diário</div>
              <DualChart data={daily} xKey="date" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
            </div>
            <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
              <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Entrega × CTR por Tamanho</div>
              <DualChart data={bySize} xKey="size" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
            </div>
          </div>
          <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20,marginBottom:20}}>
            <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Entrega × CTR por Audiência</div>
            <DualChart data={byAudience} xKey="audience" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
          </div>
          <CollapsibleTable title="Detalhamento Diário" theme={cTheme}>
            <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
              <button onClick={()=>{
                const headers=["Data","Campanha","Line","Criativo","Tamanho","Tática","Impressões","Imp. Visíveis","Cliques","CTR","CPM Ef.","Custo Ef."];
                const csv=[headers,...detail.map(r=>[r.date,r.campaign_name,r.line_name,r.creative_name,r.creative_size,r.tactic_type,r.impressions,r.viewable_impressions,r.clicks,r.ctr,r.effective_cpm_amount,r.effective_total_cost])].map(r=>r.map(v=>`"${v??""}`).join(",")).join("\n");
                const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=`display_${dispTab}_${camp.campaign_name}.csv`;a.click();
              }} style={{background:C.blue,color:C.white,border:"none",padding:"8px 16px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600}}>⬇ Download CSV</button>
            </div>
            <PerfTable rows={detail} type="DISPLAY"/>
          </CollapsibleTable>
          <TabChat token={token} tabName="Display" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={cTheme}/>
        </div>
      );
    })()}
  </div>
)}
        {mainTab==="Video"&&(<div>
    <Tabs tabs={tacticTabs} active={vidTab} onChange={(t)=>{setVidTab(t);setVidLines([]);}} small theme={cTheme}/>
    {(()=>{
      const rows = totals.filter(r=>r.media_type==="VIDEO" && r.tactic_type===vidTab);
      const detailAllV = detail0.filter(r=>r.media_type==="VIDEO" && r.line_name?.toLowerCase().includes(vidTab.toLowerCase()));
      const dailyAllV  = daily0.filter(r=>r.media_type==="VIDEO" && r.line_name?.toLowerCase().includes(vidTab.toLowerCase()));
      // Lines disponíveis para o dropdown
      const lineNamesV=["ALL",...[...new Set(detailAllV.map(r=>r.line_name).filter(Boolean))].sort()];
      // detail/daily filtrados pela line
      const detail = vidLines.length===0 ? detailAllV : detailAllV.filter(r=>vidLines.includes(r.line_name));
      const daily = (()=>{
          const m={};
          detail.forEach(r=>{
            if(!r.date)return;
            if(!m[r.date])m[r.date]={date:r.date,viewable_impressions:0,video_view_100:0};
            m[r.date].viewable_impressions+=Number(r.viewable_impressions)||0;
            m[r.date].video_view_100+=Number(r.video_view_100||r.completions||0);
          });
          return Object.values(m).sort((a,b)=>a.date>b.date?1:-1).map(r=>({...r,vtr:r.viewable_impressions>0?r.video_view_100/r.viewable_impressions*100:0}));
        })();
      // Gráfico por audiência — sempre do total
      const getAudienceV = (ln) => { const p=(ln||"").split("_"); return p.length>=2?p[p.length-2]:"N/A"; };
      const byAudience=Object.values(detailAllV.reduce((acc,r)=>{
        const k=getAudienceV(r.line_name);
        if(/survey/i.test(k)||k==="N/A")return acc;
        if(!acc[k])acc[k]={audience:k,viewable_impressions:0,video_view_100:0};
        acc[k].viewable_impressions+=r.viewable_impressions||0;
        acc[k].video_view_100+=r.video_view_100||0;
        return acc;
      },{})).map(r=>({...r,vtr:r.viewable_impressions>0?r.video_view_100/r.viewable_impressions*100:0}));
      // KPIs filtrados
      const cost=rows.reduce((s,r)=>s+(r.effective_total_cost||0),0);
      const vi=detail.reduce((s,r)=>s+(r.viewable_impressions||0),0);
      const views100=detail.reduce((s,r)=>s+(r.video_view_100||0),0);
      const starts=detail.reduce((s,r)=>s+(r.video_starts||0),0);
      const vtr=vi>0?views100/vi*100:0;
      // Métricas contratuais — direto do totals (backend já calculou corretamente)
      const views100All=rows.reduce((s,r)=>s+(r.completions||0),0);
      const viAll=detailAllV.reduce((s,r)=>s+(r.viewable_impressions||0),0);
      const budget=rows.reduce((s,r)=>s+(vidTab==="O2O"?(r.o2o_video_budget||0):(r.ooh_video_budget||0)),0);
      const cpcvNeg=rows[0]?.deal_cpcv_amount||0;
      const contracted2=vidTab==="O2O"?(rows[0]?.contracted_o2o_video_completions||0):(rows[0]?.contracted_ooh_video_completions||0);
      const bonus2=vidTab==="O2O"?(rows[0]?.bonus_o2o_video_completions||0):(rows[0]?.bonus_ooh_video_completions||0);
      const totalNeg2=contracted2+bonus2;
      // CPCV Efetivo, Rentabilidade e Pacing — usar pacing do backend
      const cpcvEf=rows[0]?.effective_cpcv_amount||0;
      const rentab=rows[0]?.rentabilidade||0;
      const pac=rows[0]?.pacing||0;
      const pacBase=Math.min(pac,100), pacOver=Math.max(0,pac-100);
      const bySize=Object.values(detail.reduce((acc,r)=>{
        const k=r.creative_size||"N/A";
        if(!acc[k])acc[k]={size:k,viewable_impressions:0,video_view_100:0};
        acc[k].viewable_impressions+=r.viewable_impressions||0;
        acc[k].video_view_100+=r.video_view_100||0;
        return acc;
      },{})).map(r=>({...r,vtr:r.viewable_impressions>0?r.video_view_100/r.viewable_impressions*100:0}));
      return (
        <div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20,padding:"10px 16px",background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10}}>
              <span style={{fontSize:12,color:cmuted,fontWeight:600,textTransform:"uppercase",letterSpacing:1,flexShrink:0}}>Line Item:</span>
              <MultiLineSelect lines={lineNamesV} selected={vidLines} onChange={setVidLines} theme={cTheme}/>
              {vidLines.length>0&&<button onClick={()=>setVidLines([])} style={{background:"none",border:`1px solid ${cbdr}`,color:cmuted,borderRadius:7,padding:"5px 12px",cursor:"pointer",fontSize:12,flexShrink:0}}>✕ Limpar</button>}
          </div>
          {/* Linha 1 — dados contratuais */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20}}>
            {[
              {l:"Budget Contratado",v:fmtR(budget)},
              {l:"Views Contratadas",v:fmt(vidTab==="O2O"?(rows[0]?.contracted_o2o_video_completions||0):(rows[0]?.contracted_ooh_video_completions||0))},
              {l:"Views Bonus",v:fmt(vidTab==="O2O"?(rows[0]?.bonus_o2o_video_completions||0):(rows[0]?.bonus_ooh_video_completions||0))},
              {l:"CPCV Negociado",v:fmtR(cpcvNeg)},
            ].map(({l,v})=>(
              <div key={l} style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>{l}</div>
                <div style={{fontSize:18,fontWeight:800,marginTop:4,color:ctext}}>{v}</div>
              </div>
            ))}
          </div>
          {/* Linha 2 — dados de performance */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20}}>
            {[
              {l:"Views Start",    v:fmt(starts)},
              {l:"Views 100%",     v:fmt(views100)},
              {l:"VTR",            v:fmtP2(vtr)},
              {l:"CPCV Efetivo",   v:fmtR(cpcvEf), blue:true},
              {l:"Rentabilidade",  v:fmtP(rentab), color:rentab>0?C.blue:rentab<0?C.red:C.white},
            ].map(({l,v,blue,color})=>(
              <div key={l} style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>{l}</div>
                <div style={{fontSize:18,fontWeight:800,marginTop:4,color:color||(blue?C.blue:ctext)}}>{v}</div>
              </div>
            ))}
          </div>
          {/* Pacing */}
          <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:"16px 20px",marginBottom:20}}>
            {(()=>{const barC=pac>=100?"#2ECC71":pac>=70?"#F1C40F":"#E74C3C";const overC=isDarkClient?"#C5EAF6":"#246C84";return(<>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontSize:12,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>Pacing {vidTab}</span>
              <span style={{fontSize:13,fontWeight:700,color:pac>100?overC:barC}}>{fmt(pac,1)}%{pac>100&&` ⚡ Over de ${fmt(pac-100,1)}%`}</span>
            </div>
            <div style={{height:8,background:isDarkClient?C.dark3:"#E2E8F0",borderRadius:4,overflow:"hidden"}}>
              <div style={{display:"flex",height:"100%"}}>
                <div style={{width:`${pacBase}%`,background:barC,borderRadius:4,transition:"width 0.8s"}}/>
                {pacOver>0&&<div style={{width:`${Math.min(pacOver,20)}%`,background:overC,borderRadius:4}}/>}
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
              <span style={{fontSize:11,color:cmuted}}>Investido: {fmtR(cost)}</span>
              <span style={{fontSize:11,color:cmuted}}>Budget: {fmtR(budget)}</span>
            </div>
            </>);})()}
          </div>
          {/* Gráficos */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20}}>
            <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
              <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Views 100% × VTR Diário</div>
              <DualChart data={daily} xKey="date" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
            </div>
            <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
              <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Views 100% × VTR por Tamanho</div>
              <DualChart data={bySize} xKey="size" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
            </div>
          </div>
          <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20,marginBottom:20}}>
            <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Views 100% × VTR por Audiência</div>
            <DualChart data={byAudience} xKey="audience" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
          </div>
          {/* Download + Tabela */}
          <CollapsibleTable title="Detalhamento Diário" theme={cTheme}>
            <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
              <button onClick={()=>{
                const headers=["Data","Campanha","Line","Criativo","Tamanho","Tática","Imp. Visíveis","Video Start","Views 25%","Views 50%","Views 75%","Views 100%","VTR","Custo Ef."];
                const csv=[headers,...detail.map(r=>[r.date,r.campaign_name,r.line_name,r.creative_name,r.creative_size,r.tactic_type,r.viewable_impressions,r.video_starts,r.video_view_25,r.video_view_50,r.video_view_75,r.video_view_100,r.vtr??0,r.effective_total_cost])].map(r=>r.map(v=>`"${v??""}`).join(",")).join("\n");
                const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=`video_${vidTab}_${camp.campaign_name}.csv`;a.click();
              }} style={{background:C.blue,color:C.white,border:"none",padding:"8px 16px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600}}>⬇ Download CSV</button>
            </div>
            <PerfTable rows={detail} type="VIDEO"/>
          </CollapsibleTable>
          <TabChat token={token} tabName="Video" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={cTheme}/>
        </div>
      );
    })()}
  </div>
)}

        {mainTab==="RMND"&&<div><UploadTab type="RMND" token={token} serverData={data.rmnd} readOnly={!isAdmin} adminJwt={adminJwt}/><TabChat token={token} tabName="RMND" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={cTheme}/></div>}
        {mainTab==="PDOOH"&&<div><UploadTab type="PDOOH" token={token} serverData={data.pdooh} readOnly={!isAdmin} adminJwt={adminJwt}/><TabChat token={token} tabName="PDOOH" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={cTheme}/></div>}
        {mainTab==="VIDEO LOOM"&&(
          <div style={{padding:"24px 0"}}>
            {data.loom?(
          <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,overflow:"hidden",position:"relative",paddingTop:"56.25%"}}>
            <iframe
              src={data.loom.replace("https://www.loom.com/share/","https://www.loom.com/embed/")}
              frameBorder="0"
              allowFullScreen
              style={{position:"absolute",top:0,left:0,width:"100%",height:"100%"}}
        />
      </div>
      
    ):(
      <div style={{textAlign:"center",padding:80,color:C.muted}}>
        <div style={{fontSize:40,marginBottom:16}}>🎥</div>
        <div style={{fontSize:16,fontWeight:600}}>Nenhum vídeo disponível ainda</div>
        <div style={{fontSize:13,marginTop:8}}>O vídeo explicativo será adicionado em breve.</div>
      </div>
    )}
  </div>
)}
{mainTab==="SURVEY"&&(
  <div style={{padding:"24px 0"}}>
    {data.survey?<SurveyTab surveyJson={data.survey} token={token} isAdmin={isAdmin} adminJwt={adminJwt} theme={cTheme}/>
    :<div style={{color:C.muted,textAlign:"center",padding:40}}>Nenhum survey cadastrado para esta campanha.</div>}
  </div>
)}
</div>
    </div>
  );
};
// ══════════════════════════════════════════════════════════════════════════════
// APP ROOT
// ══════════════════════════════════════════════════════════════════════════════

export default ClientDashboard;
