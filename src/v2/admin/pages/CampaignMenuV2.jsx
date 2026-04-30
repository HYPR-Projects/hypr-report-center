// src/v2/admin/pages/CampaignMenuV2.jsx
//
// Substitui src/pages/CampaignMenu.jsx (legacy 566 linhas com inline
// styles e props de tema). Tudo aqui usa Tailwind via tokens de
// theme.css — light/dark theme automático via data-theme no <html>.
//
// Layouts disponíveis (LayoutToggle):
//   - month:  cards de campanha agrupados por mês (refatoração do legacy)
//   - client: cards de cliente com sparkline + métricas agregadas (NOVO)
//   - list:   lista densa estilo Linear (NOVO)
//
// Comportamento mantido:
//   - filtro por search
//   - filtro por owner (CP ou CS)
//   - filtros por mês (quick pills) — só na view month
//   - sort (mês, data início, A-Z) — só na view month e list
//   - todas as ações (Loom, Survey, Logo, Owner, Link Cliente) — agora
//     dentro do CampaignDrawer que abre ao clicar no card

import { useState, useEffect, useMemo, useCallback } from "react";
import { listCampaigns, listTeamMembers, listClients, getShareId, getCachedShareId } from "../../../lib/api";
import { getTheme, setTheme, getOwnerFilter, setOwnerFilter as persistOwnerFilter } from "../../../shared/prefs";

import HyprReportCenterLogo from "../../../components/HyprReportCenterLogo";
import NewCampaignModal from "../../../components/modals/NewCampaignModal";
import LoomModal from "../../../components/modals/LoomModal";
import SurveyModal from "../../../components/modals/SurveyModal";
import LogoModal from "../../../components/modals/LogoModal";
import OwnerModal from "../../../components/modals/OwnerModal";

import { Button } from "../../../ui/Button";
import { Skeleton } from "../../../ui/Skeleton";

import { LayoutToggle } from "../components/LayoutToggle";
import { ToolbarV2 } from "../components/ToolbarV2";
import { Worklist } from "../components/Worklist";
import { MonthFilterPills } from "../components/MonthFilterPills";
import { ClientCard } from "../components/ClientCard";
import { CampaignCardV2 } from "../components/CampaignCardV2";
import { CampaignListV2 } from "../components/CampaignListV2";
import { CampaignDrawer } from "../components/CampaignDrawer";
import { formatMonthLabel } from "../lib/format";

// localStorage key pra persistir o layout escolhido entre sessões.
const LAYOUT_STORAGE_KEY = "hypr.admin.layout";

function getInitialLayout() {
  try {
    const v = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (v === "month" || v === "client" || v === "list") return v;
  } catch { /* ignore */ }
  return "month";
}

export default function CampaignMenuV2({ user, onLogout, onOpenReport, onOpenClient }) {
  // ── Estado de dados ──────────────────────────────────────────────────────
  const [campaigns, setCampaigns]     = useState([]);
  const [clients, setClients]         = useState([]);
  const [worklist, setWorklist]       = useState(null);
  const [loading, setLoading]         = useState(true);
  const [teamMembers, setTeamMembers] = useState({ cps: [], css: [] });

  // ── Estado de UI ─────────────────────────────────────────────────────────
  const [layout, setLayout]               = useState(getInitialLayout);
  const [search, setSearch]               = useState("");
  const [ownerFilter, setOwnerFilter]     = useState(() => getOwnerFilter());
  const [activeMonth, setActiveMonth]     = useState(null);
  const [sortBy, setSortBy]               = useState("month");
  const [activeWorklist, setActiveWorklist] = useState(null);
  const [drawerCampaign, setDrawerCampaign] = useState(null);
  const [copied, setCopied]               = useState(null);

  // Modais legacy reaproveitados
  const [showNewCampaign, setShowNewCampaign] = useState(false);
  const [loomModal, setLoomModal]         = useState(null);
  const [surveyModal, setSurveyModal]     = useState(null);
  const [logoModal, setLogoModal]         = useState(null);
  const [ownerModal, setOwnerModal]       = useState(null);

  // Theme toggle
  const [isDark, setIsDark] = useState(() => getTheme() === "dark");
  useEffect(() => { setTheme(isDark ? "dark" : "light"); }, [isDark]);

  // Persistência
  useEffect(() => { persistOwnerFilter(ownerFilter); }, [ownerFilter]);
  useEffect(() => {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, layout); } catch { /* ignore */ }
  }, [layout]);

  // teamMap pra resolver email → display name
  const teamMap = useMemo(() => {
    const m = {};
    teamMembers.cps.forEach((p) => { m[p.email] = p.name; });
    teamMembers.css.forEach((p) => { m[p.email] = p.name; });
    return m;
  }, [teamMembers]);

  // ── Carregamento inicial ─────────────────────────────────────────────────
  // `loading` já começa true via useState; setLoading(true) aqui seria
  // redundante e fere a regra react-hooks/set-state-in-effect.
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      listCampaigns(),
      listClients(),
      listTeamMembers(),
    ]).then(([camps, clientsResp, members]) => {
      if (cancelled) return;
      setCampaigns(camps);
      setClients(clientsResp.clients);
      setWorklist(clientsResp.worklist);
      setTeamMembers(members);
      // Limpa owner filter inválido (pessoa saiu do time)
      const validEmails = new Set([
        ...members.cps.map((p) => p.email),
        ...members.css.map((p) => p.email),
      ]);
      setOwnerFilter((prev) => (prev && !validEmails.has(prev) ? "" : prev));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, []);

  // ── Filtragem e ordenação ────────────────────────────────────────────────
  const filteredCampaigns = useMemo(() => {
    const q = search.trim().toLowerCase();
    const isTokenQuery = /[-]/.test(search.trim()) || /^[A-Z0-9]{4,8}$/.test(search.trim());

    // Worklist filter sobrepõe outros filtros — escopa em campanhas dos
    // tokens do bucket selecionado.
    const worklistTokens = activeWorklist && worklist?.[activeWorklist]?.tokens;
    const worklistSet = worklistTokens ? new Set(worklistTokens) : null;

    return campaigns.filter((c) => {
      if (worklistSet && !worklistSet.has(c.short_token)) return false;
      const matchSearch = !q ||
        c.client_name?.toLowerCase().includes(q) ||
        c.campaign_name?.toLowerCase().includes(q) ||
        (isTokenQuery && c.short_token?.toLowerCase().includes(q));
      const matchMonth = !activeMonth ||
        (c.start_date && c.start_date.slice(0, 7) === activeMonth);
      const matchOwner = !ownerFilter ||
        c.cp_email === ownerFilter ||
        c.cs_email === ownerFilter;
      return matchSearch && matchMonth && matchOwner;
    });
  }, [campaigns, search, activeMonth, ownerFilter, activeWorklist, worklist]);

  const sortedCampaigns = useMemo(() => {
    return [...filteredCampaigns].sort((a, b) => {
      if (sortBy === "alpha")      return (a.client_name || "").localeCompare(b.client_name || "");
      if (sortBy === "start_date") return (a.start_date  || "").localeCompare(b.start_date  || "");
      // month: newest first
      return (b.start_date || "").localeCompare(a.start_date || "");
    });
  }, [filteredCampaigns, sortBy]);

  // Agrupamento por mês (apenas layout=month)
  const monthGroups = useMemo(() => {
    if (layout !== "month") return [];
    const acc = new Map();
    for (const c of sortedCampaigns) {
      const m = c.start_date?.slice(0, 7) || "no-date";
      if (!acc.has(m)) acc.set(m, []);
      acc.get(m).push(c);
    }
    return [...acc.entries()].map(([key, items]) => ({
      key,
      label: key === "no-date" ? "Sem data" : formatMonthLabel(key),
      items,
    }));
  }, [sortedCampaigns, layout]);

  // Filtragem de clientes (search + ownerFilter)
  const filteredClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter((c) => {
      if (q && !c.display_name?.toLowerCase().includes(q) && !c.slug?.includes(q)) {
        return false;
      }
      if (ownerFilter) {
        const ownerEmails = new Set([
          ...(c.top_cp_owners || []).map((o) => o.email),
          ...(c.top_cs_owners || []).map((o) => o.email),
        ]);
        if (!ownerEmails.has(ownerFilter)) return false;
      }
      return true;
    });
  }, [clients, search, ownerFilter]);

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

  const handleOpenDrawer = useCallback((c) => setDrawerCampaign(c), []);
  const handleCloseDrawer = useCallback(() => setDrawerCampaign(null), []);

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

  const handleNewCampaignConfirm = useCallback((tokenData) => {
    setCampaigns((prev) =>
      prev.find((c) => c.short_token === tokenData.short_token)
        ? prev
        : [tokenData, ...prev]
    );
    setShowNewCampaign(false);
  }, []);

  const handleOpenClient = useCallback((slug) => {
    onOpenClient?.(slug);
  }, [onOpenClient]);

  const totalClients = clients.length;
  const totalCampaigns = campaigns.length;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen w-full bg-canvas text-fg transition-colors">
      {/* ── Topbar ──────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 bg-canvas-elevated border-b border-border">
        <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center text-fg">
            <HyprReportCenterLogo height={20} />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsDark((v) => !v)}
              title={isDark ? "Modo claro" : "Modo escuro"}
              className="w-8 h-8 inline-flex items-center justify-center rounded-md bg-surface border border-border text-fg-muted hover:text-fg hover:bg-surface-strong transition-colors"
            >
              {isDark ? "☀" : "☾"}
            </button>
            {user?.picture && (
              <img
                src={user.picture}
                alt=""
                referrerPolicy="no-referrer"
                className="w-7 h-7 rounded-full ring-2 ring-signature"
              />
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

      {/* ── Conteúdo ─────────────────────────────────────────────────────── */}
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        {/* Hero: título + Novo Report */}
        <div className="flex items-end justify-between gap-4 flex-wrap mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-fg leading-tight">
              Reports de Campanhas
            </h1>
            <p className="text-xs text-fg-muted mt-1 flex items-center gap-2 flex-wrap">
              <span><span className="font-semibold text-fg tabular-nums">{totalCampaigns}</span> campanhas</span>
              <span className="w-0.5 h-0.5 rounded-full bg-fg-subtle" />
              <span><span className="font-semibold text-fg tabular-nums">{totalClients}</span> clientes</span>
              <span className="w-0.5 h-0.5 rounded-full bg-fg-subtle" />
              <span>{new Date().getFullYear()}</span>
            </p>
          </div>
          <Button variant="primary" size="md" onClick={() => setShowNewCampaign(true)}>
            + Novo Report
          </Button>
        </div>

        {/* Worklist no topo — só aparece com pelo menos 1 bucket > 0 */}
        {worklist && hasAnyWorklistItem(worklist) && (
          <div className="mb-6">
            <Worklist
              worklist={worklist}
              activeKey={activeWorklist}
              onSelect={setActiveWorklist}
            />
          </div>
        )}

        {/* Banner de filtro ativo de worklist (UX feedback) */}
        {activeWorklist && (
          <ActiveWorklistBanner
            activeKey={activeWorklist}
            count={worklist?.[activeWorklist]?.count || 0}
            onClear={() => setActiveWorklist(null)}
          />
        )}

        {/* Toolbar: layout toggle (linha 1) + search/owner/sort (linha 2) */}
        <div className="space-y-3 mb-5">
          <div className="flex items-center gap-3">
            <LayoutToggle value={layout} onChange={setLayout} />
            <div className="flex-1" />
          </div>
          <ToolbarV2
            search={search}
            onSearchChange={setSearch}
            ownerFilter={ownerFilter}
            onOwnerChange={setOwnerFilter}
            teamMembers={teamMembers}
            sortBy={sortBy}
            onSortByChange={setSortBy}
            showSortBy={layout !== "client"}
            searchPlaceholder={
              layout === "client" ? "Buscar cliente..." : "Buscar cliente, campanha ou token..."
            }
          />
        </div>

        {/* Quick month pills — só no layout 'month' */}
        {layout === "month" && (
          <div className="mb-6">
            <MonthFilterPills
              campaigns={campaigns}
              activeMonth={activeMonth}
              onChange={setActiveMonth}
            />
          </div>
        )}

        {/* Conteúdo principal por layout */}
        {loading ? (
          <LoadingState layout={layout} />
        ) : layout === "month" ? (
          <MonthLayout groups={monthGroups} onOpen={handleOpenDrawer} onOpenReport={onOpenReport} teamMap={teamMap} />
        ) : layout === "client" ? (
          <ClientLayout clients={filteredClients} onOpen={handleOpenClient} />
        ) : (
          <CampaignListV2
            campaigns={sortedCampaigns}
            onOpen={handleOpenDrawer}
            onOpenReport={onOpenReport}
            teamMap={teamMap}
          />
        )}
      </main>

      {/* ── Drawer + Modais ─────────────────────────────────────────────── */}
      <CampaignDrawer
        campaign={drawerCampaign}
        open={!!drawerCampaign}
        onOpenChange={(o) => !o && handleCloseDrawer()}
        onCopyLink={handleCopyLink}
        copiedState={copied}
        onLoom={(t) => { setLoomModal(t); handleCloseDrawer(); }}
        onSurvey={(t) => { setSurveyModal(t); handleCloseDrawer(); }}
        onLogo={(t) => { setLogoModal(t); handleCloseDrawer(); }}
        onOwner={(c) => {
          setOwnerModal({
            short_token: c.short_token,
            client_name: c.client_name,
            cp_email: c.cp_email || "",
            cs_email: c.cs_email || "",
          });
          handleCloseDrawer();
        }}
        onOpenReport={onOpenReport}
        teamMap={teamMap}
      />

      {showNewCampaign && (
        <NewCampaignModal
          onClose={() => setShowNewCampaign(false)}
          onConfirm={handleNewCampaignConfirm}
          modalTheme={legacyModalTheme(isDark)}
        />
      )}
      {loomModal && (
        <LoomModal shortToken={loomModal} onClose={() => setLoomModal(null)} modalTheme={legacyModalTheme(isDark)} />
      )}
      {surveyModal && (
        <SurveyModal shortToken={surveyModal} onClose={() => setSurveyModal(null)} modalTheme={legacyModalTheme(isDark)} />
      )}
      {logoModal && (
        <LogoModal shortToken={logoModal} onClose={() => setLogoModal(null)} modalTheme={legacyModalTheme(isDark)} />
      )}
      {ownerModal && (
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

// ─────────────────────────────────────────────────────────────────────────────
// Sub-componentes
// ─────────────────────────────────────────────────────────────────────────────

function MonthLayout({ groups, onOpen, onOpenReport, teamMap }) {
  if (!groups.length) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <p className="text-sm text-fg-muted">Nenhuma campanha encontrada com os filtros atuais.</p>
      </div>
    );
  }
  return (
    <div className="space-y-8">
      {groups.map((g) => (
        <section key={g.key}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] uppercase tracking-widest font-bold text-fg-muted">
              {g.label}
            </h2>
            <span className="text-[11px] text-fg-subtle">
              {g.items.length} campanha{g.items.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="space-y-2">
            {g.items.map((c) => (
              <CampaignCardV2
                key={c.short_token}
                campaign={c}
                onOpen={onOpen}
                onOpenReport={onOpenReport}
                teamMap={teamMap}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ClientLayout({ clients, onOpen }) {
  if (!clients.length) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <p className="text-sm text-fg-muted">Nenhum cliente encontrado.</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {clients.map((c) => (
        <ClientCard key={c.slug} client={c} onOpen={onOpen} />
      ))}
    </div>
  );
}

function LoadingState({ layout }) {
  if (layout === "client") {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[180px] rounded-xl" />
        ))}
      </div>
    );
  }
  if (layout === "list") {
    return (
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-4 py-3 border-b border-border last:border-0">
            <Skeleton className="h-4 w-1/3 mb-1" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-[88px] rounded-xl" />
      ))}
    </div>
  );
}

const WORKLIST_LABELS = {
  pacing_critical:    "pacing crítico",
  no_owner:           "sem owner",
  ending_soon:        "encerram em 7 dias",
  reports_not_viewed: "reports não vistos",
};

function ActiveWorklistBanner({ activeKey, count, onClear }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-5 px-4 py-2.5 rounded-lg bg-signature-soft border border-signature/30">
      <p className="text-[12px] text-fg">
        Filtrado por <span className="font-semibold">{WORKLIST_LABELS[activeKey] || activeKey}</span>
        {" · "}
        <span className="tabular-nums font-semibold">{count}</span>{" "}
        {count === 1 ? "campanha" : "campanhas"}
      </p>
      <button
        type="button"
        onClick={onClear}
        className="text-[11px] text-fg-muted hover:text-fg font-medium"
      >
        Limpar filtro
      </button>
    </div>
  );
}

function hasAnyWorklistItem(wl) {
  return Object.values(wl).some((b) => (b?.count || 0) > 0);
}

// Modais legacy ainda esperam um objeto modalTheme com 5 keys (modalBg,
// modalBdr, inputBg, text, muted). Aqui injetamos via tokens HSL fixos
// pra cada tema — não é possível usar CSS vars direto porque os modais
// passam esses valores como inline style (não classe Tailwind).
//
// Quando os modais forem refatorados (PR futura), esse helper some.
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
