import { useState, useEffect, useMemo } from "react";
import { C } from "../shared/theme";
import { getTheme, setTheme } from "../shared/prefs";
import { gaEvent, gaPageView } from "../shared/analytics";
import { computeAggregates } from "../shared/aggregations";
import { detectLuminance } from "../shared/imageCompress";
import {
  readRangeFromUrl,
  writeRangeToUrl,
  parseYmd,
} from "../shared/dateFilter";
import { getCampaign, saveAlcanceFrequencia } from "../lib/api";
import GlobalStyle from "../components/GlobalStyle";
import Spinner from "../components/Spinner";
import HyprReportCenterLogo from "../components/HyprReportCenterLogo";
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
  // Luminância média da logo (0-1). Usada pra forçar contraste quando a logo
  // não combina com o fundo do tema (ex: PicPay azul-escuro em dark mode).
  // Default 0.5 (neutro) enquanto detecta, evita filter no primeiro render.
  const [logoLum,setLogoLum]=useState(0.5);
  // Persiste a escolha de tema entre sessões (compartilhada com CampaignMenu).
  useEffect(() => { setTheme(isDarkClient ? "dark" : "light"); }, [isDarkClient]);

  // Roda detecção de luminância sempre que o logo da campanha mudar.
  // Cancela se o componente desmontar antes da Promise resolver.
  useEffect(() => {
    if (!data?.logo) { setLogoLum(0.5); return; }
    let cancelled = false;
    detectLuminance(data.logo).then(lum => {
      if (!cancelled) setLogoLum(lum);
    });
    return () => { cancelled = true; };
  }, [data?.logo]);

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

  // Agregações derivadas de `data`. A função pura `computeAggregates`
  // (shared/aggregations.js) encapsula ~150 linhas de lógica que antes
  // viviam aqui inline. Compartilhada com o V2 (src/v2/) — bug fix
  // futuro acontece num lugar só. useMemo continua porque
  // enrichDetailCosts dentro dela é O(n*m) e roda a cada render se não
  // memoizado. Hooks precisam vir antes de early returns — daí estar aqui.
  const aggregates = useMemo(
    () => computeAggregates(data, mainRange),
    [data, mainRange],
  );

  if(loading) return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:cbg,transition:"background 0.3s"}}><GlobalStyle/><div style={{textAlign:"center"}}><Spinner size={48}/><p style={{marginTop:20,color:cmuted,fontSize:14}}>Carregando dados...</p></div></div>;
  if(error||!data||!aggregates) return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:cbg,transition:"background 0.3s"}}><GlobalStyle/><p style={{color:C.red}}>{error||"Campanha não encontrada."}</p></div>;

  const camp   = data.campaign;
  const mainTabs = ["Visão Geral", "Display", "Video", "RMND", "PDOOH", "VIDEO LOOM", "SURVEY"];

  return (
    <div style={{minHeight:"100vh",width:"100%",background:cbg,transition:"background 0.3s"}}>
      <GlobalStyle/>
      {!isDarkClient && <style>{`body{background:${cbg}!important;color:${ctext}!important;}`}</style>}
      <div style={{background:cbg2,borderBottom:`1px solid ${cbdr}`,padding:"0 32px",height:64,display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",transition:"background 0.3s"}}>
        <div style={{display:"flex",alignItems:"center",color:isDarkClient?"#FFFFFF":"#0F1419"}}>
          <HyprReportCenterLogo height={20}/>
        </div>
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
        {data.logo&&(() => {
          // Logo escura num fundo escuro ou clara num fundo claro = invisível.
          // Forçar silhueta resolve sem precisar do user subir 2 versões.
          // Zona neutra (0.4-0.6): aparece em ambos os temas, deixa passar.
          let logoFilter = "none";
          if (isDarkClient && logoLum < 0.4)        logoFilter = "brightness(0) invert(1)"; // → branco
          else if (!isDarkClient && logoLum > 0.6)  logoFilter = "brightness(0)";           // → preto
          return (
            <img src={data.logo} alt="logo" style={{height:60,objectFit:"contain",maxWidth:220,marginTop:4,filter:logoFilter,transition:"filter 0.3s"}}/>
          );
        })()}
</div>

        <Tabs tabs={mainTabs} active={mainTab} onChange={(tab)=>{ setMainTab(tab); gaEvent("tab_click", { tab_name: tab, report_token: token }); }} theme={cTheme}/>

        {/* Barra do filtro de período — só Visão Geral usa essa posição
            global. Display/Video renderizam o próprio (junto com Audiência)
            dentro de suas toolbars. RMND/PDOOH idem (com filtros próprios). */}
        {mainTab === "Visão Geral" && (
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
            mainRange={mainRange}
            setMainRange={setMainRange}
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
            mainRange={mainRange}
            setMainRange={setMainRange}
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
