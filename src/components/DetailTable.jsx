import { useState } from "react";
import { Line } from "recharts";
import { C } from "../shared/theme";
import { fmt } from "../shared/format";

const DetailTable = ({ detail, campaignName }) => {
  const [filter, setFilter] = useState("ALL");
  const filtered = filter === "ALL" ? detail : detail.filter(r => r.media_type === filter);

  const downloadCSV = () => {
    const cols = ["date","campaign_name","line_name","creative_name","creative_size","media_type","impressions","viewable_impressions","clicks","video_starts","video_view_25","video_view_50","video_view_75","video_view_100","effective_total_cost","effective_cost_with_over"];
    const header = cols.join(",");
    const rows = filtered.map(r => cols.map(c => `"${r[c] ?? ""}"`).join(","));
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], {type:"text/csv"});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `${campaignName}_detail.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const cols = ["Data","Campanha","Line","Criativo","Tamanho","Tipo","Impressões","Imp. Visíveis","Cliques","Video Starts","25%","50%","75%","100%","Custo Efetivo","Custo Ef. + Over"];
  const keys = ["date","campaign_name","line_name","creative_name","creative_size","media_type","impressions","viewable_impressions","clicks","video_starts","video_view_25","video_view_50","video_view_75","video_view_100","effective_total_cost","effective_cost_with_over"];

  return (
    <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:12}}>
        <div style={{display:"flex",gap:6}}>
          {["ALL","DISPLAY","VIDEO"].map(f => (
            <button key={f} onClick={()=>setFilter(f)} style={{background:filter===f?C.blue:C.dark3,color:filter===f?C.white:C.muted,border:"none",padding:"5px 12px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>{f}</button>
          ))}
        </div>
        <button onClick={downloadCSV} style={{background:C.blueDark,color:C.white,border:"none",padding:"8px 18px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600}}>⬇ Download CSV</button>
      </div>
      <div style={{overflowX:"auto",maxHeight:340,overflowY:"auto"}}>
        <table>
          <thead style={{position:"sticky",top:0,zIndex:2}}>
            <tr>{cols.map(h=><th key={h} style={{color:C.muted,fontWeight:600,fontSize:11,background:C.dark3}}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {filtered.slice(0,200).map((r,i)=>(
              <tr key={i}>
                {keys.map(k=>(
                  <td key={k} style={{fontSize:12,color:typeof r[k]==="number"?C.white:C.lightGray}}>
                    {typeof r[k]==="number" ? fmt(r[k]) : r[k]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 200 && <p style={{color:C.muted,fontSize:12,padding:"8px 14px"}}>Mostrando 200 de {filtered.length} linhas. Use Download CSV para ver tudo.</p>}
      </div>
    </div>
  );
};

// ── MultiLineSelect ───────────────────────────────────────────────────────────

export default DetailTable;
