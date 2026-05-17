import { useEffect } from "react";
import { C } from "../shared/theme";
import { saveSession } from "../shared/auth";
import { initGoogleAuth, renderSignInButton, requestSilentSignIn } from "../shared/googleAuth";
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
    initGoogleAuth((res)=>{
      const p=decodeJwtPayload(res.credential);
      if(p.email?.endsWith("@hypr.mobi")) {
        const user = {name:p.name,email:p.email,picture:p.picture};
        // Persiste user + id_token com TTL de 8h em localStorage para
        // sobreviver a refreshes e fechamentos de aba.
        saveSession(user, res.credential);
        onLogin(user);
      }
      else alert("Acesso restrito a emails @hypr.mobi");
    }).then(()=>{
      renderSignInButton("gbtn");
      // Tenta auto-login silencioso se o usuário já fez login antes com a
      // mesma conta do Google neste browser. Se não rolar (sem sessão Google
      // ou primeiro acesso), o botão renderizado acima fica disponível.
      requestSilentSignIn();
    });
  },[]);
  return (
    <div className="login-bg" style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:`radial-gradient(ellipse at 30% 50%,${C.dark3},${C.dark})`,padding:24}}>
      <GlobalStyle/>
      <style>{`
        @keyframes login-bg-in{from{opacity:0}to{opacity:1}}
        @keyframes login-card-in{from{opacity:0;transform:translateY(16px) scale(0.985)}to{opacity:1;transform:translateY(0) scale(1)}}
        @keyframes login-item-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .login-bg{animation:login-bg-in 420ms ease-out both}
        .login-card{animation:login-card-in 560ms cubic-bezier(0.16,1,0.3,1) 80ms both}
        .login-item{animation:login-item-in 420ms cubic-bezier(0.16,1,0.3,1) both;opacity:0}
        @media(prefers-reduced-motion:reduce){
          .login-bg,.login-card,.login-item{animation:none;opacity:1;transform:none}
        }
      `}</style>
      <div className="login-card" style={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:20,padding:"56px 48px",maxWidth:400,width:"100%",textAlign:"center",boxShadow:`0 32px 80px #00000060`}}>
        <div className="login-item" style={{display:"flex",justifyContent:"center",color:"#FFFFFF",animationDelay:"260ms"}}>
          <HyprReportCenterLogo height={36}/>
        </div>
        <div className="login-item" style={{margin:"40px 0",height:1,background:C.dark3,animationDelay:"360ms"}}/>
        <p className="login-item" style={{color:C.muted,fontSize:14,marginBottom:32,lineHeight:1.6,animationDelay:"420ms"}}>Acesso restrito à equipe HYPR.<br/>Faça login com seu email <strong style={{color:C.blueLight}}>@hypr.mobi</strong>.</p>
        <div className="login-item" id="gbtn" style={{display:"flex",justifyContent:"center",animationDelay:"500ms"}}/>
        <p className="login-item" style={{marginTop:24,fontSize:12,color:`${C.muted}80`,animationDelay:"580ms"}}>Apenas contas @hypr.mobi são autorizadas</p>
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// CAMPAIGN MENU — Redesigned v2
// ══════════════════════════════════════════════════════════════════════════════

// Light theme colors

export default LoginScreen;
