import { useState } from "react";
import LoginScreen from "./pages/LoginScreen";
import ClientPasswordScreen from "./pages/ClientPasswordScreen";
import CampaignMenu from "./pages/CampaignMenu";
import ClientDashboard from "./pages/ClientDashboard";

export default function App() {
  const [user, setUser] = useState(null);
  const [unlocked, setUnlocked] = useState(false);
  const path = window.location.pathname;
  const isClient = path.startsWith("/report/");
  const clientToken = isClient ? path.replace("/report/", "") : null;

  if (isClient && clientToken) {
    const _isAdmin = !!user || new URLSearchParams(window.location.search).get("ak") === "hypr2026";
    if (!_isAdmin && !unlocked) return <ClientPasswordScreen token={clientToken} onUnlock={() => setUnlocked(true)} />;
    return <ClientDashboard token={clientToken} isAdmin={_isAdmin} />;
  }
  if (!user) return <LoginScreen onLogin={setUser} />;
  return <CampaignMenu user={user} onLogout={() => setUser(null)} onOpenReport={t => window.open(`/report/${t}?ak=hypr2026`, "_blank")} />;
}
