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

  // Busca respostas agregadas via proxy do backend. Resposta pode vir em
  // dois formatos:
  //   { type: "choice", counts: {label: n}, total: N }
  //   { type: "matrix", rows: {row: {counts, total}}, total: N }
  // Devolve o objeto cru pro caller decidir como agregar.
  const fetchTypeformData = async (url) => {
    const proxy = `${API_URL}?action=typeform_proxy&form_url=${encodeURIComponent(url)}`;
    const r = await fetch(proxy);
    const data = await r.json().catch(()=>({}));
    if (!r.ok) {
      throw new Error(data?.error || `HTTP ${r.status}`);
    }
    return data;
  };

  useEffect(()=>{
    let cancelled=false;
    const load=async()=>{
      setLoading(true);setError(null);
      try{
        const parsed=JSON.parse(surveyJson);
        // Modelo atual: array de {nome, ctrlUrl, expUrl, focusRow?}.
        // focusRow é opcional, só aplica a forms tipo matrix.
        if(Array.isArray(parsed)&&parsed[0]?.ctrlUrl){
          const results=await Promise.all(parsed.map(async(q)=>{
            const [ctrlData, expData] = await Promise.all([
              fetchTypeformData(q.ctrlUrl),
              fetchTypeformData(q.expUrl),
            ]);
            // Matrix: backend retorna {type:"matrix", rows:{row:{counts,total}}}
            if(ctrlData.type === "matrix" && expData.type === "matrix"){
              return {
                nome: q.nome,
                type: "matrix",
                focusRow: q.focusRow || null,
                control_total: ctrlData.total,
                exposed_total: expData.total,
                ctrlRows: ctrlData.rows || {},
                expRows: expData.rows || {},
              };
            }
            // Choice: comportamento atual
            return {
              nome: q.nome,
              type: "choice",
              control_total: ctrlData.total,
              exposed_total: expData.total,
              ctrl: ctrlData.counts || {},
              exp: expData.counts || {},
            };
          }));
          if(!cancelled)setQuestions(results);
        } else {
          // Modelo antigo (CSV pré-Typeform) — retrocompatibilidade
          const surveys=Array.isArray(parsed)?parsed:[parsed];
          const results=surveys.map(s=>({
            nome:s.nome||"Survey",
            type:"legacy",
            control_total:s.control_total,
            exposed_total:s.exposed_total,
            legacy:true,
            questions:s.questions,
          }));
          if(!cancelled)setQuestions(results);
        }
      }catch(e){
        if(!cancelled){
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

  // Pergunta tipo choice/choices simples (Sim/Não/Talvez, etc).
  const renderQuestion=(nome,ctrl,exp,ctrlTotal,expTotal,qIdx,isLegacy,legacyQ)=>{
    const allKeys=isLegacy
      ?[...new Set([...Object.keys(legacyQ.control),...Object.keys(legacyQ.exposed)])]
      :[...new Set([...Object.keys(ctrl),...Object.keys(exp)])];
    const ctrlMap=isLegacy?legacyQ.control:ctrl;
    const expMap=isLegacy?legacyQ.exposed:exp;
    const ctrlTot=isLegacy?Object.values(ctrlMap).reduce((a,b)=>a+b,0):ctrlTotal;
    const expTot=isLegacy?Object.values(expMap).reduce((a,b)=>a+b,0):expTotal;
    const ctrlPct=allKeys.map(k=>ctrlTot>0?Math.round((ctrlMap[k]||0)/ctrlTot*100):0);
    const expPct=allKeys.map(k=>expTot>0?Math.round((expMap[k]||0)/expTot*100):0);
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

  // Layout compacto pra matrix: 1 linha por marca, distribuição controle e
  // exposto lado a lado, média + lift na direita. Marca-foco ganha borda
  // esquerda azul, tint de fundo e ícone ★ — sem ocupar espaço extra.
  const renderMatrix = (q, qIdx) => {
    const allRows=[...new Set([...Object.keys(q.ctrlRows||{}),...Object.keys(q.expRows||{})])];
    const sortedRows=q.focusRow
      ?[q.focusRow,...allRows.filter(r=>r!==q.focusRow)]
      :allRows;

    // Calcula tudo que cada linha precisa pra render
    const rowData=sortedRows.map(rowLabel=>{
      const ctrl=q.ctrlRows?.[rowLabel];
      const exp=q.expRows?.[rowLabel];
      if(!ctrl||!exp)return null;
      const allKeys=[...new Set([...Object.keys(ctrl.counts||{}),...Object.keys(exp.counts||{})])].sort();

      // Média ponderada (só faz sentido se as labels forem números)
      const mean=(counts,total)=>{
        if(!total)return 0;
        let sum=0,n=0;
        for(const[k,v]of Object.entries(counts||{})){
          const num=parseFloat(k);
          if(!isNaN(num)){sum+=num*v;n+=v;}
        }
        return n>0?sum/n:0;
      };
      const ctrlMean=mean(ctrl.counts,ctrl.total);
      const expMean=mean(exp.counts,exp.total);
      const numericKeys=allKeys.every(k=>!isNaN(parseFloat(k)));
      const liftAbs=numericKeys?expMean-ctrlMean:0;
      const liftRel=ctrlMean>0?(liftAbs/ctrlMean)*100:0;

      const ctrlPct=allKeys.map(k=>ctrl.total?Math.round((ctrl.counts[k]||0)/ctrl.total*100):0);
      const expPct=allKeys.map(k=>exp.total?Math.round((exp.counts[k]||0)/exp.total*100):0);

      return{
        label:rowLabel,
        isFocus:rowLabel===q.focusRow,
        ctrlMean,expMean,liftAbs,liftRel,
        keys:allKeys,
        ctrlPct,expPct,
        ctrlTotal:ctrl.total||0,
        expTotal:exp.total||0,
        numericKeys,
      };
    }).filter(Boolean);

    // Cor por nota: gradient red → yellow → green pra escalas numéricas;
    // fallback HSL pra outros casos.
    const noteColor=(idx,total)=>{
      const palettes={
        2:["#E74C3C","#27AE60"],
        3:["#E74C3C","#F39C12","#27AE60"],
        4:["#E74C3C","#E67E22","#52BE80","#27AE60"],
        5:["#E74C3C","#E67E22","#F39C12","#52BE80","#16A085"],
      };
      if(palettes[total])return palettes[total][idx];
      const hue=total>1?(idx/(total-1))*120:60;
      return `hsl(${hue}, 60%, 50%)`;
    };

    const StackedBar=({pcts,keys})=>(
      <div style={{display:"flex",height:18,borderRadius:4,overflow:"hidden",background:bgInner,border:`1px solid ${bdr}`}}>
        {pcts.map((pct,i)=>pct>0&&(
          <div key={i} title={`Nota ${keys[i]}: ${pct}%`} style={{
            width:`${pct}%`,
            background:noteColor(i,keys.length),
            color:pct>=10?"#fff":"transparent",
            fontSize:10,
            fontWeight:600,
            textAlign:"center",
            lineHeight:"18px",
            transition:"all 0.2s",
          }}>{pct>=10?`${pct}%`:""}</div>
        ))}
      </div>
    );

    return(
      <div style={{border:`1px solid ${bdr}`,borderRadius:12,padding:16,background:bgCard,marginBottom:8}}>
        {/* Legenda das notas */}
        <div style={{display:"flex",gap:14,fontSize:11,color:mt,marginBottom:14,flexWrap:"wrap"}}>
          <span style={{fontWeight:600}}>Notas:</span>
          {(rowData[0]?.keys||[]).map((k,i)=>(
            <span key={i} style={{display:"inline-flex",alignItems:"center",gap:5}}>
              <span style={{width:10,height:10,background:noteColor(i,rowData[0].keys.length),borderRadius:2,display:"inline-block"}}/>
              {k}
            </span>
          ))}
          <span style={{marginLeft:"auto",color:mt,opacity:0.8}}>★ marca-foco</span>
        </div>

        {/* Linhas — 1 por marca */}
        {rowData.map((r,idx)=>{
          const liftColor=r.liftAbs>=0?"#2ECC71":"#E74C3C";
          const sign=n=>n>=0?"+":"";
          return(
            <div key={idx} style={{
              display:"grid",
              gridTemplateColumns:"minmax(120px, 1.2fr) minmax(180px, 2fr) minmax(180px, 2fr) minmax(140px, 1.4fr)",
              gap:14,
              alignItems:"center",
              padding:"12px 12px 12px 14px",
              borderRadius:8,
              borderLeft:r.isFocus?`3px solid ${C.blue}`:`3px solid transparent`,
              background:r.isFocus?`${C.blue}14`:"transparent",
              borderTop:idx>0?`1px solid ${bdr}`:"none",
              borderTopLeftRadius:idx>0?0:8,
              borderTopRightRadius:idx>0?0:8,
            }}>
              {/* Marca */}
              <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                {r.isFocus&&<span style={{color:C.blue,fontSize:14,lineHeight:1,flexShrink:0}}>★</span>}
                <div style={{minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:r.isFocus?700:600,color:txt,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                    {r.label}
                  </div>
                  <div style={{fontSize:10,color:mt,marginTop:2}}>
                    {r.ctrlTotal} ctrl • {r.expTotal} exp
                  </div>
                </div>
              </div>

              {/* Distribuição Controle */}
              <div>
                <div style={{fontSize:10,color:mt,marginBottom:4,display:"flex",justifyContent:"space-between"}}>
                  <span>Controle</span>
                  {r.numericKeys&&<span style={{fontWeight:600,color:txt}}>μ {r.ctrlMean.toFixed(2)}</span>}
                </div>
                <StackedBar pcts={r.ctrlPct} keys={r.keys}/>
              </div>

              {/* Distribuição Exposto */}
              <div>
                <div style={{fontSize:10,color:mt,marginBottom:4,display:"flex",justifyContent:"space-between"}}>
                  <span>Exposto</span>
                  {r.numericKeys&&<span style={{fontWeight:600,color:txt}}>μ {r.expMean.toFixed(2)}</span>}
                </div>
                <StackedBar pcts={r.expPct} keys={r.keys}/>
              </div>

              {/* Lift */}
              <div style={{textAlign:"right"}}>
                {r.numericKeys?(
                  <>
                    <div style={{fontSize:10,color:mt,marginBottom:2}}>Lift na média</div>
                    <div style={{fontSize:15,fontWeight:700,color:liftColor,lineHeight:1.2}}>
                      {sign(r.liftAbs)}{r.liftAbs.toFixed(2)}
                    </div>
                    <div style={{fontSize:11,color:liftColor,fontWeight:600}}>
                      {sign(r.liftRel)}{r.liftRel.toFixed(1)}%
                    </div>
                  </>
                ):(
                  <div style={{fontSize:11,color:mt,fontStyle:"italic"}}>
                    Escala não-numérica
                  </div>
                )}
              </div>
            </div>
          );
        })}
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
            :q.type==="matrix"
              ?renderMatrix(q,i)
              :renderQuestion(q.nome,q.ctrl,q.exp,q.control_total,q.exposed_total,i,false,null)
          }
        </div>
      ))}
      <TabChat token={token} tabName="SURVEY" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={theme}/>
    </div>
  );
};

export default SurveyTab;
