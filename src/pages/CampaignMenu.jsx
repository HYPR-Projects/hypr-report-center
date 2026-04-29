import { useState, useEffect } from "react";
import { C, CL } from "../shared/theme";
import {
  getTheme,
  setTheme,
  getOwnerFilter,
  setOwnerFilter as persistOwnerFilter,
} from "../shared/prefs";
import { listCampaigns, listTeamMembers } from "../lib/api";
import GlobalStyle from "../components/GlobalStyle";
import Spinner from "../components/Spinner";
import HyprReportCenterLogo from "../components/HyprReportCenterLogo";
import MonthGroup from "../components/MonthGroup";
import NewCampaignModal from "../components/modals/NewCampaignModal";
import LoomModal from "../components/modals/LoomModal";
import SurveyModal from "../components/modals/SurveyModal";
import LogoModal from "../components/modals/LogoModal";
import OwnerModal from "../components/modals/OwnerModal";

const CampaignMenu = ({ user, onLogout, onOpenReport }) => {
  const [campaigns,     setCampaigns]     = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [search,        setSearch]        = useState("");
  const [copied,        setCopied]        = useState(null);

  // Modais — cada um aberto/fechado via flag aqui no pai. State interno
  // (URL, blocks, file, etc.) vive dentro do próprio modal.
  const [showNewCampaign, setShowNewCampaign] = useState(false);
  const [loomModal,       setLoomModal]       = useState(null); // shortToken | null
  const [surveyModal,     setSurveyModal]     = useState(null); // shortToken | null
  const [logoModal,       setLogoModal]       = useState(null); // shortToken | null
  const [ownerModal,      setOwnerModal]      = useState(null); // { short_token, client_name, cp_email, cs_email } | null

  // New UI state
  const [isDark,       setIsDark]       = useState(() => getTheme() === "dark");
  const [sortBy,       setSortBy]       = useState("month");   // "month" | "start_date" | "alpha"
  const [sortAsc,      setSortAsc]      = useState(false);
  const [activeMonth,  setActiveMonth]  = useState(null);      // quick-access filter

  // Persiste a escolha de tema entre sessões (compartilhada com ClientDashboard).
  useEffect(() => { setTheme(isDark ? "dark" : "light"); }, [isDark]);

  // Owners — admin only
  const [teamMembers, setTeamMembers] = useState({ cps: [], css: [] });
  const [ownerFilter, setOwnerFilter] = useState(() => getOwnerFilter()); // email selecionado, "" = todos

  // Persiste o owner selecionado entre sessões.
  useEffect(() => { persistOwnerFilter(ownerFilter); }, [ownerFilter]);

  // teamMap: email → display name (usado pelo CampaignCard pra mostrar nome curto nos chips)
  const teamMap = {};
  teamMembers.cps.forEach(p => { teamMap[p.email] = p.name; });
  teamMembers.css.forEach(p => { teamMap[p.email] = p.name; });

  useEffect(() => { fetchList(); }, []);

  // Carrega lista de CPs/CSs (lê external table → planilha de De-Para).
  // Roda em paralelo com fetchList — sem bloquear render do menu.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const members = await listTeamMembers();
      if (!cancelled) {
        setTeamMembers(members);
        // Se o filtro persistido aponta pra um email que não existe mais
        // (pessoa saiu da equipe, email mudou), limpa pra evitar dropdown
        // em estado inválido.
        const validEmails = new Set([
          ...members.cps.map(p => p.email),
          ...members.css.map(p => p.email),
        ]);
        setOwnerFilter(prev => (prev && !validEmails.has(prev) ? "" : prev));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const openOwnerModal = (campaign) => {
    setOwnerModal({
      short_token: campaign.short_token,
      client_name: campaign.client_name,
      cp_email:    campaign.cp_email || "",
      cs_email:    campaign.cs_email || "",
    });
  };

  /**
   * Após save bem-sucedido do OwnerModal, atualiza a campanha localmente
   * pra evitar re-fetch da lista inteira.
   */
  const handleOwnerSaved = (updated) => {
    setCampaigns(prev => prev.map(c =>
      c.short_token === updated.short_token
        ? { ...c, cp_email: updated.cp_email, cs_email: updated.cs_email }
        : c
    ));
    setOwnerModal(null);
  };

  const fetchList = async () => {
    setLoading(true);
    try {
      const deduped = await listCampaigns();
      setCampaigns(deduped);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Após confirm bem-sucedido do NewCampaignModal, insere a campanha no topo
   * da lista local (se ainda não estiver). Modal já tratou save do logo.
   */
  const handleNewCampaignConfirm = (tokenData) => {
    if (!campaigns.find(c => c.short_token === tokenData.short_token)) {
      setCampaigns(p => [tokenData, ...p]);
    }
    setShowNewCampaign(false);
  };

  const copyLink = (token) => {
    navigator.clipboard.writeText(`${window.location.origin}/report/${token}`);
    setCopied(token); setTimeout(() => setCopied(null), 2000);
  };

  const openLoomModal  = (token) => setLoomModal(token);
  const openLogoModal  = (token) => setLogoModal(token);

  // ── Theme vars ──
  const bg     = isDark ? C.dark  : CL.bg;
  const bg2    = isDark ? C.dark2 : CL.bg2;
  const bg3    = isDark ? C.dark3 : CL.bg3;
  const border = isDark ? C.dark3 : CL.border;
  const text   = isDark ? C.white : CL.text;
  const muted  = isDark ? C.muted : CL.muted;

  // ── Filtering + sorting ──
  const filtered = campaigns.filter(c => {
    const q = search.trim();
    const ql = q.toLowerCase();
    // Token: contém traço OU é todo maiúsculo (ex: UT10QW, 6BVGU6Q)
    const isTokenQuery = /[-]/.test(q) || /^[A-Z0-9]{4,8}$/.test(q);
    const matchSearch = !q ||
      c.client_name?.toLowerCase().includes(ql) ||
      c.campaign_name?.toLowerCase().includes(ql) ||
      (isTokenQuery && c.short_token?.toLowerCase().includes(ql));
    const matchMonth = !activeMonth ||
      (c.start_date && c.start_date.slice(0, 7) === activeMonth);
    // Owner filter: email selecionado precisa bater com cp OU cs do report
    const matchOwner = !ownerFilter ||
      c.cp_email === ownerFilter ||
      c.cs_email === ownerFilter;
    return matchSearch && matchMonth && matchOwner;
  });

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortBy === "alpha")      cmp = (a.client_name || "").localeCompare(b.client_name || "");
    else if (sortBy === "start_date") cmp = (a.start_date || "").localeCompare(b.start_date || "");
    else cmp = (b.start_date || "").localeCompare(a.start_date || ""); // month: newest first default
    return sortAsc ? cmp : -cmp;
  });

  // ── Month groups ──
  const groups = sorted.reduce((acc, c) => {
    const raw = c.start_date || "";
    const [year, month] = raw.split("-").map(Number);
    const key   = year && month ? `${year}-${String(month).padStart(2, "0")}` : "Sem data";
    const label = year && month
      ? new Date(year, month - 1, 1).toLocaleString("pt-BR", { month: "long", year: "numeric" }).replace(/^\w/, l => l.toUpperCase())
      : "Sem data";
    if (!acc[key]) acc[key] = { label, items: [] };
    acc[key].items.push(c);
    return acc;
  }, {});

  // Unique months for quick access
  const allMonths = Object.keys(campaigns.reduce((acc, c) => {
    if (c.start_date) acc[c.start_date.slice(0, 7)] = true; return acc;
  }, {})).sort((a, b) => b.localeCompare(a));

  const cardProps = {
    onOpenReport,
    onLoom:     openLoomModal,
    onSurvey:   (t) => setSurveyModal(t),
    onLogo:     openLogoModal,
    onCopyLink: copyLink,
    onOwner:    openOwnerModal,
    copied,
    isDark,
    teamMap,
  };

  // Modal style helper — agrupa as cores que os modais consomem em um objeto
  // único pra reduzir prop drilling. Os modais usam estes nomes literais
  // (modalBg, modalBdr, inputBg, text, muted) — não renomear sem ajustar lá.
  const modalBg  = isDark ? C.dark2 : CL.bg2;
  const modalBdr = isDark ? C.dark3 : CL.border;
  const inputBg  = isDark ? C.dark3 : CL.bg3;
  const modalTheme = { modalBg, modalBdr, inputBg, text, muted };

  return (
    <div style={{ minHeight: "100vh", width: "100%", background: bg, transition: "background 0.3s" }}>
      <GlobalStyle/>
      {/* Dynamic light-mode override */}
      {!isDark && <style>{`body{background:${CL.bg}!important;color:${CL.text}!important;}`}</style>}

      {/* ── Header ── */}
      <div style={{
        background: bg2,
        borderBottom: `1px solid ${border}`,
        padding: "0 32px",
        height: 64,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "sticky",
        top: 0,
        zIndex: 100,
        width: "100%",
        transition: "background 0.3s, border-color 0.3s",
      }}>
        <div style={{display:"flex",alignItems:"center",color:isDark?"#FFFFFF":"#0F1419"}}>
          <HyprReportCenterLogo height={22}/>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Theme toggle */}
          <button
            onClick={() => setIsDark(v => !v)}
            title={isDark ? "Modo claro" : "Modo escuro"}
            style={{
              background: bg3,
              border: `1px solid ${border}`,
              color: muted,
              width: 36,
              height: 36,
              borderRadius: 9,
              cursor: "pointer",
              fontSize: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.2s",
            }}
          >{isDark ? "☀️" : "🌙"}</button>
          <img src={user.picture} alt="" referrerPolicy="no-referrer"
            style={{ width: 32, height: 32, borderRadius: "50%", border: `2px solid ${C.blue}` }}/>
          <span style={{ fontSize: 13, color: muted }}>{user.name}</span>
          <button onClick={onLogout} style={{
            background: "none",
            border: `1px solid ${border}`,
            color: muted,
            padding: "6px 14px",
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 12,
          }}>Sair</button>
        </div>
      </div>

      {/* ── Main content ── */}
      <div style={{ width: "100%", maxWidth: 1400, margin: "0 auto", padding: "36px 24px" }}>

        {/* Title + New Report */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 16 }}>
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 800, color: text }}>Reports de Campanhas</h1>
            <p style={{ color: muted, fontSize: 13, marginTop: 4 }}>{campaigns.length} campanhas em 2026</p>
          </div>
          <button onClick={() => setShowNewCampaign(true)} style={{
            background: C.blue,
            color: "#fff",
            border: "none",
            padding: "11px 22px",
            borderRadius: 10,
            cursor: "pointer",
            fontSize: 14,
            fontWeight: 700,
            transition: "background 0.15s",
          }}
            onMouseEnter={e => e.currentTarget.style.background = C.blueDark}
            onMouseLeave={e => e.currentTarget.style.background = C.blue}
          >+ Novo Report</button>
        </div>

        {/* ── Quick month access ── */}
        {allMonths.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 600, marginBottom: 10 }}>Acesso Rápido por Mês</div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              <button
                onClick={() => setActiveMonth(null)}
                style={{
                  background: activeMonth === null ? C.blue : bg3,
                  color:      activeMonth === null ? "#fff" : muted,
                  border:     `1px solid ${activeMonth === null ? C.blue : border}`,
                  padding:    "6px 14px",
                  borderRadius: 20,
                  cursor:     "pointer",
                  fontSize:   12,
                  fontWeight: 600,
                  transition: "all 0.15s",
                }}
              >Todos</button>
              {allMonths.map(m => {
                const [y, mo] = m.split("-").map(Number);
                const label = new Date(y, mo - 1, 1).toLocaleString("pt-BR", { month: "short", year: "2-digit" });
                const count = campaigns.filter(c => c.start_date?.startsWith(m)).length;
                const isActive = activeMonth === m;
                return (
                  <button key={m} onClick={() => setActiveMonth(isActive ? null : m)} style={{
                    background: isActive ? C.blue : bg3,
                    color:      isActive ? "#fff" : muted,
                    border:     `1px solid ${isActive ? C.blue : border}`,
                    padding:    "6px 14px",
                    borderRadius: 20,
                    cursor:     "pointer",
                    fontSize:   12,
                    fontWeight: 600,
                    transition: "all 0.15s",
                    display:    "flex",
                    alignItems: "center",
                    gap:        5,
                  }}>
                    {label.charAt(0).toUpperCase() + label.slice(1)}
                    <span style={{
                      background: isActive ? "rgba(255,255,255,0.25)" : (isDark ? C.dark2 : CL.border),
                      borderRadius: 10,
                      padding: "1px 6px",
                      fontSize: 10,
                      fontWeight: 700,
                    }}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Search + Sort bar ── */}
        <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", flex: 1, minWidth: 240 }}>
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: muted, fontSize: 14 }}>🔍</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por cliente, campanha ou token..."
              style={{
                width: "100%",
                background: bg2,
                border: `1px solid ${border}`,
                borderRadius: 10,
                padding: "12px 16px 12px 40px",
                color: text,
                fontSize: 14,
                outline: "none",
                transition: "border-color 0.2s",
              }}
              onFocus={e => e.target.style.borderColor = C.blue}
              onBlur={e => e.target.style.borderColor = border}
            />
          </div>

          {/* Owner filter — agrupado por CP / CS no select.
              Wrapper div com SVG ao lado em vez de background-image inline,
              que tava tendo glitch de pattern repetido em alguns browsers. */}
          <div style={{ position: "relative", display: "inline-block" }}>
            <select
              value={ownerFilter}
              onChange={e => setOwnerFilter(e.target.value)}
              title="Filtrar por owner HYPR"
              style={{
                backgroundColor: ownerFilter ? `${C.blue}18` : bg2,
                color:      ownerFilter ? C.blue : text,
                border:     `1px solid ${ownerFilter ? C.blue + "40" : border}`,
                padding:    "10px 32px 10px 14px",
                borderRadius: 10,
                cursor:     "pointer",
                fontSize:   13,
                fontWeight: 600,
                minWidth:   170,
                outline:    "none",
                appearance: "none",
                WebkitAppearance: "none",
                MozAppearance: "none",
                fontFamily: "inherit",
              }}
            >
              <option value="">👤 Todos os owners</option>
              {teamMembers.cps.length > 0 && (
                <optgroup label="CPs (Comercial)">
                  {teamMembers.cps.map(p => (
                    <option key={`cp-${p.email}`} value={p.email}>{p.name}</option>
                  ))}
                </optgroup>
              )}
              {teamMembers.css.length > 0 && (
                <optgroup label="CSs (Customer Success)">
                  {teamMembers.css.map(p => (
                    <option key={`cs-${p.email}`} value={p.email}>{p.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
            {/* Setinha — pointer-events:none pra não bloquear cliques no select */}
            <svg
              width="10" height="6" viewBox="0 0 10 6"
              style={{
                position: "absolute",
                right: 12,
                top: "50%",
                transform: "translateY(-50%)",
                pointerEvents: "none",
              }}
            >
              <path d="M0 0l5 6 5-6z" fill={ownerFilter ? C.blue : muted} />
            </svg>
          </div>

          {/* Sort buttons */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Ordenar:</span>
            {[
              { key: "month",      label: "Mês" },
              { key: "start_date", label: "Data início" },
              { key: "alpha",      label: "A–Z" },
            ].map(s => {
              const isActive = sortBy === s.key;
              return (
                <button key={s.key} onClick={() => {
                  if (sortBy === s.key) setSortAsc(v => !v);
                  else { setSortBy(s.key); setSortAsc(false); }
                }} style={{
                  background: isActive ? `${C.blue}18` : bg3,
                  color:      isActive ? C.blue : muted,
                  border:     `1px solid ${isActive ? C.blue + "40" : border}`,
                  padding:    "7px 13px",
                  borderRadius: 8,
                  cursor:     "pointer",
                  fontSize:   12,
                  fontWeight: 600,
                  display:    "flex",
                  alignItems: "center",
                  gap:        4,
                  transition: "all 0.15s",
                }}>
                  {s.label}
                  {isActive && (
                    <span style={{ fontSize: 10 }}>{sortAsc ? "↑" : "↓"}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Campaign list ── */}
        {loading
          ? <div style={{ textAlign: "center", padding: 80 }}><Spinner size={40}/></div>
          : sorted.length === 0
            ? <div style={{ textAlign: "center", padding: 80, color: muted }}>
                {activeMonth ? "Sem campanhas neste mês." : "Nenhuma campanha encontrada."}
              </div>
            : (
              <div>
                {Object.entries(groups)
                  .sort(([a], [b]) => sortBy === "month" ? (sortAsc ? a.localeCompare(b) : b.localeCompare(a)) : 0)
                  .map(([key, { label, items }], gi) => (
                    <MonthGroup
                      key={key}
                      label={label}
                      items={items}
                      defaultOpen={gi === 0}
                      isDark={isDark}
                      {...cardProps}
                    />
                  ))
                }
              </div>
            )
        }
      </div>

      {/* ══ MODALS ══════════════════════════════════════════════════════════ */}
      {/* Cada modal é um componente separado em src/components/modals/.
          O CampaignMenu só sabe se está aberto/fechado; state interno
          (URL digitada, blocks de survey, file selecionado) vive lá dentro. */}

      {showNewCampaign && (
        <NewCampaignModal
          theme={modalTheme}
          onClose={() => setShowNewCampaign(false)}
          onConfirm={handleNewCampaignConfirm}
        />
      )}

      {loomModal && (
        <LoomModal
          shortToken={loomModal}
          theme={modalTheme}
          onClose={() => setLoomModal(null)}
          onSaved={() => setLoomModal(null)}
        />
      )}

      {surveyModal && (
        <SurveyModal
          shortToken={surveyModal}
          theme={modalTheme}
          onClose={() => setSurveyModal(null)}
          onSaved={() => setSurveyModal(null)}
        />
      )}

      {logoModal && (
        <LogoModal
          shortToken={logoModal}
          theme={modalTheme}
          onClose={() => setLogoModal(null)}
          onSaved={() => setLogoModal(null)}
        />
      )}

      {ownerModal && (
        <OwnerModal
          campaign={ownerModal}
          teamMembers={teamMembers}
          theme={modalTheme}
          onClose={() => setOwnerModal(null)}
          onSaved={handleOwnerSaved}
        />
      )}
    </div>
  );
};
// ══════════════════════════════════════════════════════════════════════════════

export default CampaignMenu;
