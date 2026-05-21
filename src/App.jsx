import { lazy, Suspense, useEffect, useState } from "react";
import RouteSuspense from "./components/RouteSuspense";
import LoadingShell from "./components/LoadingShell";
import V2ErrorBoundary from "./v2/components/ErrorBoundary";
import ClientPasswordScreen from "./pages/ClientPasswordScreen";
import { SessionExpiredModalV2 } from "./v2/components/SessionExpiredModalV2";
import {
  getAdminJwtFromUrl,
  isJwtExpired,
  getGoogleIdToken,
  issueAdminJwt,
  getOrIssueAdminJwt,
  clearCachedAdminJwt,
  loadSession,
  clearSession,
  isClientUnlocked,
  getResolvedShortToken,
  updateSessionIdToken,
  decodeJwtPayload,
} from "./shared/auth";
import { initGoogleAuth, requestSilentSignIn } from "./shared/googleAuth";
import { lookupShare } from "./lib/api";
import { isDemoToken } from "./shared/demoData";

// ── Code-splitting ──────────────────────────────────────────────────────
// Cada rota é um chunk próprio, EXCETO o ClientPasswordScreen — esse é
// pequeno (~3-5KB gzipped) e está no caminho crítico de qualquer cliente
// que abre o link de uma campanha sem unlock cacheado. Mantê-lo no bundle
// inicial elimina o Suspense fallback (spinner solto sobre fundo escuro)
// que aparecia antes da tela de senha enquanto o chunk era baixado —
// transição visual ficava feia: spinner básico → tela de senha →
// LoadingShell bonito → dashboard.
//
// ErrorBoundary também fica estático pra estar disponível ANTES do
// dashboard lazy carregar — caso o chunk falhe, o boundary captura.
// Helpers de auth também ficam estáticos por serem usados sincronamente
// no caminho crítico.
const LoginScreen          = lazy(() => import("./pages/LoginScreen"));
const CampaignMenu         = lazy(() => import("./v2/admin/pages/CampaignMenuV2"));
const ClientDetailPage     = lazy(() => import("./v2/admin/pages/ClientDetailPage"));
const ClientDashboard      = lazy(() => import("./v2/dashboards/ClientDashboardV2"));
const PmpDealsPage         = lazy(() => import("./v2/admin/pages/PmpDealsPage"));

/**
 * Heurística pra distinguir share_id (formato novo, opaco) de
 * short_token (formato legacy, exposto).
 *
 *  - short_token: 4-8 chars, alfanuméricos, todo maiúsculo.
 *    Ex: "ABC123", "UT10QW", "6BVGU6Q".
 *
 *  - share_id: 16 chars URL-safe (base64url) gerados via
 *    secrets.token_urlsafe(12). Pode conter '-' ou '_', e tem
 *    mistura de maiúsculas/minúsculas.
 *
 * Critérios para classificar como share_id:
 *   - Mais de 12 chars (short_tokens nunca chegam perto disso); OU
 *   - Contém '-' ou '_' (caracteres inválidos em short_token); OU
 *   - Contém minúscula (short_tokens são todo uppercase).
 */
function isLikelyShareId(token) {
  if (!token) return false;
  if (token.length > 12) return true;
  if (/[-_]/.test(token)) return true;
  if (/[a-z]/.test(token)) return true;
  return false;
}

export default function App() {
  // SessionExpiredModalV2 é montado uma vez aqui pra cobrir todas as
  // rotas — ouve o evento global emitido pelo postJson em api.js quando
  // uma call admin 401a mesmo após auto-retry (ver lib/sessionEvents.js).
  return (
    <>
      <SessionExpiredModalV2 />
      <AppRoutes />
    </>
  );
}

function AppRoutes() {
  // Restaura sessão admin (8h TTL) e unlock de cliente direto do localStorage
  // para que um refresh não derrube o login.
  const [user, setUser] = useState(() => loadSession()?.user || null);

  // Force re-render on popstate (back/forward + nossa nav client-side
  // via pushState abaixo). Sem isso, navegar pra /admin/client/:slug
  // muda a URL mas o React continua renderizando a tela anterior.
  const [, forceRender] = useState(0);
  useEffect(() => {
    const handler = () => forceRender((n) => n + 1);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  // Refresh silencioso do id_token do Google enquanto admin está logado.
  //
  // Sessão admin = 8h (localStorage). id_token do Google = ~1h. Sem refresh,
  // ações admin (salvar logo, listar campanhas, emitir JWT pro report) começam
  // a falhar uma hora depois do login mesmo com a sessão local válida.
  //
  // Estratégia: agendar `prompt()` ~5min antes do `exp` do id_token. Com FedCM
  // (Chrome moderno) o callback registrado abaixo recebe um credential novo
  // sem UI nenhuma; em browsers sem FedCM pode aparecer One Tap brevemente.
  // Em qualquer caso o `expiresAt` da sessão NÃO é estendido — a janela de 8h
  // continua contando desde o login inicial.
  //
  // Se o refresh falhar (ex: usuário deslogou do Google no browser), as ações
  // admin vão falhar naturalmente e o backend força relogin via 401.
  useEffect(() => {
    if (!user) return;

    let timeoutId = null;
    let cancelled = false;

    const scheduleNext = () => {
      if (cancelled) return;
      const idToken = getGoogleIdToken();
      if (!idToken) return;
      const payload = decodeJwtPayload(idToken);
      if (!payload?.exp) return;
      const expMs = Number(payload.exp) * 1000;
      // Refresh 5min antes do exp, com piso de 30s pra evitar stampede caso
      // o token já esteja perto do fim quando o effect roda (ex: tab reaberto
      // depois de 55min).
      const delayMs = Math.max(30_000, expMs - Date.now() - 5 * 60 * 1000);
      timeoutId = setTimeout(async () => {
        await requestSilentSignIn();
        // O callback abaixo dispara assíncrono via GIS; agenda re-check
        // 60s depois pra pegar o id_token renovado e marcar o próximo.
        timeoutId = setTimeout(scheduleNext, 60_000);
      }, delayMs);
    };

    initGoogleAuth((res) => {
      const p = decodeJwtPayload(res.credential);
      if (!p?.email?.endsWith("@hypr.mobi")) return;
      updateSessionIdToken(res.credential);
      // NÃO invalida o admin JWT em cache aqui. O admin JWT do backend
      // (8h, HS256, ver backend/auth.py) é independente do id_token Google
      // depois do mint inicial — o backend só revalida assinatura+exp do
      // próprio JWT, não o id_token. Antes da TTL de 8h e da persistência
      // em localStorage, o admin JWT vivia 30min e era invalidado aqui pra
      // forçar re-mint com o id_token novo. Hoje isso só causa re-mint
      // desnecessário a cada ~55min (jogando fora 7h+ de validade).
    }).then(scheduleNext).catch(() => {});

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [user]);

  const path = window.location.pathname;
  const isClient = path.startsWith("/report/");
  const clientToken = isClient ? path.replace("/report/", "") : null;
  // Rota /admin/client/:slug — drilldown do cliente. Único caso de "deep
  // link" admin com path-param. Não usamos React Router porque o app
  // tem só duas rotas profundas (esta + /report/) e o overhead da lib
  // não vale o ganho.
  const adminClientMatch = path.match(/^\/admin\/client\/([a-z0-9-]+)\/?$/i);
  const adminClientSlug  = adminClientMatch ? adminClientMatch[1].toLowerCase() : null;
  // Rota /admin/pmp — análise de deals de pagamento (PMP). Substitui a
  // planilha "HYPR Product Performance" no Google Sheets. Mesmo gate
  // do CampaignMenu (sessão admin @hypr.mobi).
  const isAdminPmp = path === "/admin/pmp" || path === "/admin/pmp/";
  // Quando o cliente desbloqueia, guardamos o short_token resolvido pelo
  // backend (que pode diferir do `clientToken` da URL no formato novo
  // /report/{share_id}). O state inicial é populado do localStorage para
  // sobreviver a refresh; `setResolvedToken` é chamado depois do unlock
  // pra cobrir o primeiro acesso.
  const [resolvedToken, setResolvedToken] = useState(() =>
    clientToken ? getResolvedShortToken(clientToken) : null
  );
  // DEMO bypass: vendedor abre `/report/DEMO` direto sem senha — payload
  // é mockado em shared/demoData.js, não há nada secreto pra proteger.
  const [unlocked, setUnlocked] = useState(() =>
    clientToken
      ? (isDemoToken(clientToken) || isClientUnlocked(clientToken))
      : false,
  );

  // Bootstrap do adminJwt vindo da URL (`?adm=`). É o "primeiro JWT" da aba
  // de report — mintado pelo menu admin no momento de abrir o link. Tem TTL
  // de 8h (ver backend/auth.py:JWT_TTL_SECONDS).
  const adminJwtFromUrl = isClient ? getAdminJwtFromUrl() : null;
  const initialUrlJwtValid = !!adminJwtFromUrl && !isJwtExpired(adminJwtFromUrl);

  // `adminJwt` é state — começa com o JWT da URL (se válido) e é renovado em
  // background via `getOrIssueAdminJwt()` (que agora persiste em
  // hypr.session.adminJwt e é independente do id_token Google após mint
  // inicial). Cobre o caso de aba aberta por > 8h (TTL do JWT) sem cache em
  // memória — antes, o user via "Não autorizado" no card de Google Sheets.
  const [adminJwt, setAdminJwt] = useState(() =>
    initialUrlJwtValid ? adminJwtFromUrl : null
  );
  const hasLegacyAk = isClient
    ? new URLSearchParams(window.location.search).get("ak") === "hypr2026"
    : false;
  // `isAdminMode` aceita: sessão admin local, JWT URL inicial válido (mesmo
  // que tenha expirado depois — a aba já assumiu identidade admin), JWT
  // renovado em state, ou `?ak=` legacy.
  const isAdminMode = !!user || initialUrlJwtValid || !!adminJwt || hasLegacyAk;

  // Renovação automática do adminJwt em background.
  //
  // Cobre o cenário: aba `/report/<token>?adm=<jwt>` aberta sem sessão admin
  // local (ex: link colado direto, ou aba que ficou aberta após o menu fechar).
  // O JWT da URL expira em 8h; sem isso, o user vê "Não autorizado" no card
  // de Google Sheets e em qualquer outra ação admin. Em background tabs o
  // setTimeout de horas é throttled pelo browser e pode não disparar — o
  // auto-retry em api.js cobre na próxima ação do user.
  //
  // Estratégia: agendar refresh ~1min antes do `exp`. A renovação usa o Google
  // id_token do localStorage (cross-tab, TTL 8h da sessão; o id_token em si é
  // ~1h mas é refrescado pelo effect anterior quando `user` existe).
  // Se o id_token não estiver disponível (ex: aba filha sem sessão Google),
  // a função retorna null silenciosamente — o JWT atual continua valendo até
  // expirar de fato; aí cai no fluxo normal de re-login.
  useEffect(() => {
    if (!isClient) return;
    if (!isAdminMode) return;

    let cancelled = false;
    let timeoutId = null;

    const renew = async () => {
      if (cancelled) return;
      const newJwt = await getOrIssueAdminJwt();
      if (cancelled) return;
      if (newJwt) {
        setAdminJwt(newJwt);
        const payload = decodeJwtPayload(newJwt);
        const expMs = payload?.exp ? Number(payload.exp) * 1000 : 0;
        // Renova 1min antes do exp; piso de 30s pra evitar stampede.
        const delayMs = Math.max(30_000, expMs - Date.now() - 60 * 1000);
        timeoutId = setTimeout(renew, delayMs);
      } else {
        // Sem id_token disponível (aba filha sem sessão Google, ou sessão
        // expirou). Tenta de novo em 1min — se o user re-logar em outra aba,
        // o id_token volta pro localStorage e a próxima tentativa funciona.
        timeoutId = setTimeout(renew, 60_000);
      }
    };

    // Bootstrap: se o JWT atual está válido por mais de 1min, agenda renovação
    // pra ~1min antes do exp. Senão, renova já.
    const currentJwt = adminJwt;
    const payload = currentJwt ? decodeJwtPayload(currentJwt) : null;
    const expMs = payload?.exp ? Number(payload.exp) * 1000 : 0;
    const remainingMs = expMs - Date.now();
    if (!currentJwt || remainingMs < 60 * 1000) {
      renew();
    } else {
      timeoutId = setTimeout(renew, Math.max(30_000, remainingMs - 60 * 1000));
    }

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
    // `adminJwt` intencionalmente fora das deps: o effect lê o valor inicial
    // pra agendar o primeiro refresh, e cada renovação re-agenda via timeoutId
    // dentro do mesmo ciclo do effect. Inclui-lo causaria re-execução e cancel
    // em cascata a cada setAdminJwt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClient, isAdminMode]);

  // Quando o admin abre uma URL com share_id direto (ex: "Link Cliente"
  // colado em outra aba enquanto ainda logado), o app pula a tela de
  // senha — mas o dashboard precisa do short_token canônico para chamar
  // os endpoints de dados. Resolve via endpoint admin antes de renderizar.
  const needsAdminLookup =
    isClient && isAdminMode && clientToken && isLikelyShareId(clientToken);
  const [adminLookup, setAdminLookup] = useState(() => ({
    loading: needsAdminLookup,
    token: null,
    error: false,
  }));

  useEffect(() => {
    if (!needsAdminLookup) return;
    let cancelled = false;
    setAdminLookup({ loading: true, token: null, error: false });
    lookupShare(clientToken).then((short) => {
      if (cancelled) return;
      if (short) {
        setAdminLookup({ loading: false, token: short, error: false });
      } else {
        setAdminLookup({ loading: false, token: null, error: true });
      }
    });
    return () => { cancelled = true; };
  }, [needsAdminLookup, clientToken]);

  if (isClient && clientToken) {
    if (!isAdminMode && !unlocked) {
      return (
        <ClientPasswordScreen
          token={clientToken}
          onUnlock={(shortToken) => {
            if (shortToken) setResolvedToken(shortToken);
            setUnlocked(true);
          }}
        />
      );
    }

    // Admin abrindo URL com share_id: aguarda lookup terminar.
    if (needsAdminLookup) {
      if (adminLookup.loading) return <LoadingShell />;
      if (adminLookup.error) {
        return (
          <div style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            color: "#fff",
            background: "#0d1117",
            fontFamily: "system-ui, sans-serif",
            textAlign: "center",
          }}>
            <div>
              <h2 style={{ marginBottom: 12 }}>Link inválido</h2>
              <p style={{ opacity: 0.7, fontSize: 14 }}>
                O share_id <code>{clientToken}</code> não foi encontrado.
              </p>
            </div>
          </div>
        );
      }
    }

    // Admin sempre abre via short_token na URL (fluxo do menu não muda).
    // Cliente pode estar com share_id na URL — usa o resolvedToken.
    const dashboardToken = isAdminMode
      ? (adminLookup.token || clientToken)
      : (resolvedToken || getResolvedShortToken(clientToken) || clientToken);

    const dashboardProps = {
      token: dashboardToken,
      isAdmin: isAdminMode,
      adminJwt: adminJwt,
    };

    return (
      <V2ErrorBoundary>
        <Suspense fallback={<LoadingShell />}>
          <ClientDashboard {...dashboardProps} />
        </Suspense>
      </V2ErrorBoundary>
    );
  }

  if (!user) {
    return (
      <Suspense fallback={<RouteSuspense />}>
        <LoginScreen onLogin={setUser} />
      </Suspense>
    );
  }

  // Ao clicar "Ver Report":
  //  • Tenta emitir um JWT custom de 5min via backend (modo novo).
  //  • Se backend ainda não tem o endpoint (404/erro), cai no ?ak= legacy
  //    para não quebrar o fluxo durante o período de rollout.
  const onOpenReport = async (t) => {
    const idToken = getGoogleIdToken();
    if (idToken) {
      const issued = await issueAdminJwt(idToken);
      if (issued?.token) {
        window.open(`/report/${t}?adm=${encodeURIComponent(issued.token)}`, "_blank");
        return;
      }
    }
    // Fallback: link legacy. Pode acontecer em três casos:
    //  • Backend ainda não foi redeployado com o endpoint issue_admin_token.
    //  • id_token do Google expirou (TTL de 1h sem refresh).
    //  • Rede caiu na hora — usuário abre o link mesmo assim.
    window.open(`/report/${t}?ak=hypr2026`, "_blank");
  };

  const onLogout = () => {
    clearSession();
    clearCachedAdminJwt();
    setUser(null);
  };

  // Navegação client-side leve. Usa history.pushState pra evitar full
  // reload — drilldown e back ficam instantâneos. Quando React Router
  // entrar (eventualmente), substitui isso.
  const goToClient = (slug) => {
    window.history.pushState({}, "", `/admin/client/${slug}`);
    // Força re-render do App lendo location.pathname.
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const goHome = () => {
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  // Rota /admin/pmp — análise de deals PMP. Mesma topbar do menu,
  // botão "Voltar" leva pro CampaignMenu (goHome).
  if (isAdminPmp) {
    return (
      <Suspense fallback={<RouteSuspense />}>
        <PmpDealsPage user={user} onLogout={onLogout} onBackToMenu={goHome} />
      </Suspense>
    );
  }

  // Drilldown do cliente. `key={slug}` força remount quando o slug muda
  // (ex: navegação via back+forward entre dois clientes), zerando state
  // local e refazendo o fetch — equivalente a setLoading(true) sem ferir
  // a regra react-hooks/set-state-in-effect.
  if (adminClientSlug) {
    return (
      <Suspense fallback={<RouteSuspense />}>
        <ClientDetailPage
          key={adminClientSlug}
          slug={adminClientSlug}
          user={user}
          onLogout={onLogout}
          onBack={goHome}
          onOpenReport={onOpenReport}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<RouteSuspense />}>
      <CampaignMenu
        user={user}
        onLogout={onLogout}
        onOpenReport={onOpenReport}
        onOpenClient={goToClient}
      />
    </Suspense>
  );
}
