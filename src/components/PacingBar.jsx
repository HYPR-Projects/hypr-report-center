import { C } from "../shared/theme";
import { fmt, fmtR } from "../shared/format";

const PacingBar = ({ pacing, budget, cost, label="Pacing da Campanha", theme }) => {
  const realPct   = pacing || 0;
  const pct       = Math.min(realPct, 150);
  const overPct   = pct > 100 ? pct - 100 : 0;
  const normalPct = Math.min(pct, 100);
  const barColor  = pct >= 100 ? "#2ECC71" : pct >= 70 ? "#F1C40F" : "#E74C3C";
  const isLight   = !!theme && theme.bg !== C.dark;
  const overColor = isLight ? "#246C84" : "#C5EAF6";
  const labelColor = pct > 100 ? overColor : barColor;
  const bg        = theme?.bg2  || C.dark2;
  const bdr       = theme?.bdr  || C.dark3;
  const trackBg   = isLight ? "#E2E8F0" : C.dark3;
  const mt        = theme?.muted|| C.muted;
  return (
    <div style={{background:bg,border:`1px solid ${bdr}`,borderRadius:12,padding:"18px 22px"}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
        <span style={{fontSize:11,color:mt,textTransform:"uppercase",letterSpacing:1,fontWeight:500}}>{label}</span>
        <span style={{fontSize:13,fontWeight:700,color:labelColor}}>{fmt(realPct,1)}%{realPct>100&&" ⚡ Over de "+fmt(realPct-100,1)+"%"}</span>
      </div>
      <div style={{height:10,background:trackBg,borderRadius:6,overflow:"hidden",position:"relative"}}>
        <div style={{position:"absolute",left:0,top:0,height:"100%",width:`${normalPct}%`,background:barColor,borderRadius:6,transition:"width 0.6s ease"}}/>
        {overPct>0&&(
          <div style={{position:"absolute",left:`${normalPct}%`,top:0,height:"100%",width:`${Math.min(overPct,50)}%`,background:overColor,borderRadius:"0 6px 6px 0"}}/>
        )}
      </div>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
        <span style={{fontSize:11,color:mt}}>Investido: {fmtR(cost)}</span>
        <span style={{fontSize:11,color:mt}}>Budget: {fmtR(budget)}</span>
      </div>
    </div>
  );
};

// ── Summary cards (Display / Video) ──────────────────────────────────────────

export default PacingBar;
