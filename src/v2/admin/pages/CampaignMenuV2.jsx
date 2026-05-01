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
// IMPORT CRÍTICO — sem isso o Tailwind+theme.css não chega no bundle do
// admin (v2.css é onde @import "tailwindcss" e tokens HYPR vivem). O
// ClientDashboardV2 já importa em outro chunk lazy, mas o admin é a
// rota raiz, então precisa importar explicitamente aqui.
import "../../v2.css";

import { listCampaigns, listTeamMembers, listClients, getShareId, getCachedShareId } from "../../../lib/api";
import { getOwnerFilter, setOwnerFilter as persistOwnerFilter } from "../../../shared/prefs";
import { useTheme } from "../../hooks/useTheme";
import { normalizeSlug, computeMetricsSummary } from "../lib/aggregation";

import HyprReportCenterLogo from "../../../components/HyprReportCenterLogo";
import NewCampaignModal from "../../../components/modals/NewCampaignModal";
import LoomModal from "../../../components/modals/LoomModal";
import SurveyModal from "../../../components/modals/SurveyModal";
import LogoModal from "../../../components/modals/LogoModal";
import OwnerModal from "../../../components/modals/OwnerModal";
import MergeModal from "../../../components/modals/MergeModal";

import { Button } from "../../../ui/Button";
import { Skeleton } from "../../../ui/Skeleton";
import { cn } from "../../../ui/cn";
import { ThemeToggleV2 } from "../../components/ThemeToggleV2";

import { LayoutToggle } from "../components/LayoutToggle";
import { ToolbarV2 } from "../components/ToolbarV2";
import { MetricStrip, SecondaryAlerts } from "../components/MetricStrip";
import { PerformersLayout } from "../components/TopPerformers";
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
    if (v === "month" || v === "client" || v === "list" || v === "performers") return v;
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
  const [mergeModal, setMergeModal]       = useState(null);

  // Theme — single source of truth via hook V2 (aplica data-theme no
  // <html>, persiste em localStorage com a key correta 'hypr_theme',
  // e sincroniza com prefers-color-scheme do OS quando user não tem
  // preferência salva).
  const [theme] = useTheme();
  const isDark = theme === "dark";

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

  // Filtragem de clientes (search + ownerFilter + worklist).
  // Estratégia para owner e worklist: derivar a partir das CAMPANHAS do
  // cliente, não dos top_*_owners (que só têm os 2 mais frequentes —
  // perderia owners no 3º lugar pra baixo) nem do active_short_tokens
  // sozinho (perderia worklist).
  const filteredClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    const worklistTokens = activeWorklist && worklist?.[activeWorklist]?.tokens;
    const worklistSet = worklistTokens ? new Set(worklistTokens) : null;

    // Indexa campanhas por slug pra cruzar com tokens/owners do cliente
    // sem percorrer a lista inteira por cliente.
    const campaignsBySlug = new Map();
    for (const camp of campaigns) {
      const camps = campaignsBySlug.get(normalizeSlug(camp.client_name)) || [];
      camps.push(camp);
      campaignsBySlug.set(normalizeSlug(camp.client_name), camps);
    }

    return clients.filter((c) => {
      if (q && !c.display_name?.toLowerCase().includes(q) && !c.slug?.includes(q)) {
        return false;
      }
      const clientCampaigns = campaignsBySlug.get(c.slug) || [];

      if (ownerFilter) {
        // Match completo: passa se QUALQUER campanha do cliente tem o
        // owner. Não depende mais de top_*_owners (limitado a top 2).
        const hasOwner = clientCampaigns.some(
          (camp) => camp.cp_email === ownerFilter || camp.cs_email === ownerFilter
        );
        if (!hasOwner) return false;
      }

      if (worklistSet) {
        // Cliente passa se QUALQUER campanha sua está no bucket ativo.
        const hasInBucket = clientCampaigns.some(
          (camp) => camp.short_token && worklistSet.has(camp.short_token)
        );
        if (!hasInBucket) return false;
      }

      return true;
    });
  }, [clients, campaigns, search, ownerFilter, activeWorklist, worklist]);

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

  // Após salvar/desfazer merge, refaz a lista para que o backend devolva
  // os tokens com merge_id atualizado. Mais simples que tentar manter
  // estado local sincronizado com várias campanhas afetadas (até N tokens
  // do grupo mudam de uma vez). 1 round-trip extra, aceitável após ação
  // pouco frequente.
  const handleMergeSaved = useCallback(() => {
    setMergeModal(null);
    listCampaigns().then((camps) => setCampaigns(camps)).catch(() => { /* keep stale */ });
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

  // KPIs agregados das campanhas ativas — alimenta a MetricStrip do topo.
  const metricsSummary = useMemo(() => computeMetricsSummary(campaigns), [campaigns]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen w-full bg-canvas text-fg transition-colors">
      {/* ── Topbar ──────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 bg-canvas-elevated border-b border-border">
        <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center text-fg">
            <HyprReportCenterLogo height={32} />
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggleV2 />
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

        {/* MetricStrip no topo — KPIs das campanhas ativas em grid de cards
            bordados leves. Alertas operacionais (críticas, sem owner,
            encerram em 7d) ficam logo abaixo como pills discretos pra
            preservar a função de filtro sem competir com os números. */}
        {!loading && totalCampaigns > 0 && (
          <div className="mb-8 space-y-4">
            <MetricStrip summary={metricsSummary} />
            <SecondaryAlerts
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

        {/* Toolbar: layout toggle (linha 1) + search/owner/sort (linha 2).
            Filtros de busca/owner/sort não aplicam ao layout de performers
            (é um leaderboard auto-contido com filtro próprio). */}
        <div className="space-y-3 mb-5">
          <div className="flex items-center gap-3">
            <LayoutToggle value={layout} onChange={setLayout} />
            <div className="flex-1" />
          </div>
          {layout !== "performers" && (
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
          )}
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
          <MonthLayout
            groups={monthGroups}
            onOpen={handleOpenDrawer}
            onOpenReport={onOpenReport}
            teamMap={teamMap}
            filterSignature={[search.trim(), ownerFilter || "", activeWorklist || ""]
              .filter(Boolean)
              .join("|")}
          />
        ) : layout === "client" ? (
          <ClientLayout clients={filteredClients} onOpen={handleOpenClient} />
        ) : layout === "performers" ? (
          <PerformersLayout campaigns={campaigns} teamMap={teamMap} />
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
        onMerge={(c) => {
          setMergeModal(c);
          handleCloseDrawer();
        }}
        onOpenReport={onOpenReport}
        teamMap={teamMap}
      />

      {showNewCampaign && (
        <NewCampaignModal
          onClose={() => setShowNewCampaign(false)}
          onConfirm={handleNewCampaignConfirm}
          theme={legacyModalTheme(isDark)}
        />
      )}
      {loomModal && (
        <LoomModal
          shortToken={loomModal}
          onClose={() => setLoomModal(null)}
          onSaved={() => setLoomModal(null)}
          theme={legacyModalTheme(isDark)}
        />
      )}
      {surveyModal && (
        <SurveyModal
          shortToken={surveyModal}
          onClose={() => setSurveyModal(null)}
          onSaved={() => setSurveyModal(null)}
          theme={legacyModalTheme(isDark)}
        />
      )}
      {logoModal && (
        <LogoModal
          shortToken={logoModal}
          onClose={() => setLogoModal(null)}
          onSaved={() => setLogoModal(null)}
          theme={legacyModalTheme(isDark)}
        />
      )}
      {ownerModal && (
        <OwnerModal
          campaign={ownerModal}
          teamMembers={teamMembers}
          onSaved={handleOwnerSaved}
          onClose={() => setOwnerModal(null)}
          theme={legacyModalTheme(isDark)}
        />
      )}
      {mergeModal && (
        <MergeModal
          campaign={mergeModal}
          onSaved={handleMergeSaved}
          onClose={() => setMergeModal(null)}
          theme={legacyModalTheme(isDark)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-componentes
// ─────────────────────────────────────────────────────────────────────────────

function MonthLayout({ groups, onOpen, onOpenReport, teamMap, filterSignature = "" }) {
  const currentYM = new Date().toISOString().slice(0, 7);

  // Estado de colapso por chave de mês. Default: meses passados começam
  // colapsados, mês atual/futuros expandidos, E o mês mais recente da lista
  // sempre aberto (mesmo se for passado — ex: dia 1 do mês novo, sem dados
  // ainda no mês corrente). Toggles do user persistem entre filtros —
  // useEffect só inicializa chaves NOVAS, sem sobrescrever.
  const [collapsed, setCollapsed] = useState({});

  useEffect(() => {
    setCollapsed((prev) => {
      const next = { ...prev };
      let changed = false;
      const mostRecentKey = groups
        .map((g) => g.key)
        .filter((k) => k !== "no-date")
        .sort()
        .at(-1);
      for (const g of groups) {
        if (g.key === "no-date") continue;
        if (!(g.key in next)) {
          next[g.key] = g.key < currentYM && g.key !== mostRecentKey;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [groups, currentYM]);

  // Auto-expand quando o filtro está ATIVO. Dispara em qualquer mudança da
  // assinatura (search, owner, worklist) — incluindo a transição
  // inativo→ativo e mudanças entre estados ativos (ex: trocar query).
  // Se o filtro estiver inativo (signature vazia), preservamos os toggles
  // do user (defaults do useEffect acima já cobrem o estado inicial).
  // Toggles durante filtro continuam valendo: o user pode colapsar manual.
  const isFiltering = !!filterSignature;
  useEffect(() => {
    if (isFiltering) setCollapsed({});
  }, [filterSignature, isFiltering]);

  const toggle = useCallback(
    (key) => setCollapsed((s) => ({ ...s, [key]: !s[key] })),
    []
  );

  if (!groups.length) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <p className="text-sm text-fg-muted">Nenhuma campanha encontrada com os filtros atuais.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {groups.map((g) => {
        const canCollapse = g.key !== "no-date";
        const isCollapsed = canCollapse && !!collapsed[g.key];
        return (
          <section key={g.key}>
            <button
              type="button"
              onClick={() => canCollapse && toggle(g.key)}
              disabled={!canCollapse}
              aria-expanded={!isCollapsed}
              className={cn(
                "w-full flex items-center justify-between mb-3 group rounded",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature/40",
                canCollapse && "cursor-pointer"
              )}
            >
              <div className="flex items-center gap-2">
                {canCollapse && (
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                    className={cn(
                      "text-fg-subtle transition-transform duration-150 group-hover:text-fg",
                      isCollapsed ? "-rotate-90" : "rotate-0"
                    )}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="3 4.5 6 7.5 9 4.5" />
                  </svg>
                )}
                <h2 className="text-[11px] uppercase tracking-widest font-bold text-fg-muted group-hover:text-fg transition-colors">
                  {g.label}
                </h2>
              </div>
              <span className="text-[11px] text-fg-subtle">
                {g.items.length} campanha{g.items.length === 1 ? "" : "s"}
              </span>
            </button>
            {!isCollapsed && (
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
            )}
          </section>
        );
      })}
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
  if (layout === "list" || layout === "performers") {
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
