import { useEffect } from "react";
import { GOOGLE_CLIENT_ID } from "../shared/config";
import { C } from "../shared/theme";
import { saveSession } from "../shared/auth";
import GlobalStyle from "../components/GlobalStyle";
import HyprReportCenterLogo from "../components/HyprReportCenterLogo";

const LoginScreen = ({ onLogin }) => {
  useEffect(()=>{
    const s=document.createElement("script"); s.src="https://accounts.google.com/gsi/client"; s.async=true;
    s.onload=()=>{
      window.google?.accounts.id.initialize({
        client_id:GOOGLE_CLIENT_ID,
        callback:(res)=>{
          const p=JSON.parse(atob(res.credential.split(".")[1]));
          if(p.email?.endsWith("@hypr.mobi")) {
            const user = {name:p.name,email:p.email,picture:p.picture};
            // Persiste user + id_token com TTL de 8h em localStorage para
            // sobreviver a refreshes e fechamentos de aba.
            saveSession(user, res.credential);
            onLogin(user);
          }
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
        <div style={{display:"flex",justifyContent:"center",color:"#FFFFFF"}}>
          <HyprReportCenterLogo height={36}/>
        </div>
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

export default LoginScreen;
