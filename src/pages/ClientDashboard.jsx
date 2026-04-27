import { useState, useEffect, useMemo } from "react";
import { C } from "../shared/theme";
import { getTheme, setTheme } from "../shared/prefs";
import { gaEvent, gaPageView } from "../shared/analytics";
import { enrichDetailCosts } from "../shared/enrichDetail";
import { getCampaign, saveAlcanceFrequencia } from "../lib/api";
import GlobalStyle from "../components/GlobalStyle";
import Spinner from "../components/Spinner";
import HyprLogo from "../components/HyprLogo";
import Tabs from "../components/Tabs";
import UploadTab from "../dashboards/UploadTab";
import SurveyTab from "../dashboards/SurveyTab";
import TabChat from "../components/TabChat";
import OverviewTab from "../components/dashboard-tabs/OverviewTab";
import DisplayTab from "../components/dashboard-tabs/DisplayTab";
import VideoTab from "../components/dashboard-tabs/VideoTab";
import LoomTab from "../components/dashboard-tabs/LoomTab";

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
  const [isDarkClient,setIsDarkClient]=useState(() => getTheme() === "dark");
  // Persiste a escolha de tema entre sessões (compartilhada com CampaignMenu).
  useEffect(() => { setTheme(isDarkClient ? "dark" : "light"); }, [isDarkClient]);
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
      await saveAlcanceFrequencia({
        short_token: token,
        alcance: alcance.trim(),
        frequencia: frequencia.trim(),
        adminJwt,
      });
      setEditingAfReach(false);
    } catch(e) { alert("Erro ao salvar: " + e.message); }
    finally { setSavingAf(false); }
  };



  useEffect(()=>{
    getCampaign(token)
      .then(d=>{
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
  const mainTabs = ["Visão Geral", "Display", "Video", "RMND", "PDOOH", "VIDEO LOOM", "SURVEY"];

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

        {mainTab==="Visão Geral" && (
          <OverviewTab
            data={data}
            aggregates={aggregates}
            theme={cTheme}
            token={token}
            isAdmin={isAdmin}
            adminJwt={adminJwt}
            alcance={alcance}
            frequencia={frequencia}
            setAlcance={setAlcance}
            setFrequencia={setFrequencia}
            editingAfReach={editingAfReach}
            setEditingAfReach={setEditingAfReach}
            savingAf={savingAf}
            saveAf={saveAf}
          />
        )}

        {mainTab==="Display" && (
          <DisplayTab
            aggregates={aggregates}
            camp={camp}
            theme={cTheme}
            token={token}
            isAdmin={isAdmin}
            adminJwt={adminJwt}
            isDarkClient={isDarkClient}
            dispTab={dispTab}
            setDispTab={setDispTab}
            dispLines={dispLines}
            setDispLines={setDispLines}
          />
        )}

        {mainTab==="Video" && (
          <VideoTab
            aggregates={aggregates}
            camp={camp}
            theme={cTheme}
            token={token}
            isAdmin={isAdmin}
            adminJwt={adminJwt}
            isDarkClient={isDarkClient}
            vidTab={vidTab}
            setVidTab={setVidTab}
            vidLines={vidLines}
            setVidLines={setVidLines}
          />
        )}
        {mainTab==="RMND"&&<div><UploadTab type="RMND" token={token} serverData={data.rmnd} readOnly={!isAdmin} adminJwt={adminJwt}/><TabChat token={token} tabName="RMND" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={cTheme}/></div>}
        {mainTab==="PDOOH"&&<div><UploadTab type="PDOOH" token={token} serverData={data.pdooh} readOnly={!isAdmin} adminJwt={adminJwt}/><TabChat token={token} tabName="PDOOH" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={cTheme}/></div>}
        {mainTab==="VIDEO LOOM" && <LoomTab loomUrl={data.loom}/>}
        {mainTab==="SURVEY" && (
          <div style={{padding:"24px 0"}}>
            {data.survey
              ? <SurveyTab surveyJson={data.survey} token={token} isAdmin={isAdmin} adminJwt={adminJwt} theme={cTheme}/>
              : <div style={{color:C.muted,textAlign:"center",padding:40}}>Nenhum survey cadastrado para esta campanha.</div>}
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
