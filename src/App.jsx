import { useState, useEffect, useRef } from "react";
import { LineChart, Line, BarChart as RechartBar, Bar, XAxis, YAxis, Tooltip as RTooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";

const GOOGLE_CLIENT_ID = "453955675457-p7bj0e8jt6s83da5teo2var5t97okqk7.apps.googleusercontent.com";
const API_URL = import.meta.env.VITE_API_URL || "https://southamerica-east1-site-hypr.cloudfunctions.net/report_data";

const C = {
  dark:      "#1C262F",
  dark2:     "#243140",
  dark3:     "#2d3d4f",
  blue:      "#3397B9",
  blueDark:  "#246C84",
  blueLight: "#C5EAF6",
  lightGray: "#E5EBF2",
  muted:     "#78909C",
  darkMuted: "#536872",
  white:     "#FCFEFE",
  green:     "#2ECC71",
  yellow:    "#F1C40F",
  red:       "#E74C3C",
};

const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Urbanist:wght@300;400;500;600;700;800;900&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html,body,#root{width:100%;min-height:100vh;}
    body{font-family:'Urbanist',sans-serif;background:${C.dark};color:${C.white};min-height:100vh;}
    ::-webkit-scrollbar{width:6px;} ::-webkit-scrollbar-track{background:${C.dark2};}
    ::-webkit-scrollbar-thumb{background:${C.blueDark};border-radius:3px;}
    input,button,select{font-family:'Urbanist',sans-serif;}
    button:focus,button:focus-visible{outline:none!important;box-shadow:none!important;}
    input:focus,input:focus-visible{outline:none!important;}
    @keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes glitterPulse{
      0%{transform:scale(1.08) rotate(0deg);opacity:0.5;}
      33%{transform:scale(1.15) rotate(1.5deg);opacity:0.65;}
      66%{transform:scale(1.1) rotate(-1deg);opacity:0.55;}
      100%{transform:scale(1.08) rotate(0deg);opacity:0.5;}
    }
    @keyframes particleFloat{
      0%,100%{transform:translateY(0) translateX(0) scale(1);opacity:0.6;}
      25%{transform:translateY(-20px) translateX(12px) scale(1.15);opacity:0.9;}
      75%{transform:translateY(14px) translateX(-10px) scale(0.9);opacity:0.7;}
    }
    .fade-in{animation:fadeIn 0.35s ease forwards;}
    @media(max-width:640px){
      .resp-hide{display:none!important;}
      .camp-row{flex-direction:column!important;align-items:flex-start!important;}
      .camp-actions{width:100%;}
      .camp-actions button{flex:1;}
    }
    table{border-collapse:collapse;width:100%;}
    th,td{padding:10px 14px;text-align:left;white-space:nowrap;}
    thead tr{background:${C.dark3};}
    tbody tr{border-bottom:1px solid ${C.dark3};}
    tbody tr:hover{background:${C.dark3}40;}
  `}</style>
);

const Spinner = ({ size=24, color=C.blue }) => (
  <div style={{width:size,height:size,border:`2px solid ${color}30`,borderTop:`2px solid ${color}`,borderRadius:"50%",animation:"spin 0.8s linear infinite",display:"inline-block"}}/>
);
const HyprLogo = ({ height=32, center=false, isDark=true }) => (
  <img src="/logo.png" alt="HYPR" style={{height, width:"auto", display:"block", margin:center?"0 auto":"0", filter: isDark ? "none" : "invert(1)"}} />
);

const fmt  = (n,d=0) => n==null?"—":Number(n).toLocaleString("pt-BR",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtR = (n)     => n==null?"—":`R$ ${fmt(n,2)}`;
const fmtP = (n)     => n==null?"—":`${fmt(n,1)}%`;
const fmtP2= (n)     => n==null?"—":`${fmt(n,2)}%`;

const BarChart = ({ data, xKey, yKey, color = C.blue, height = 160, formatter, rotateX = false }) => {
  if (!data?.length) return null;
  const fmtVal = (v) => {
    if (v >= 1000000) return `${(v/1000000).toFixed(1)}M`;
    if (v >= 1000)    return `${(v/1000).toFixed(0)}K`;
    return String(v);
  };
  return (
    <ResponsiveContainer width="98%" height={height} style={{overflow:"hidden"}}>
      <RechartBar data={data} margin={{ top: 4, right: 8, left: 0, bottom: rotateX ? 60 : 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.dark3} vertical={false} />
        <XAxis dataKey={xKey} tick={{ fill: C.muted, fontSize: 10, angle: rotateX ? -35 : 0, textAnchor: rotateX ? "end" : "middle", dy: rotateX ? 8 : 0 }} tickLine={false} tickFormatter={v => rotateX ? String(v) : String(v).slice(5)} interval="preserveStartEnd" />
        <YAxis tick={{ fill: C.muted, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={fmtVal} width={44} />
        <RTooltip contentStyle={{ background: C.dark2, border: `1px solid ${C.dark3}`, borderRadius: 8, fontSize: 12 }} formatter={formatter || ((v) => [fmtVal(v)])} labelFormatter={l => `Data: ${l}`} />
        <Bar dataKey={yKey} fill={color} radius={[3, 3, 0, 0]} opacity={0.85} />
      </RechartBar>
    </ResponsiveContainer>
  );
};

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
const LoginScreen = ({ onLogin }) => {
  useEffect(()=>{
    const s=document.createElement("script"); s.src="https://accounts.google.com/gsi/client"; s.async=true;
    s.onload=()=>{
      window.google?.accounts.id.initialize({
        client_id:GOOGLE_CLIENT_ID,
        callback:(res)=>{
          const p=JSON.parse(atob(res.credential.split(".")[1]));
          if(p.email?.endsWith("@hypr.mobi")) onLogin({name:p.name,email:p.email,picture:p.picture});
          else alert("Acesso restrito a emails @hypr.mobi");
        },
      });
      window.google?.accounts.id.renderButton(document.getElementById("gbtn"),{theme:"filled_black",size:"large",width:280});
    };
    document.body.appendChild(s);
  },[]);
  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:`radial-gradient(ellipse at 30% 50%,${C.dark3},${C.dark})`,padding:24}}>
      <GlobalStyle/>
      <div className="fade-in" style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:20,padding:"56px 48px",maxWidth:400,width:"100%",textAlign:"center",boxShadow:`0 32px 80px #00000060`}}>
        <HyprLogo height={44} center/>
        <div style={{marginTop:8,fontSize:13,color:C.muted,letterSpacing:3,textTransform:"uppercase"}}>Report Hub</div>
        <div style={{margin:"40px 0",height:1,background:C.dark3}}/>
        <p style={{color:C.muted,fontSize:14,marginBottom:32,lineHeight:1.6}}>Acesso restrito à equipe HYPR.<br/>Faça login com seu email <strong style={{color:C.blueLight}}>@hypr.mobi</strong>.</p>
        <div id="gbtn" style={{display:"flex",justifyContent:"center"}}/>
        <p style={{marginTop:24,fontSize:12,color:`${C.muted}80`}}>Apenas contas @hypr.mobi são autorizadas</p>
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// CAMPAIGN MENU — Redesigned v2
// ══════════════════════════════════════════════════════════════════════════════

// Light theme colors
const CL = {
  bg:       "#F4F6FA",
  bg2:      "#FFFFFF",
  bg3:      "#EEF1F7",
  border:   "#DDE2EC",
  text:     "#1C262F",
  muted:    "#6B7A8D",
  blue:     "#3397B9",
  blueDark: "#246C84",
  blueLight:"#E8F6FB",
  accent:   "#EDD900",
  green:    "#2ECC71",
};

// Campaign card with expandable actions
const CampaignCard = ({ c, onOpenReport, onLoom, onSurvey, onLogo, onCopyLink, copied, isDark }) => {
  const [expanded, setExpanded] = useState(false);
  const bg    = isDark ? C.dark2 : CL.bg2;
  const bg3   = isDark ? C.dark3 : CL.bg3;
  const border= isDark ? C.dark3 : CL.border;
  const text  = isDark ? C.white : CL.text;
  const muted = isDark ? C.muted : CL.muted;

  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 14,
        overflow: "hidden",
        transition: "box-shadow 0.2s, transform 0.15s, border-color 0.2s",
        cursor: "default",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.boxShadow = isDark
          ? "0 8px 28px rgba(0,0,0,0.45)"
          : "0 8px 28px rgba(51,151,185,0.15)";
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.borderColor = C.blue;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.boxShadow = "none";
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.borderColor = border;
      }}
    >
      {/* Main row */}
      <div style={{
        padding: "14px 18px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
      }}>
        {/* Info */}
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: text }}>{c.client_name}</div>
          <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{c.campaign_name}</div>
          {c.start_date && (
            <div style={{ fontSize: 11, color: muted, marginTop: 3, opacity: 0.7 }}>
              {c.start_date} → {c.end_date || "—"}
            </div>
          )}
        </div>

        {/* Metric badges — display_pacing, video_pacing, display_ctr, video_vtr */}
        {(c.display_pacing != null || c.video_pacing != null || c.display_ctr != null || c.video_vtr != null) && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {c.display_pacing != null && (
              <div title="Pacing Display" style={{
                background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${
                  c.display_pacing >= 90 && c.display_pacing <= 110 ? "#3397B930" :
                  c.display_pacing < 70 ? "#e5534b30" : "#f0a52930"
                }`,
                borderRadius: 6, padding: "3px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
              }}>
                <span style={{ fontSize: 9, color: muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>DSP PAC</span>
                <span style={{ fontSize: 12, fontWeight: 700, color:
                  c.display_pacing >= 90 && c.display_pacing <= 110 ? C.blue :
                  c.display_pacing < 70 ? "#e5534b" : "#f0a529"
                }}>{c.display_pacing.toFixed(0)}%</span>
              </div>
            )}
            {c.video_pacing != null && (
              <div title="Pacing Video" style={{
                background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${
                  c.video_pacing >= 90 && c.video_pacing <= 110 ? "#3397B930" :
                  c.video_pacing < 70 ? "#e5534b30" : "#f0a52930"
                }`,
                borderRadius: 6, padding: "3px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
              }}>
                <span style={{ fontSize: 9, color: muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>VID PAC</span>
                <span style={{ fontSize: 12, fontWeight: 700, color:
                  c.video_pacing >= 90 && c.video_pacing <= 110 ? C.blue :
                  c.video_pacing < 70 ? "#e5534b" : "#f0a529"
                }}>{c.video_pacing.toFixed(0)}%</span>
              </div>
            )}
            {c.display_ctr != null && (
              <div title="CTR Display" style={{
                background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${muted}25`,
                borderRadius: 6, padding: "3px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
              }}>
                <span style={{ fontSize: 9, color: muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>CTR</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: text }}>{c.display_ctr.toFixed(2)}%</span>
              </div>
            )}
            {c.video_vtr != null && (
              <div title="VTR (View-Through Rate)" style={{
                background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${muted}25`,
                borderRadius: 6, padding: "3px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
              }}>
                <span style={{ fontSize: 9, color: muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>VTR</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: text }}>{c.video_vtr.toFixed(2)}%</span>
              </div>
            )}
          </div>
        )}

        {/* Token badge */}
        <div style={{
          background: `${C.blue}18`,
          border: `1px solid ${C.blue}35`,
          borderRadius: 7,
          padding: "4px 10px",
          fontSize: 11,
          fontWeight: 700,
          color: C.blue,
          letterSpacing: 1,
          fontFamily: "monospace",
        }}>{c.short_token}</div>

        {/* Ver Report */}
        <button
          onClick={() => onOpenReport(c.short_token)}
          style={{
            background: C.blue,
            color: "#fff",
            border: "none",
            padding: "8px 18px",
            borderRadius: 9,
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0.3,
            transition: "background 0.15s",
          }}
          onMouseEnter={e => e.currentTarget.style.background = C.blueDark}
          onMouseLeave={e => e.currentTarget.style.background = C.blue}
        >Ver Report</button>

        {/* Expand toggle */}
        <button
          onClick={() => setExpanded(v => !v)}
          title="Mais ações"
          style={{
            background: expanded ? `${C.blue}18` : bg3,
            border: `1px solid ${expanded ? C.blue + "40" : border}`,
            color: expanded ? C.blue : muted,
            width: 34,
            height: 34,
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "all 0.2s",
            flexShrink: 0,
          }}
        >
          <span style={{ display: "inline-block", transition: "transform 0.2s", transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}>▾</span>
        </button>
      </div>

      {/* Expanded actions */}
      {expanded && (
        <div style={{
          borderTop: `1px solid ${border}`,
          padding: "12px 18px",
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          background: bg3,
        }}>
          {[
            { label: "🎥 Loom",       onClick: () => onLoom(c.short_token) },
            { label: "📋 Survey",     onClick: () => onSurvey(c.short_token) },
            { label: "🖼️ Logo",       onClick: () => onLogo(c.short_token) },
            {
              label: copied === c.short_token ? "✓ Copiado!" : "🔗 Link Cliente",
              onClick: () => onCopyLink(c.short_token),
              highlight: copied === c.short_token,
            },
          ].map(btn => (
            <button
              key={btn.label}
              onClick={btn.onClick}
              style={{
                background: btn.highlight ? `${C.accent}22` : (isDark ? C.dark2 : CL.bg2),
                color: btn.highlight ? "#b8960a" : muted,
                border: `1px solid ${btn.highlight ? C.accent + "60" : border}`,
                padding: "7px 14px",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                transition: "all 0.15s",
              }}
              onMouseEnter={e => { if (!btn.highlight) { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.color = C.blue; } }}
              onMouseLeave={e => { if (!btn.highlight) { e.currentTarget.style.borderColor = border; e.currentTarget.style.color = muted; } }}
            >{btn.label}</button>
          ))}
        </div>
      )}
    </div>
  );
};

// Month group with collapsible
const MonthGroup = ({ label, items, defaultOpen, isDark, ...cardProps }) => {
  const [open, setOpen] = useState(defaultOpen);
  const border = isDark ? C.dark3 : CL.border;
  const muted  = isDark ? C.muted : CL.muted;
  const bg2    = isDark ? C.dark2 : CL.bg2;

  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 4px",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color: muted,
          textTransform: "uppercase",
          letterSpacing: 2,
          flex: 1,
        }}>{label}</span>
        <span style={{
          background: isDark ? C.dark3 : CL.bg3,
          color: muted,
          fontSize: 11,
          fontWeight: 600,
          borderRadius: 20,
          padding: "2px 9px",
          border: `1px solid ${border}`,
        }}>{items.length}</span>
        <span style={{
          color: C.blue,
          fontSize: 14,
          display: "inline-block",
          transition: "transform 0.2s",
          transform: open ? "rotate(180deg)" : "rotate(0deg)",
        }}>▾</span>
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 8 }}>
          {items.map((c, i) => (
            <div key={c.short_token} className="fade-in" style={{ animationDelay: `${i * 18}ms` }}>
              <CampaignCard c={c} isDark={isDark} {...cardProps} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const CampaignMenu = ({ user, onLogout, onOpenReport }) => {
  const [campaigns,     setCampaigns]     = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [search,        setSearch]        = useState("");
  const [showModal,     setShowModal]     = useState(false);
  const [newToken,      setNewToken]      = useState("");
  const [tokenData,     setTokenData]     = useState(null);
  const [logoFile,      setLogoFile]      = useState(null);
  const [logoPreview,   setLogoPreview]   = useState(null);
  const [checking,      setChecking]      = useState(false);
  const [copied,        setCopied]        = useState(null);
  const [loomModal,     setLoomModal]     = useState(null);
  const [loomUrl,       setLoomUrl]       = useState("");
  const [savingLoom,    setSavingLoom]    = useState(false);
  const [surveyModal,   setSurveyModal]   = useState(null);
  const [savingSurvey,  setSavingSurvey]  = useState(false);
  const [surveyBlocks,  setSurveyBlocks]  = useState([{ nome: "", ctrlUrl: "", expUrl: "" }]);
  const [logoModal,     setLogoModal]     = useState(null);
  const [logoModalFile, setLogoModalFile] = useState(null);
  const [logoModalPreview, setLogoModalPreview] = useState(null);
  const [savingLogoModal,  setSavingLogoModal]  = useState(false);

  // New UI state
  const [isDark,       setIsDark]       = useState(true);
  const [sortBy,       setSortBy]       = useState("month");   // "month" | "start_date" | "alpha"
  const [sortAsc,      setSortAsc]      = useState(false);
  const [activeMonth,  setActiveMonth]  = useState(null);      // quick-access filter

  useEffect(() => { fetchList(); }, []);

  const fetchList = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}?list=true`);
      const d = await r.json();
      const raw = d.campaigns || [];
      const seen = new Set();
      const deduped = raw.filter(c => {
        if (seen.has(c.short_token)) return false;
        seen.add(c.short_token);
        return true;
      });
      setCampaigns(deduped);
    } catch { setCampaigns([]); }
    finally { setLoading(false); }
  };

  const checkToken = async () => {
    if (!newToken.trim()) return; setChecking(true);
    try {
      const r = await fetch(`${API_URL}?token=${newToken.trim()}`);
      const d = await r.json();
      if (d.campaign) setTokenData(d.campaign); else alert("Token não encontrado.");
    } catch { alert("Erro ao buscar token."); } finally { setChecking(false); }
  };

  const confirm = async () => {
    if (!tokenData) return;
    if (logoPreview) {
      try {
        await fetch(`https://southamerica-east1-site-hypr.cloudfunctions.net/report_data?action=save_logo`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ short_token: tokenData.short_token, logo_base64: logoPreview }),
        });
      } catch (e) { console.warn("Erro ao salvar logo", e); }
    }
    if (!campaigns.find(c => c.short_token === tokenData.short_token)) setCampaigns(p => [tokenData, ...p]);
    setShowModal(false); setNewToken(""); setTokenData(null); setLogoFile(null); setLogoPreview(null);
  };

  const copyLink = (token) => {
    navigator.clipboard.writeText(`${window.location.origin}/report/${token}`);
    setCopied(token); setTimeout(() => setCopied(null), 2000);
  };

  const openLoomModal = (token) => { setLoomModal(token); setLoomUrl(""); };

  const saveLoom = async () => {
    if (!loomUrl.trim()) return;
    setSavingLoom(true);
    try {
      await fetch(`https://southamerica-east1-site-hypr.cloudfunctions.net/report_data?action=save_loom`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ short_token: loomModal, loom_url: loomUrl.trim() }),
      });
      alert("Loom salvo com sucesso!"); setLoomModal(null); setLoomUrl("");
    } catch { alert("Erro ao salvar Loom."); } finally { setSavingLoom(false); }
  };

  const saveSurvey = async () => {
    setSavingSurvey(true);
    try {
      for (const b of surveyBlocks) {
        if (!b.ctrlUrl.trim() || !b.expUrl.trim()) { alert("Preencha os dois links em todas as perguntas."); setSavingSurvey(false); return; }
        if (!b.nome.trim()) { alert("Preencha o nome de todas as perguntas."); setSavingSurvey(false); return; }
      }
      const payload = surveyBlocks.map(b => ({ nome: b.nome.trim(), ctrlUrl: b.ctrlUrl.trim(), expUrl: b.expUrl.trim() }));
      await fetch(`${API_URL}?action=save_survey`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ short_token: surveyModal, survey_data: JSON.stringify(payload) }),
      });
      alert("Survey salvo com sucesso!"); setSurveyModal(null); setSurveyBlocks([{ nome: "", ctrlUrl: "", expUrl: "" }]);
    } catch { alert("Erro ao salvar survey."); } finally { setSavingSurvey(false); }
  };

  const openLogoModal = (token) => { setLogoModal(token); setLogoModalFile(null); setLogoModalPreview(null); };

  const saveLogoModal = async () => {
    if (!logoModalPreview) return;
    setSavingLogoModal(true);
    try {
      await fetch(`https://southamerica-east1-site-hypr.cloudfunctions.net/report_data?action=save_logo`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ short_token: logoModal, logo_base64: logoModalPreview }),
      });
      alert("Logo salvo com sucesso!"); setLogoModal(null); setLogoModalFile(null); setLogoModalPreview(null);
    } catch { alert("Erro ao salvar logo."); } finally { setSavingLogoModal(false); }
  };

  // ── Theme vars ──
  const bg     = isDark ? C.dark  : CL.bg;
  const bg2    = isDark ? C.dark2 : CL.bg2;
  const bg3    = isDark ? C.dark3 : CL.bg3;
  const border = isDark ? C.dark3 : CL.border;
  const text   = isDark ? C.white : CL.text;
  const muted  = isDark ? C.muted : CL.muted;

  // ── Filtering + sorting ──
  const filtered = campaigns.filter(c => {
    const q = search.trim();
    const ql = q.toLowerCase();
    // Token: contém traço OU é todo maiúsculo (ex: UT10QW, 6BVGU6Q)
    const isTokenQuery = /[-]/.test(q) || /^[A-Z0-9]{4,8}$/.test(q);
    const matchSearch = !q ||
      c.client_name?.toLowerCase().includes(ql) ||
      c.campaign_name?.toLowerCase().includes(ql) ||
      (isTokenQuery && c.short_token?.toLowerCase().includes(ql));
    const matchMonth = !activeMonth ||
      (c.start_date && c.start_date.slice(0, 7) === activeMonth);
    return matchSearch && matchMonth;
  });

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortBy === "alpha")      cmp = (a.client_name || "").localeCompare(b.client_name || "");
    else if (sortBy === "start_date") cmp = (a.start_date || "").localeCompare(b.start_date || "");
    else cmp = (b.start_date || "").localeCompare(a.start_date || ""); // month: newest first default
    return sortAsc ? cmp : -cmp;
  });

  // ── Month groups ──
  const groups = sorted.reduce((acc, c) => {
    const raw = c.start_date || "";
    const [year, month] = raw.split("-").map(Number);
    const key   = year && month ? `${year}-${String(month).padStart(2, "0")}` : "Sem data";
    const label = year && month
      ? new Date(year, month - 1, 1).toLocaleString("pt-BR", { month: "long", year: "numeric" }).replace(/^\w/, l => l.toUpperCase())
      : "Sem data";
    if (!acc[key]) acc[key] = { label, items: [] };
    acc[key].items.push(c);
    return acc;
  }, {});

  // Unique months for quick access
  const allMonths = Object.keys(campaigns.reduce((acc, c) => {
    if (c.start_date) acc[c.start_date.slice(0, 7)] = true; return acc;
  }, {})).sort((a, b) => b.localeCompare(a));

  const cardProps = {
    onOpenReport,
    onLoom:     openLoomModal,
    onSurvey:   (t) => setSurveyModal(t),
    onLogo:     openLogoModal,
    onCopyLink: copyLink,
    copied,
    isDark,
  };

  // Modal style helper
  const modalBg  = isDark ? C.dark2 : CL.bg2;
  const modalBdr = isDark ? C.dark3 : CL.border;
  const inputBg  = isDark ? C.dark3 : CL.bg3;

  return (
    <div style={{ minHeight: "100vh", width: "100%", background: bg, transition: "background 0.3s" }}>
      <GlobalStyle/>
      {/* Dynamic light-mode override */}
      {!isDark && <style>{`body{background:${CL.bg}!important;color:${CL.text}!important;}`}</style>}

      {/* ── Header ── */}
      <div style={{
        background: bg2,
        borderBottom: `1px solid ${border}`,
        padding: "0 32px",
        height: 64,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "sticky",
        top: 0,
        zIndex: 100,
        width: "100%",
        transition: "background 0.3s, border-color 0.3s",
      }}>
        <HyprLogo height={28} isDark={isDark}/>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Theme toggle */}
          <button
            onClick={() => setIsDark(v => !v)}
            title={isDark ? "Modo claro" : "Modo escuro"}
            style={{
              background: bg3,
              border: `1px solid ${border}`,
              color: muted,
              width: 36,
              height: 36,
              borderRadius: 9,
              cursor: "pointer",
              fontSize: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.2s",
            }}
          >{isDark ? "☀️" : "🌙"}</button>
          <img src={user.picture} alt="" referrerPolicy="no-referrer"
            style={{ width: 32, height: 32, borderRadius: "50%", border: `2px solid ${C.blue}` }}/>
          <span style={{ fontSize: 13, color: muted }}>{user.name}</span>
          <button onClick={onLogout} style={{
            background: "none",
            border: `1px solid ${border}`,
            color: muted,
            padding: "6px 14px",
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 12,
          }}>Sair</button>
        </div>
      </div>

      {/* ── Main content ── */}
      <div style={{ width: "100%", maxWidth: 1400, margin: "0 auto", padding: "36px 24px" }}>

        {/* Title + New Report */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 16 }}>
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 800, color: text }}>Reports de Campanhas</h1>
            <p style={{ color: muted, fontSize: 13, marginTop: 4 }}>{campaigns.length} campanhas em 2026</p>
          </div>
          <button onClick={() => setShowModal(true)} style={{
            background: C.blue,
            color: "#fff",
            border: "none",
            padding: "11px 22px",
            borderRadius: 10,
            cursor: "pointer",
            fontSize: 14,
            fontWeight: 700,
            transition: "background 0.15s",
          }}
            onMouseEnter={e => e.currentTarget.style.background = C.blueDark}
            onMouseLeave={e => e.currentTarget.style.background = C.blue}
          >+ Novo Report</button>
        </div>

        {/* ── Quick month access ── */}
        {allMonths.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 600, marginBottom: 10 }}>Acesso Rápido por Mês</div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              <button
                onClick={() => setActiveMonth(null)}
                style={{
                  background: activeMonth === null ? C.blue : bg3,
                  color:      activeMonth === null ? "#fff" : muted,
                  border:     `1px solid ${activeMonth === null ? C.blue : border}`,
                  padding:    "6px 14px",
                  borderRadius: 20,
                  cursor:     "pointer",
                  fontSize:   12,
                  fontWeight: 600,
                  transition: "all 0.15s",
                }}
              >Todos</button>
              {allMonths.map(m => {
                const [y, mo] = m.split("-").map(Number);
                const label = new Date(y, mo - 1, 1).toLocaleString("pt-BR", { month: "short", year: "2-digit" });
                const count = campaigns.filter(c => c.start_date?.startsWith(m)).length;
                const isActive = activeMonth === m;
                return (
                  <button key={m} onClick={() => setActiveMonth(isActive ? null : m)} style={{
                    background: isActive ? C.blue : bg3,
                    color:      isActive ? "#fff" : muted,
                    border:     `1px solid ${isActive ? C.blue : border}`,
                    padding:    "6px 14px",
                    borderRadius: 20,
                    cursor:     "pointer",
                    fontSize:   12,
                    fontWeight: 600,
                    transition: "all 0.15s",
                    display:    "flex",
                    alignItems: "center",
                    gap:        5,
                  }}>
                    {label.charAt(0).toUpperCase() + label.slice(1)}
                    <span style={{
                      background: isActive ? "rgba(255,255,255,0.25)" : (isDark ? C.dark2 : CL.border),
                      borderRadius: 10,
                      padding: "1px 6px",
                      fontSize: 10,
                      fontWeight: 700,
                    }}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Search + Sort bar ── */}
        <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", flex: 1, minWidth: 240 }}>
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: muted, fontSize: 14 }}>🔍</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por cliente, campanha ou token..."
              style={{
                width: "100%",
                background: bg2,
                border: `1px solid ${border}`,
                borderRadius: 10,
                padding: "12px 16px 12px 40px",
                color: text,
                fontSize: 14,
                outline: "none",
                transition: "border-color 0.2s",
              }}
              onFocus={e => e.target.style.borderColor = C.blue}
              onBlur={e => e.target.style.borderColor = border}
            />
          </div>

          {/* Sort buttons */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Ordenar:</span>
            {[
              { key: "month",      label: "Mês" },
              { key: "start_date", label: "Data início" },
              { key: "alpha",      label: "A–Z" },
            ].map(s => {
              const isActive = sortBy === s.key;
              return (
                <button key={s.key} onClick={() => {
                  if (sortBy === s.key) setSortAsc(v => !v);
                  else { setSortBy(s.key); setSortAsc(false); }
                }} style={{
                  background: isActive ? `${C.blue}18` : bg3,
                  color:      isActive ? C.blue : muted,
                  border:     `1px solid ${isActive ? C.blue + "40" : border}`,
                  padding:    "7px 13px",
                  borderRadius: 8,
                  cursor:     "pointer",
                  fontSize:   12,
                  fontWeight: 600,
                  display:    "flex",
                  alignItems: "center",
                  gap:        4,
                  transition: "all 0.15s",
                }}>
                  {s.label}
                  {isActive && (
                    <span style={{ fontSize: 10 }}>{sortAsc ? "↑" : "↓"}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Campaign list ── */}
        {loading
          ? <div style={{ textAlign: "center", padding: 80 }}><Spinner size={40}/></div>
          : sorted.length === 0
            ? <div style={{ textAlign: "center", padding: 80, color: muted }}>
                {activeMonth ? "Sem campanhas neste mês." : "Nenhuma campanha encontrada."}
              </div>
            : (
              <div>
                {Object.entries(groups)
                  .sort(([a], [b]) => sortBy === "month" ? (sortAsc ? a.localeCompare(b) : b.localeCompare(a)) : 0)
                  .map(([key, { label, items }], gi) => (
                    <MonthGroup
                      key={key}
                      label={label}
                      items={items}
                      defaultOpen={gi === 0}
                      isDark={isDark}
                      {...cardProps}
                    />
                  ))
                }
              </div>
            )
        }
      </div>

      {/* ══ MODALS ══════════════════════════════════════════════════════════ */}

      {/* New Report modal */}
      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "#00000080", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) { setShowModal(false); setNewToken(""); setTokenData(null); } }}>
          <div className="fade-in" style={{ background: modalBg, border: `1px solid ${modalBdr}`, borderRadius: 16, padding: 40, width: "100%", maxWidth: 480 }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, color: text }}>Novo Report</h2>
            <p style={{ color: muted, fontSize: 14, marginBottom: 28 }}>Digite o short_token da campanha para gerar o link de acesso do cliente.</p>
            {!tokenData ? (
              <>
                <label style={{ fontSize: 12, color: muted, textTransform: "uppercase", letterSpacing: 1 }}>Short Token</label>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <input value={newToken} onChange={e => setNewToken(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && checkToken()} placeholder="ex: GEE-MAR26"
                    style={{ flex: 1, background: inputBg, border: `1px solid ${modalBdr}`, borderRadius: 8, padding: "12px 14px", color: text, fontSize: 15, fontWeight: 700, letterSpacing: 1, outline: "none" }}/>
                  <button onClick={checkToken} disabled={checking || !newToken.trim()} style={{ background: C.blue, color: C.white, border: "none", padding: "12px 20px", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700, minWidth: 80, opacity: !newToken.trim() ? 0.5 : 1 }}>
                    {checking ? <Spinner size={16} color={C.white}/> : "Buscar"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ background: `${C.blue}15`, border: `1px solid ${C.blue}30`, borderRadius: 10, padding: 20, marginBottom: 24 }}>
                  <div style={{ fontSize: 12, color: C.blue, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Campanha encontrada</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: text }}>{tokenData.client_name}</div>
                  <div style={{ fontSize: 14, color: muted, marginTop: 4 }}>{tokenData.campaign_name}</div>
                  <div style={{ marginTop: 12, display: "flex", gap: 16 }}>
                    <div><div style={{ fontSize: 11, color: muted }}>Início</div><div style={{ fontSize: 13, fontWeight: 600, color: text }}>{tokenData.start_date}</div></div>
                    <div><div style={{ fontSize: 11, color: muted }}>Fim</div><div style={{ fontSize: 13, fontWeight: 600, color: text }}>{tokenData.end_date}</div></div>
                    <div><div style={{ fontSize: 11, color: muted }}>Token</div><div style={{ fontSize: 13, fontWeight: 700, color: C.blue }}>{tokenData.short_token}</div></div>
                  </div>
                </div>
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, color: muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Logo do Cliente (PNG sem fundo)</div>
                  {logoPreview ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 12, background: inputBg, borderRadius: 8, padding: 12 }}>
                      <img src={logoPreview} style={{ height: 40, objectFit: "contain", maxWidth: 120 }}/>
                      <span style={{ fontSize: 12, color: muted, flex: 1 }}>Logo carregado</span>
                      <button onClick={() => { setLogoFile(null); setLogoPreview(null); }} style={{ background: "none", border: "none", color: muted, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
                    </div>
                  ) : (
                    <label style={{ display: "flex", alignItems: "center", gap: 10, background: inputBg, border: `1px dashed ${modalBdr}`, borderRadius: 8, padding: 12, cursor: "pointer" }}>
                      <input type="file" accept="image/png" style={{ display: "none" }} onChange={e => {
                        const file = e.target.files?.[0]; if (!file) return;
                        setLogoFile(file);
                        const reader = new FileReader(); reader.onload = ev => setLogoPreview(ev.target.result); reader.readAsDataURL(file);
                      }}/>
                      <span style={{ fontSize: 20 }}>🖼️</span>
                      <span style={{ fontSize: 13, color: muted }}>Clique para inserir logo PNG</span>
                    </label>
                  )}
                </div>
                <div style={{ background: inputBg, borderRadius: 8, padding: 12, marginBottom: 20 }}>
                  <div style={{ fontSize: 11, color: muted, marginBottom: 4 }}>Link do cliente (senha = short token)</div>
                  <div style={{ fontSize: 13, color: C.blue, wordBreak: "break-all" }}>{window.location.origin}/report/{tokenData.short_token}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => { setTokenData(null); setNewToken(""); }} style={{ flex: 1, background: inputBg, color: muted, border: `1px solid ${modalBdr}`, padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14 }}>Voltar</button>
                  <button onClick={confirm} style={{ flex: 2, background: C.blue, color: C.white, border: "none", padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>✓ Confirmar e Adicionar</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Loom modal */}
      {loomModal && (
        <div style={{ position: "fixed", inset: 0, background: "#00000080", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) { setLoomModal(null); setLoomUrl(""); } }}>
          <div className="fade-in" style={{ background: modalBg, border: `1px solid ${modalBdr}`, borderRadius: 16, padding: 40, width: "100%", maxWidth: 480 }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, color: text }}>🎥 Adicionar Loom</h2>
            <p style={{ color: muted, fontSize: 14, marginBottom: 24 }}>Cole o link do Loom para <strong>{loomModal}</strong>.</p>
            <input value={loomUrl} onChange={e => setLoomUrl(e.target.value)} placeholder="https://www.loom.com/share/..."
              style={{ width: "100%", background: inputBg, border: `1px solid ${modalBdr}`, borderRadius: 8, padding: "12px 14px", color: text, fontSize: 14, outline: "none", marginBottom: 20 }}/>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setLoomModal(null); setLoomUrl(""); }} style={{ flex: 1, background: inputBg, color: muted, border: `1px solid ${modalBdr}`, padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14 }}>Cancelar</button>
              <button onClick={saveLoom} disabled={savingLoom || !loomUrl.trim()} style={{ flex: 2, background: C.blue, color: C.white, border: "none", padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700, opacity: !loomUrl.trim() ? 0.5 : 1 }}>
                {savingLoom ? "Salvando..." : "✓ Salvar Loom"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Survey modal */}
      {surveyModal && (
        <div style={{ position: "fixed", inset: 0, background: "#00000080", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) { setSurveyModal(null); setSurveyBlocks([{ nome: "", ctrlUrl: "", expUrl: "" }]); } }}>
          <div className="fade-in" style={{ background: modalBg, border: `1px solid ${modalBdr}`, borderRadius: 16, padding: 32, width: "100%", maxWidth: 540, maxHeight: "90vh", overflowY: "auto" }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4, color: text }}>📋 Configurar Survey</h2>
            <p style={{ color: muted, fontSize: 14, marginBottom: 6 }}>Links do Google Sheets para <strong>{surveyModal}</strong>.</p>
            <p style={{ color: muted, fontSize: 12, marginBottom: 20, lineHeight: 1.6 }}>
              Cada link deve ser um Sheets publicado como CSV.<br/>
              No Sheets: <span style={{ color: C.blue }}>Arquivo → Compartilhar → Publicar na web → CSV</span>
            </p>
            {surveyBlocks.map((block, idx) => (
              <div key={idx} style={{ border: `1px solid ${modalBdr}`, borderRadius: 10, padding: 16, marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, textTransform: "uppercase", letterSpacing: 1 }}>Pergunta {idx + 1}</div>
                  {surveyBlocks.length > 1 && (
                    <button onClick={() => setSurveyBlocks(b => b.filter((_, i) => i !== idx))}
                      style={{ background: "none", border: "none", color: muted, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
                  )}
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>Nome da pergunta</div>
                  <input
                    value={block.nome}
                    onChange={e => setSurveyBlocks(b => b.map((bl, i) => i === idx ? { ...bl, nome: e.target.value } : bl))}
                    placeholder="Ex: Ad Recall, Awareness — SP..."
                    style={{ width: "100%", background: inputBg, border: `1px solid ${modalBdr}`, borderRadius: 7, padding: "9px 12px", color: text, fontSize: 13, outline: "none" }}
                  />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>Link Sheets — Grupo Controle</div>
                  <input
                    value={block.ctrlUrl}
                    onChange={e => setSurveyBlocks(b => b.map((bl, i) => i === idx ? { ...bl, ctrlUrl: e.target.value } : bl))}
                    placeholder="https://docs.google.com/spreadsheets/d/.../export?format=csv&gid=..."
                    style={{ width: "100%", background: inputBg, border: `1px solid ${block.ctrlUrl ? C.blue+"60" : modalBdr}`, borderRadius: 7, padding: "9px 12px", color: text, fontSize: 12, outline: "none", fontFamily: "monospace" }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>Link Sheets — Grupo Exposto</div>
                  <input
                    value={block.expUrl}
                    onChange={e => setSurveyBlocks(b => b.map((bl, i) => i === idx ? { ...bl, expUrl: e.target.value } : bl))}
                    placeholder="https://docs.google.com/spreadsheets/d/.../export?format=csv&gid=..."
                    style={{ width: "100%", background: inputBg, border: `1px solid ${block.expUrl ? C.blue+"60" : modalBdr}`, borderRadius: 7, padding: "9px 12px", color: text, fontSize: 12, outline: "none", fontFamily: "monospace" }}
                  />
                </div>
              </div>
            ))}
            <button onClick={() => setSurveyBlocks(b => [...b, { nome: "", ctrlUrl: "", expUrl: "" }])}
              style={{ width: "100%", background: "none", border: `1px dashed ${modalBdr}`, color: C.blue, borderRadius: 8, padding: "10px 0", cursor: "pointer", fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
              + Adicionar pergunta
            </button>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setSurveyModal(null); setSurveyBlocks([{ nome: "", ctrlUrl: "", expUrl: "" }]); }}
                style={{ flex: 1, background: inputBg, color: muted, border: `1px solid ${modalBdr}`, padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14 }}>Cancelar</button>
              <button disabled={savingSurvey} onClick={saveSurvey}
                style={{ flex: 2, background: C.blue, color: C.white, border: "none", padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700, opacity: savingSurvey ? 0.5 : 1 }}>
                {savingSurvey ? "Salvando..." : `✓ Salvar ${surveyBlocks.length > 1 ? surveyBlocks.length + " perguntas" : "Survey"}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Logo modal */}
      {logoModal && (
        <div style={{ position: "fixed", inset: 0, background: "#00000080", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) { setLogoModal(null); setLogoModalPreview(null); } }}>
          <div className="fade-in" style={{ background: modalBg, border: `1px solid ${modalBdr}`, borderRadius: 16, padding: 40, width: "100%", maxWidth: 480 }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, color: text }}>🖼️ Adicionar Logo</h2>
            <p style={{ color: muted, fontSize: 14, marginBottom: 24 }}>Selecione o logo PNG para <strong>{logoModal}</strong>.</p>
            <label style={{ display: "flex", alignItems: "center", gap: 10, background: inputBg, border: `1px solid ${modalBdr}`, borderRadius: 8, padding: "12px 14px", cursor: "pointer", marginBottom: 20 }}>
              <input type="file" accept="image/png,image/jpeg" style={{ display: "none" }} onChange={e => {
                const file = e.target.files?.[0]; if (!file) return;
                setLogoModalFile(file);
                const reader = new FileReader(); reader.onload = ev => setLogoModalPreview(ev.target.result); reader.readAsDataURL(file);
              }}/>
              <span style={{ fontSize: 20 }}>📁</span>
              <span style={{ fontSize: 13, color: muted }}>{logoModalFile ? logoModalFile.name : "Clique para selecionar imagem"}</span>
            </label>
            {logoModalPreview && <img src={logoModalPreview} style={{ width: "100%", maxHeight: 120, objectFit: "contain", marginBottom: 20, borderRadius: 8 }}/>}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setLogoModal(null); setLogoModalPreview(null); }} style={{ flex: 1, background: inputBg, color: muted, border: `1px solid ${modalBdr}`, padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14 }}>Cancelar</button>
              <button onClick={saveLogoModal} disabled={savingLogoModal || !logoModalPreview} style={{ flex: 2, background: C.blue, color: C.white, border: "none", padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700, opacity: !logoModalPreview ? 0.5 : 1 }}>
                {savingLogoModal ? "Salvando..." : "✓ Salvar Logo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
// ══════════════════════════════════════════════════════════════════════════════
// CLIENT PASSWORD
// ══════════════════════════════════════════════════════════════════════════════
const ClientPasswordScreen = ({ token, onUnlock }) => {
  const [pw,setPw]=useState(""); const [err,setErr]=useState(false);
  const submit=()=>{ if(pw.trim().toUpperCase()===token.toUpperCase())onUnlock(); else{setErr(true);setTimeout(()=>setErr(false),2000);} };
  return (
    <div style={{minHeight:"100vh",width:"100%",display:"flex",alignItems:"center",justifyContent:"center",padding:24,position:"relative",overflow:"hidden",background:C.dark}}>
      <GlobalStyle/>
      <div style={{position:"absolute",inset:0,backgroundImage:`url(/glitter.jpg)`,backgroundSize:"cover",backgroundPosition:"center",animation:"glitterPulse 9s ease-in-out infinite",filter:"blur(3px) brightness(0.4) saturate(1.5)",transformOrigin:"center"}}/>
      <div style={{position:"absolute",inset:0,background:`radial-gradient(ellipse at 62% 42%, ${C.blueDark}50 0%, transparent 58%)`,pointerEvents:"none"}}/>
      <div className="fade-in" style={{position:"relative",zIndex:10,background:"rgba(28,38,47,0.52)",backdropFilter:"blur(28px) saturate(1.7)",WebkitBackdropFilter:"blur(28px) saturate(1.7)",border:`1px solid ${err?"rgba(83,104,114,0.7)":"rgba(51,151,185,0.22)"}`,borderRadius:24,padding:"48px 40px",maxWidth:380,width:"100%",textAlign:"center",boxShadow:"0 8px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.07)",transition:"border-color 0.3s"}}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:12}}><HyprLogo height={38} center/></div>
        <div style={{fontSize:12,color:C.muted,letterSpacing:4,textTransform:"uppercase",fontWeight:500,marginBottom:32}}>Report Hub</div>
        <div style={{height:1,background:"rgba(255,255,255,0.07)",marginBottom:28}}/>
        <p style={{color:C.lightGray,fontSize:14,marginBottom:28,lineHeight:1.7,fontWeight:300}}>Insira o código de acesso fornecido<br/>pela equipe HYPR para visualizar o report.</p>
        <input value={pw} onChange={e=>setPw(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&submit()} placeholder="Código de acesso"
          style={{width:"100%",background:"rgba(255,255,255,0.07)",border:`1px solid ${err?"rgba(83,104,114,0.8)":"rgba(51,151,185,0.28)"}`,borderRadius:10,padding:"14px 16px",color:C.white,fontSize:16,fontWeight:700,letterSpacing:2,textAlign:"center",outline:"none",marginBottom:12,transition:"border-color 0.3s"}}/>
        {err&&<p style={{color:C.darkMuted,fontSize:13,marginBottom:12}}>Código inválido. Tente novamente.</p>}
        <button onClick={submit} style={{width:"100%",background:C.blue,color:C.white,border:"none",padding:14,borderRadius:10,cursor:"pointer",fontSize:15,fontWeight:700}}>Acessar Report</button>
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// UPLOAD TAB (RMND / PDOOH) — usa SheetJS via CDN
// ══════════════════════════════════════════════════════════════════════════════
const useXlsx = () => {
  const [lib, setLib] = useState(null);
  useEffect(()=>{
    if (window.XLSX) { setLib(window.XLSX); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => setLib(window.XLSX);
    document.head.appendChild(s);
  },[]);
  return lib;
};

const UploadTab = ({ type, token, serverData, readOnly }) => {
  const XLSX       = useXlsx();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const fileRef               = useRef();
  const storageKey            = `hypr_${type.toLowerCase()}_${token}`;

  useEffect(()=>{
    try { const s=localStorage.getItem(storageKey); if(s){setData(JSON.parse(s));return;} } catch{}
    if(serverData){
      try{
        const parsed=typeof serverData==="string"?JSON.parse(serverData):serverData;
        setData(parsed);
      }catch{}
    }
  },[storageKey,serverData]);

  const handleFile = async (e) => {
    const file = e.target.files?.[0]; if(!file||!XLSX) return;
    setLoading(true);
    try {
      const ab  = await file.arrayBuffer();
      const wb  = XLSX.read(ab);
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws,{header:1});
      let headerIdx=0;
      for(let i=0;i<raw.length;i++){
        const row=raw[i];
        if(row&&row.some(c=>typeof c==="string"&&(c.toUpperCase().includes("DATE")||c.toUpperCase().includes("CAMPAIGN")))){headerIdx=i;break;}
      }
      const headers=raw[headerIdx].map(h=>String(h||"").trim());
      const rows=raw.slice(headerIdx+1).filter(r=>r&&r[0]).map(r=>{
        const obj={};headers.forEach((h,i)=>{obj[h]=r[i];});return obj;
      });
      const parsed={type,rows,headers,uploadedAt:new Date().toISOString()};
      setData(parsed);
      try{localStorage.setItem(storageKey,JSON.stringify(parsed));}catch{}
      fetch(`${API_URL}?action=save_upload`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({short_token:token,type,data_json:JSON.stringify(parsed)})
      }).catch(e=>console.warn("Erro ao salvar upload",e));
    } catch(err){alert("Erro ao ler arquivo: "+err.message);}
    finally{setLoading(false);}
  };

  const clear=()=>{setData(null);try{localStorage.removeItem(storageKey);}catch{} if(fileRef.current)fileRef.current.value="";};

  if(!data) return (
    <div style={{padding:"40px 0",textAlign:"center"}}>
      <div style={{fontSize:48,marginBottom:16}}>📂</div>
      <h3 style={{fontSize:18,fontWeight:700,marginBottom:8}}>{type}</h3>
      <p style={{color:C.muted,fontSize:14,marginBottom:32,maxWidth:400,margin:"0 auto 32px"}}>
        {readOnly
          ? "Nenhum dado disponível para esta campanha ainda."
          : type==="RMND"
            ?"Faça upload do relatório Amazon Ads (Excel) para visualizar os dados de RMND desta campanha."
            :"Faça upload do relatório PDOOH (Excel) para visualizar os dados desta campanha."}
      </p>
      {!readOnly&&(
        <>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{display:"none"}} id={`upload-${type}-${token}`}/>
          <label htmlFor={`upload-${type}-${token}`} style={{background:!XLSX?C.dark3:C.blue,color:C.white,padding:"14px 32px",borderRadius:10,cursor:!XLSX?"not-allowed":"pointer",fontSize:15,fontWeight:700,display:"inline-block",opacity:!XLSX?0.6:1}}>
            {loading?"Carregando...":!XLSX?"Carregando biblioteca...":"Selecionar Arquivo"}
          </label>
          <p style={{marginTop:16,fontSize:12,color:`${C.muted}80`}}>Formatos aceitos: .xlsx, .xls</p>
        </>
      )}
    </div>
  );
  if(type==="RMND") return <RmndDashboard data={data} onClear={readOnly?null:clear}/>;
  return <PdoohDashboard data={data} onClear={readOnly?null:clear}/>;
};

// ── RMND Dashboard ────────────────────────────────────────────────────────────
const RmndDashboard = ({ data, onClear }) => {
  const rows=data.rows;
  const get=(r,k)=>{for(const key of Object.keys(r)){if(key.includes(k))return Number(r[key])||0;}return 0;};
  const totalImpressions = rows.reduce((s,r)=>s+(Number(r["Impressions"])||0),0);
  const totalClicks      = rows.reduce((s,r)=>s+(Number(r["Clicks"])||0),0);
  const totalSpend       = rows.reduce((s,r)=>s+(Number(r["Spend"])||0),0);
  const totalSales       = rows.reduce((s,r)=>s+get(r,"14 Day Total Sales"),0);
  const totalOrders      = rows.reduce((s,r)=>s+get(r,"14 Day Total Orders"),0);
  const totalUnits       = rows.reduce((s,r)=>s+get(r,"14 Day Total Units"),0);
  const avgTicket        = totalOrders>0?totalSales/totalOrders:0;
  const avgCTR           = totalImpressions>0?(totalClicks/totalImpressions)*100:0;
  const roas             = totalSpend>0?totalSales/totalSpend:0;

  const byDate={};
  rows.forEach(r=>{
    let d=r["Date"]||r["DATE"]||"";
    if(typeof d==="number"){
      // Converte serial do Excel para data
      const excelEpoch=new Date(1899,11,30);
      const dt=new Date(excelEpoch.getTime()+d*86400000);
      d=dt.toISOString().slice(0,10);
    } else {
      d=String(d).slice(0,10);
    }
    if(!d||d==="NaN-Na")return;
    if(!byDate[d])byDate[d]={date:d,spend:0,sales:0,impressions:0};
    byDate[d].spend      +=Number(r["Spend"])||0;
    byDate[d].sales      +=get(r,"14 Day Total Sales");
    byDate[d].impressions+=Number(r["Impressions"])||0;
  });
  const chartData=Object.values(byDate).sort((a,b)=>a.date>b.date?1:-1);

  const fmtTooltip=(value,name)=>{
    if(name==="spend"||name==="sales") return [`R$ ${Number(value).toFixed(2).replace(".",",")}`,name==="spend"?"Spend":"Vendas"];
    return [value,name];
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:11,color:C.muted}}>Atualizado em: {new Date(data.uploadedAt).toLocaleString("pt-BR")}</div>
        <button onClick={onClear} style={{background:C.dark3,color:C.muted,border:"none",padding:"6px 14px",borderRadius:8,cursor:"pointer",fontSize:12}}>🔄 Trocar arquivo</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(100px,1fr))",gap:12,marginBottom:24}}>
        <KpiCard label="Impressões"   value={fmt(totalImpressions)}/>
        <KpiCard label="Cliques"      value={fmt(totalClicks)}/>
        <KpiCard label="CTR"          value={fmtP2(avgCTR)} color={C.blue}/>
        <KpiCard label="ROAS"         value={roas.toFixed(2)+"x"} color={C.blue}/>
        <KpiCard label="Vendas 14d" value={fmtR(totalSales)} color={C.green} fontSize={16}/>        <KpiCard label="Pedidos"      value={fmt(totalOrders)}/>
        <KpiCard label="Unidades"     value={fmt(totalUnits)}/>
        <KpiCard label="Ticket Médio" value={fmtR(avgTicket)}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
          <div style={{fontSize:13,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Spend Diário</div>
          <BarChart data={chartData} xKey="date" yKey="spend" color={C.blue} formatter={fmtTooltip}/>
        </div>
        <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
          <div style={{fontSize:13,fontWeight:700,color:C.green,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Vendas Diárias (14d)</div>
          <BarChart data={chartData} xKey="date" yKey="sales" color={C.green} formatter={fmtTooltip}/>
        </div>
      </div>
    </div>
  );
};

// ── PDOOH Dashboard ───────────────────────────────────────────────────────────
// ── PDOOH Dashboard ───────────────────────────────────────────────────────────
const useleaflet = () => {
  const [lib, setLib] = useState(null);
  useEffect(()=>{
    if (window.L) { setLib(window.L); return; }
    // CSS
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(link);
    // Leaflet JS
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    s.onload = () => {
      // Leaflet Heat plugin
      const s2 = document.createElement("script");
      s2.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet.heat/0.2.0/leaflet-heat.js";
      s2.onload = () => setLib(window.L);
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  },[]);
  return lib;
};

const PdoohMap = ({ points, metric }) => {
  const mapRef = useRef(null);
  const instanceRef = useRef(null);
  const heatRef = useRef(null);
  const L = useleaflet();

    useEffect(()=>{
  if (!L || !mapRef.current) return;
  if (!L.heatLayer) return;
  
  // Destroi instância anterior se existir
  if (instanceRef.current) {
    instanceRef.current.remove();
    instanceRef.current = null;
  }
  
  instanceRef.current = L.map(mapRef.current, { zoomControl: true, scrollWheelZoom: false }).setView([-15.7801, -47.9292], 4);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; CARTO',
    maxZoom: 18
  }).addTo(instanceRef.current);

  if (points.length > 0) {
    const maxVal = Math.max(...points.map(p => p[2]));
    const heatPoints = points.map(p => [p[0], p[1], p[2] / maxVal]);
    heatRef.current = L.heatLayer(heatPoints, {
    radius: 40, blur: 30, maxZoom: 10,
    gradient: { 0.2: "#0000ff", 0.4: "#3397B9", 0.6: "#C5EAF6", 0.8: "#ffffff" }
  }).addTo(instanceRef.current);
  }
}, [L, points]);

  if (!L) return <div style={{height:400,display:"flex",alignItems:"center",justifyContent:"center",color:C.muted,fontSize:13}}>Carregando mapa...</div>;

  return <div ref={mapRef} style={{height:400,borderRadius:8,overflow:"hidden"}}/>;
};

const PdoohDashboard = ({ data, onClear }) => {
  const [mapMetric, setMapMetric] = useState("impressions");
  const rows = data.rows;

  const totalImpressions = rows.reduce((s,r)=>s+(Number(r["IMPRESSIONS"])||0),0);
  const totalPlays       = rows.reduce((s,r)=>s+(Number(r["PLAYS"])||0),0);
  const uniqueCities     = new Set(rows.map(r=>r["CITY"]).filter(Boolean)).size;
  const uniqueOwners     = new Set(rows.map(r=>r["MEDIA_OWNER"]).filter(Boolean)).size;

  const byDate={};
rows.forEach(r=>{
  let d=r["DATE"]||r["Date"]||"";
  d=String(d).trim();
  // Converte número serial do Excel para data
  if(/^\d+$/.test(d)){
    const dt=new Date(Date.UTC(1899,11,30)+Number(d)*86400000);
    d=dt.toISOString().slice(0,10);
  }
  // Converte DD/MM/YYYY para YYYY-MM-DD
  if(/^\d{2}\/\d{2}\/\d{4}$/.test(d)){
    const [dd,mm,yyyy]=d.split("/");
    d=`${yyyy}-${mm}-${dd}`;
  }
  if(!d||d==="NaN-Na")return;
  if(!byDate[d])byDate[d]={date:d,impressions:0,plays:0};
  byDate[d].impressions+=Number(r["IMPRESSIONS"])||0;
  byDate[d].plays+=Number(r["PLAYS"])||0;
});
  const chartData=Object.values(byDate).sort((a,b)=>a.date>b.date?1:-1);
  const hasGeo = rows.some(r=>Number(r["LATITUDE"]||r["LAT"]||0)!==0);
  const byCity={};
  rows.forEach(r=>{
    const c=r["CITY"]||"Outras";
    const lat=Number(r["LATITUDE"]||r["LAT"]||0);
    const lng=Number(r["LONGITUDE"]||r["LNG"]||r["LON"]||r["LONG"]||0);
    if(!byCity[c])byCity[c]={city:c,impressions:0,plays:0,lat,lng};
    byCity[c].impressions+=Number(r["IMPRESSIONS"])||0;
    byCity[c].plays+=Number(r["PLAYS"])||0;
  });
  const cityData=Object.values(byCity).sort((a,b)=>b.impressions-a.impressions).slice(0,10);

  // Pontos para heatmap — só cidades com lat/lng válidos
  const mapPoints = rows
  .filter(r=>{
    const lat=Number(r["LATITUDE"]||r["LAT"]||0);
    const lng=Number(r["LONGITUDE"]||r["LNG"]||r["LON"]||r["LONG"]||0);
    return lat!==0&&lng!==0;
  })
  .map(r=>[
    Number(r["LATITUDE"]||r["LAT"]),
    Number(r["LONGITUDE"]||r["LNG"]||r["LON"]||r["LONG"]),
    mapMetric==="impressions"?Number(r["IMPRESSIONS"]||0):Number(r["PLAYS"]||0)
  ]);
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:11,color:C.muted}}>Atualizado em: {new Date(data.uploadedAt).toLocaleString("pt-BR")}</div>
        <button onClick={onClear} style={{background:C.dark3,color:C.muted,border:"none",padding:"6px 14px",borderRadius:8,cursor:"pointer",fontSize:12}}>🔄 Trocar arquivo</button>
      </div>

      {/* KPI Cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12,marginBottom:24}}>
        <KpiCard label="Impressões"   value={fmt(totalImpressions)}/>
        <KpiCard label="Plays"        value={fmt(totalPlays)} color={C.blue}/>
        <KpiCard label="Cidades"      value={uniqueCities} color={C.yellow}/>
        <KpiCard label="Media Owners" value={uniqueOwners}/>
      </div>

      {/* Gráficos diários */}
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
  <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
    <div style={{fontSize:13,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Impressões Diárias</div>
    <BarChart data={chartData} xKey="date" yKey="impressions" color={C.blue}
      formatter={(v)=>Number(v).toLocaleString("pt-BR")}/>
  </div>
  <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
    <div style={{fontSize:13,fontWeight:700,color:C.yellow,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Plays Diários</div>
    <BarChart data={chartData} xKey="date" yKey="plays" color={C.yellow}
      formatter={(v)=>Number(v).toLocaleString("pt-BR")}/>
  </div>
</div>

{/* Gráficos por Media Owner */}
{(() => {
  const byOwner={};
  rows.forEach(r=>{
    const o=r["MEDIA_OWNER"]||"Outros";
    if(!byOwner[o])byOwner[o]={owner:o,impressions:0,plays:0};
    byOwner[o].impressions+=Number(r["IMPRESSIONS"])||0;
    byOwner[o].plays+=Number(r["PLAYS"])||0;
  });
  const ownerData=Object.values(byOwner).sort((a,b)=>b.impressions-a.impressions);
  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
      <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
        <div style={{fontSize:13,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Impressões por Media Owner</div>
        <BarChart data={ownerData} xKey="owner" yKey="impressions" color={C.blue}
          formatter={(v)=>Number(v).toLocaleString("pt-BR")} rotateX={true} height={200}/>
      </div>
      <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
        <div style={{fontSize:13,fontWeight:700,color:C.yellow,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Plays por Media Owner</div>
        <BarChart data={ownerData} xKey="owner" yKey="plays" color={C.yellow}
          formatter={(v)=>Number(v).toLocaleString("pt-BR")} rotateX={true} height={200}/>
      </div>
    </div>
  );
})()}

      {/* Mapa Heatmap */}
      <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20,marginBottom:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:1}}>Mapa de Calor</div>
          {hasGeo ? (
            <div style={{display:"flex",gap:8}}>
              {["impressions","plays"].map(m=>(
                <button key={m} onClick={()=>setMapMetric(m)} style={{
                  background:mapMetric===m?C.blue:C.dark3,
                  color:mapMetric===m?C.white:C.muted,
                  border:"none",padding:"6px 14px",borderRadius:8,
                  cursor:"pointer",fontSize:12,fontWeight:600,
                  transition:"all 0.2s"
                }}>{m==="impressions"?"Impressões":"Plays"}</button>
              ))}
            </div>
          ) : (
            <span style={{fontSize:11,color:C.muted}}>⚠️ Adicione colunas LATITUDE e LONGITUDE no arquivo para ativar o mapa</span>
          )}
        </div>
        {hasGeo
          ? <PdoohMap points={mapPoints} metric={mapMetric}/>
          : <div style={{height:200,display:"flex",alignItems:"center",justifyContent:"center",color:C.muted,fontSize:13,flexDirection:"column",gap:8}}>
              <span style={{fontSize:32}}>🗺️</span>
              <span>O arquivo não possui colunas de geolocalização</span>
              <span style={{fontSize:11}}>Adicione as colunas LATITUDE e LONGITUDE para visualizar o mapa</span>
            </div>
        }
      </div>

      {/* Top Cidades */}
      <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,padding:20}}>
        <div style={{fontSize:13,fontWeight:700,color:C.muted,marginBottom:16,textTransform:"uppercase",letterSpacing:1}}>Top Cidades</div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>
              <th style={{color:C.muted,fontWeight:600,fontSize:12,textAlign:"left",paddingBottom:8}}>Cidade</th>
              <th style={{color:C.muted,fontWeight:600,fontSize:12,textAlign:"left",paddingBottom:8}}>Impressões</th>
              <th style={{color:C.muted,fontWeight:600,fontSize:12,textAlign:"left",paddingBottom:8}}>Plays</th>
            </tr></thead>
            <tbody>{cityData.map((c,i)=>(
              <tr key={i} style={{borderTop:`1px solid ${C.dark3}`}}>
                <td style={{fontWeight:600,padding:"10px 0"}}>{c.city}</td>
                <td style={{padding:"10px 0"}}>{fmt(c.impressions)}</td>
                <td style={{padding:"10px 0"}}>{fmt(c.plays)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// ── Pacing Bar ────────────────────────────────────────────────────────────────
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
const DualChart = ({ data, xKey, y1Key, y2Key, label1, label2, color1=C.blue, color2=C.blueLight, height=180 }) => {
  if (!data?.length) return null;
  const isDate = data.length > 0 && /^\d{4}-\d{2}/.test(String(data[0][xKey]));
  const fmtBig = (v) => v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : v >= 1000 ? `${(v/1000).toFixed(0)}K` : String(v);
  const fmtPct = (v) => `${Number(v).toFixed(2)}%`;
  return (
    <div>
      <div style={{display:"flex",gap:16,marginBottom:8}}>
        <span style={{fontSize:11,color:color1,fontWeight:600}}>● {label1}</span>
        <span style={{fontSize:11,color:color2,fontWeight:600}}>● {label2}</span>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{top:4,right:64,left:8,bottom:4}}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.dark3} vertical={false}/>
          <XAxis dataKey={xKey} tick={{fill:C.muted,fontSize:10}} tickLine={false} tickFormatter={v=> isDate ? String(v).slice(5) : String(v)} interval="preserveStartEnd"/>
          <YAxis yAxisId="left" tick={{fill:C.muted,fontSize:10}} tickLine={false} axisLine={false} tickFormatter={fmtBig} width={52}/>
          <YAxis yAxisId="right" orientation="right" tick={{fill:C.muted,fontSize:10}} tickLine={false} axisLine={false} tickFormatter={fmtPct} width={56}/>
          <RTooltip
            contentStyle={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:8,fontSize:12}}
            formatter={(v,name) => name===label2 ? [fmtPct(v),name] : [fmtBig(v),name]}
            labelFormatter={l=>`Data: ${l}`}
          />
      <Bar yAxisId="left" dataKey={y1Key} name={label1} fill={color1} radius={[3,3,0,0]} opacity={0.75} isAnimationActive={false} barSize={Math.min(32, Math.max(8, Math.floor(600/data.length)))}/>          <Line yAxisId="right" dataKey={y2Key} name={label2} type="monotone" stroke={color2} strokeWidth={2} dot={{r:3,fill:color2}} activeDot={{r:5}}/>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

// ── Detail Table with CSV download ───────────────────────────────────────────
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
const MultiLineSelect = ({ lines, selected, onChange, theme }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Cores totalmente derivadas do tema — dark ou light
  const isDark = !(theme?.bg === "#F4F6FA");
  const bg2    = theme?.bg2  || C.dark2;
  const bg3    = theme?.bg3  || C.dark3;
  const bdr    = theme?.bdr  || C.dark3;
  const txt    = theme?.text || C.white;
  const muted  = theme?.muted|| C.muted;
  const rowHov = isDark ? `${C.blue}22` : "#EBF6FB";
  const rowSel = isDark ? `${C.blue}28` : "#D6EFF8";
  const shadow = isDark ? "0 8px 32px rgba(0,0,0,0.5)" : "0 8px 32px rgba(51,151,185,0.18)";
  const chkBdr = isDark ? "#4a6070" : "#b0ccd8";

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggle = (line) => {
    if (selected.includes(line)) onChange(selected.filter(l => l !== line));
    else onChange([...selected, line]);
  };

  const label = selected.length === 0
    ? "Todos os Line Items"
    : selected.length === 1
      ? selected[0].split("_").slice(-2).join("_")
      : `${selected.length} lines selecionadas`;

  return (
    <div ref={ref} style={{ position: "relative", flex: 1, maxWidth: 560 }}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          background: bg3, border: `1.5px solid ${open ? C.blue : bdr}`, borderRadius: 8,
          padding: "8px 13px", cursor: "pointer", color: selected.length > 0 ? txt : muted,
          fontSize: 13, fontWeight: selected.length > 0 ? 600 : 400, textAlign: "left",
          transition: "border-color 0.15s", outline: "none",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {label}
        </span>
        {selected.length > 0 && (
          <span style={{
            background: C.blue, color: "#fff", borderRadius: 20,
            padding: "1px 7px", fontSize: 11, fontWeight: 700, marginLeft: 8, flexShrink: 0,
          }}>{selected.length}</span>
        )}
        <span style={{
          marginLeft: 8, fontSize: 11, color: muted, flexShrink: 0,
          display: "inline-block",
          transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s",
        }}>▾</span>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 300,
          background: bg2, border: `1.5px solid ${C.blue}50`, borderRadius: 10,
          boxShadow: shadow, maxHeight: 340, overflowY: "auto",
        }}>
          {/* "Todos" row */}
          <div
            onClick={() => { onChange([]); setOpen(false); }}
            style={{
              padding: "10px 14px", cursor: "pointer",
              borderBottom: `1px solid ${bdr}`,
              display: "flex", alignItems: "center", gap: 10,
              background: selected.length === 0 ? rowSel : "transparent",
            }}
            onMouseEnter={e => e.currentTarget.style.background = rowHov}
            onMouseLeave={e => e.currentTarget.style.background = selected.length === 0 ? rowSel : "transparent"}
          >
            {/* Checkbox */}
            <div style={{
              width: 16, height: 16, borderRadius: 4, flexShrink: 0,
              border: `2px solid ${selected.length === 0 ? C.blue : chkBdr}`,
              background: selected.length === 0 ? C.blue : bg3,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {selected.length === 0 && <span style={{ color: "#fff", fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>}
            </div>
            <span style={{ fontSize: 13, color: txt, fontWeight: 700 }}>Todos os Line Items</span>
          </div>

          {/* Line rows */}
          {lines.map(line => {
            const checked = selected.includes(line);
            // Mostrar apenas os últimos 3 segmentos como label curto, tooltip com nome completo
            const parts = line.split("_");
            const shortLabel = parts.length > 3 ? "…_" + parts.slice(-3).join("_") : line;
            return (
              <div
                key={line}
                onClick={() => toggle(line)}
                title={line}
                style={{
                  padding: "9px 14px", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 10,
                  background: checked ? rowSel : "transparent",
                  borderBottom: `1px solid ${bdr}30`,
                }}
                onMouseEnter={e => e.currentTarget.style.background = rowHov}
                onMouseLeave={e => e.currentTarget.style.background = checked ? rowSel : "transparent"}
              >
                <div style={{
                  width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                  border: `2px solid ${checked ? C.blue : chkBdr}`,
                  background: checked ? C.blue : bg3,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all 0.12s",
                }}>
                  {checked && <span style={{ color: "#fff", fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                </div>
                <span style={{
                  fontSize: 12, color: checked ? txt : muted,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  fontWeight: checked ? 600 : 400,
                }}>
                  {shortLabel}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};


// ══════════════════════════════════════════════════════════════════════════════
// CLIENT DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
// ── SurveyChart ──────────────────────────────────────────────────────────────
const SurveyTab=({surveyJson,token,isAdmin,theme})=>{
  const [questions,setQuestions]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);

  const parseCSVText=(text)=>{
    const lines=text.trim().split("\n").map(l=>l.trim()).filter(l=>l);
    // Coluna A = respostas (ignora demais colunas)
    return lines.slice(1).map(line=>line.split(",")[0].replace(/"/g,"").trim()).filter(Boolean);
  };
  const countValues=(vals)=>vals.reduce((acc,v)=>{acc[v]=(acc[v]||0)+1;return acc;},{});

  useEffect(()=>{
    let cancelled=false;
    const load=async()=>{
      setLoading(true);setError(null);
      try{
        const parsed=JSON.parse(surveyJson);
        // Novo modelo: array de {nome, ctrlUrl, expUrl}
        if(Array.isArray(parsed)&&parsed[0]?.ctrlUrl){
          const results=await Promise.all(parsed.map(async(q)=>{
            const [ctrlRes,expRes]=await Promise.all([
              fetch(q.ctrlUrl).then(r=>r.text()),
              fetch(q.expUrl).then(r=>r.text()),
            ]);
            const ctrlVals=parseCSVText(ctrlRes);
            const expVals=parseCSVText(expRes);
            const ctrl=countValues(ctrlVals);
            const exp=countValues(expVals);
            return{nome:q.nome,control_total:ctrlVals.length,exposed_total:expVals.length,ctrl,exp};
          }));
          if(!cancelled)setQuestions(results);
        } else {
          // Modelo antigo (CSV já processado): retrocompatível
          const surveys=Array.isArray(parsed)?parsed:[parsed];
          const results=surveys.map(s=>({
            nome:s.nome||"Survey",
            control_total:s.control_total,
            exposed_total:s.exposed_total,
            legacy:true,
            questions:s.questions,
          }));
          if(!cancelled)setQuestions(results);
        }
      }catch(e){if(!cancelled)setError("Erro ao carregar dados do survey.");}
      finally{if(!cancelled)setLoading(false);}
    };
    load();
    return()=>{cancelled=true;};
  },[surveyJson]);

  const bgCard=theme?.bg2||C.dark2;
  const bgInner=theme?.bg||C.dark;
  const bdr=theme?.bdr||C.dark3;
  const txt=theme?.text||C.white;
  const mt=theme?.muted||C.muted;

  const renderQuestion=(nome,ctrl,exp,ctrlTotal,expTotal,qIdx,isLegacy,legacyQ)=>{
    const allKeys=isLegacy
      ?[...new Set([...Object.keys(legacyQ.control),...Object.keys(legacyQ.exposed)])]
      :[...new Set([...Object.keys(ctrl),...Object.keys(exp)])];
    const ctrlMap=isLegacy?legacyQ.control:ctrl;
    const expMap=isLegacy?legacyQ.exposed:exp;
    const ctrlTot=isLegacy?Object.values(ctrlMap).reduce((a,b)=>a+b,0):ctrlTotal;
    const expTot=isLegacy?Object.values(expMap).reduce((a,b)=>a+b,0):expTotal;
    const ctrlPct=allKeys.map(k=>Math.round((ctrlMap[k]||0)/ctrlTot*100));
    const expPct=allKeys.map(k=>Math.round((expMap[k]||0)/expTot*100));
    const lifts=allKeys.map((k,i)=>{
      const abs=Math.round((expPct[i]-ctrlPct[i])*10)/10;
      const rel=ctrlPct[i]>0?Math.round((abs/ctrlPct[i])*1000)/10:0;
      return{key:k,abs,rel};
    });
    return(
      <div style={{border:`1px solid ${bdr}`,borderRadius:12,padding:20,marginBottom:16,background:bgCard}}>
        <div style={{fontSize:12,color:mt,marginBottom:2}}>{isLegacy?`Pergunta ${qIdx+1}`:nome}</div>
        {isLegacy&&<div style={{fontSize:15,fontWeight:600,color:txt,marginBottom:16}}>{legacyQ.label}</div>}

        <div style={{display:"flex",gap:24,flexWrap:"wrap",alignItems:"flex-start"}}>
          <div style={{flex:2,minWidth:260}}>
            <SurveyChart id={`sc-${qIdx}`} labels={allKeys} ctrl={ctrlPct} exp={expPct}/>
          </div>
          <div style={{flex:1,minWidth:160,display:"flex",flexDirection:"column",gap:10}}>
            {lifts.map((l,j)=>{
              const color=l.abs>=0?"#2ECC71":"#E74C3C";
              return(
                <div key={j} style={{border:`1px solid ${bdr}`,borderRadius:8,padding:12}}>
                  <div style={{fontSize:12,color:mt,marginBottom:6,fontWeight:600}}>{l.key}</div>
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
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  if(loading)return<div style={{textAlign:"center",padding:60}}><Spinner size={36} color={C.blue}/><p style={{color:mt,marginTop:16,fontSize:14}}>Carregando dados do survey...</p></div>;
  if(error)return<div style={{color:"#E74C3C",textAlign:"center",padding:40}}>{error}</div>;
  if(!questions)return null;

  return(
    <div>
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
            <div style={{fontSize:13,fontWeight:700,color:C.blue,textTransform:"uppercase",letterSpacing:1.5,marginBottom:12,paddingBottom:8,borderBottom:`1px solid ${bdr}`}}>
              {q.nome||`Pergunta ${i+1}`}
            </div>
          )}
          {q.legacy
            ?q.questions.map((lq,j)=>renderQuestion(lq.label,null,null,q.control_total,q.exposed_total,j,true,lq))
            :renderQuestion(q.nome,q.ctrl,q.exp,q.control_total,q.exposed_total,i,false,null)
          }
        </div>
      ))}
      <TabChat token={token} tabName="SURVEY" author={isAdmin?"HYPR":"Cliente"} theme={theme}/>
    </div>
  );
};

const SurveyChart=({id,labels,ctrl,exp})=>{
  const ref=useRef(null);
  useEffect(()=>{
    if(!ref.current)return;
    const existing=ref.current._chartInstance;
    if(existing)existing.destroy();
    const chart=new window.Chart(ref.current,{
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
  },[labels,ctrl,exp]);
  return <div style={{position:"relative",height:460}}><canvas ref={ref} id={id}/></div>;
};
// ── TabChat ──────────────────────────────────────────────────────────────────
const TabChat = ({ token, tabName, author, theme }) => {
  const [messages, setMessages] = useState([]);
  const [newMsg, setNewMsg] = useState("");
  const [sending, setSending] = useState(false);
  const containerRef = useRef(null);
  const shouldScroll = useRef(false);

  const loadMessages = () => {
    fetch(`${API_URL}?action=get_comments&token=${token}`)
      .then(r=>r.json())
      .then(d=>{
        const filtered=(d.comments||[]).filter(c=>c.metric_name===tabName);
        setMessages(filtered);
      }).catch(()=>{});
  };

  useEffect(()=>{
    loadMessages();
    const interval = setInterval(loadMessages, 30000);
    return () => clearInterval(interval);
  },[token, tabName]);

  useEffect(()=>{
    if(shouldScroll.current && containerRef.current){
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      shouldScroll.current = false;
    }
  },[messages]);

  const sendMessage = async() => {
    if(!newMsg.trim()) return;
    setSending(true);
    try{
      await fetch(`${API_URL}?action=save_comment`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({short_token:token, metric_name:tabName, author, comment:newMsg.trim()})
      });
      setMessages(prev=>[...prev,{metric_name:tabName, author, comment:newMsg.trim(), created_at:new Date().toISOString()}]);
      shouldScroll.current = true;
      setNewMsg("");
    }catch(e){}
    finally{setSending(false);}
  };

  const tc_bg  = theme?.bg  || C.dark;
  const tc_bg2 = theme?.bg2 || C.dark2;
  const tc_bg3 = theme?.bg3 || C.dark3;
  const tc_bdr = theme?.bdr || C.dark3;
  const tc_txt = theme?.text|| C.white;
  const tc_mut = theme?.muted||C.muted;
  return(
    <div style={{marginTop:32,border:`1px solid ${tc_bdr}`,borderRadius:12,overflow:"hidden"}}>
      <div style={{background:tc_bg2,padding:"12px 16px",borderBottom:`1px solid ${tc_bdr}`,display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:14}}>💬</span>
        <span style={{fontSize:13,fontWeight:600,color:tc_txt}}>Conversa</span>
        {messages.length>0&&<span style={{fontSize:11,color:tc_mut}}>· {messages.length} mensagem{messages.length>1?"s":""}</span>}
      </div>
      <div ref={containerRef} style={{background:tc_bg,padding:16,maxHeight:300,overflowY:"auto",display:"flex",flexDirection:"column",gap:10}}>
        {messages.length===0&&(
          <div style={{textAlign:"center",color:tc_mut,fontSize:13,padding:"20px 0"}}>Nenhuma mensagem ainda. Seja o primeiro a comentar!</div>
        )}
        {messages.map((m,i)=>{
          const isHypr = m.author==="HYPR";
          return(
            <div key={i} style={{display:"flex",flexDirection:"column",alignItems:isHypr?"flex-end":"flex-start"}}>
              <div style={{fontSize:10,color:tc_mut,marginBottom:3,fontWeight:600,letterSpacing:0.5}}>
                {isHypr?"HYPR":"Cliente"}
              </div>
              <div style={{
                background:isHypr?C.blue:"#FFFFFF",
                border:`1px solid ${isHypr?C.blue:"#DDDDDD"}`,
                borderRadius:isHypr?"12px 12px 2px 12px":"12px 12px 12px 2px",
                padding:"8px 12px",
                maxWidth:"75%",
              }}>
                <div style={{fontSize:13,color:isHypr?C.white:"#1C262F"}}>{m.comment}</div>
              </div>
              <div style={{fontSize:10,color:tc_mut,marginTop:3}}>{m.created_at?.slice(0,16).replace("T"," ")}</div>
            </div>
          );
        })}
        <div/>
      </div>
      <div style={{background:tc_bg2,padding:"10px 12px",borderTop:`1px solid ${tc_bdr}`,display:"flex",gap:8}}>
        <input value={newMsg} onChange={e=>setNewMsg(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&sendMessage()}
          placeholder="Digite uma mensagem..."
          style={{flex:1,background:tc_bg3,border:`1px solid ${tc_bdr}`,borderRadius:8,padding:"8px 12px",color:tc_txt,fontSize:13,outline:"none"}}/>
        <button onClick={sendMessage} disabled={sending||!newMsg.trim()}
          style={{background:C.blue,color:C.white,border:"none",borderRadius:8,padding:"8px 16px",cursor:"pointer",fontSize:13,fontWeight:600,opacity:!newMsg.trim()?0.5:1}}>
          {sending?"...":"↑"}
        </button>
      </div>
    </div>
  );
};
const enrichDetailCosts = (detailRows, totalsRows) => {
  const totalsMap = {};
  totalsRows.forEach(t => {
    const key = `${t.media_type}|${t.tactic_type}`;
    totalsMap[key] = t;
  });
  const groupSums = {};
  detailRows.forEach(r => {
    const key = `${r.media_type}|${r.tactic_type}`;
    if (!groupSums[key]) groupSums[key] = { vi: 0, v100: 0 };
    groupSums[key].vi  += r.viewable_impressions || 0;
    groupSums[key].v100 += r.video_view_100 || 0;
  });
  return detailRows.map(r => {
    const key = `${r.media_type}|${r.tactic_type}`;
    const tot = totalsMap[key];
    const grp = groupSums[key];
    if (!tot || !grp) return { ...r, effective_total_cost: 0, effective_cost_with_over: 0 };
    const isVideo = r.media_type === "VIDEO";
    const delivered = isVideo ? (r.video_view_100 || 0) : (r.viewable_impressions || 0);
    const totalDelivered = isVideo ? grp.v100 : grp.vi;
    const proportion = totalDelivered > 0 ? delivered / totalDelivered : 0;
    return {
      ...r,
      effective_total_cost:      Math.round(proportion * (tot.effective_total_cost || 0) * 100) / 100,
      effective_cost_with_over:  Math.round(proportion * (tot.effective_cost_with_over || 0) * 100) / 100,
      deal_cpm_amount:           tot.deal_cpm_amount || 0,
      deal_cpcv_amount:          tot.deal_cpcv_amount || 0,
      effective_cpm_amount:      tot.effective_cpm_amount || 0,
      effective_cpcv_amount:     tot.effective_cpcv_amount || 0,
    };
  });
};
const ClientDashboard = ({ token, isAdmin }) => {
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);
  const [mainTab,setMainTab]=useState("Visão Geral");
  const [dispTab,setDispTab]=useState("O2O");
  const [vidTab,setVidTab]=useState("O2O");
  const [dispLines,setDispLines]=useState([]);  // [] = todos
  const [vidLines,setVidLines]=useState([]);    // [] = todos
  // Alcance & Frequência — campos manuais preenchidos pelo admin
  const [alcance,setAlcance]=useState("");
  const [frequencia,setFrequencia]=useState("");
  const [editingAfReach,setEditingAfReach]=useState(false);
  const [savingAf,setSavingAf]=useState(false);
  const [isDarkClient,setIsDarkClient]=useState(true);
  const cbg   = isDarkClient ? C.dark  : "#F4F6FA";
  const cbg2  = isDarkClient ? C.dark2 : "#FFFFFF";
  const cbg3  = isDarkClient ? C.dark3 : "#EEF1F7";
  const cbdr  = isDarkClient ? C.dark3 : "#DDE2EC";
  const ctext = isDarkClient ? C.white : "#1C262F";
  const cmuted= isDarkClient ? C.muted : "#6B7A8D";
  const cTheme = { bg:cbg, bg2:cbg2, bg3:cbg3, bdr:cbdr, text:ctext, muted:cmuted };
  // Salvar alcance & frequência
  const saveAf = async () => {
    setSavingAf(true);
    try {
      await fetch(`${API_URL}?action=save_af`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ short_token: token, alcance: alcance.trim(), frequencia: frequencia.trim() }),
      });
      setEditingAfReach(false);
    } catch(e) { alert("Erro ao salvar: " + e.message); }
    finally { setSavingAf(false); }
  };

  const cardStyle = { background:cbg2, border:`1px solid ${cbdr}`, borderRadius:12, padding:20 };

  useEffect(()=>{
    fetch(`${API_URL}?token=${token}`)
      .then(r=>{
        if(!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d=>{
        if(!d.campaign) throw new Error("Campanha não encontrada");
        setData(d);setLoading(false);
        if(d.alcance!=null)   setAlcance(String(d.alcance));
        if(d.frequencia!=null) setFrequencia(String(d.frequencia));
        gaPageView(`/report/${token}`, token);
      })
      .catch(e=>{setError("Erro ao carregar dados: "+e.message);setLoading(false);});
  },[token]);

  if(loading) return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:C.dark}}><GlobalStyle/><div style={{textAlign:"center"}}><Spinner size={48}/><p style={{marginTop:20,color:C.muted,fontSize:14}}>Carregando dados...</p></div></div>;
  if(error||!data) return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:C.dark}}><GlobalStyle/><p style={{color:C.red}}>{error||"Campanha não encontrada."}</p></div>;

  const camp   = data.campaign;
  const noSurvey = r => !/survey/i.test(r.line_name||"");
  const totals = (data.totals||[]).filter(noSurvey);
  const daily0  = (data.daily||[]).filter(noSurvey);
  const detail0 = (data.detail||[]).filter(noSurvey);
  const daily  = daily0;
  const detail = enrichDetailCosts(detail0, totals);
  const chartDisplay = daily.filter(r=>r.media_type==="DISPLAY").map(r=>({...r,ctr:r.viewable_impressions>0?(r.clicks||0)/r.viewable_impressions*100:0}));
  const chartVideo   = daily.filter(r=>r.media_type==="VIDEO").map(r=>{
    const v100 = r.video_view_100||r.completions||r.viewable_video_view_100_complete||0;
    const vi   = r.viewable_impressions||0;
    return {...r, video_view_100: v100, completions: v100, vtr: vi>0 ? v100/vi*100 : 0};
  });

  const enrich = (rows) => rows.map(r=>({
    ...r,
    ctr: r.impressions>0?(r.clicks/r.impressions)*100:null,
    vcr: r.impressions>0?((r.viewable_video_view_100_complete||0)/r.impressions)*100:null,
    // Usar pacing do backend diretamente — já calculado com datas reais por frente
    pacing: r.pacing ?? null,
    rentabilidade: r.deal_cpm_amount>0?((r.deal_cpm_amount-(r.effective_cpm_amount||0))/r.deal_cpm_amount)*100
      :r.deal_cpcv_amount>0?((r.deal_cpcv_amount-(r.effective_cpcv_amount||0))/r.deal_cpcv_amount)*100:null,
    custo_efetivo: r.effective_total_cost,
    custo_efetivo_over: r.effective_cost_with_over,
    completions: r.viewable_video_view_100_complete ?? r.completions,
  }));

  const display = enrich(totals.filter(t=>t.media_type==="DISPLAY"));
  const video   = enrich(totals.filter(t=>t.media_type==="VIDEO"));

  const dailyByDate={};
  daily.forEach(r=>{
    if(!dailyByDate[r.date])dailyByDate[r.date]={date:r.date,impressions:0,custo:0,viewable_impressions:0,completions:0,clicks:0,video_view_100:0};
    dailyByDate[r.date].impressions+=Number(r.viewable_impressions)||0;
    dailyByDate[r.date].viewable_impressions+=Number(r.viewable_impressions)||0;
    dailyByDate[r.date].custo+=Number(r.effective_total_cost)||0;
    dailyByDate[r.date].completions+=Number(r.completions||r.video_view_100||0);
    dailyByDate[r.date].clicks+=Number(r.clicks)||0;
    dailyByDate[r.date].video_view_100+=Number(r.video_view_100||0);
  });
  const chartDailyRaw=Object.values(dailyByDate).sort((a,b)=>a.date>b.date?1:-1);
  const chartDaily=chartDailyRaw.map(r=>({...r,ctr:r.viewable_impressions>0?r.clicks/r.viewable_impressions*100:0,vtr:r.viewable_impressions>0?r.video_view_100/r.viewable_impressions*100:0}));

  const totalImpressions=totals.reduce((s,t)=>s+(t.viewable_impressions||0),0);
  const totalCusto=totals.reduce((s,t)=>s+(t.effective_total_cost||0),0);
  const totalCustoOver=totals.reduce((s,t)=>s+(t.effective_cost_with_over||0),0);
  const mainTabs=["Visão Geral","Display","Video","RMND","PDOOH", "VIDEO LOOM","SURVEY"];
  const tacticTabs=["O2O","OOH"];

  return (
    <div style={{minHeight:"100vh",width:"100%",background:cbg,transition:"background 0.3s"}}>
      <GlobalStyle/>
      {!isDarkClient && <style>{`body{background:${cbg}!important;color:${ctext}!important;}`}</style>}
      <div style={{background:cbg2,borderBottom:`1px solid ${cbdr}`,padding:"0 32px",height:64,display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",transition:"background 0.3s"}}>
        <HyprLogo height={26} isDark={isDarkClient}/>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <button
            onClick={()=>setIsDarkClient(v=>!v)}
            title={isDarkClient?"Modo claro":"Modo escuro"}
            style={{width:36,height:36,borderRadius:9,border:`1px solid ${cbdr}`,background:cbg3,color:ctext,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.2s"}}
          >{isDarkClient?"☀️":"🌙"}</button>
          <div style={{fontSize:12,color:cmuted}}>Atualizado em {camp.updated_at?.slice(0,16).replace("T"," ")}</div>
        </div>
      </div>
      <div style={{width:"100%",maxWidth:1400,margin:"0 auto",padding:"40px 24px",background:cbg,transition:"background 0.3s"}} className="fade-in">
        <div style={{marginBottom:28,display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
      <div>
        <div style={{fontSize:12,color:C.blue,textTransform:"uppercase",letterSpacing:2,marginBottom:6}}>{camp.client_name}</div>
        <h1 style={{fontSize:26,fontWeight:900,color:ctext}}>{camp.campaign_name}</h1>
        <p style={{color:cmuted,fontSize:14,marginTop:6}}>{camp.start_date} → {camp.end_date} · <span style={{color:C.blue}}>Token: {camp.short_token}</span></p>
      </div>
        {data.logo&&(
    <img src={data.logo} alt="logo" style={{height:60,objectFit:"contain",maxWidth:220,marginTop:4,filter:isDarkClient?"none":"invert(1)"}}/>
  )}
</div>

        <Tabs tabs={mainTabs} active={mainTab} onChange={(tab)=>{ setMainTab(tab); gaEvent("tab_click", { tab_name: tab, report_token: token }); }} theme={cTheme}/>

        {mainTab==="Visão Geral"&&(
          <div style={{display:"flex",flexDirection:"column",gap:16}}>

            {/* KPI Cards */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:8}}>
              <KpiCard label="Budget Total"        value={fmtR(camp.budget_contracted)} theme={cTheme}/>
              {display.length>0&&<KpiCard label="CPM Neg." value={fmtR(camp.cpm_negociado)} theme={cTheme}/>}
              {video.length>0&&<KpiCard label="CPCV Neg." value={fmtR(camp.cpcv_negociado)} theme={cTheme}/>}
              <KpiCard label="Imp. Visíveis" value={fmt(totalImpressions)} theme={cTheme}/>
              {video.length>0&&<KpiCard label="Views 100%" value={fmt(totals.reduce((s,t)=>s+(t.completions||0),0))} theme={cTheme}/>}
              <KpiCard label="Custo Efetivo" value={fmtR(totalCusto)} color={C.blue} theme={cTheme}/>
              <KpiCard label="Custo Ef. + Over" value={fmtR(totalCustoOver)} color={C.blue} theme={cTheme}/>
            </div>

            {/* Pacing Display */}
{display.length>0&&(
  <PacingBar
    theme={cTheme}
    label="Pacing Display"
    pacing={(()=>{
      const contracted=display.reduce((s,r)=>s+(r.contracted_o2o_display_impressions||0)+(r.contracted_ooh_display_impressions||0),0);
      const bonus=display.reduce((s,r)=>s+(r.bonus_o2o_display_impressions||0)+(r.bonus_ooh_display_impressions||0),0);
      const totalNeg=contracted+bonus;
      const delivered=display.reduce((s,r)=>s+(r.viewable_impressions||0),0);
      if(!camp.start_date||!camp.end_date||!totalNeg)return 0;
      const [sy,sm,sd]=camp.start_date.split("-").map(Number);
      const [ey,em,ed]=camp.end_date.split("-").map(Number);
      const start=new Date(sy,sm-1,sd),end=new Date(ey,em-1,ed),now=new Date();
      if(now>end)return delivered/totalNeg*100;
      const total=(end-start)/864e5+1,elapsed=now<start?0:now>end?total:Math.floor((now-start)/864e5);
      const expected=totalNeg*(elapsed/total);
      return expected>0?(delivered/expected*100):0;
    })()}
    budget={display.reduce((s,r)=>s+(r.o2o_display_budget||0)+(r.ooh_display_budget||0),0)}
    cost={display.reduce((s,r)=>s+(r.effective_total_cost||0),0)}
  />
)}
{video.length>0&&(
  <PacingBar
    theme={cTheme}
    label="Pacing Video"
    pacing={video[0]?.pacing||0}
    budget={video.reduce((s,r)=>s+(r.o2o_video_budget||0)+(r.ooh_video_budget||0),0)}
    cost={video.reduce((s,r)=>s+(r.effective_total_cost||0),0)}
  />
)}

            {/* Display + Video summaries */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:12}}>
              <MediaSummary rows={totals} type="DISPLAY" theme={cTheme} detail0={detail0} camp={camp}/>
              <MediaSummary rows={totals} type="VIDEO" theme={cTheme} detail0={detail0} camp={camp}/>
            </div>

            {/* Display chart: Imp. Visíveis x CTR */}
            {chartDisplay.length>0&&(
              <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
                <div style={{fontSize:12,fontWeight:600,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Display — Imp. Visíveis × CTR Diário</div>
                <DualChart data={chartDisplay} xKey="date" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
              </div>
            )}

            {/* Video chart: Views 100% x VTR */}
            {chartVideo.length>0&&(
              <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
                <div style={{fontSize:12,fontWeight:600,color:C.darkMuted,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Video — Views 100% × VTR Diário</div>
                <DualChart data={chartVideo} xKey="date" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
              </div>
            )}

            {/* Detail table */}
            <CollapsibleTable title="Tabela Consolidada" theme={cTheme}>
              <DetailTable detail={detail} campaignName={camp.campaign_name}/>
            </CollapsibleTable>


            {/* ── Alcance & Frequência ── */}
            <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
                <div style={{fontSize:12,fontWeight:700,color:C.blue,textTransform:"uppercase",letterSpacing:1}}>Alcance & Frequência</div>
                {isAdmin&&!editingAfReach&&(
                  <button onClick={()=>setEditingAfReach(true)} style={{background:"none",border:`1px solid ${cbdr}`,color:cmuted,borderRadius:7,padding:"5px 12px",cursor:"pointer",fontSize:12,fontWeight:600}}>✏️ Editar</button>
                )}
                {isAdmin&&editingAfReach&&(
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>setEditingAfReach(false)} style={{background:"none",border:`1px solid ${cbdr}`,color:cmuted,borderRadius:7,padding:"5px 12px",cursor:"pointer",fontSize:12}}>Cancelar</button>
                    <button onClick={saveAf} disabled={savingAf} style={{background:C.blue,color:"#fff",border:"none",borderRadius:7,padding:"5px 14px",cursor:"pointer",fontSize:12,fontWeight:700,opacity:savingAf?0.6:1}}>{savingAf?"Salvando...":"✓ Salvar"}</button>
                  </div>
                )}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12}}>
                {/* Alcance */}
                <div style={{background:cbg3,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Alcance</div>
                  {isAdmin&&editingAfReach
                    ? <input value={alcance} onChange={e=>setAlcance(e.target.value)} placeholder="Ex: 1.250.000" style={{width:"100%",background:cbg2,border:`1px solid ${C.blue}60`,borderRadius:7,padding:"8px 12px",color:ctext,fontSize:16,fontWeight:800,outline:"none"}}/>
                    : <div style={{fontSize:22,fontWeight:800,color:ctext}}>{alcance||"—"}</div>
                  }
                </div>
                {/* Frequência */}
                <div style={{background:cbg3,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Frequência</div>
                  {isAdmin&&editingAfReach
                    ? <input value={frequencia} onChange={e=>setFrequencia(e.target.value)} placeholder="Ex: 3.2x" style={{width:"100%",background:cbg2,border:`1px solid ${C.blue}60`,borderRadius:7,padding:"8px 12px",color:ctext,fontSize:16,fontWeight:800,outline:"none"}}/>
                    : <div style={{fontSize:22,fontWeight:800,color:ctext}}>{frequencia||"—"}</div>
                  }
                </div>
              </div>
              {!isAdmin&&!alcance&&!frequencia&&(
                <p style={{fontSize:12,color:cmuted,marginTop:12,opacity:0.7}}>Dados de alcance e frequência serão disponibilizados em breve.</p>
              )}
            </div>

            <TabChat token={token} tabName="Visão Geral" author={isAdmin?"HYPR":"Cliente"} theme={cTheme}/>

          </div>
        )}

         {mainTab==="Display"&&(<div>
    <Tabs tabs={tacticTabs} active={dispTab} onChange={(t)=>{setDispTab(t);setDispLines([]);}} small theme={cTheme}/>
    {(()=>{
      const rows = totals.filter(r=>r.media_type==="DISPLAY" && r.tactic_type===dispTab);
      const detailAll = detail0.filter(r=>r.media_type==="DISPLAY" && r.line_name?.toLowerCase().includes(dispTab.toLowerCase()));
      const dailyAll  = daily0.filter(r=>r.media_type==="DISPLAY" && r.line_name?.toLowerCase().includes(dispTab.toLowerCase()));
      // Lines disponíveis para o dropdown
      const lineNames=["ALL",...[...new Set(detailAll.map(r=>r.line_name).filter(Boolean))].sort()];
      // detail/daily filtrados pela line — para impressões, cliques, gráficos, tabela
      const detail = dispLines.length===0 ? detailAll : detailAll.filter(r=>dispLines.includes(r.line_name));
      const daily = (()=>{
          const m={};
          detail.forEach(r=>{
            if(!r.date)return;
            if(!m[r.date])m[r.date]={date:r.date,viewable_impressions:0,clicks:0};
            m[r.date].viewable_impressions+=Number(r.viewable_impressions)||0;
            m[r.date].clicks+=Number(r.clicks)||0;
          });
          return Object.values(m).sort((a,b)=>a.date>b.date?1:-1).map(r=>({...r,ctr:r.viewable_impressions>0?r.clicks/r.viewable_impressions*100:0}));
        })();
      // Gráfico por audiência — sempre do total
      const getAudience = (ln) => { const p=(ln||"").split("_"); return p.length>=2?p[p.length-2]:"N/A"; };
      const byAudience=Object.values(detailAll.reduce((acc,r)=>{
        const k=getAudience(r.line_name);
        if(/survey/i.test(k)||k==="N/A")return acc;
        if(!acc[k])acc[k]={audience:k,viewable_impressions:0,clicks:0};
        acc[k].viewable_impressions+=r.viewable_impressions||0;
        acc[k].clicks+=r.clicks||0;
        return acc;
      },{})).map(r=>({...r,ctr:r.viewable_impressions>0?r.clicks/r.viewable_impressions*100:0}));
      // KPIs filtrados
      const sumD = k => detail.reduce((s,r)=>s+(r[k]||0),0);
      const cost=rows.reduce((s,r)=>s+(r.effective_total_cost||0),0);
      const impr=sumD("impressions"), vi=sumD("viewable_impressions"), clks=sumD("clicks");
      const ctr=vi>0?clks/vi*100:0;
      // Métricas contratuais — sempre do TOTAL
      const sumDAll = k => detailAll.reduce((s,r)=>s+(r[k]||0),0);
      const viAll=sumDAll("viewable_impressions");
      const budget=rows.reduce((s,r)=>s+(dispTab==="O2O"?(r.o2o_display_budget||0):(r.ooh_display_budget||0)),0);
      const cpmNeg=rows[0]?.deal_cpm_amount||0;
      const [sy2,sm2,sd2]=camp.start_date.split("-").map(Number);
      const [ey2,em2,ed2]=camp.end_date.split("-").map(Number);
      const start2=new Date(sy2,sm2-1,sd2),end2=new Date(ey2,em2-1,ed2),today2=new Date();
      const contracted2=dispTab==="O2O"?(rows[0]?.contracted_o2o_display_impressions||0):(rows[0]?.contracted_ooh_display_impressions||0);
      const bonus2=dispTab==="O2O"?(rows[0]?.bonus_o2o_display_impressions||0):(rows[0]?.bonus_ooh_display_impressions||0);
      const totalNeg2=contracted2+bonus2;
      const tDays=(end2-start2)/864e5+1, eDays=today2<start2?0:today2>end2?tDays:Math.floor((today2-start2)/864e5);
      const budgetPropDisp=today2>end2?budget:budget/tDays*eDays;
      // CPM Efetivo, Rentabilidade e Pacing sempre sobre total (não filtrado por audiência)
      const cpmEf=cpmNeg>0?Math.min(viAll>0?budgetPropDisp/viAll*1000:0,cpmNeg):0;
      const cpc=clks>0?cpmEf/1000*(viAll/clks):0;
      const rentab=cpmNeg>0?(cpmNeg-cpmEf)/cpmNeg*100:0;
      const deliveredAll=sumDAll("viewable_impressions");
      const expected2=totalNeg2*(eDays/tDays);
      const pac=totalNeg2>0?(today2>end2?deliveredAll/totalNeg2*100:expected2>0?deliveredAll/expected2*100:0):0;
      const pacBase=Math.min(pac,100), pacOver=Math.max(0,pac-100);
      const bySize=Object.values(detail.reduce((acc,r)=>{
        const k=r.creative_size||"N/A";
        if(!acc[k])acc[k]={size:k,viewable_impressions:0,clicks:0};
        acc[k].viewable_impressions+=r.viewable_impressions||0;
        acc[k].clicks+=r.clicks||0;
        return acc;
      },{})).map(r=>({...r,ctr:r.viewable_impressions>0?r.clicks/r.viewable_impressions*100:0}));
      return (
        <div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20,padding:"10px 16px",background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10}}>
              <span style={{fontSize:12,color:cmuted,fontWeight:600,textTransform:"uppercase",letterSpacing:1,flexShrink:0}}>Line Item:</span>
              <MultiLineSelect lines={lineNames} selected={dispLines} onChange={setDispLines} theme={cTheme}/>
              {dispLines.length>0&&<button onClick={()=>setDispLines([])} style={{background:"none",border:`1px solid ${cbdr}`,color:cmuted,borderRadius:7,padding:"5px 12px",cursor:"pointer",fontSize:12,flexShrink:0}}>✕ Limpar</button>}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20}}>
            {[
              {l:"Budget Contratado",v:fmtR(budget)},
              {l:"Imp. Contratadas",v:fmt(dispTab==="O2O"?(rows[0]?.contracted_o2o_display_impressions||0):(rows[0]?.contracted_ooh_display_impressions||0))},
              {l:"Imp. Bonus",v:fmt(dispTab==="O2O"?(rows[0]?.bonus_o2o_display_impressions||0):(rows[0]?.bonus_ooh_display_impressions||0))},
              {l:"CPM Negociado",v:fmtR(cpmNeg)},
            ].map(({l,v})=>(
              <div key={l} style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>{l}</div>
                <div style={{fontSize:18,fontWeight:800,marginTop:4,color:ctext}}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20}}>
            {[
              {l:"Impressões",        v:fmt(impr)},
              {l:"Imp. Visíveis",     v:fmt(vi)},
              {l:"CPM Efetivo",       v:fmtR(cpmEf), blue:true},
              {l:"Rentabilidade",     v:fmtP(rentab), color:rentab>0?C.blue:rentab<0?C.red:C.white},
              {l:"Cliques",           v:fmt(clks)},
              {l:"CTR",               v:fmtP2(ctr)},
              {l:"CPC",               v:fmtR(cpc)},
            ].map(({l,v,blue,color})=>(
              <div key={l} style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>{l}</div>
                <div style={{fontSize:18,fontWeight:800,marginTop:4,color:color||(blue?C.blue:ctext)}}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:"16px 20px",marginBottom:20}}>
            {(()=>{const barC=pac>=100?"#2ECC71":pac>=70?"#F1C40F":"#E74C3C";const overC=isDarkClient?"#C5EAF6":"#246C84";return(<>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontSize:12,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>Pacing {dispTab}</span>
              <span style={{fontSize:13,fontWeight:700,color:pac>100?overC:barC}}>{fmt(pac,1)}%{pac>100&&` ⚡ Over de ${fmt(pac-100,1)}%`}</span>
            </div>
            <div style={{height:8,background:isDarkClient?C.dark3:"#E2E8F0",borderRadius:4,overflow:"hidden"}}>
              <div style={{display:"flex",height:"100%"}}>
                <div style={{width:`${pacBase}%`,background:barC,borderRadius:4,transition:"width 0.8s"}}/>
                {pacOver>0&&<div style={{width:`${Math.min(pacOver,20)}%`,background:overC,borderRadius:4}}/>}
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
              <span style={{fontSize:11,color:cmuted}}>Investido: {fmtR(cost)}</span>
              <span style={{fontSize:11,color:cmuted}}>Budget: {fmtR(budget)}</span>
            </div>
            </>);})()}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20}}>
            <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
              <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Entrega × CTR Diário</div>
              <DualChart data={daily} xKey="date" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
            </div>
            <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
              <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Entrega × CTR por Tamanho</div>
              <DualChart data={bySize} xKey="size" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
            </div>
          </div>
          <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20,marginBottom:20}}>
            <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Entrega × CTR por Audiência</div>
            <DualChart data={byAudience} xKey="audience" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
          </div>
          <CollapsibleTable title="Detalhamento Diário" theme={cTheme}>
            <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
              <button onClick={()=>{
                const headers=["Data","Campanha","Line","Criativo","Tamanho","Tática","Impressões","Imp. Visíveis","Cliques","CTR","CPM Ef.","Custo Ef."];
                const csv=[headers,...detail.map(r=>[r.date,r.campaign_name,r.line_name,r.creative_name,r.creative_size,r.tactic_type,r.impressions,r.viewable_impressions,r.clicks,r.ctr,r.effective_cpm_amount,r.effective_total_cost])].map(r=>r.map(v=>`"${v??""}`).join(",")).join("\n");
                const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=`display_${dispTab}_${camp.campaign_name}.csv`;a.click();
              }} style={{background:C.blue,color:C.white,border:"none",padding:"8px 16px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600}}>⬇ Download CSV</button>
            </div>
            <PerfTable rows={detail} type="DISPLAY"/>
          </CollapsibleTable>
          <TabChat token={token} tabName="Display" author={isAdmin?"HYPR":"Cliente"} theme={cTheme}/>
        </div>
      );
    })()}
  </div>
)}
        {mainTab==="Video"&&(<div>
    <Tabs tabs={tacticTabs} active={vidTab} onChange={(t)=>{setVidTab(t);setVidLines([]);}} small theme={cTheme}/>
    {(()=>{
      const rows = totals.filter(r=>r.media_type==="VIDEO" && r.tactic_type===vidTab);
      const detailAllV = detail0.filter(r=>r.media_type==="VIDEO" && r.line_name?.toLowerCase().includes(vidTab.toLowerCase()));
      const dailyAllV  = daily0.filter(r=>r.media_type==="VIDEO" && r.line_name?.toLowerCase().includes(vidTab.toLowerCase()));
      // Lines disponíveis para o dropdown
      const lineNamesV=["ALL",...[...new Set(detailAllV.map(r=>r.line_name).filter(Boolean))].sort()];
      // detail/daily filtrados pela line
      const detail = vidLines.length===0 ? detailAllV : detailAllV.filter(r=>vidLines.includes(r.line_name));
      const daily = (()=>{
          const m={};
          detail.forEach(r=>{
            if(!r.date)return;
            if(!m[r.date])m[r.date]={date:r.date,viewable_impressions:0,video_view_100:0};
            m[r.date].viewable_impressions+=Number(r.viewable_impressions)||0;
            m[r.date].video_view_100+=Number(r.video_view_100||r.completions||0);
          });
          return Object.values(m).sort((a,b)=>a.date>b.date?1:-1).map(r=>({...r,vtr:r.viewable_impressions>0?r.video_view_100/r.viewable_impressions*100:0}));
        })();
      // Gráfico por audiência — sempre do total
      const getAudienceV = (ln) => { const p=(ln||"").split("_"); return p.length>=2?p[p.length-2]:"N/A"; };
      const byAudience=Object.values(detailAllV.reduce((acc,r)=>{
        const k=getAudienceV(r.line_name);
        if(/survey/i.test(k)||k==="N/A")return acc;
        if(!acc[k])acc[k]={audience:k,viewable_impressions:0,video_view_100:0};
        acc[k].viewable_impressions+=r.viewable_impressions||0;
        acc[k].video_view_100+=r.video_view_100||0;
        return acc;
      },{})).map(r=>({...r,vtr:r.viewable_impressions>0?r.video_view_100/r.viewable_impressions*100:0}));
      // KPIs filtrados
      const cost=rows.reduce((s,r)=>s+(r.effective_total_cost||0),0);
      const vi=detail.reduce((s,r)=>s+(r.viewable_impressions||0),0);
      const views100=detail.reduce((s,r)=>s+(r.video_view_100||0),0);
      const starts=detail.reduce((s,r)=>s+(r.video_starts||0),0);
      const vtr=vi>0?views100/vi*100:0;
      // Métricas contratuais — direto do totals (backend já calculou corretamente)
      const views100All=rows.reduce((s,r)=>s+(r.completions||0),0);
      const viAll=detailAllV.reduce((s,r)=>s+(r.viewable_impressions||0),0);
      const budget=rows.reduce((s,r)=>s+(vidTab==="O2O"?(r.o2o_video_budget||0):(r.ooh_video_budget||0)),0);
      const cpcvNeg=rows[0]?.deal_cpcv_amount||0;
      const contracted2=vidTab==="O2O"?(rows[0]?.contracted_o2o_video_completions||0):(rows[0]?.contracted_ooh_video_completions||0);
      const bonus2=vidTab==="O2O"?(rows[0]?.bonus_o2o_video_completions||0):(rows[0]?.bonus_ooh_video_completions||0);
      const totalNeg2=contracted2+bonus2;
      // CPCV Efetivo, Rentabilidade e Pacing — usar pacing do backend
      const cpcvEf=rows[0]?.effective_cpcv_amount||0;
      const rentab=rows[0]?.rentabilidade||0;
      const pac=rows[0]?.pacing||0;
      const pacBase=Math.min(pac,100), pacOver=Math.max(0,pac-100);
      const bySize=Object.values(detail.reduce((acc,r)=>{
        const k=r.creative_size||"N/A";
        if(!acc[k])acc[k]={size:k,viewable_impressions:0,video_view_100:0};
        acc[k].viewable_impressions+=r.viewable_impressions||0;
        acc[k].video_view_100+=r.video_view_100||0;
        return acc;
      },{})).map(r=>({...r,vtr:r.viewable_impressions>0?r.video_view_100/r.viewable_impressions*100:0}));
      return (
        <div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20,padding:"10px 16px",background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10}}>
              <span style={{fontSize:12,color:cmuted,fontWeight:600,textTransform:"uppercase",letterSpacing:1,flexShrink:0}}>Line Item:</span>
              <MultiLineSelect lines={lineNamesV} selected={vidLines} onChange={setVidLines} theme={cTheme}/>
              {vidLines.length>0&&<button onClick={()=>setVidLines([])} style={{background:"none",border:`1px solid ${cbdr}`,color:cmuted,borderRadius:7,padding:"5px 12px",cursor:"pointer",fontSize:12,flexShrink:0}}>✕ Limpar</button>}
          </div>
          {/* Linha 1 — dados contratuais */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20}}>
            {[
              {l:"Budget Contratado",v:fmtR(budget)},
              {l:"Views Contratadas",v:fmt(vidTab==="O2O"?(rows[0]?.contracted_o2o_video_completions||0):(rows[0]?.contracted_ooh_video_completions||0))},
              {l:"Views Bonus",v:fmt(vidTab==="O2O"?(rows[0]?.bonus_o2o_video_completions||0):(rows[0]?.bonus_ooh_video_completions||0))},
              {l:"CPCV Negociado",v:fmtR(cpcvNeg)},
            ].map(({l,v})=>(
              <div key={l} style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>{l}</div>
                <div style={{fontSize:18,fontWeight:800,marginTop:4,color:ctext}}>{v}</div>
              </div>
            ))}
          </div>
          {/* Linha 2 — dados de performance */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20}}>
            {[
              {l:"Views Start",    v:fmt(starts)},
              {l:"Views 100%",     v:fmt(views100)},
              {l:"VTR",            v:fmtP2(vtr)},
              {l:"CPCV Efetivo",   v:fmtR(cpcvEf), blue:true},
              {l:"Rentabilidade",  v:fmtP(rentab), color:rentab>0?C.blue:rentab<0?C.red:C.white},
            ].map(({l,v,blue,color})=>(
              <div key={l} style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontSize:11,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>{l}</div>
                <div style={{fontSize:18,fontWeight:800,marginTop:4,color:color||(blue?C.blue:ctext)}}>{v}</div>
              </div>
            ))}
          </div>
          {/* Pacing */}
          <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:"16px 20px",marginBottom:20}}>
            {(()=>{const barC=pac>=100?"#2ECC71":pac>=70?"#F1C40F":"#E74C3C";const overC=isDarkClient?"#C5EAF6":"#246C84";return(<>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontSize:12,color:cmuted,textTransform:"uppercase",letterSpacing:1}}>Pacing {vidTab}</span>
              <span style={{fontSize:13,fontWeight:700,color:pac>100?overC:barC}}>{fmt(pac,1)}%{pac>100&&` ⚡ Over de ${fmt(pac-100,1)}%`}</span>
            </div>
            <div style={{height:8,background:isDarkClient?C.dark3:"#E2E8F0",borderRadius:4,overflow:"hidden"}}>
              <div style={{display:"flex",height:"100%"}}>
                <div style={{width:`${pacBase}%`,background:barC,borderRadius:4,transition:"width 0.8s"}}/>
                {pacOver>0&&<div style={{width:`${Math.min(pacOver,20)}%`,background:overC,borderRadius:4}}/>}
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
              <span style={{fontSize:11,color:cmuted}}>Investido: {fmtR(cost)}</span>
              <span style={{fontSize:11,color:cmuted}}>Budget: {fmtR(budget)}</span>
            </div>
            </>);})()}
          </div>
          {/* Gráficos */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20}}>
            <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
              <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Views 100% × VTR Diário</div>
              <DualChart data={daily} xKey="date" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
            </div>
            <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20}}>
              <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Views 100% × VTR por Tamanho</div>
              <DualChart data={bySize} xKey="size" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
            </div>
          </div>
          <div style={{background:cbg2,border:`1px solid ${cbdr}`,borderRadius:12,padding:20,marginBottom:20}}>
            <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Views 100% × VTR por Audiência</div>
            <DualChart data={byAudience} xKey="audience" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
          </div>
          {/* Download + Tabela */}
          <CollapsibleTable title="Detalhamento Diário" theme={cTheme}>
            <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
              <button onClick={()=>{
                const headers=["Data","Campanha","Line","Criativo","Tamanho","Tática","Imp. Visíveis","Video Start","Views 25%","Views 50%","Views 75%","Views 100%","VTR","Custo Ef."];
                const csv=[headers,...detail.map(r=>[r.date,r.campaign_name,r.line_name,r.creative_name,r.creative_size,r.tactic_type,r.viewable_impressions,r.video_starts,r.video_view_25,r.video_view_50,r.video_view_75,r.video_view_100,r.vtr??0,r.effective_total_cost])].map(r=>r.map(v=>`"${v??""}`).join(",")).join("\n");
                const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=`video_${vidTab}_${camp.campaign_name}.csv`;a.click();
              }} style={{background:C.blue,color:C.white,border:"none",padding:"8px 16px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600}}>⬇ Download CSV</button>
            </div>
            <PerfTable rows={detail} type="VIDEO"/>
          </CollapsibleTable>
          <TabChat token={token} tabName="Video" author={isAdmin?"HYPR":"Cliente"} theme={cTheme}/>
        </div>
      );
    })()}
  </div>
)}

        {mainTab==="RMND"&&<div><UploadTab type="RMND" token={token} serverData={data.rmnd} readOnly={!isAdmin}/><TabChat token={token} tabName="RMND" author={isAdmin?"HYPR":"Cliente"} theme={cTheme}/></div>}
        {mainTab==="PDOOH"&&<div><UploadTab type="PDOOH" token={token} serverData={data.pdooh} readOnly={!isAdmin}/><TabChat token={token} tabName="PDOOH" author={isAdmin?"HYPR":"Cliente"} theme={cTheme}/></div>}
        {mainTab==="VIDEO LOOM"&&(
          <div style={{padding:"24px 0"}}>
            {data.loom?(
          <div style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:12,overflow:"hidden",position:"relative",paddingTop:"56.25%"}}>
            <iframe
              src={data.loom.replace("https://www.loom.com/share/","https://www.loom.com/embed/")}
              frameBorder="0"
              allowFullScreen
              style={{position:"absolute",top:0,left:0,width:"100%",height:"100%"}}
        />
      </div>
      
    ):(
      <div style={{textAlign:"center",padding:80,color:C.muted}}>
        <div style={{fontSize:40,marginBottom:16}}>🎥</div>
        <div style={{fontSize:16,fontWeight:600}}>Nenhum vídeo disponível ainda</div>
        <div style={{fontSize:13,marginTop:8}}>O vídeo explicativo será adicionado em breve.</div>
      </div>
    )}
  </div>
)}
{mainTab==="SURVEY"&&(
  <div style={{padding:"24px 0"}}>
    {data.survey?<SurveyTab surveyJson={data.survey} token={token} isAdmin={isAdmin} theme={cTheme}/>
    :<div style={{color:C.muted,textAlign:"center",padding:40}}>Nenhum survey cadastrado para esta campanha.</div>}
  </div>
)}
</div>
    </div>
  );
};
// ══════════════════════════════════════════════════════════════════════════════
// APP ROOT
// ══════════════════════════════════════════════════════════════════════════════
const gaPageView = (path, token) => {
  if(typeof window.gtag !== "function") return;
  window.gtag("config", "G-GL9LXQVMT4", {
    page_path: path,
    page_title: token ? `Report ${token}` : "Hub",
  });
};

const gaEvent = (eventName, params = {}) => {
  if(typeof window.gtag !== "function") return;
  window.gtag("event", eventName, params);
};
export default function App() {
  const [user,setUser]=useState(null);
  const [unlocked,setUnlocked]=useState(false);
  const path=window.location.pathname;
  const isClient=path.startsWith("/report/");
  const clientToken=isClient?path.replace("/report/",""):null;

  if(isClient&&clientToken){
    const _isAdmin = !!user || new URLSearchParams(window.location.search).get("ak")==="hypr2026";
    if(!_isAdmin&&!unlocked)return <ClientPasswordScreen token={clientToken} onUnlock={()=>setUnlocked(true)}/>;
    return <ClientDashboard token={clientToken} isAdmin={_isAdmin}/>;
  }
  if(!user)return <LoginScreen onLogin={setUser}/>;
  return <CampaignMenu user={user} onLogout={()=>setUser(null)} onOpenReport={t=>window.open(`/report/${t}?ak=hypr2026`,"_blank")}/>;
}

