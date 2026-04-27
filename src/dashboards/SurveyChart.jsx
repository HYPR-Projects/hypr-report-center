import { useEffect, useRef } from "react";
import { useChart } from "../shared/useChart";

const SurveyChart=({id,labels,ctrl,exp})=>{
  const ref=useRef(null);
  const Chart=useChart();
  useEffect(()=>{
    if(!ref.current||!Chart)return;
    const existing=ref.current._chartInstance;
    if(existing)existing.destroy();
    const chart=new Chart(ref.current,{
      type:"bar",
      data:{
        labels,
        datasets:[
          {label:"Controle", data:ctrl, backgroundColor:"#E5EBF2", borderRadius:4},
          {label:"Exposto",  data:exp,  backgroundColor:"#3397B9", borderRadius:4},
        ]
      },
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
