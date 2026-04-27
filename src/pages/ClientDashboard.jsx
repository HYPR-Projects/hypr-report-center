import { useState, useEffect, useMemo } from "react";
import { C } from "../shared/theme";
import { getTheme, setTheme } from "../shared/prefs";
import { gaEvent, gaPageView } from "../shared/analytics";
import { enrichDetailCosts } from "../shared/enrichDetail";
import {
  readRangeFromUrl,
  writeRangeToUrl,
  inRange,
  parseYmd,
  daysInRange,
  daysBetween,
  formatRangeShort,
} from "../shared/dateFilter";
import { getCampaign, saveAlcanceFrequencia } from "../lib/api";
import GlobalStyle from "../components/GlobalStyle";
import Spinner from "../components/Spinner";
import HyprLogo from "../components/HyprLogo";
import Tabs from "../components/Tabs";
import DateRangeFilter from "../components/DateRangeFilter";
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

  // Filtro de período — compartilhado entre Visão Geral / Display / Video.
  // Lido da URL (?from=&to=) pra ser shareable e sobreviver a refresh.
  // RMND e PDOOH têm seus próprios filtros independentes (gerenciados dentro
  // de cada UploadTab via prefix "rmnd"/"pdooh").
  const [mainRange, setMainRangeState] = useState(() => readRangeFromUrl());
  const setMainRange = (r) => {
    setMainRangeState(r);
    writeRangeToUrl(r);
  };
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
  //
  // Quando há filtro de período (mainRange), re-agrega tudo a partir do
  // `detail` filtrado por data. `detail` tem dimensão (date, line, creative)
  // então é a fonte de verdade pra recalcular `totals` filtrados. Custos de
  // detail são reproporcionalizados em `enrichDetailCosts` baseado nos novos
  // totals.
  const aggregates = useMemo(() => {
    if (!data || !data.campaign) return null;
    const noSurvey = r => !/survey/i.test(r.line_name||"");
    const totalsRaw = (data.totals||[]).filter(noSurvey);
    const dailyRaw  = (data.daily||[]).filter(noSurvey);
    const detailRaw = (data.detail||[]).filter(noSurvey);

    const isFiltered = !!mainRange;
    const daily0  = isFiltered ? dailyRaw.filter(r => inRange(r.date, mainRange))   : dailyRaw;
    const detail0 = isFiltered ? detailRaw.filter(r => inRange(r.date, mainRange))  : detailRaw;

    // Quando filtrado, reconstroi `totals` agregando `detail0` por
    // (media_type, tactic_type). Mantém preços de tabela (deal_cpm/cpcv) do
    // `totalsRaw` original — esses são fixos da campanha e não dependem de
    // qual janela está sendo analisada. Custo efetivo é re-somado de detail.
    let totals = totalsRaw;
    if (isFiltered) {
      const byKey = {};
      detail0.forEach(r => {
        const k = `${r.media_type}|${r.tactic_type}`;
        if (!byKey[k]) {
          byKey[k] = {
            media_type: r.media_type,
            tactic_type: r.tactic_type,
            impressions: 0,
            viewable_impressions: 0,
            clicks: 0,
            video_view_100: 0,
            video_view_25: 0, video_view_50: 0, video_view_75: 0,
            video_starts: 0,
            completions: 0,
            effective_total_cost: 0,
            line_name: "TOTAL",
          };
        }
        const g = byKey[k];
        g.impressions          += r.impressions          || 0;
        g.viewable_impressions += r.viewable_impressions || 0;
        g.clicks               += r.clicks               || 0;
        g.video_view_100       += r.video_view_100       || 0;
        g.video_view_25        += r.video_view_25        || 0;
        g.video_view_50        += r.video_view_50        || 0;
        g.video_view_75        += r.video_view_75        || 0;
        g.video_starts         += r.video_starts         || 0;
        g.effective_total_cost += r.effective_total_cost || 0;
        g.completions          += r.video_view_100       || 0;
      });
      // Preserva preços contratados (deal_cpm/cpcv) do `totalsRaw` original
      // e calcula CPM/CPCV efetivo a partir dos custos somados.
      totals = Object.values(byKey).map(g => {
        const orig = totalsRaw.find(t => t.media_type === g.media_type && t.tactic_type === g.tactic_type) || {};
        const isVideo = g.media_type === "VIDEO";
        // CPM efetivo: total_cost / (viewable / 1000); CPCV efetivo: total_cost / completions
        const eff_cpm  = g.viewable_impressions > 0 ? (g.effective_total_cost / g.viewable_impressions) * 1000 : 0;
        const eff_cpcv = g.completions          > 0 ? (g.effective_total_cost / g.completions)               : 0;
        const deal_cpm = orig.deal_cpm_amount || 0;
        const deal_cpcv = orig.deal_cpcv_amount || 0;
        const cost_with_over = isVideo
          ? deal_cpcv * g.completions
          : deal_cpm * g.viewable_impressions / 1000;
        return {
          ...g,
          deal_cpm_amount: deal_cpm,
          deal_cpcv_amount: deal_cpcv,
          effective_cpm_amount: Math.round(eff_cpm * 100) / 100,
          effective_cpcv_amount: Math.round(eff_cpcv * 100) / 100,
          effective_cost_with_over: Math.round(cost_with_over * 100) / 100,
          // pacing não faz sentido em janela parcial — deixa null pra UI esconder
          pacing: null,
        };
      });
    }

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
      vcr: r.impressions>0?((r.viewable_video_view_100_complete||r.video_view_100||0)/r.impressions)*100:null,
      // Usar pacing do backend diretamente — já calculado com datas reais por frente
      // Quando filtrado, pacing fica null (escondido na UI)
      pacing: r.pacing ?? null,
      rentabilidade: r.deal_cpm_amount>0?((r.deal_cpm_amount-(r.effective_cpm_amount||0))/r.deal_cpm_amount)*100
        :r.deal_cpcv_amount>0?((r.deal_cpcv_amount-(r.effective_cpcv_amount||0))/r.deal_cpcv_amount)*100:null,
      custo_efetivo: r.effective_total_cost,
      custo_efetivo_over: r.effective_cost_with_over,
      completions: r.viewable_video_view_100_complete ?? r.completions ?? r.video_view_100,
    }));

    const display = enrich(totals.filter(t=>t.media_type==="DISPLAY"));
    const video   = enrich(totals.filter(t=>t.media_type==="VIDEO"));

    const totalImpressions=totals.reduce((s,t)=>s+(t.viewable_impressions||0),0);
    const totalCusto=totals.reduce((s,t)=>s+(t.effective_total_cost||0),0);
    const totalCustoOver=totals.reduce((s,t)=>s+(t.effective_cost_with_over||0),0);

    // Budget proporcional ao período filtrado: budget_total * (dias_filtro / dias_campanha).
    // Aproximação linear — assume distribuição uniforme. É o mesmo cálculo
    // usado no pacing.
    const camp = data.campaign;
    const budgetTotal = camp?.budget_contracted || 0;
    const campaignDays = daysBetween(camp?.start_date, camp?.end_date) || 1;
    const filterDays = isFiltered ? daysInRange(mainRange) : campaignDays;
    const budgetProRata = isFiltered
      ? Math.round(budgetTotal * (filterDays / campaignDays) * 100) / 100
      : budgetTotal;

    // Datas com entrega real (extraídas do daily bruto, antes do filtro).
    // Usado pro DateRangeFilter desabilitar dias sem dado.
    const availableDates = Array.from(
      new Set(dailyRaw.map(r => r.date).filter(Boolean))
    ).sort();

    return {
      totals, daily0, detail0, detail,
      chartDisplay, chartVideo,
      display, video,
      totalImpressions, totalCusto, totalCustoOver,
      isFiltered,
      range: mainRange,
      rangeLabel: isFiltered ? formatRangeShort(mainRange) : null,
      filterDays,
      campaignDays,
      budgetTotal,
      budgetProRata,
      availableDates,
    };
  }, [data, mainRange]);

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

        {/* Barra do filtro de período — aparece nas abas que suportam.
            Visão Geral / Display / Video compartilham `mainRange`.
            RMND / PDOOH têm filtros próprios renderizados dentro do UploadTab. */}
        {["Visão Geral", "Display", "Video"].includes(mainTab) && (
          <div style={{
            display:"flex",
            justifyContent:"flex-end",
            alignItems:"center",
            gap:12,
            marginTop:20,
            marginBottom:16,
            flexWrap:"wrap",
          }}>
            {aggregates.isFiltered && (
              <span style={{
                fontSize:12,
                color:cmuted,
                fontWeight:500,
              }}>
                Exibindo {aggregates.filterDays} de {aggregates.campaignDays} dias da campanha
              </span>
            )}
            <DateRangeFilter
              value={mainRange}
              onChange={setMainRange}
              minDate={parseYmd(camp.start_date)}
              maxDate={parseYmd(camp.end_date)}
              availableDates={aggregates.availableDates}
              isDark={isDarkClient}
            />
          </div>
        )}

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
        {mainTab==="RMND"&&<div><UploadTab type="RMND" token={token} serverData={data.rmnd} readOnly={!isAdmin} adminJwt={adminJwt} isDark={isDarkClient}/><TabChat token={token} tabName="RMND" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={cTheme}/></div>}
        {mainTab==="PDOOH"&&<div><UploadTab type="PDOOH" token={token} serverData={data.pdooh} readOnly={!isAdmin} adminJwt={adminJwt} isDark={isDarkClient}/><TabChat token={token} tabName="PDOOH" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={cTheme}/></div>}
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
