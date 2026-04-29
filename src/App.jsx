import { lazy, Suspense, useState } from "react";
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
} from "./shared/auth";

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
  const [unlocked, setUnlocked] = useState(() =>
    clientToken ? isClientUnlocked(clientToken) : false
  );
  // Resolução do toggle Legacy ↔ V2. Chamado no topo do componente para
  // respeitar a regra de hooks do React (mesmo que useReportVersion seja
  // hoje uma função pura, manter como hook prepara o terreno se um dia
  // precisar de useSyncExternalStore para reatividade ao localStorage).
  const reportVersion = useReportVersion();

  if (isClient && clientToken) {
    // Modo admin determinado por (em ordem):
    //   1. Sessão local — quem logou e abriu o report na mesma aba.
    //   2. JWT admin via ?adm=<jwt> — emitido pelo backend, viaja na URL
    //      quando o menu abre o report em nova aba.
    //   3. Legacy ?ak=hypr2026 — fallback para links antigos durante a
    //      transição. Removido depois que a migração completar.
    const adminJwt = getAdminJwtFromUrl();
    const hasValidAdminJwt = !!adminJwt && !isJwtExpired(adminJwt);
    const hasLegacyAk = new URLSearchParams(window.location.search).get("ak") === "hypr2026";
    const _isAdmin = !!user || hasValidAdminJwt || hasLegacyAk;
    if (!_isAdmin && !unlocked) {
      return (
        <Suspense fallback={<RouteSuspense />}>
          <ClientPasswordScreen token={clientToken} onUnlock={() => setUnlocked(true)} />
        </Suspense>
      );
    }

    // Roteamento Legacy ↔ V2 controlado por src/shared/version.js.
    // Default permanece 'legacy' até a Fase 7. O cliente só vê o V2 se
    // chegar com ?v=v2 na URL ou já tiver feito opt-in numa sessão
    // anterior. O ErrorBoundary do V2 captura crashes, registra no
    // GA via gaEvent('v2_crash'), força localStorage='legacy' e
    // recarrega — cliente nunca vê tela branca.
    const dashboardProps = {
      token: clientToken,
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
