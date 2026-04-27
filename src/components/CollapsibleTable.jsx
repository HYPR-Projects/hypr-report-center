import { useState } from "react";
import { C } from "../shared/theme";

const CollapsibleTable = ({ title, children, defaultOpen = false, theme }) => {
  const [open, setOpen] = useState(defaultOpen);
  const bg   = theme?.bg2  || C.dark2;
  const bg0  = theme?.bg   || C.dark;
  const bdr  = theme?.bdr  || C.dark3;
  const txt  = theme?.text || C.white;
  const mt   = theme?.muted|| C.muted;
  return (
    <div style={{border:`1px solid ${bdr}`,borderRadius:12,overflow:"hidden",marginBottom:8}}>
      <button onClick={()=>setOpen(o=>!o)} style={{
        width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",
        background:bg,border:"none",padding:"12px 16px",cursor:"pointer",
        color:txt,fontSize:13,fontWeight:600,
      }}>
        <span style={{color:mt,textTransform:"uppercase",letterSpacing:1,fontSize:12}}>{title}</span>
        <span style={{color:C.blue,fontSize:16,transform:open?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.2s"}}>▾</span>
      </button>
      {open&&<div style={{padding:16,background:bg0}}>{children}</div>}
    </div>
  );
};

// ── Performance table ─────────────────────────────────────────────────────────

export default CollapsibleTable;
