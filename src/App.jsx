import { useState } from "react";
import LoginScreen from "./pages/LoginScreen";
import ClientPasswordScreen from "./pages/ClientPasswordScreen";
import CampaignMenu from "./pages/CampaignMenu";
import ClientDashboard from "./pages/ClientDashboard";
import {
  getAdminJwtFromUrl,
  isJwtExpired,
  getGoogleIdToken,
  issueAdminJwt,
  setGoogleIdToken,
  clearCachedAdminJwt,
} from "./shared/auth";

export default function App() {
  const [user, setUser] = useState(null);
  const [unlocked, setUnlocked] = useState(false);
  const path = window.location.pathname;
  const isClient = path.startsWith("/report/");
  const clientToken = isClient ? path.replace("/report/", "") : null;

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
    if (!_isAdmin && !unlocked) return <ClientPasswordScreen token={clientToken} onUnlock={() => setUnlocked(true)} />;
    return <ClientDashboard token={clientToken} isAdmin={_isAdmin} adminJwt={hasValidAdminJwt ? adminJwt : null} />;
  }

  if (!user) return <LoginScreen onLogin={setUser} />;

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
    setGoogleIdToken(null);
    clearCachedAdminJwt();
    setUser(null);
  };

  return <CampaignMenu user={user} onLogout={onLogout} onOpenReport={onOpenReport} />;
}
