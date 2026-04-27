import { useState, useEffect } from "react";
import { API_URL } from "../shared/config";
import { C } from "../shared/theme";
import Spinner from "../components/Spinner";
import TabChat from "../components/TabChat";
import SurveyChart from "./SurveyChart";

const SurveyTab=({surveyJson,token,isAdmin,adminJwt,theme})=>{
  const [questions,setQuestions]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);

  // Busca respostas agregadas de um form do Typeform via proxy do backend.
  // O backend valida a URL, chama a API oficial do Typeform com o token
  // privado e devolve { counts: {label: count}, total: N }.
  // CSV legado (Google Sheets publicado) não é mais suportado — todos os
  // surveys hoje vêm do Typeform.
  const fetchTypeformCounts = async (url) => {
    const proxy = `${API_URL}?action=typeform_proxy&form_url=${encodeURIComponent(url)}`;
    const r = await fetch(proxy);
    const data = await r.json().catch(()=>({}));
    if (!r.ok) {
      // Backend devolve {error: "..."} com mensagem útil (token, 404, etc)
      throw new Error(data?.error || `HTTP ${r.status}`);
    }
    return { counts: data.counts || {}, total: data.total || 0 };
  };

  useEffect(()=>{
    let cancelled=false;
    const load=async()=>{
      setLoading(true);setError(null);
      try{
        const parsed=JSON.parse(surveyJson);
        // Modelo atual: array de {nome, ctrlUrl, expUrl} onde ctrl/exp são
        // URLs públicas de forms do Typeform.
        if(Array.isArray(parsed)&&parsed[0]?.ctrlUrl){
          const results=await Promise.all(parsed.map(async(q)=>{
            const [ctrlData, expData] = await Promise.all([
              fetchTypeformCounts(q.ctrlUrl),
              fetchTypeformCounts(q.expUrl),
            ]);
            return {
              nome: q.nome,
              control_total: ctrlData.total,
              exposed_total: expData.total,
              ctrl: ctrlData.counts,
              exp: expData.counts,
            };
          }));
          if(!cancelled)setQuestions(results);
        } else {
          // Modelo antigo (CSV já processado pré-Typeform): retrocompatível
          // com surveys cadastrados antes da migração pra API.
          const surveys=Array.isArray(parsed)?parsed:[parsed];
          const results=surveys.map(s=>({
            nome:s.nome||"Survey",
            control_total:s.control_total,
            exposed_total:s.exposed_total,
            legacy:true,
            questions:s.questions,
          }));
          if(!cancelled)setQuestions(results);
        }
      }catch(e){
        if(!cancelled){
          // Mensagem mais informativa: prefixa com a fonte do erro pra
          // admin debugar (URL inválida vs Typeform fora vs token expirado).
          const msg = e?.message ? `Erro ao carregar survey: ${e.message}` : "Erro ao carregar dados do survey.";
          setError(msg);
        }
      }
      finally{if(!cancelled)setLoading(false);}
    };
    load();
    return()=>{cancelled=true;};
  },[surveyJson]);

  const bgCard=theme?.bg2||C.dark2;
  const bgInner=theme?.bg||C.dark;
  const bdr=theme?.bdr||C.dark3;
  const txt=theme?.text||C.white;
  const mt=theme?.muted||C.muted;

  const renderQuestion=(nome,ctrl,exp,ctrlTotal,expTotal,qIdx,isLegacy,legacyQ)=>{
    const allKeys=isLegacy
      ?[...new Set([...Object.keys(legacyQ.control),...Object.keys(legacyQ.exposed)])]
      :[...new Set([...Object.keys(ctrl),...Object.keys(exp)])];
    const ctrlMap=isLegacy?legacyQ.control:ctrl;
    const expMap=isLegacy?legacyQ.exposed:exp;
    const ctrlTot=isLegacy?Object.values(ctrlMap).reduce((a,b)=>a+b,0):ctrlTotal;
    const expTot=isLegacy?Object.values(expMap).reduce((a,b)=>a+b,0):expTotal;
    const ctrlPct=allKeys.map(k=>Math.round((ctrlMap[k]||0)/ctrlTot*100));
    const expPct=allKeys.map(k=>Math.round((expMap[k]||0)/expTot*100));
    const lifts=allKeys.map((k,i)=>{
      const abs=Math.round((expPct[i]-ctrlPct[i])*10)/10;
      const rel=ctrlPct[i]>0?Math.round((abs/ctrlPct[i])*1000)/10:0;
      return{key:k,abs,rel};
    });
    return(
      <div style={{border:`1px solid ${bdr}`,borderRadius:12,padding:20,marginBottom:16,background:bgCard}}>
        <div style={{fontSize:12,color:mt,marginBottom:2}}>{isLegacy?`Pergunta ${qIdx+1}`:nome}</div>
        {isLegacy&&<div style={{fontSize:15,fontWeight:600,color:txt,marginBottom:16}}>{legacyQ.label}</div>}

        <div style={{display:"flex",gap:24,flexWrap:"wrap",alignItems:"flex-start"}}>
          <div style={{flex:2,minWidth:260}}>
            <SurveyChart id={`sc-${qIdx}`} labels={allKeys} ctrl={ctrlPct} exp={expPct}/>
          </div>
          <div style={{flex:1,minWidth:160,display:"flex",flexDirection:"column",gap:10}}>
            {lifts.map((l,j)=>{
              const color=l.abs>=0?"#2ECC71":"#E74C3C";
              return(
                <div key={j} style={{border:`1px solid ${bdr}`,borderRadius:8,padding:12}}>
                  <div style={{fontSize:12,color:mt,marginBottom:6,fontWeight:600}}>{l.key}</div>
                  <div style={{display:"flex",gap:8}}>
                    <div style={{flex:1,background:bgInner,borderRadius:6,padding:"8px 10px"}}>
                      <div style={{fontSize:11,color:mt,marginBottom:2}}>Lift absoluto</div>
                      <div style={{fontSize:16,fontWeight:600,color}}>{l.abs>=0?"+":""}{l.abs} pp</div>
                    </div>
                    <div style={{flex:1,background:bgInner,borderRadius:6,padding:"8px 10px"}}>
                      <div style={{fontSize:11,color:mt,marginBottom:2}}>Lift relativo</div>
                      <div style={{fontSize:16,fontWeight:600,color}}>{l.rel>=0?"+":""}{l.rel}%</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  if(loading)return<div style={{textAlign:"center",padding:60}}><Spinner size={36} color={C.blue}/><p style={{color:mt,marginTop:16,fontSize:14}}>Carregando dados do survey...</p></div>;
  if(error)return<div style={{color:"#E74C3C",textAlign:"center",padding:40}}>{error}</div>;
  if(!questions)return null;

  return(
    <div>
      <div style={{display:"flex",gap:24,flexWrap:"wrap",marginBottom:24,padding:"12px 16px",background:bgCard,borderRadius:10,border:`1px solid ${bdr}`}}>
        <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
          <div style={{width:12,height:12,borderRadius:2,background:"#E5EBF2",flexShrink:0,marginTop:2}}/>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:txt}}>Grupo Controle</div>
            <div style={{fontSize:12,color:mt,marginTop:2}}>Usuários que não foram expostos à campanha via HYPR</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
          <div style={{width:12,height:12,borderRadius:2,background:C.blue,flexShrink:0,marginTop:2}}/>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:txt}}>Grupo Exposto</div>
            <div style={{fontSize:12,color:mt,marginTop:2}}>Usuários que foram expostos à campanha via HYPR</div>
          </div>
        </div>
      </div>
      {questions.map((q,i)=>(
        <div key={i} style={{marginBottom:28}}>
          {!q.legacy&&(
            <div style={{fontSize:13,fontWeight:700,color:C.blue,textTransform:"uppercase",letterSpacing:1.5,marginBottom:12,paddingBottom:8,borderBottom:`1px solid ${bdr}`}}>
              {q.nome||`Pergunta ${i+1}`}
            </div>
          )}
          {q.legacy
            ?q.questions.map((lq,j)=>renderQuestion(lq.label,null,null,q.control_total,q.exposed_total,j,true,lq))
            :renderQuestion(q.nome,q.ctrl,q.exp,q.control_total,q.exposed_total,i,false,null)
          }
        </div>
      ))}
      <TabChat token={token} tabName="SURVEY" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={theme}/>
    </div>
  );
};

export default SurveyTab;
