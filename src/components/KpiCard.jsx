import { C } from "../shared/theme";

const KpiCard = ({ label, value, color, fontSize, theme }) => {
  const bg   = theme?.bg2  || C.dark2;
  const bdr  = theme?.bdr  || C.dark3;
  const mt   = theme?.muted|| C.muted;
  const txt  = theme?.text || C.white;
  return (
    <div style={{background:bg,border:`1px solid ${bdr}`,borderRadius:10,padding:"14px 16px"}}>
      <div style={{fontSize:10,color:mt,textTransform:"uppercase",letterSpacing:0.8,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{label}</div>
      <div style={{fontSize:fontSize||18,fontWeight:800,marginTop:4,color:color||txt,whiteSpace:"nowrap"}}>{value}</div>
    </div>
  );
};

export default KpiCard;
