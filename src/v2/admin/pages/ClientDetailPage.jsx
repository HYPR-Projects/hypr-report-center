// src/v2/admin/pages/ClientDetailPage.jsx
//
// Página de drilldown do cliente — `/admin/client/:slug`.
//
// Visual:
//   - Breadcrumb "← Reports" / Kenvue
//   - Hero: nome do cliente + contador (12 campanhas · 3 ativas)
//   - 4 KPIs agregados (Investimento total, Pacing médio, CTR médio, VTR médio)
//   - Toolbar (search + owner + sort) — sem layout toggle aqui
//   - Lista de cards de campanha (mesmo CampaignCardV2 da home)
//
// Reusa CampaignCardV2 e CampaignDrawer pra manter coerência visual.

import { useState, useEffect, useMemo, useCallback } from "react";
import { listCampaigns, listTeamMembers, getShareId, getCachedShareId } from "../../../lib/api";
import { getTheme, setTheme } from "../../../shared/prefs";
import { normalizeSlug } from "../lib/aggregation";

import HyprReportCenterLogo from "../../../components/HyprReportCenterLogo";
import LoomModal from "../../../components/modals/LoomModal";
import SurveyModal from "../../../components/modals/SurveyModal";
import LogoModal from "../../../components/modals/LogoModal";
import OwnerModal from "../../../components/modals/OwnerModal";

import { Card } from "../../../ui/Card";
import { Skeleton } from "../../../ui/Skeleton";

import { ToolbarV2 } from "../components/ToolbarV2";
import { CampaignCardV2 } from "../components/CampaignCardV2";
import { CampaignDrawer } from "../components/CampaignDrawer";
import {
  formatPacingValue,
  formatPct,
  pacingColorClass,
  slugToDisplay,
} from "../lib/format";

export default function ClientDetailPage({ slug, user, onLogout, onBack, onOpenReport }) {
  const [campaigns, setCampaigns]     = useState([]);
  const [loading, setLoading]         = useState(true);
  const [teamMembers, setTeamMembers] = useState({ cps: [], css: [] });
  const [search, setSearch]           = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [sortBy, setSortBy]           = useState("month");

  const [drawerCampaign, setDrawerCampaign] = useState(null);
  const [copied, setCopied]                 = useState(null);
  const [loomModal, setLoomModal]           = useState(null);
  const [surveyModal, setSurveyModal]       = useState(null);
  const [logoModal, setLogoModal]           = useState(null);
  const [ownerModal, setOwnerModal]         = useState(null);

  const [isDark, setIsDark] = useState(() => getTheme() === "dark");
  useEffect(() => { setTheme(isDark ? "dark" : "light"); }, [isDark]);

  const teamMap = useMemo(() => {
    const m = {};
    teamMembers.cps.forEach((p) => { m[p.email] = p.name; });
    teamMembers.css.forEach((p) => { m[p.email] = p.name; });
    return m;
  }, [teamMembers]);

  // ── Carregamento ─────────────────────────────────────────────────────────
  // `loading` já começa true. Quando slug muda, o componente é remontado
  // via `key={slug}` no App.jsx — então useState volta ao default e
  // não precisamos chamar setLoading(true) aqui (que feriria a regra
  // react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    Promise.all([listCampaigns(), listTeamMembers()]).then(([camps, members]) => {
      if (cancelled) return;
      // Filtra só as campanhas desse cliente (slug normalizado)
      const filtered = camps.filter((c) => normalizeSlug(c.client_name) === slug);
      setCampaigns(filtered);
      setTeamMembers(members);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [slug]);

  // Display name (mais frequente)
  const displayName = useMemo(() => {
    if (!campaigns.length) return slugToDisplay(slug);
    const counter = new Map();
    for (const c of campaigns) {
      if (!c.client_name) continue;
      counter.set(c.client_name, (counter.get(c.client_name) || 0) + 1);
    }
    const top = [...counter.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : slugToDisplay(slug);
  }, [campaigns, slug]);

  // KPIs agregados
  const kpis = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const active = campaigns.filter((c) => c.end_date && c.end_date.slice(0, 10) >= today);

    const pacings = [];
    const ctrs = [];
    const vtrs = [];
    for (const c of active) {
      if (c.display_pacing != null) pacings.push(Number(c.display_pacing));
      if (c.video_pacing   != null) pacings.push(Number(c.video_pacing));
      if (c.display_ctr    != null) ctrs.push(Number(c.display_ctr));
      if (c.video_vtr      != null) vtrs.push(Number(c.video_vtr));
    }
    const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    return {
      totalCampaigns:  campaigns.length,
      activeCampaigns: active.length,
      avgPacing:       mean(pacings) != null ? Math.round(mean(pacings) * 10) / 10 : null,
      avgCtr:          mean(ctrs)    != null ? Math.round(mean(ctrs) * 100) / 100 : null,
      avgVtr:          mean(vtrs)    != null ? Math.round(mean(vtrs) * 10) / 10 : null,
    };
  }, [campaigns]);

  // Filtragem
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return campaigns.filter((c) => {
      const matchSearch = !q ||
        c.campaign_name?.toLowerCase().includes(q) ||
        c.short_token?.toLowerCase().includes(q);
      const matchOwner = !ownerFilter ||
        c.cp_email === ownerFilter || c.cs_email === ownerFilter;
      return matchSearch && matchOwner;
    });
  }, [campaigns, search, ownerFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortBy === "alpha")      return (a.campaign_name || "").localeCompare(b.campaign_name || "");
      if (sortBy === "start_date") return (a.start_date    || "").localeCompare(b.start_date    || "");
      return (b.start_date || "").localeCompare(a.start_date || "");
    });
  }, [filtered, sortBy]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleCopyLink = useCallback(async (campaign) => {
    const token = campaign.short_token;
    const fromObject = campaign.share_id;
    const shareIdSync = fromObject || getCachedShareId(token);
    if (shareIdSync) {
      navigator.clipboard.writeText(`${window.location.origin}/report/${shareIdSync}`);
      setCopied(token);
      setTimeout(() => setCopied(null), 2000);
      return;
    }
    setCopied(`${token}:loading`);
    const shareId = await getShareId(token);
    if (!shareId) {
      setCopied(`${token}:error`);
      setTimeout(() => setCopied(null), 3000);
      return;
    }
    navigator.clipboard.writeText(`${window.location.origin}/report/${shareId}`);
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const handleOwnerSaved = useCallback((updated) => {
    setCampaigns((prev) =>
      prev.map((c) =>
        c.short_token === updated.short_token
          ? { ...c, cp_email: updated.cp_email, cs_email: updated.cs_email }
          : c
      )
    );
    setOwnerModal(null);
  }, []);

  return (
    <div className="min-h-screen w-full bg-canvas text-fg transition-colors">
      {/* Topbar */}
      <header className="sticky top-0 z-30 bg-canvas-elevated border-b border-border">
        <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center text-fg">
            <HyprReportCenterLogo height={20} />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsDark((v) => !v)}
              className="w-8 h-8 inline-flex items-center justify-center rounded-md bg-surface border border-border text-fg-muted hover:text-fg hover:bg-surface-strong transition-colors"
            >
              {isDark ? "☀" : "☾"}
            </button>
            {user?.picture && (
              <img src={user.picture} alt="" referrerPolicy="no-referrer" className="w-7 h-7 rounded-full ring-2 ring-signature" />
            )}
            <span className="text-xs text-fg-muted hidden sm:inline">{user?.name}</span>
            <button
              onClick={onLogout}
              className="text-xs text-fg-muted hover:text-fg px-3 h-8 rounded-md border border-border hover:bg-surface transition-colors"
            >
              Sair
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-6">
        {/* Breadcrumb */}
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[12px] text-fg-muted hover:text-fg transition-colors mb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature rounded"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Reports de Campanhas
        </button>

        {/* Hero */}
        <div className="flex items-end justify-between gap-4 flex-wrap mb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-fg leading-tight">
              {displayName}
            </h1>
            <p className="text-xs text-fg-muted mt-1">
              <span className="font-semibold text-fg tabular-nums">{kpis.totalCampaigns}</span> campanhas no total
              {kpis.activeCampaigns > 0 && (
                <>
                  {" · "}
                  <span className="font-semibold text-success tabular-nums">{kpis.activeCampaigns} rodando agora</span>
                </>
              )}
            </p>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <KpiBox label="Campanhas ativas" value={kpis.activeCampaigns ?? "—"} colorClass="text-fg" />
          <KpiBox label="Pacing médio"      value={formatPacingValue(kpis.avgPacing)} colorClass={pacingColorClass(kpis.avgPacing)} />
          <KpiBox label="CTR médio"         value={formatPct(kpis.avgCtr, 2)} colorClass="text-success" />
          <KpiBox label="VTR médio"         value={formatPct(kpis.avgVtr, 1)} colorClass="text-success" />
        </div>

        {/* Toolbar */}
        <div className="mb-5">
          <ToolbarV2
            search={search}
            onSearchChange={setSearch}
            ownerFilter={ownerFilter}
            onOwnerChange={setOwnerFilter}
            teamMembers={teamMembers}
            sortBy={sortBy}
            onSortByChange={setSortBy}
            searchPlaceholder="Buscar campanha..."
          />
        </div>

        {/* Section header */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[11px] uppercase tracking-widest font-bold text-fg-muted">
            Campanhas {displayName}
          </h2>
          <span className="text-[11px] text-fg-subtle">
            {sorted.length} campanha{sorted.length === 1 ? "" : "s"}
          </span>
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-[88px] rounded-xl" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface p-8 text-center">
            <p className="text-sm text-fg-muted">Nenhuma campanha encontrada com os filtros atuais.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((c) => (
              <CampaignCardV2
                key={c.short_token}
                campaign={c}
                onOpen={setDrawerCampaign}
                onOpenReport={onOpenReport}
                teamMap={teamMap}
              />
            ))}
          </div>
        )}
      </main>

      {/* Drawer + modais */}
      <CampaignDrawer
        campaign={drawerCampaign}
        open={!!drawerCampaign}
        onOpenChange={(o) => !o && setDrawerCampaign(null)}
        onCopyLink={handleCopyLink}
        copiedState={copied}
        onLoom={(t) => { setLoomModal(t); setDrawerCampaign(null); }}
        onSurvey={(t) => { setSurveyModal(t); setDrawerCampaign(null); }}
        onLogo={(t) => { setLogoModal(t); setDrawerCampaign(null); }}
        onOwner={(c) => {
          setOwnerModal({
            short_token: c.short_token,
            client_name: c.client_name,
            cp_email: c.cp_email || "",
            cs_email: c.cs_email || "",
          });
          setDrawerCampaign(null);
        }}
        onOpenReport={onOpenReport}
        teamMap={teamMap}
      />

      {loomModal   && <LoomModal   shortToken={loomModal}   onClose={() => setLoomModal(null)}   modalTheme={legacyModalTheme(isDark)} />}
      {surveyModal && <SurveyModal shortToken={surveyModal} onClose={() => setSurveyModal(null)} modalTheme={legacyModalTheme(isDark)} />}
      {logoModal   && <LogoModal   shortToken={logoModal}   onClose={() => setLogoModal(null)}   modalTheme={legacyModalTheme(isDark)} />}
      {ownerModal  && (
        <OwnerModal
          shortToken={ownerModal.short_token}
          clientName={ownerModal.client_name}
          initialCpEmail={ownerModal.cp_email}
          initialCsEmail={ownerModal.cs_email}
          teamMembers={teamMembers}
          onSave={handleOwnerSaved}
          onClose={() => setOwnerModal(null)}
          modalTheme={legacyModalTheme(isDark)}
        />
      )}
    </div>
  );
}

function KpiBox({ label, value, colorClass }) {
  return (
    <Card className="p-4">
      <div className="text-[10.5px] uppercase tracking-widest font-bold text-fg-subtle">{label}</div>
      <div className={`text-2xl font-bold tracking-tight tabular-nums mt-1 ${colorClass || "text-fg"}`}>
        {value}
      </div>
    </Card>
  );
}

function legacyModalTheme(isDark) {
  if (isDark) {
    return {
      modalBg: "#232F3A",
      modalBdr: "rgba(245,247,250,0.12)",
      inputBg: "#2D3D4F",
      text: "#F5F7FA",
      muted: "rgba(245,247,250,0.7)",
    };
  }
  return {
    modalBg: "#FFFFFF",
    modalBdr: "rgba(15,20,25,0.10)",
    inputBg: "#F1F3F6",
    text: "#0F1419",
    muted: "rgba(15,20,25,0.65)",
  };
}
