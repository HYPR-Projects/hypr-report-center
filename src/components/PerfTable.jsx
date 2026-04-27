import { Line } from "recharts";
import { C } from "../shared/theme";
import { fmt, fmtP, fmtP2, fmtR } from "../shared/format";

const PerfTable = ({ rows, type }) => {
  if (!rows?.length) return <p style={{color:C.muted,padding:"24px 0"}}>Sem dados para esta combinação.</p>;
  const isDisplay = type==="DISPLAY";
  const cols = isDisplay
    ? ["Data","Tática","Line","Criativo","Impressões","Imp. Visíveis","Cliques","CTR","CPM Neg.","CPM Ef.","Custo Ef.","Custo c/ Over","Pacing","Rentabilidade"]
    : ["Data","Tática","Line","Criativo","Impressões","Imp. Visíveis","Completions","VCR","CPCV Neg.","CPCV Ef.","Custo Ef.","Custo c/ Over","Pacing","Rentabilidade"];
  return (
    <div style={{overflowX:"auto",maxHeight:400,overflowY:"auto"}}>
      <table>
        <thead><tr style={{position:"sticky",top:0,background:"inherit",zIndex:1}}>{cols.map(h=><th key={h} style={{color:C.muted,fontWeight:600,fontSize:12,background:"#1a2232"}}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r,i)=>(
            <tr key={i}>
              <td>{r.date||"—"}</td>
              <td style={{fontWeight:700}}>{r.tactic_type}</td>
              <td style={{color:C.muted,fontSize:12,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis"}}>{r.line_name||"—"}</td>
              <td style={{color:C.muted,fontSize:12,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis"}}>{r.creative_name||"—"}</td>
              <td>{fmt(r.impressions)}</td>
              <td>{fmt(r.viewable_impressions)}</td>
              {isDisplay
                ? <><td>{fmt(r.clicks)}</td><td>{fmtP2(r.ctr)}</td></>
                : <><td>{fmt(r.completions)}</td><td>{fmtP2(r.vcr)}</td></>
              }
              <td>{isDisplay?fmtR(r.deal_cpm_amount):fmtR(r.deal_cpcv_amount)}</td>
              <td style={{color:C.blue}}>{isDisplay?fmtR(r.effective_cpm_amount):fmtR(r.effective_cpcv_amount)}</td>
              <td>{fmtR(r.effective_total_cost)}</td>
              <td>{fmtR(r.effective_cost_with_over)}</td>
              <td><span style={{color:(r.pacing||0)>=90?C.blue:C.yellow}}>{fmtP(r.pacing)}</span></td>
              <td><span style={{color:(r.rentabilidade||0)>=0?C.green:C.red}}>{fmtP(r.rentabilidade)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════════════════════════════════════

export default PerfTable;
