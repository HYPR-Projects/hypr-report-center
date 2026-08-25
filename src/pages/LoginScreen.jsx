import { useCallback, useEffect, useState } from "react";
import { C } from "../shared/theme";
import {
  saveSession,
  clearSession,
  issueAdminJwt,
  primeAdminJwt,
  storageWritable,
  measureClockSkewMs,
} from "../shared/auth";
import {
  initGoogleAuth,
  renderSignInButton,
  requestSilentSignIn,
  disableAutoSelect,
} from "../shared/googleAuth";
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

/**
 * O QUE ESTA TELA PASSOU A GARANTIR
 * ─────────────────────────────────────────────────────────────────────────
 * Login = Google aceitou a conta **E** o backend emitiu o admin JWT. As duas
 * coisas, antes de entrar.
 *
 * Antes bastava a primeira: com o e-mail @hypr.mobi conferido no id_token, a
 * tela salvava a sessão e chamava `onLogin`. Se o backend recusasse aquela
 * conta em seguida (`?action=issue_admin_token` → 401), o menu montava sem
 * credencial, todas as chamadas admin saíam sem `Authorization`, levavam 401,
 * e o handler de 401 apagava a sessão e recarregava a página. A tela de login
 * então re-autenticava sozinha (`auto_select` + One Tap silencioso) e o ciclo
 * recomeçava: login pisca, entra, volta pro login, para sempre, sem uma linha
 * de erro em nenhum lugar. Foi exatamente o que aconteceu em produção.
 *
 * Duas mudanças fecham esse caminho:
 *
 *   1. A troca id_token → admin JWT acontece AQUI, antes de `onLogin`. Não
 *      existe mais estado "logado no front, recusado no backend".
 *   2. Recusa desarma o `auto_select` e é MOSTRADA na tela, com o motivo que
 *      o backend mandou. O `alert()` antigo não fazia nem uma nem outra: o
 *      operador dava OK e a próxima carga reelegia a mesma conta errada.
 *
 * A distinção que a tela faz questão de manter é entre "sua conta não passa"
 * (nada de tentar de novo vai resolver — é Workspace/conta) e "não deu pra
 * validar agora" (backend/Google fora — tentar de novo é exatamente o certo).
 */

// Motivo técnico → o que o operador precisa ler. `reason` vem de
// backend/auth.py (`verify_google_id_token_verbose`) ou do próprio front.
// `retry: true` = falha de infra, tem sentido insistir.
const REASONS = {
  email_not_verified: {
    title: "O Google não confirma este e-mail",
    body: "A conta existe, mas o Google não a considera verificada — então o acesso admin não pode ser emitido. Quem administra o Workspace precisa concluir a ativação da conta (primeiro acesso/verificação).",
  },
  domain_not_allowed: {
    title: "Conta fora do domínio HYPR",
    body: "O acesso é restrito a contas @hypr.mobi. Escolha a conta HYPR no seletor abaixo.",
  },
  invalid_token: {
    title: "O login do Google não completou",
    body: "O token chegou incompleto ou já expirado. Tente entrar de novo.",
    retry: true,
  },
  tokeninfo_error: {
    title: "Não foi possível validar agora",
    body: "O backend não conseguiu falar com o Google pra confirmar seu login. É indisponibilidade momentânea, não a sua conta — tente de novo em alguns instantes.",
    retry: true,
  },
  network_error: {
    title: "Sem conexão com o backend",
    body: "Não conseguimos alcançar o servidor pra validar seu login. Confira a conexão e tente de novo.",
    retry: true,
  },
};

function describeReason(reason, status) {
  if (REASONS[reason]) return REASONS[reason];
  // 5xx e 404 (endpoint fora do ar / não deployado) são infra, não conta.
  if (status >= 500 || status === 404) {
    return {
      title: "O backend está indisponível",
      body: "O servidor não conseguiu emitir seu acesso agora. Tente de novo em alguns instantes; se persistir, avise o time.",
      retry: true,
    };
  }
  return {
    title: "Acesso recusado",
    body: "O backend não autorizou esta conta. Mande o print desta tela pro time — o motivo abaixo diz onde olhar.",
  };
}

const LoginScreen = ({ onLogin }) => {
  // `null` = nada aconteceu ainda. Quando preenchido, carrega o que mostrar
  // (título, corpo, e o par motivo/status que faz um print desta tela valer
  // como diagnóstico).
  const [failure, setFailure] = useState(null);
  const [checking, setChecking] = useState(false);

  const handleCredential = useCallback(async (res) => {
    let payload;
    try {
      payload = decodeJwtPayload(res.credential);
    } catch {
      setFailure({ ...describeReason("invalid_token"), reason: "unreadable_id_token", status: 0 });
      return;
    }

    const email = payload?.email || "";
    if (!email.toLowerCase().endsWith("@hypr.mobi")) {
      // Desarma o auto-select ANTES de mostrar o erro: sem isso a próxima
      // carga da página reelege esta mesma conta sozinha, e o operador não
      // chega no seletor pra corrigir.
      await disableAutoSelect();
      setFailure({
        ...REASONS.domain_not_allowed,
        email,
        reason: "domain_not_allowed",
        status: 0,
      });
      return;
    }

    // Só é login de verdade se o backend emitir o JWT. Ver o bloco de cima.
    setChecking(true);
    const issued = await issueAdminJwt(res.credential);
    setChecking(false);

    if (!issued?.token) {
      await disableAutoSelect();
      // A sessão não deve sobrar de uma tentativa recusada — é o que fazia o
      // app entrar sem credencial no reload seguinte.
      clearSession();
      setFailure({
        ...describeReason(issued?.reason, issued?.status || 0),
        email,
        reason: issued?.reason || "unknown",
        status: issued?.status || 0,
      });
      return;
    }

    // Cache em memória primeiro: é o que faz a aba funcionar mesmo quando a
    // gravação abaixo falha.
    primeAdminJwt(issued.token, issued.ttl);

    // Relógio torto não trava mais o acesso (ver CLOCK_SKEW_TOLERANCE_MS em
    // shared/auth), mas continua valendo registrar: era candidato a causa de
    // "sessão expirou" e é a própria pessoa que conserta.
    const skewMs = measureClockSkewMs(issued.token, issued.ttl);
    if (skewMs != null && Math.abs(skewMs) > 10 * 60 * 1000) {
      const minutes = Math.round(skewMs / 60000);
      console.warn(
        `[HYPR] O relógio deste computador está ${Math.abs(minutes)} min ` +
        `${minutes > 0 ? "atrasado" : "adiantado"} em relação ao servidor. ` +
        "Ligar data/hora automática evita sessão caindo sem motivo."
      );
    }

    const user = { name: payload.name, email, picture: payload.picture };
    // user + id_token + admin JWT numa escrita só, TTL de 8h.
    const stored = saveSession(user, res.credential, issued.token, issued.ttl);
    if (!stored) {
      // Sem persistência a aba FUNCIONA (o JWT está em memória), mas todo
      // refresh volta pro login e nada sobrevive a fechar a aba. Entrar
      // calado aqui é o que fazia esse caso virar "sessão expirou" sem
      // explicação — então mostra o que houve e deixa a decisão com ele.
      setFailure({
        title: "Seu navegador está bloqueando os dados deste site",
        body: "Consegui te autenticar, mas não consigo guardar a sessão neste navegador (dados de site bloqueados por configuração, política ou extensão). Você pode entrar assim mesmo — só vai precisar logar de novo a cada refresh. Pra resolver de vez, libere cookies e dados de site para este endereço.",
        email,
        reason: "storage_blocked",
        status: 0,
        proceed: () => onLogin?.(user),
      });
      return;
    }
    setFailure(null);
    onLogin?.(user);
  }, [onLogin]);

  // `handleCredential` na dependência: o GIS aceita `initialize` múltiplas
  // vezes e o último callback registrado vence (ver shared/googleAuth), então
  // re-registrar é a forma barata de nunca servir um callback obsoleto.
  useEffect(() => {
    let cancelled = false;
    initGoogleAuth((res) => { if (!cancelled) handleCredential(res); }).then(() => {
      if (cancelled) return;
      renderSignInButton("gbtn");
      // Auto-login silencioso se o usuário já entrou antes com a mesma conta
      // neste browser. Quando não rola (sem sessão Google, primeiro acesso,
      // ou auto-select desarmado por uma recusa anterior), o botão acima é o
      // caminho — e aí o seletor de contas aparece.
      requestSilentSignIn();
    });
    return () => { cancelled = true; };
  }, [handleCredential]);

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

        {failure && <LoginFailure failure={failure}/>}

        <div className="login-item" id="gbtn" style={{display:"flex",justifyContent:"center",animationDelay:"500ms"}}/>
        {checking && (
          <p style={{marginTop:16,fontSize:12,color:C.muted}}>Validando seu acesso…</p>
        )}
        <p className="login-item" style={{marginTop:24,fontSize:12,color:`${C.muted}80`,animationDelay:"580ms"}}>Apenas contas @hypr.mobi são autorizadas</p>
      </div>
    </div>
  );
};

/**
 * O bloco de recusa. Existe pra que a tela de login pare de ser um beco sem
 * saída silencioso: diz o que houve, com qual conta, o que fazer, e carrega o
 * par `reason`/`status` que transforma um print desta tela em diagnóstico
 * (é o mesmo `reason` que o backend registra no log).
 */
function LoginFailure({ failure }) {
  const { title, body, email, reason, status, retry, proceed } = failure;
  return (
    <div
      role="alert"
      style={{
        textAlign:"left",
        background:"#3A1E1E",
        border:"1px solid #7A3B3B",
        borderRadius:12,
        padding:"14px 16px",
        marginBottom:24,
      }}
    >
      <p style={{color:"#FFB4B4",fontSize:13,fontWeight:700,margin:0,lineHeight:1.4}}>
        {title}
      </p>
      {email && (
        <p style={{color:C.muted,fontSize:12,margin:"6px 0 0",wordBreak:"break-all"}}>
          Conta usada: <strong style={{color:"#FFFFFF"}}>{email}</strong>
        </p>
      )}
      <p style={{color:C.muted,fontSize:12,margin:"8px 0 0",lineHeight:1.55}}>
        {body}
      </p>
      {proceed && (
        <button
          type="button"
          onClick={proceed}
          style={{
            marginTop:12,
            background:C.blueLight,
            border:"none",
            color:"#0B1620",
            borderRadius:8,
            padding:"7px 14px",
            fontSize:12,
            fontWeight:700,
            cursor:"pointer",
          }}
        >
          Entrar mesmo assim
        </button>
      )}
      {retry && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop:12,
            background:"transparent",
            border:`1px solid ${C.dark3}`,
            color:"#FFFFFF",
            borderRadius:8,
            padding:"6px 12px",
            fontSize:12,
            fontWeight:600,
            cursor:"pointer",
          }}
        >
          Tentar de novo
        </button>
      )}
      {/* Rodapé técnico: é o que transforma um print desta tela em
          diagnóstico. `armazenamento` entra aqui porque "sessão não
          persiste" e "conta recusada" têm sintoma idêntico pro operador e
          causas que não se parecem em nada. */}
      <p style={{color:`${C.muted}90`,fontSize:10.5,margin:"12px 0 0",fontFamily:"ui-monospace, SFMono-Regular, Menlo, monospace"}}>
        motivo: {reason}{status ? ` · http ${status}` : ""} · armazenamento:{" "}
        {storageWritable() ? "ok" : "bloqueado"}
      </p>
    </div>
  );
}

export default LoginScreen;
