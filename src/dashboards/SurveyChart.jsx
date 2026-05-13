import { useEffect, useRef } from "react";
import { useChart } from "../shared/useChart";

// ctrl/exp opcionais — quando a pergunta tem só um lado, passa null/[] no
// lado faltante e o chart oculta o dataset correspondente (em vez de
// renderizar zeros enganosos).
const SurveyChart=({id,labels,ctrl,exp})=>{
  const ref=useRef(null);
  const Chart=useChart();
  useEffect(()=>{
    if(!ref.current||!Chart)return;
    const existing=ref.current._chartInstance;
    if(existing)existing.destroy();
    const datasets=[];
    if(Array.isArray(ctrl) && ctrl.length>0){
      datasets.push({label:"Controle", data:ctrl, backgroundColor:"#E5EBF2", borderRadius:4});
    }
    if(Array.isArray(exp) && exp.length>0){
      datasets.push({label:"Exposto",  data:exp,  backgroundColor:"#3397B9", borderRadius:4});
    }
    const chart=new Chart(ref.current,{
      type:"bar",
      data:{labels,datasets},
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>` ${ctx.dataset.label}: ${ctx.parsed.y}%`}}},
        scales:{
          x:{grid:{display:false},ticks:{font:{size:12}}},
          y:{max:100,ticks:{callback:v=>v+"%",font:{size:11}},grid:{color:"rgba(255,255,255,0.06)"}},
        }
      }
    });
    ref.current._chartInstance=chart;
    return()=>chart.destroy();
  },[labels,ctrl,exp,Chart]);
  return <div style={{position:"relative",height:460}}><canvas ref={ref} id={id}/></div>;
};
// ── TabChat ──────────────────────────────────────────────────────────────────

export default SurveyChart;
