import { C } from "../shared/theme";
import { fmt, fmtP, fmtR } from "../shared/format";

const MediaSummary = ({ rows, type, theme, detail0, camp }) => {
  const filtered = rows.filter(r => r.media_type === type);
  if (!filtered.length) return null;
  const detailFiltered = (detail0||[]).filter(r => r.media_type === type);
  const total = filtered.reduce((acc, r) => ({
    viewable_impressions:  (acc.viewable_impressions||0)  + (r.viewable_impressions||0),
    clicks:                (acc.clicks||0)                + (r.clicks||0),
    completions:           (acc.completions||0)           + (r.completions||0),
    effective_total_cost:  (acc.effective_total_cost||0)  + (r.effective_total_cost||0),
    effective_cost_with_over: (acc.effective_cost_with_over||0) + (r.effective_cost_with_over||0),
  }), {});
  const isDisplay = type === "DISPLAY";
  // Use detail for vi and views100 (filtered without survey)
  const vi_det = detailFiltered.reduce((s,r)=>s+(r.viewable_impressions||0),0);
  const v100_det = detailFiltered.reduce((s,r)=>s+(r.video_view_100||0),0);
  const vi = vi_det || total.viewable_impressions;
  const v100 = v100_det || total.completions;
  // Budget proportional calculation
  const budget_d = filtered.reduce((s,r)=>s+(r.o2o_display_budget||0)+(r.ooh_display_budget||0),0);
  const budget_v = filtered.reduce((s,r)=>s+(r.o2o_video_budget||0)+(r.ooh_video_budget||0),0);
  const budget = isDisplay ? budget_d : budget_v;
  const cpmNeg = filtered[0]?.deal_cpm_amount||0;
  const cpcvNeg = filtered[0]?.deal_cpcv_amount||0;
  const [sy,sm,sd] = (camp?.start_date||"2026-01-01").split("-").map(Number);
  const [ey,em,ed] = (camp?.end_date||"2026-12-31").split("-").map(Number);
  const start=new Date(sy,sm-1,sd),end=new Date(ey,em-1,ed),today=new Date();
  const tDays=(end-start)/864e5+1, eDays=today<start?0:today>end?tDays:Math.floor((today-start)/864e5);
  const budgetProp = today>end ? budget : budget/tDays*eDays;
  const isDisplay2 = type === "DISPLAY";
  const ctr  = vi > 0 ? (total.clicks / vi * 100) : 0;
  const vtr  = vi > 0 ? (v100 / vi * 100) : 0;
  const cpm_ef  = cpmNeg>0 ? Math.min(vi>0 ? budgetProp/vi*1000 : 0, cpmNeg) : 0;
  const cpcv_ef = cpcvNeg>0 ? Math.min(v100>0 ? budgetProp/v100 : 0, cpcvNeg) : 0;
  const cpc  = total.clicks > 0 ? (cpm_ef/1000*(vi/total.clicks)) : 0;
  const bg  = theme?.bg2  || C.dark2;
  const bdr = theme?.bdr  || C.dark3;
  const mt  = theme?.muted|| C.muted;
  const txt = theme?.text || C.white;
  return (
    <div style={{background:bg,border:`1px solid ${bdr}`,borderRadius:12,padding:"18px 22px"}}>
      <div style={{fontSize:12,color:C.blue,textTransform:"uppercase",letterSpacing:2,fontWeight:600,marginBottom:14}}>{type}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:12}}>
        <div><div style={{fontSize:10,color:mt,textTransform:"uppercase",letterSpacing:1}}>Imp. Visíveis</div><div style={{fontSize:16,fontWeight:700,marginTop:4,color:txt}}>{fmt(total.viewable_impressions)}</div></div>
        {isDisplay ? (
          <>
            <div><div style={{fontSize:10,color:mt,textTransform:"uppercase",letterSpacing:1}}>CPM Efetivo</div><div style={{fontSize:16,fontWeight:700,marginTop:4,color:C.blue}}>{fmtR(cpm_ef)}</div></div>
            <div><div style={{fontSize:10,color:mt,textTransform:"uppercase",letterSpacing:1}}>CPC</div><div style={{fontSize:16,fontWeight:700,marginTop:4,color:txt}}>{fmtR(cpc)}</div></div>
            <div><div style={{fontSize:10,color:mt,textTransform:"uppercase",letterSpacing:1}}>CTR</div><div style={{fontSize:16,fontWeight:700,marginTop:4,color:C.blue}}>{fmtP(ctr)}</div></div>
          </>
        ) : (
          <>
            <div><div style={{fontSize:10,color:mt,textTransform:"uppercase",letterSpacing:1}}>Views 100%</div><div style={{fontSize:16,fontWeight:700,marginTop:4,color:txt}}>{fmt(total.completions)}</div></div>
            <div><div style={{fontSize:10,color:mt,textTransform:"uppercase",letterSpacing:1}}>CPCV Efetivo</div><div style={{fontSize:16,fontWeight:700,marginTop:4,color:C.blue}}>{fmtR(cpcv_ef)}</div></div>
            <div><div style={{fontSize:10,color:mt,textTransform:"uppercase",letterSpacing:1}}>VTR</div><div style={{fontSize:16,fontWeight:700,marginTop:4,color:C.blue}}>{fmtP(vtr)}</div></div>
          </>
        )}
      </div>
    </div>
  );
};

// ── Dual Chart (recharts) ─────────────────────────────────────────────────────

export default MediaSummary;
