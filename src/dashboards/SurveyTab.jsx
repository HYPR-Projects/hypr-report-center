import { useState, useEffect, useMemo } from "react";
import { C } from "../shared/theme";
import Spinner from "../components/Spinner";
import TabChat from "../components/TabChat";
import SurveyChart from "./SurveyChart";
import DateRangeFilter from "../components/DateRangeFilter";
import { ymd } from "../shared/dateFilter";
import { parseSurveyConfig, fmtClientRange } from "../shared/surveyConfig";
import { loadSurveyQuestions, combineSurveyQuestions } from "../shared/surveyCombine";
import { fmt } from "../shared/format";
import { SOURCE_LABELS, SOURCE_TINTS, reconciliationSummary } from "../shared/surveySources";
import { liftSignificance, significanceLabel } from "../shared/surveyStats";

// Auto-refresh: a aba recarrega sozinha enquanto estiver aberta.
//
// Nasceu de uma pergunta que não tinha resposta boa: "respondi no preview da
// DSP e o número do report não mexeu". Não mexia mesmo — o fetch acontecia só
// no mount, então a única forma de ver dado novo era F5. Botão de "Atualizar"
// seria pior: transfere pro leitor um trabalho que a máquina faz melhor, e
// quem não souber que o botão existe continua olhando número velho sem saber.
//
// 60s é o intervalo do CICLO, não a idade do dado: as duas fontes cacheiam 5
// min no backend (`_MA_RESULTS_TTL` / `_TYPEFORM_RESULTS_TTL`), então o ciclo
// mais frequente só garante que, assim que o cache vira, a tela pega na
// próxima volta. Polling mais rápido que o TTL não deixaria o dado mais novo
// — só gastaria invocação de Cloud Function.
//
// Três guardas, todas por motivo concreto:
//   • só com a aba visível — navegador estrangula timer em aba de fundo, e
//     recarregar report que ninguém está lendo é custo sem leitor;
//   • `inFlight` — se um ciclo demora mais que o intervalo (Typeform paginando
//     cold), o próximo não empilha em cima;
//   • guard de 10s no foco — `visibilitychange` e `focus` disparam juntos ao
//     voltar pra aba, e sem isso cada alt-tab custava duas requests idênticas
//     (mesma correção que o DspHealthPanel já carrega).
const POLL_INTERVAL_MS = 60000;

// Quando `combinedItems` é passado (array de {short_token, label, survey}),
// o SurveyTab opera em modo AGREGADO: busca cada mês, soma as contagens
// brutas via combineSurveyQuestions e renderiza um único conjunto de
// perguntas. Sem `combinedItems`, comportamento normal (1 token via
// `surveyJson`).
const SurveyTab=({surveyJson,token,isAdmin,adminJwt,theme,combinedItems})=>{
  const [questions,setQuestions]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);
  // Filtro de data — admin-only de inspeção. Não persiste em URL nem afeta
  // visão do cliente. Quando setado, ignora o `clientRange` salvo no survey.
  const [adminRange,setAdminRange]=useState(null);

  // clientRange é o filtro persistido pelo admin no setup pra restringir
  // o que o cliente vê. Admin não fica preso a ele — quando admin não
  // tem `adminRange` ativo, mostramos tudo (ignoramos clientRange) pra
  // facilitar inspeção.
  const config = useMemo(()=>parseSurveyConfig(surveyJson),[surveyJson]);
  const clientRange = config?.clientRange || null;

  const isCombined = Array.isArray(combinedItems) && combinedItems.length > 0;

  // Range efetivo: admin com filtro próprio ganha; admin sem filtro vê tudo;
  // cliente respeita o clientRange salvo. No modo combinado o admin aplica
  // o MESMO range a todos os meses; cada mês usa seu clientRange pro cliente.
  const adminRangeParam = adminRange?.from && adminRange?.to
    ? { from: ymd(adminRange.from), to: ymd(adminRange.to) }
    : null;
  const rangeParam = isAdmin ? adminRangeParam : clientRange;
  // useMemo na chave do JSON pra estabilidade do effect — sem isso o objeto
  // novo a cada render dispararia o efeito repetidamente.
  const rangeKey = rangeParam ? `${rangeParam.from}|${rangeParam.to}` : "";
  // Chave de deps do modo combinado: tokens dos meses agregados.
  const combinedKey = isCombined ? combinedItems.map((it)=>it.short_token).join(",") : "";

  useEffect(()=>{
    let cancelled=false;
    let inFlight=false;
    // `silent` = ciclo de auto-refresh. Não mostra spinner e não apaga o que
    // está na tela: sem isso a aba inteira piscaria de minuto em minuto, e
    // piscar de graça é pior que não atualizar.
    const load=async(silent=false)=>{
      if(inFlight)return;
      inFlight=true;
      if(!silent){setLoading(true);setError(null);}
      try{
        let next;
        if(isCombined){
          // Agregado: busca cada mês (filtrado pelo seu próprio range) e
          // soma as contagens brutas. Admin sem filtro vê tudo; admin com
          // filtro aplica o mesmo período a todos; cliente usa o clientRange
          // salvo de cada mês.
          const perMonth = await Promise.all(combinedItems.map(async(it)=>{
            const cfg = parseSurveyConfig(it.survey);
            const itemRange = isAdmin ? adminRangeParam : (cfg?.clientRange || null);
            return loadSurveyQuestions(it.survey, itemRange);
          }));
          next = combineSurveyQuestions(perMonth);
        }else{
          // Single token — normalização delegada ao módulo compartilhado.
          next = await loadSurveyQuestions(surveyJson, rangeParam);
        }
        if(!cancelled){
          setQuestions(next);
          // Sucesso limpa erro anterior: falha transitória de uma fonte
          // agora se resolve sozinha no ciclo seguinte, em vez de deixar a
          // aba travada num erro até alguém dar F5.
          setError(null);
        }
      }catch(e){
        if(!cancelled && !silent){
          const msg = e?.message ? `Erro ao carregar survey: ${e.message}` : "Erro ao carregar dados do survey.";
          setError(msg);
        }
        // Falha num ciclo automático NÃO vira erro na tela: o cliente estava
        // lendo um número, e um 502 transitório do Typeform trocaria o número
        // por uma mensagem de erro. Quem ainda não tem dado (load inicial)
        // cai no ramo de cima e vê o erro normalmente.
      }
      finally{
        inFlight=false;
        if(!cancelled && !silent)setLoading(false);
      }
    };
    load();
    const id=setInterval(()=>{
      if(document.visibilityState!=="visible")return;
      load(true);
    },POLL_INTERVAL_MS);
    // Voltar pra aba recarrega na hora, sem esperar o próximo tick — é o
    // momento em que alguém MAIS quer o dado novo.
    let lastFocusLoad=0;
    const onFocus=()=>{
      if(document.visibilityState!=="visible")return;
      if(Date.now()-lastFocusLoad<10_000)return;
      lastFocusLoad=Date.now();
      load(true);
    };
    document.addEventListener("visibilitychange",onFocus);
    window.addEventListener("focus",onFocus);
    return()=>{
      cancelled=true;
      clearInterval(id);
      document.removeEventListener("visibilitychange",onFocus);
      window.removeEventListener("focus",onFocus);
    };
  // rangeKey absorve adminRange (admin) e clientRange (cliente). combinedKey
  // cobre mudança dos meses agregados; surveyJson cobre config single.
  },[surveyJson,isAdmin,rangeKey,isCombined,combinedKey]);

  const bgCard=theme?.bg2||C.dark2;
  const bgInner=theme?.bg||C.dark;
  const bdr=theme?.bdr||C.dark3;
  const txt=theme?.text||C.white;
  const mt=theme?.muted||C.muted;

  // Pergunta tipo choice/choices simples (Sim/Não/Talvez, etc).
  // focusRow (opcional): se preenchido e bater com algum dos labels, ordena
  // esse card primeiro e aplica destaque visual (borda azul, tint, ★).
  //
  // Lados (ctrl/exp) podem ser null — quando admin configurou só um, o
  // gráfico mostra a distribuição daquele lado e os cards de lift somem
  // (sem comparativo possível).
  const renderQuestion=(nome,ctrl,exp,ctrlTotal,expTotal,qIdx,isLegacy,legacyQ,focusRow)=>{
    const ctrlMap = isLegacy ? legacyQ.control  : (ctrl || null);
    const expMap  = isLegacy ? legacyQ.exposed  : (exp  || null);
    const hasCtrl = !!ctrlMap && Object.keys(ctrlMap).length > 0;
    const hasExp  = !!expMap  && Object.keys(expMap).length  > 0;
    const hasBoth = hasCtrl && hasExp;
    const baseKeys=[...new Set([
      ...(ctrlMap ? Object.keys(ctrlMap) : []),
      ...(expMap  ? Object.keys(expMap)  : []),
    ])];
    // Sort: focusRow primeiro (quando bate com alguma label), demais preservam ordem.
    const allKeys = focusRow && baseKeys.includes(focusRow)
      ? [focusRow, ...baseKeys.filter(k=>k!==focusRow)]
      : baseKeys;
    const ctrlTot = hasCtrl
      ? (isLegacy ? Object.values(ctrlMap).reduce((a,b)=>a+b,0) : (ctrlTotal || 0))
      : 0;
    const expTot  = hasExp
      ? (isLegacy ? Object.values(expMap).reduce((a,b)=>a+b,0) : (expTotal || 0))
      : 0;
    const ctrlPct = hasCtrl ? allKeys.map(k=>ctrlTot>0?Math.round((ctrlMap[k]||0)/ctrlTot*100):0) : [];
    const expPct  = hasExp  ? allKeys.map(k=>expTot>0?Math.round((expMap[k]||0)/expTot*100):0) : [];
    const lifts = hasBoth ? allKeys.map((k,i)=>{
      const cp = ctrlPct[i] ?? 0;
      const ep = expPct[i]  ?? 0;
      const abs=Math.round((ep-cp)*10)/10;
      const rel=cp>0?Math.round((abs/cp)*1000)/10:0;
      // O teste vai na CONTAGEM BRUTA, não em ctrlPct/expPct: aqueles já
      // passaram por Math.round e perderam justamente a precisão que o
      // teste mede.
      const sig = significanceLabel(liftSignificance({
        ctrlN: ctrlTot,
        ctrlPositive: ctrlMap?.[k] ?? 0,
        expN: expTot,
        expPositive: expMap?.[k] ?? 0,
      }));
      return{key:k,abs,rel,sig,isFocus:k===focusRow};
    }) : [];
    return(
      <div key={qIdx} style={{border:`1px solid ${bdr}`,borderRadius:12,padding:20,marginBottom:16,background:bgCard}}>
        <div style={{fontSize:12,color:mt,marginBottom:2}}>{isLegacy?`Pergunta ${qIdx+1}`:nome}</div>
        {isLegacy&&<div style={{fontSize:15,fontWeight:600,color:txt,marginBottom:16}}>{legacyQ.label}</div>}

        <div style={{display:"flex",gap:24,flexWrap:"wrap",alignItems:"flex-start"}}>
          <div style={{flex:2,minWidth:260}}>
            <SurveyChart id={`sc-${qIdx}`} labels={allKeys} ctrl={ctrlPct} exp={expPct}/>
            {!hasBoth && (
              <div style={{
                marginTop:10,fontSize:11.5,color:mt,fontStyle:"italic",
                padding:"8px 12px",borderRadius:6,background:bgInner,border:`1px dashed ${bdr}`,
              }}>
                Apenas {hasCtrl ? "Controle" : "Exposto"} configurado — sem comparativo de lift nesta pergunta.
              </div>
            )}
          </div>
          <div style={{flex:1,minWidth:160,display:"flex",flexDirection:"column",gap:10}}>
            {lifts.map((l,j)=>{
              const color=l.abs>=0?"#2ECC71":"#E74C3C";
              return(
                <div key={j} style={{
                  border:l.isFocus?`1px solid ${C.blue}80`:`1px solid ${bdr}`,
                  borderLeft:l.isFocus?`3px solid ${C.blue}`:`1px solid ${bdr}`,
                  borderRadius:8,
                  padding:12,
                  background:l.isFocus?`${C.blue}14`:"transparent",
                }}>
                  <div style={{fontSize:12,color:l.isFocus?txt:mt,marginBottom:6,fontWeight:l.isFocus?700:600,display:"flex",alignItems:"center",gap:6}}>
                    {l.isFocus&&<span role="img" aria-label="Resposta-foco" style={{color:C.blue,fontSize:13,lineHeight:1}}>★</span>}
                    <span>{l.key}</span>
                  </div>
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
                  {/* Margem de erro e significância são a régua com que a HYPR
                      julga o próprio número — inclusive quando ela diz "não
                      concluir". Sai da visão do cliente; o gate é aqui, e não
                      no cálculo, porque `l.sig` continua alimentando o título
                      e a leitura interna. */}
                  {isAdmin && l.sig && (
                    <div
                      title={
                        l.sig.tone === "muted"
                          ? "Amostra abaixo do piso da HYPR (60 respostas por célula). O número aparece, mas não sustenta conclusão."
                          : "Teste z de duas proporções, bicaudal, 95% de confiança — a mesma régua do brand lift do AdBolt."
                      }
                      style={{
                        marginTop:8,fontSize:10.5,fontWeight:600,letterSpacing:0.2,cursor:"help",
                        color: l.sig.tone === "good" ? "#2ECC71" : l.sig.tone === "warn" ? "#E0A21E" : mt,
                      }}
                    >
                      {l.sig.tone === "good" ? "✓ " : l.sig.tone === "warn" ? "≈ " : "· "}{l.sig.text}
                    </div>
                  )}
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
  const renderMatrix = (q) => {
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
                {r.isFocus&&<span role="img" aria-label="Marca em foco" style={{color:C.blue,fontSize:14,lineHeight:1,flexShrink:0}}>★</span>}
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
                      {sign(r.liftRel)}{fmt(r.liftRel, 1)}%
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

  // Totais visíveis ao admin — soma só totais válidos (pula lados null
  // pra não inflar com zeros de perguntas só-um-lado).
  const adminTotals = isAdmin && questions
    ? questions.reduce((acc,q)=>{
        if(q.legacy) return acc;
        return {
          ctrl: acc.ctrl + (q.control_total ?? 0),
          exp:  acc.exp  + (q.exposed_total ?? 0),
        };
      },{ctrl:0,exp:0})
    : null;
  const isDarkTheme = (theme?.bg || C.dark) === C.dark;

  return(
    <div>
      {isAdmin && (
        <div style={{
          display:"flex",
          alignItems:"center",
          gap:12,
          flexWrap:"wrap",
          marginBottom:14,
          padding:"10px 14px",
          background:bgCard,
          border:`1px dashed ${C.blue}55`,
          borderRadius:10,
        }}>
          <div style={{display:"flex",alignItems:"center",gap:8,flex:"0 0 auto",flexWrap:"wrap"}}>
            <span style={{
              fontSize:10,
              fontWeight:700,
              letterSpacing:1.2,
              textTransform:"uppercase",
              color:C.blue,
              background:`${C.blue}18`,
              padding:"3px 8px",
              borderRadius:999,
              border:`1px solid ${C.blue}40`,
            }}>Admin</span>
            <span style={{fontSize:12.5,color:mt}}>
              Filtro de período aplicado às respostas do Typeform.{" "}
              <span style={{color:txt,fontWeight:600}}>Não afeta a visão do cliente.</span>
            </span>
            {clientRange && (
              <span
                title="O cliente só vê respostas neste período. Configurado em Gerenciar Survey."
                style={{
                  fontSize:11,
                  color:mt,
                  background:`${C.blue}10`,
                  border:`1px solid ${C.blue}30`,
                  padding:"3px 8px",
                  borderRadius:6,
                }}
              >
                Cliente vê: <span style={{color:txt,fontWeight:600}}>
                  {fmtClientRange(clientRange)}
                </span>
              </span>
            )}
          </div>
          <div style={{flex:1}}/>
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            {adminTotals && (
              <div style={{display:"flex",gap:14,fontSize:12,color:mt}}>
                <span><span style={{color:txt,fontWeight:700}}>{adminTotals.ctrl.toLocaleString("pt-BR")}</span> ctrl</span>
                <span><span style={{color:txt,fontWeight:700}}>{adminTotals.exp.toLocaleString("pt-BR")}</span> exp</span>
              </div>
            )}
            <DateRangeFilter
              value={adminRange}
              onChange={setAdminRange}
              isDark={isDarkTheme}
            />
          </div>
        </div>
      )}
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
            <div style={{
              display:"flex",
              alignItems:"baseline",
              justifyContent:"space-between",
              gap:12,
              marginBottom:12,
              paddingBottom:8,
              borderBottom:`1px solid ${bdr}`,
            }}>
              <div style={{display:"flex",alignItems:"baseline",gap:10,flexWrap:"wrap"}}>
                <div style={{fontSize:13,fontWeight:700,color:C.blue,textTransform:"uppercase",letterSpacing:1.5}}>
                  {q.nome||`Pergunta ${i+1}`}
                </div>
                {/* De qual base veio a resposta é decisão de metodologia da
                    HYPR, não informação de relatório: pro cliente a pergunta
                    é uma só, com um total só. As pílulas de fonte e o aviso de
                    reconciliação entre bases ficam do lado de dentro. */}
                {isAdmin && <SourceBadges sources={q.sources}/>}
                {isAdmin && <ReconciliationNote reconciliation={q.reconciliation}/>}
              </div>
              {isAdmin && (
                <div style={{fontSize:11,color:mt,whiteSpace:"nowrap"}}>
                  {q.control_total!=null && (
                    <><span style={{color:txt,fontWeight:600}}>{q.control_total.toLocaleString("pt-BR")}</span> ctrl</>
                  )}
                  {q.control_total!=null && q.exposed_total!=null && " · "}
                  {q.exposed_total!=null && (
                    <><span style={{color:txt,fontWeight:600}}>{q.exposed_total.toLocaleString("pt-BR")}</span> exp</>
                  )}
                </div>
              )}
            </div>
          )}
          {q.legacy
            ?q.questions.map((lq,j)=>renderQuestion(lq.label,null,null,q.control_total,q.exposed_total,j,true,lq,null))
            :q.type==="matrix"
              ?renderMatrix(q)
              :renderQuestion(q.nome,q.ctrl,q.exp,q.control_total,q.exposed_total,i,false,null,q.focusRow)
          }
        </div>
      ))}
      <TabChat token={token} tabName="SURVEY" author={isAdmin?"HYPR":"Cliente"} adminJwt={adminJwt} theme={theme}/>
    </div>
  );
};

// Badge inline da fonte de cada lado da pergunta. Pra Typeform/Typeform
// (caso comum) escondemos badges — sem ruído. Pra mistos, só-VideoAsk ou
// lados com MAIS DE UMA fonte somada, renderizamos: quando o número na
// tela é a soma de duas bases, o leitor tem que saber disso.
const SOURCE_LABEL = SOURCE_LABELS;
const SOURCE_TINT  = SOURCE_TINTS;

// `sources` de cada lado é uma lista (multi-fonte). Normaliza o formato
// antigo (string) pra não depender da versão do dado em memória.
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v.filter(Boolean) : [v]);

function SourceBadges({ sources }) {
  if (!sources) return null;
  const c = asList(sources.ctrl);
  const e = asList(sources.exp);
  const isPlainTypeform = (l) => l.length === 0 || (l.length === 1 && l[0] === "typeform");
  // Caso default: typeform×typeform, uma base de cada lado — nada a mostrar
  if (isPlainTypeform(c) && isPlainTypeform(e)) return null;

  const pill = (label, kind, key) => {
    const t = SOURCE_TINT[kind] || SOURCE_TINT.typeform;
    return (
      <span key={key} style={{
        fontSize:10,fontWeight:700,letterSpacing:0.6,textTransform:"uppercase",
        color:t.fg,background:t.bg,border:`1px solid ${t.bd}`,borderRadius:999,padding:"2px 7px",
      }}>{label}</span>
    );
  };
  // Um lado com N fontes vira N pílulas encostadas, com "+" entre elas —
  // a soma fica explícita ("Standard Survey + Max Attention").
  const stack = (list, prefix) => (
    <span style={{display:"inline-flex",gap:4,alignItems:"center"}}>
      {list.map((kind, i) => (
        <span key={`${prefix}-${kind}-${i}`} style={{display:"inline-flex",gap:4,alignItems:"center"}}>
          {i > 0 && <span style={{fontSize:10,color:C.muted,fontWeight:700}}>+</span>}
          {pill(i === 0 && prefix ? `${prefix}: ${SOURCE_LABEL[kind] || kind}` : (SOURCE_LABEL[kind] || kind), kind, `${prefix}-${kind}-${i}`)}
        </span>
      ))}
    </span>
  );

  // Mesmas fontes nos 2 lados → um conjunto só de pílulas, sem prefixo
  const sameBothSides =
    c.length && e.length && c.length === e.length && c.every((v, i) => v === e[i]);
  if (sameBothSides) return stack(c, "");

  return (
    <span style={{display:"inline-flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
      {c.length > 0 && stack(c, "Ctrl")}
      {e.length > 0 && stack(e, "Exp")}
    </span>
  );
}

// Aviso de reconciliação entre bases — SÓ pro admin (o chamador já gateia).
// Já foi visível pro cliente no caso grave, na ideia de que "bases
// divergentes" fosse uma proteção contra ler um total mal somado. Não era:
// quem corrige divergência de base é a HYPR, na origem, e o aviso ainda
// entregava ao cliente o que a decisão de esconder a fonte quer esconder —
// que existe mais de uma base. Some pros dois motivos de uma vez.
function ReconciliationNote({ reconciliation }) {
  if (!reconciliation) return null;
  const sides = [
    { key: "ctrl", label: "Controle", rec: reconciliation.ctrl },
    { key: "exp",  label: "Exposto",  rec: reconciliation.exp },
  ].filter((s) => s.rec && s.rec.status !== "single");
  if (!sides.length) return null;

  const worst = sides.some((s) => s.rec.status === "mismatch")
    ? "mismatch"
    : sides.some((s) => s.rec.status === "partial")
      ? "partial"
      : "ok";

  const tint = worst === "mismatch"
    ? { fg:"#C0392B", bg:"#C0392B14", bd:"#C0392B40" }
    : worst === "partial"
      ? { fg:"#B7791F", bg:"#B7791F14", bd:"#B7791F40" }
      : { fg:C.muted, bg:"transparent", bd:"transparent" };

  const title = sides
    .map((s) => `${s.label}: ${reconciliationSummary(s.rec) || "bases somadas sem divergência"}`)
    .join("\n");

  const text = worst === "mismatch"
    ? "bases divergentes"
    : worst === "partial"
      ? "respostas sem par entre bases"
      : "bases somadas";

  return (
    <span
      title={title}
      style={{
        fontSize:10,fontWeight:700,letterSpacing:0.6,textTransform:"uppercase",
        color:tint.fg,background:tint.bg,border:`1px solid ${tint.bd}`,
        borderRadius:999,padding:"2px 7px",cursor:"help",
      }}
    >{text}</span>
  );
}

export default SurveyTab;
