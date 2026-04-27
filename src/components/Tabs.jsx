import { C } from "../shared/theme";

const Tabs = ({ tabs, active, onChange, small, theme }) => (
  <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:small?12:20}}>
    {tabs.map(t=>(
      <button key={t} onClick={()=>onChange(t)} style={{
        background:active===t?C.blue:(theme?.bg3||C.dark3),
        color:active===t?C.white:(theme?.muted||C.muted),
        border:`1px solid ${active===t?C.blue:(theme?.bdr||C.dark3)}`,
        borderRadius:8,padding:small?"6px 14px":"9px 20px",
        cursor:"pointer",fontSize:small?12:13,fontWeight:600,transition:"all 0.15s",
      }}>{t}</button>
    ))}
  </div>
);

// ── CollapsibleTable ──────────────────────────────────────────────────────────

export default Tabs;
