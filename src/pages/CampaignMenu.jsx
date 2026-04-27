import { useState, useEffect } from "react";
import { API_URL } from "../shared/config";
import { C, CL } from "../shared/theme";
import { getOrIssueAdminJwt, adminAuthHeaders } from "../shared/auth";
import GlobalStyle from "../components/GlobalStyle";
import Spinner from "../components/Spinner";
import HyprLogo from "../components/HyprLogo";
import MonthGroup from "../components/MonthGroup";

const CampaignMenu = ({ user, onLogout, onOpenReport }) => {
  const [campaigns,     setCampaigns]     = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [search,        setSearch]        = useState("");
  const [showModal,     setShowModal]     = useState(false);
  const [newToken,      setNewToken]      = useState("");
  const [tokenData,     setTokenData]     = useState(null);
  const [logoFile,      setLogoFile]      = useState(null);
  const [logoPreview,   setLogoPreview]   = useState(null);
  const [checking,      setChecking]      = useState(false);
  const [copied,        setCopied]        = useState(null);
  const [loomModal,     setLoomModal]     = useState(null);
  const [loomUrl,       setLoomUrl]       = useState("");
  const [savingLoom,    setSavingLoom]    = useState(false);
  const [surveyModal,   setSurveyModal]   = useState(null);
  const [savingSurvey,  setSavingSurvey]  = useState(false);
  const [surveyBlocks,  setSurveyBlocks]  = useState([{ nome: "", ctrlUrl: "", expUrl: "", focusRow: "" }]);
  const [logoModal,     setLogoModal]     = useState(null);
  const [logoModalFile, setLogoModalFile] = useState(null);
  const [logoModalPreview, setLogoModalPreview] = useState(null);
  const [savingLogoModal,  setSavingLogoModal]  = useState(false);

  // New UI state
  const [isDark,       setIsDark]       = useState(true);
  const [sortBy,       setSortBy]       = useState("month");   // "month" | "start_date" | "alpha"
  const [sortAsc,      setSortAsc]      = useState(false);
  const [activeMonth,  setActiveMonth]  = useState(null);      // quick-access filter

  useEffect(() => { fetchList(); }, []);

  const fetchList = async () => {
    setLoading(true);
    try {
      const jwt = await getOrIssueAdminJwt();
      const r = await fetch(`${API_URL}?list=true`, {
        headers: { ...adminAuthHeaders(jwt) },
      });
      const d = await r.json();
      const raw = d.campaigns || [];
      const seen = new Set();
      const deduped = raw.filter(c => {
        if (seen.has(c.short_token)) return false;
        seen.add(c.short_token);
        return true;
      });
      setCampaigns(deduped);
    } catch { setCampaigns([]); }
    finally { setLoading(false); }
  };

  const checkToken = async () => {
    if (!newToken.trim()) return; setChecking(true);
    try {
      const r = await fetch(`${API_URL}?token=${newToken.trim()}`);
      const d = await r.json();
      if (d.campaign) setTokenData(d.campaign); else alert("Token não encontrado.");
    } catch { alert("Erro ao buscar token."); } finally { setChecking(false); }
  };

  const confirm = async () => {
    if (!tokenData) return;
    if (logoPreview) {
      try {
        const jwt = await getOrIssueAdminJwt();
        await fetch(`${API_URL}?action=save_logo`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...adminAuthHeaders(jwt) },
          body: JSON.stringify({ short_token: tokenData.short_token, logo_base64: logoPreview }),
        });
      } catch (e) { console.warn("Erro ao salvar logo", e); }
    }
    if (!campaigns.find(c => c.short_token === tokenData.short_token)) setCampaigns(p => [tokenData, ...p]);
    setShowModal(false); setNewToken(""); setTokenData(null); setLogoFile(null); setLogoPreview(null);
  };

  const copyLink = (token) => {
    navigator.clipboard.writeText(`${window.location.origin}/report/${token}`);
    setCopied(token); setTimeout(() => setCopied(null), 2000);
  };

  const openLoomModal = (token) => { setLoomModal(token); setLoomUrl(""); };

  const saveLoom = async () => {
    if (!loomUrl.trim()) return;
    setSavingLoom(true);
    try {
      const jwt = await getOrIssueAdminJwt();
      await fetch(`${API_URL}?action=save_loom`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminAuthHeaders(jwt) },
        body: JSON.stringify({ short_token: loomModal, loom_url: loomUrl.trim() }),
      });
      alert("Loom salvo com sucesso!"); setLoomModal(null); setLoomUrl("");
    } catch { alert("Erro ao salvar Loom."); } finally { setSavingLoom(false); }
  };

  const saveSurvey = async () => {
    setSavingSurvey(true);
    try {
      for (const b of surveyBlocks) {
        if (!b.ctrlUrl.trim() || !b.expUrl.trim()) { alert("Preencha os dois links em todas as perguntas."); setSavingSurvey(false); return; }
        if (!b.nome.trim()) { alert("Preencha o nome de todas as perguntas."); setSavingSurvey(false); return; }
      }
      const payload = surveyBlocks.map(b => {
        const out = { nome: b.nome.trim(), ctrlUrl: b.ctrlUrl.trim(), expUrl: b.expUrl.trim() };
        if (b.focusRow && b.focusRow.trim()) out.focusRow = b.focusRow.trim();
        return out;
      });
      const jwt = await getOrIssueAdminJwt();
      await fetch(`${API_URL}?action=save_survey`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminAuthHeaders(jwt) },
        body: JSON.stringify({ short_token: surveyModal, survey_data: JSON.stringify(payload) }),
      });
      alert("Survey salvo com sucesso!"); setSurveyModal(null); setSurveyBlocks([{ nome: "", ctrlUrl: "", expUrl: "", focusRow: "" }]);
    } catch { alert("Erro ao salvar survey."); } finally { setSavingSurvey(false); }
  };

  const openLogoModal = (token) => { setLogoModal(token); setLogoModalFile(null); setLogoModalPreview(null); };

  const saveLogoModal = async () => {
    if (!logoModalPreview) return;
    setSavingLogoModal(true);
    try {
      const jwt = await getOrIssueAdminJwt();
      await fetch(`${API_URL}?action=save_logo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminAuthHeaders(jwt) },
        body: JSON.stringify({ short_token: logoModal, logo_base64: logoModalPreview }),
      });
      alert("Logo salvo com sucesso!"); setLogoModal(null); setLogoModalFile(null); setLogoModalPreview(null);
    } catch { alert("Erro ao salvar logo."); } finally { setSavingLogoModal(false); }
  };

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
    return matchSearch && matchMonth;
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
    copied,
    isDark,
  };

  // Modal style helper
  const modalBg  = isDark ? C.dark2 : CL.bg2;
  const modalBdr = isDark ? C.dark3 : CL.border;
  const inputBg  = isDark ? C.dark3 : CL.bg3;

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
        <HyprLogo height={28} isDark={isDark}/>
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
          <button onClick={() => setShowModal(true)} style={{
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

      {/* New Report modal */}
      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "#00000080", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) { setShowModal(false); setNewToken(""); setTokenData(null); } }}>
          <div className="fade-in" style={{ background: modalBg, border: `1px solid ${modalBdr}`, borderRadius: 16, padding: 40, width: "100%", maxWidth: 480 }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, color: text }}>Novo Report</h2>
            <p style={{ color: muted, fontSize: 14, marginBottom: 28 }}>Digite o short_token da campanha para gerar o link de acesso do cliente.</p>
            {!tokenData ? (
              <>
                <label style={{ fontSize: 12, color: muted, textTransform: "uppercase", letterSpacing: 1 }}>Short Token</label>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <input value={newToken} onChange={e => setNewToken(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && checkToken()} placeholder="ex: GEE-MAR26"
                    style={{ flex: 1, background: inputBg, border: `1px solid ${modalBdr}`, borderRadius: 8, padding: "12px 14px", color: text, fontSize: 15, fontWeight: 700, letterSpacing: 1, outline: "none" }}/>
                  <button onClick={checkToken} disabled={checking || !newToken.trim()} style={{ background: C.blue, color: C.white, border: "none", padding: "12px 20px", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700, minWidth: 80, opacity: !newToken.trim() ? 0.5 : 1 }}>
                    {checking ? <Spinner size={16} color={C.white}/> : "Buscar"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ background: `${C.blue}15`, border: `1px solid ${C.blue}30`, borderRadius: 10, padding: 20, marginBottom: 24 }}>
                  <div style={{ fontSize: 12, color: C.blue, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Campanha encontrada</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: text }}>{tokenData.client_name}</div>
                  <div style={{ fontSize: 14, color: muted, marginTop: 4 }}>{tokenData.campaign_name}</div>
                  <div style={{ marginTop: 12, display: "flex", gap: 16 }}>
                    <div><div style={{ fontSize: 11, color: muted }}>Início</div><div style={{ fontSize: 13, fontWeight: 600, color: text }}>{tokenData.start_date}</div></div>
                    <div><div style={{ fontSize: 11, color: muted }}>Fim</div><div style={{ fontSize: 13, fontWeight: 600, color: text }}>{tokenData.end_date}</div></div>
                    <div><div style={{ fontSize: 11, color: muted }}>Token</div><div style={{ fontSize: 13, fontWeight: 700, color: C.blue }}>{tokenData.short_token}</div></div>
                  </div>
                </div>
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, color: muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Logo do Cliente (PNG sem fundo)</div>
                  {logoPreview ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 12, background: inputBg, borderRadius: 8, padding: 12 }}>
                      <img src={logoPreview} style={{ height: 40, objectFit: "contain", maxWidth: 120 }}/>
                      <span style={{ fontSize: 12, color: muted, flex: 1 }}>Logo carregado</span>
                      <button onClick={() => { setLogoFile(null); setLogoPreview(null); }} style={{ background: "none", border: "none", color: muted, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
                    </div>
                  ) : (
                    <label style={{ display: "flex", alignItems: "center", gap: 10, background: inputBg, border: `1px dashed ${modalBdr}`, borderRadius: 8, padding: 12, cursor: "pointer" }}>
                      <input type="file" accept="image/png" style={{ display: "none" }} onChange={e => {
                        const file = e.target.files?.[0]; if (!file) return;
                        setLogoFile(file);
                        const reader = new FileReader(); reader.onload = ev => setLogoPreview(ev.target.result); reader.readAsDataURL(file);
                      }}/>
                      <span style={{ fontSize: 20 }}>🖼️</span>
                      <span style={{ fontSize: 13, color: muted }}>Clique para inserir logo PNG</span>
                    </label>
                  )}
                </div>
                <div style={{ background: inputBg, borderRadius: 8, padding: 12, marginBottom: 20 }}>
                  <div style={{ fontSize: 11, color: muted, marginBottom: 4 }}>Link do cliente (senha = short token)</div>
                  <div style={{ fontSize: 13, color: C.blue, wordBreak: "break-all" }}>{window.location.origin}/report/{tokenData.short_token}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => { setTokenData(null); setNewToken(""); }} style={{ flex: 1, background: inputBg, color: muted, border: `1px solid ${modalBdr}`, padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14 }}>Voltar</button>
                  <button onClick={confirm} style={{ flex: 2, background: C.blue, color: C.white, border: "none", padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>✓ Confirmar e Adicionar</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Loom modal */}
      {loomModal && (
        <div style={{ position: "fixed", inset: 0, background: "#00000080", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) { setLoomModal(null); setLoomUrl(""); } }}>
          <div className="fade-in" style={{ background: modalBg, border: `1px solid ${modalBdr}`, borderRadius: 16, padding: 40, width: "100%", maxWidth: 480 }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, color: text }}>🎥 Adicionar Loom</h2>
            <p style={{ color: muted, fontSize: 14, marginBottom: 24 }}>Cole o link do Loom para <strong>{loomModal}</strong>.</p>
            <input value={loomUrl} onChange={e => setLoomUrl(e.target.value)} placeholder="https://www.loom.com/share/..."
              style={{ width: "100%", background: inputBg, border: `1px solid ${modalBdr}`, borderRadius: 8, padding: "12px 14px", color: text, fontSize: 14, outline: "none", marginBottom: 20 }}/>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setLoomModal(null); setLoomUrl(""); }} style={{ flex: 1, background: inputBg, color: muted, border: `1px solid ${modalBdr}`, padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14 }}>Cancelar</button>
              <button onClick={saveLoom} disabled={savingLoom || !loomUrl.trim()} style={{ flex: 2, background: C.blue, color: C.white, border: "none", padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700, opacity: !loomUrl.trim() ? 0.5 : 1 }}>
                {savingLoom ? "Salvando..." : "✓ Salvar Loom"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Survey modal */}
      {surveyModal && (
        <div style={{ position: "fixed", inset: 0, background: "#00000080", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) { setSurveyModal(null); setSurveyBlocks([{ nome: "", ctrlUrl: "", expUrl: "", focusRow: "" }]); } }}>
          <div className="fade-in" style={{ background: modalBg, border: `1px solid ${modalBdr}`, borderRadius: 16, padding: 32, width: "100%", maxWidth: 540, maxHeight: "90vh", overflowY: "auto" }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4, color: text }}>📋 Configurar Survey</h2>
            <p style={{ color: muted, fontSize: 14, marginBottom: 6 }}>Links públicos do Typeform para <strong>{surveyModal}</strong>.</p>
            <p style={{ color: muted, fontSize: 12, marginBottom: 20, lineHeight: 1.6 }}>
              Cole a URL pública de cada form do Typeform (uma para o grupo controle, outra para o exposto).<br/>
              No Typeform: <span style={{ color: C.blue }}>Share → Copiar link público</span>. As respostas atualizam automaticamente.
            </p>
            {surveyBlocks.map((block, idx) => (
              <div key={idx} style={{ border: `1px solid ${modalBdr}`, borderRadius: 10, padding: 16, marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, textTransform: "uppercase", letterSpacing: 1 }}>Pergunta {idx + 1}</div>
                  {surveyBlocks.length > 1 && (
                    <button onClick={() => setSurveyBlocks(b => b.filter((_, i) => i !== idx))}
                      style={{ background: "none", border: "none", color: muted, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
                  )}
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>Nome da pergunta</div>
                  <input
                    value={block.nome}
                    onChange={e => setSurveyBlocks(b => b.map((bl, i) => i === idx ? { ...bl, nome: e.target.value } : bl))}
                    placeholder="Ex: Ad Recall, Awareness — SP..."
                    style={{ width: "100%", background: inputBg, border: `1px solid ${modalBdr}`, borderRadius: 7, padding: "9px 12px", color: text, fontSize: 13, outline: "none" }}
                  />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>Link Typeform — Grupo Controle</div>
                  <input
                    value={block.ctrlUrl}
                    onChange={e => setSurveyBlocks(b => b.map((bl, i) => i === idx ? { ...bl, ctrlUrl: e.target.value } : bl))}
                    placeholder="https://hypr-mobi.typeform.com/to/..."
                    style={{ width: "100%", background: inputBg, border: `1px solid ${block.ctrlUrl ? C.blue+"60" : modalBdr}`, borderRadius: 7, padding: "9px 12px", color: text, fontSize: 12, outline: "none", fontFamily: "monospace" }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>Link Typeform — Grupo Exposto</div>
                  <input
                    value={block.expUrl}
                    onChange={e => setSurveyBlocks(b => b.map((bl, i) => i === idx ? { ...bl, expUrl: e.target.value } : bl))}
                    placeholder="https://hypr-mobi.typeform.com/to/..."
                    style={{ width: "100%", background: inputBg, border: `1px solid ${block.expUrl ? C.blue+"60" : modalBdr}`, borderRadius: 7, padding: "9px 12px", color: text, fontSize: 12, outline: "none", fontFamily: "monospace" }}
                  />
                </div>
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${modalBdr}` }}>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
                    Marca-foco para destaque <span style={{ opacity: 0.6 }}>(opcional)</span>
                  </div>
                  <input
                    value={block.focusRow || ""}
                    onChange={e => setSurveyBlocks(b => b.map((bl, i) => i === idx ? { ...bl, focusRow: e.target.value } : bl))}
                    placeholder="Ex: Heineken — destaca essa linha visualmente"
                    style={{ width: "100%", background: inputBg, border: `1px solid ${block.focusRow ? C.blue+"60" : modalBdr}`, borderRadius: 7, padding: "9px 12px", color: text, fontSize: 13, outline: "none" }}
                  />
                  <div style={{ fontSize: 11, color: muted, marginTop: 6, lineHeight: 1.5, opacity: 0.85 }}>
                    O tipo da pergunta (choice ou matrix) é detectado automaticamente pela API do Typeform. Se for matrix, a marca digitada acima fica em destaque visual no relatório.
                  </div>
                </div>
              </div>
            ))}
            <button onClick={() => setSurveyBlocks(b => [...b, { nome: "", ctrlUrl: "", expUrl: "", focusRow: "" }])}
              style={{ width: "100%", background: "none", border: `1px dashed ${modalBdr}`, color: C.blue, borderRadius: 8, padding: "10px 0", cursor: "pointer", fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
              + Adicionar pergunta
            </button>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setSurveyModal(null); setSurveyBlocks([{ nome: "", ctrlUrl: "", expUrl: "", focusRow: "" }]); }}
                style={{ flex: 1, background: inputBg, color: muted, border: `1px solid ${modalBdr}`, padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14 }}>Cancelar</button>
              <button disabled={savingSurvey} onClick={saveSurvey}
                style={{ flex: 2, background: C.blue, color: C.white, border: "none", padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700, opacity: savingSurvey ? 0.5 : 1 }}>
                {savingSurvey ? "Salvando..." : `✓ Salvar ${surveyBlocks.length > 1 ? surveyBlocks.length + " perguntas" : "Survey"}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Logo modal */}
      {logoModal && (
        <div style={{ position: "fixed", inset: 0, background: "#00000080", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 }}
          onClick={e => { if (e.target === e.currentTarget) { setLogoModal(null); setLogoModalPreview(null); } }}>
          <div className="fade-in" style={{ background: modalBg, border: `1px solid ${modalBdr}`, borderRadius: 16, padding: 40, width: "100%", maxWidth: 480 }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, color: text }}>🖼️ Adicionar Logo</h2>
            <p style={{ color: muted, fontSize: 14, marginBottom: 24 }}>Selecione o logo PNG para <strong>{logoModal}</strong>.</p>
            <label style={{ display: "flex", alignItems: "center", gap: 10, background: inputBg, border: `1px solid ${modalBdr}`, borderRadius: 8, padding: "12px 14px", cursor: "pointer", marginBottom: 20 }}>
              <input type="file" accept="image/png,image/jpeg" style={{ display: "none" }} onChange={e => {
                const file = e.target.files?.[0]; if (!file) return;
                setLogoModalFile(file);
                const reader = new FileReader(); reader.onload = ev => setLogoModalPreview(ev.target.result); reader.readAsDataURL(file);
              }}/>
              <span style={{ fontSize: 20 }}>📁</span>
              <span style={{ fontSize: 13, color: muted }}>{logoModalFile ? logoModalFile.name : "Clique para selecionar imagem"}</span>
            </label>
            {logoModalPreview && <img src={logoModalPreview} style={{ width: "100%", maxHeight: 120, objectFit: "contain", marginBottom: 20, borderRadius: 8 }}/>}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setLogoModal(null); setLogoModalPreview(null); }} style={{ flex: 1, background: inputBg, color: muted, border: `1px solid ${modalBdr}`, padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14 }}>Cancelar</button>
              <button onClick={saveLogoModal} disabled={savingLogoModal || !logoModalPreview} style={{ flex: 2, background: C.blue, color: C.white, border: "none", padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700, opacity: !logoModalPreview ? 0.5 : 1 }}>
                {savingLogoModal ? "Salvando..." : "✓ Salvar Logo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
// ══════════════════════════════════════════════════════════════════════════════
// CLIENT PASSWORD
// ══════════════════════════════════════════════════════════════════════════════

export default CampaignMenu;
