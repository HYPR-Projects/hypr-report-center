import { lazy, Suspense, useEffect, useState } from "react";
import RouteSuspense from "./components/RouteSuspense";
import LoadingShell from "./components/LoadingShell";
import V2ErrorBoundary from "./v2/components/ErrorBoundary";
import ClientPasswordScreen from "./pages/ClientPasswordScreen";
import {
  getAdminJwtFromUrl,
  isJwtExpired,
  getGoogleIdToken,
  issueAdminJwt,
  clearCachedAdminJwt,
  loadSession,
  clearSession,
  isClientUnlocked,
  getResolvedShortToken,
} from "./shared/auth";
import { lookupShare } from "./lib/api";

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

  const path = window.location.pathname;
  const isClient = path.startsWith("/report/");
  const clientToken = isClient ? path.replace("/report/", "") : null;
  // Rota /admin/client/:slug — drilldown do cliente. Único caso de "deep
  // link" admin com path-param. Não usamos React Router porque o app
  // tem só duas rotas profundas (esta + /report/) e o overhead da lib
  // não vale o ganho.
  const adminClientMatch = path.match(/^\/admin\/client\/([a-z0-9-]+)\/?$/i);
  const adminClientSlug  = adminClientMatch ? adminClientMatch[1].toLowerCase() : null;
  // Quando o cliente desbloqueia, guardamos o short_token resolvido pelo
  // backend (que pode diferir do `clientToken` da URL no formato novo
  // /report/{share_id}). O state inicial é populado do localStorage para
  // sobreviver a refresh; `setResolvedToken` é chamado depois do unlock
  // pra cobrir o primeiro acesso.
  const [resolvedToken, setResolvedToken] = useState(() =>
    clientToken ? getResolvedShortToken(clientToken) : null
  );
  const [unlocked, setUnlocked] = useState(() =>
    clientToken ? isClientUnlocked(clientToken) : false
  );

  // Computa status admin sincronamente — usado tanto no effect abaixo
  // quanto na renderização condicional.
  const adminJwtFromUrl = isClient ? getAdminJwtFromUrl() : null;
  const hasValidAdminJwt = !!adminJwtFromUrl && !isJwtExpired(adminJwtFromUrl);
  const hasLegacyAk = isClient
    ? new URLSearchParams(window.location.search).get("ak") === "hypr2026"
    : false;
  const isAdminMode = !!user || hasValidAdminJwt || hasLegacyAk;

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
      adminJwt: hasValidAdminJwt ? adminJwtFromUrl : null,
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
