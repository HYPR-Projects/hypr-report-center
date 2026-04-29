import { lazy, Suspense, useEffect, useState } from "react";
import RouteSuspense from "./components/RouteSuspense";
import V2ErrorBoundary from "./v2/components/ErrorBoundary";
import { useReportVersion } from "./shared/version";
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

// ── Code-splitting (Fase 4 · PR-21) ─────────────────────────────────────
// Cada rota é um chunk próprio. O bundle inicial cai de ~975 kB pra
// apenas o que App.jsx + auth + version + ErrorBoundary precisam.
//
// Por que importar ErrorBoundary V2 estático
//   ErrorBoundary deve estar disponível ANTES do componente que ele
//   protege carregar — caso contrário, se o lazy do V2 falhar (chunk
//   404 por deploy stale, rede caiu), não há boundary pra capturar.
//   ErrorBoundary é leve (~3kB) então fica no bundle inicial.
//
// Por que getAdminJwt / loadSession / etc também ficam estáticos
//   São utilitários sync usados antes do lazy resolver. Tentar
//   lazy-loadar shared/auth criaria um await desnecessário no caminho
//   crítico.
const LoginScreen          = lazy(() => import("./pages/LoginScreen"));
const ClientPasswordScreen = lazy(() => import("./pages/ClientPasswordScreen"));
const CampaignMenu         = lazy(() => import("./pages/CampaignMenu"));
const ClientDashboard      = lazy(() => import("./pages/ClientDashboard"));
const ClientDashboardV2    = lazy(() => import("./v2/dashboards/ClientDashboardV2"));

export default function App() {
  // Restaura sessão admin (8h TTL) e unlock de cliente direto do localStorage
  // para que um refresh não derrube o login.
  const [user, setUser] = useState(() => loadSession()?.user || null);
  const path = window.location.pathname;
  const isClient = path.startsWith("/report/");
  const clientToken = isClient ? path.replace("/report/", "") : null;
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

  // Resolução do toggle Legacy ↔ V2. Chamado no topo do componente para
  // respeitar a regra de hooks do React (mesmo que useReportVersion seja
  // hoje uma função pura, manter como hook prepara o terreno se um dia
  // precisar de useSyncExternalStore para reatividade ao localStorage).
  const reportVersion = useReportVersion();

  if (isClient && clientToken) {
    if (!isAdminMode && !unlocked) {
      return (
        <Suspense fallback={<RouteSuspense />}>
          <ClientPasswordScreen
            token={clientToken}
            onUnlock={(shortToken) => {
              if (shortToken) setResolvedToken(shortToken);
              setUnlocked(true);
            }}
          />
        </Suspense>
      );
    }

    // Admin abrindo URL com share_id: aguarda lookup terminar.
    if (needsAdminLookup) {
      if (adminLookup.loading) return <RouteSuspense />;
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
    const adminJwt = adminJwtFromUrl;
    const _isAdmin = isAdminMode;
    const dashboardToken = _isAdmin
      ? (adminLookup.token || clientToken)
      : (resolvedToken || getResolvedShortToken(clientToken) || clientToken);

    // Roteamento Legacy ↔ V2 controlado por src/shared/version.js.
    // Default permanece 'legacy' até a Fase 7. O cliente só vê o V2 se
    // chegar com ?v=v2 na URL ou já tiver feito opt-in numa sessão
    // anterior. O ErrorBoundary do V2 captura crashes, registra no
    // GA via gaEvent('v2_crash'), força localStorage='legacy' e
    // recarrega — cliente nunca vê tela branca.
    const dashboardProps = {
      token: dashboardToken,
      isAdmin: _isAdmin,
      adminJwt: hasValidAdminJwt ? adminJwt : null,
    };
    if (reportVersion === "v2") {
      return (
        <V2ErrorBoundary>
          <Suspense fallback={<RouteSuspense />}>
            <ClientDashboardV2 {...dashboardProps} />
          </Suspense>
        </V2ErrorBoundary>
      );
    }
    return (
      <Suspense fallback={<RouteSuspense />}>
        <ClientDashboard {...dashboardProps} />
      </Suspense>
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

  return (
    <Suspense fallback={<RouteSuspense />}>
      <CampaignMenu user={user} onLogout={onLogout} onOpenReport={onOpenReport} />
    </Suspense>
  );
}
