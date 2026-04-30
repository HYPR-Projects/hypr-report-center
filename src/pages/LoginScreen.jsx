import { useEffect } from "react";
import { GOOGLE_CLIENT_ID } from "../shared/config";
import { C } from "../shared/theme";
import { saveSession } from "../shared/auth";
import GlobalStyle from "../components/GlobalStyle";
import HyprReportCenterLogo from "../components/HyprReportCenterLogo";

/**
 * Decodifica o payload de um JWT (id_token do Google).
 *
 * O `atob()` direto sobre o segmento base64url do JWT tem dois bugs:
 *   1. base64url usa '-' e '_' em vez de '+' e '/' — atob não entende
 *      esses caracteres, então tokens contendo eles falham.
 *   2. atob retorna uma string em ISO-8859-1 (Latin-1). Como o payload
 *      do Google está em UTF-8, nomes com acentos viram mojibake — ex:
 *      "João" decodifica como "JoÃ£o", "Conceição" como "ConceiÃ§Ã£o".
 *
 * Aqui resolvemos os dois: troca base64url → base64 padrão, decodifica,
 * remonta como sequência de bytes %XX e usa decodeURIComponent pra
 * interpretar como UTF-8 nativo. É o padrão recomendado pelo MDN.
 */
function decodeJwtPayload(token) {
  const segment = token.split(".")[1];
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  // Padding: base64 sem padding falha em alguns browsers/builds. Adiciona '=' até múltiplo de 4.
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const utf8 = decodeURIComponent(
    binary
      .split("")
      .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
      .join("")
  );
  return JSON.parse(utf8);
}

const LoginScreen = ({ onLogin }) => {
  useEffect(()=>{
    const s=document.createElement("script"); s.src="https://accounts.google.com/gsi/client"; s.async=true;
    s.onload=()=>{
      window.google?.accounts.id.initialize({
        client_id:GOOGLE_CLIENT_ID,
        callback:(res)=>{
          const p=decodeJwtPayload(res.credential);
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
