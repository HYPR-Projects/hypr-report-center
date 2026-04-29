import { useState } from "react";
import { C } from "../shared/theme";
import { markClientUnlocked } from "../shared/auth";
import GlobalStyle from "../components/GlobalStyle";
import HyprReportCenterLogo from "../components/HyprReportCenterLogo";

const ClientPasswordScreen = ({ token, onUnlock }) => {
  const [pw,setPw]=useState(""); const [err,setErr]=useState(false);
  const submit=()=>{
    if(pw.trim().toUpperCase()===token.toUpperCase()){
      // Persiste o unlock por 8h para que refreshes não peçam senha de novo.
      markClientUnlocked(token);
      onUnlock();
    } else {
      setErr(true);setTimeout(()=>setErr(false),2000);
    }
  };
  return (
    <div style={{minHeight:"100vh",width:"100%",display:"flex",alignItems:"center",justifyContent:"center",padding:24,position:"relative",overflow:"hidden",background:C.dark}}>
      <GlobalStyle/>
      <div style={{position:"absolute",inset:0,backgroundImage:`url(/glitter.jpg)`,backgroundSize:"cover",backgroundPosition:"center",animation:"glitterPulse 9s ease-in-out infinite",filter:"blur(3px) brightness(0.4) saturate(1.5)",transformOrigin:"center"}}/>
      <div style={{position:"absolute",inset:0,background:`radial-gradient(ellipse at 62% 42%, ${C.blueDark}50 0%, transparent 58%)`,pointerEvents:"none"}}/>
      <div className="fade-in" style={{position:"relative",zIndex:10,background:"rgba(28,38,47,0.52)",backdropFilter:"blur(28px) saturate(1.7)",WebkitBackdropFilter:"blur(28px) saturate(1.7)",border:`1px solid ${err?"rgba(83,104,114,0.7)":"rgba(51,151,185,0.22)"}`,borderRadius:24,padding:"48px 40px",maxWidth:380,width:"100%",textAlign:"center",boxShadow:"0 8px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.07)",transition:"border-color 0.3s"}}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:32,color:"#FFFFFF"}}><HyprReportCenterLogo height={32}/></div>
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

export default ClientPasswordScreen;
