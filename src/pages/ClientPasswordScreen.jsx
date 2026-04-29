import { useState } from "react";
import { C } from "../shared/theme";
import { markClientUnlocked } from "../shared/auth";
import { API_URL } from "../shared/config";
import GlobalStyle from "../components/GlobalStyle";
import HyprReportCenterLogo from "../components/HyprReportCenterLogo";

/**
 * Tela de senha do cliente.
 *
 * Antes desta refatoração, a senha era comparada localmente contra o
 * `token` da URL — que era o próprio short_token, exposto literalmente
 * no path. Agora a URL pode ser um `share_id` opaco (16 chars random),
 * e a validação acontece server-side via `?action=resolve_share`.
 *
 * Compatibilidade: o endpoint aceita tanto share_id quanto short_token
 * legacy, então URLs antigas continuam funcionando sem mudanças no
 * frontend.
 *
 * Em caso de falha de rede, faz fallback para a comparação local:
 * mantém o report acessível mesmo se o backend estiver fora ou se
 * a URL ainda for o formato legacy e a Cloud Function não tiver
 * sido redeployada com o novo endpoint. O fallback só funciona quando
 * a URL é legacy (token == senha), que é o caso onde a comparação
 * local sempre foi suficiente.
 */
const ClientPasswordScreen = ({ token, onUnlock }) => {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const password = pw.trim();
    if (!password) return;
    setLoading(true);
    setErr(false);

    try {
      const res = await fetch(`${API_URL}?action=resolve_share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ share_id: token, password }),
      });

      if (res.ok) {
        const data = await res.json();
        const shortToken = data?.short_token;
        if (shortToken) {
          markClientUnlocked(token, shortToken);
          onUnlock(shortToken);
          return;
        }
      }
      // Backend respondeu mas senha errada (401) ou payload inesperado.
      setErr(true);
      setTimeout(() => setErr(false), 2000);
    } catch (_e) {
      // Falha de rede: tenta o caminho legacy local. Só funciona se a
      // URL for o formato antigo (token == senha). Se for share_id
      // novo, a comparação local não tem como validar — desiste.
      if (password.toUpperCase() === token.toUpperCase()) {
        markClientUnlocked(token, token);
        onUnlock(token);
      } else {
        setErr(true);
        setTimeout(() => setErr(false), 2000);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{minHeight:"100vh",width:"100%",display:"flex",alignItems:"center",justifyContent:"center",padding:24,position:"relative",overflow:"hidden",background:C.dark}}>
      <GlobalStyle/>
      {/* Dot grid layer: pontos sutis em azul brand, espaçamento 24px */}
      <div style={{position:"absolute",inset:0,backgroundImage:`radial-gradient(rgba(51,151,185,0.18) 1px, transparent 1px)`,backgroundSize:"24px 24px",pointerEvents:"none"}}/>
      {/* Vignette layer: fade radial centralizado pra dar foco no card */}
      <div style={{position:"absolute",inset:0,background:`radial-gradient(ellipse 70% 60% at center, transparent 0%, ${C.dark}d9 80%)`,pointerEvents:"none"}}/>
      {/* Soft glow atrás do card pra dar profundidade */}
      <div style={{position:"absolute",inset:0,background:`radial-gradient(ellipse 40% 35% at center, ${C.blue}1f 0%, transparent 60%)`,pointerEvents:"none"}}/>
      <div className="fade-in" style={{position:"relative",zIndex:10,background:"rgba(28,38,47,0.52)",backdropFilter:"blur(28px) saturate(1.7)",WebkitBackdropFilter:"blur(28px) saturate(1.7)",border:`1px solid ${err?"rgba(83,104,114,0.7)":"rgba(51,151,185,0.22)"}`,borderRadius:24,padding:"48px 40px",maxWidth:380,width:"100%",textAlign:"center",boxShadow:"0 8px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.07)",transition:"border-color 0.3s"}}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:32,color:"#FFFFFF"}}><HyprReportCenterLogo height={32}/></div>
        <div style={{height:1,background:"rgba(255,255,255,0.07)",marginBottom:28}}/>
        <p style={{color:C.lightGray,fontSize:14,marginBottom:28,lineHeight:1.7,fontWeight:300}}>Insira o código de acesso fornecido<br/>pela equipe HYPR para visualizar o report.</p>
        <input
          value={pw}
          onChange={e=>setPw(e.target.value.toUpperCase())}
          onKeyDown={e=>e.key==="Enter"&&!loading&&submit()}
          placeholder="Código de acesso"
          disabled={loading}
          style={{width:"100%",background:"rgba(255,255,255,0.07)",border:`1px solid ${err?"rgba(83,104,114,0.8)":"rgba(51,151,185,0.28)"}`,borderRadius:10,padding:"14px 16px",color:C.white,fontSize:16,fontWeight:700,letterSpacing:2,textAlign:"center",outline:"none",marginBottom:12,transition:"border-color 0.3s",opacity:loading?0.6:1}}
        />
        {err&&<p style={{color:C.darkMuted,fontSize:13,marginBottom:12}}>Código inválido. Tente novamente.</p>}
        <button
          onClick={submit}
          disabled={loading}
          style={{width:"100%",background:C.blue,color:C.white,border:"none",padding:14,borderRadius:10,cursor:loading?"wait":"pointer",fontSize:15,fontWeight:700,opacity:loading?0.7:1}}
        >
          {loading ? "Validando..." : "Acessar Report"}
        </button>
      </div>
    </div>
  );
};

export default ClientPasswordScreen;
