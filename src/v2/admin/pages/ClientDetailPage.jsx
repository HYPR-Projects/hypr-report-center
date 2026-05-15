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
// Mesmo motivo do CampaignMenuV2: precisa do v2.css explícito porque
// é uma rota raiz acessada direto via /admin/client/:slug.
import "../../v2.css";

import { listCampaigns, listTeamMembers, getShareId, getCachedShareId } from "../../../lib/api";
import { readCache, writeCache } from "../../../lib/persistedCache";
import { useTheme } from "../../hooks/useTheme";
import { normalizeSlug } from "../lib/aggregation";
import { createOwnerMatcher } from "../lib/ownerFilter";

import HyprReportCenterLogo from "../../../components/HyprReportCenterLogo";
import LoomModal from "../../../components/modals/LoomModal";
import SurveyModal from "../../../components/modals/SurveyModal";
import LogoModal from "../../../components/modals/LogoModal";
import OwnerModal from "../../../components/modals/OwnerModal";
import MergeModal from "../../../components/modals/MergeModal";
import { NegotiationModal } from "../../components/NegotiationModal";

import { Card } from "../../../ui/Card";
import { Skeleton } from "../../../ui/Skeleton";
import { ThemeToggleV2 } from "../../components/ThemeToggleV2";

import { ToolbarV2 } from "../components/ToolbarV2";
import { CampaignCardV2 } from "../components/CampaignCardV2";
import { MergeGroupCardV2 } from "../components/MergeGroupCardV2";
import { CampaignDrawer } from "../components/CampaignDrawer";
import { MonthGroupedSections } from "../components/MonthGroupedSections";
import {
  formatMonthLabel,
  formatPacingValue,
  formatPct,
  formatTimeAgo,
  pacingColorClass,
  slugToDisplay,
} from "../lib/format";

export default function ClientDetailPage({ slug, user, onLogout, onBack, onOpenReport }) {
  // Stale-while-revalidate via mesmas keys do menu (`menu.campaigns` /
  // `menu.team`). Não há prejuízo em compartilhar — o payload é idêntico,
  // ClientDetailPage apenas filtra por slug. Quando o user navega
  // Menu → ClientDetail, os dados aparecem instantaneamente vindos do
  // cache populado lá.
  const [bootstrap] = useState(() => ({
    campaigns: readCache("menu.campaigns"),
    team:      readCache("menu.team"),
  }));
  // Filtra cache por slug no init pra render imediato sem flicker.
  const [campaigns, setCampaigns] = useState(() => {
    const cached = bootstrap.campaigns?.data ?? [];
    return cached.filter((c) => normalizeSlug(c.client_name) === slug);
  });
  const [loading, setLoading]         = useState(!bootstrap.campaigns);
  const [teamMembers, setTeamMembers] = useState(bootstrap.team?.data ?? { cps: [], css: [] });
  // Init refreshing=true: o useEffect inicial sempre dispara um fetch.
  // Manter false aqui exigiria setRefreshing(true) síncrono dentro do
  // effect, o que viola react-hooks/set-state-in-effect.
  const [refreshing, setRefreshing]       = useState(true);
  const [refreshError, setRefreshError]   = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(bootstrap.campaigns?.ts ?? null);
  const [search, setSearch]           = useState("");
  const [ownerFilter, setOwnerFilter] = useState([]);
  const [sortBy, setSortBy]           = useState("month");

  const [drawerCampaign, setDrawerCampaign] = useState(null);
  const [copied, setCopied]                 = useState(null);
  const [loomModal, setLoomModal]           = useState(null);
  const [surveyModal, setSurveyModal]       = useState(null);
  const [logoModal, setLogoModal]           = useState(null);
  const [ownerModal, setOwnerModal]         = useState(null);
  const [mergeModal, setMergeModal]         = useState(null);
  const [negotiationModal, setNegotiationModal] = useState(null); // { short_token, negotiation }

  // Theme — single source of truth via hook V2 (ver CampaignMenuV2).
  const [theme] = useTheme();
  const isDark = theme === "dark";

  const teamMap = useMemo(() => {
    const m = {};
    teamMembers.cps.forEach((p) => { m[p.email] = p.name; });
    teamMembers.css.forEach((p) => { m[p.email] = p.name; });
    return m;
  }, [teamMembers]);

  // ── Carregamento / refresh ───────────────────────────────────────────────
  // Mesmo padrão do CampaignMenuV2: Promise.allSettled pra falha de uma
  // não corromper a outra; cache atualizado apenas em sucesso por seção;
  // banner sutil quando refresh em background falha. Caller (useEffect ou
  // handleRetry) é responsável por setRefreshing(true) — runRefresh não
  // mexe nisso pra não violar react-hooks/set-state-in-effect.
  const runRefresh = useCallback(() => {
    let cancelled = false;

    Promise.allSettled([listCampaigns(), listTeamMembers()]).then(([campsR, membersR]) => {
      if (cancelled) return;

      const errors = [];

      if (campsR.status === "fulfilled") {
        // Persiste o payload completo no cache compartilhado (mesma key do
        // menu) — beneficia navegação cross-page. Filtra por slug ao salvar
        // localmente.
        writeCache("menu.campaigns", campsR.value);
        setCampaigns(campsR.value.filter((c) => normalizeSlug(c.client_name) === slug));
        setLastFetchedAt(Date.now());
      } else {
        errors.push(`campaigns: ${campsR.reason?.message || campsR.reason}`);
      }

      if (membersR.status === "fulfilled") {
        setTeamMembers(membersR.value);
        writeCache("menu.team", membersR.value);
      } else {
        errors.push(`team: ${membersR.reason?.message || membersR.reason}`);
      }

      if (errors.length > 0) {
        setRefreshError(errors.join(" | "));
        console.warn("[client-detail] refresh failures:", errors);
      } else {
        setRefreshError(null);
      }

      setLoading(false);
      setRefreshing(false);
    });

    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    const cancel = runRefresh();
    return cancel;
  }, [runRefresh]);

  const handleRetry = useCallback(() => {
    setRefreshing(true);
    runRefresh();
  }, [runRefresh]);

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
  // Matcher de owners: AND entre papéis (CP+CS), OR dentro do mesmo papel.
  // Memoizado fora do filter pra split CP/CS rodar 1x por mudança, não por
  // campanha. Detalhes em ../lib/ownerFilter.js.
  const ownerMatcher = useMemo(
    () => createOwnerMatcher(ownerFilter, teamMembers),
    [ownerFilter, teamMembers]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return campaigns.filter((c) => {
      const matchSearch = !q ||
        c.campaign_name?.toLowerCase().includes(q) ||
        c.short_token?.toLowerCase().includes(q);
      return matchSearch && ownerMatcher(c);
    });
  }, [campaigns, search, ownerMatcher]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortBy === "alpha")      return (a.campaign_name || "").localeCompare(b.campaign_name || "");
      if (sortBy === "start_date") return (a.start_date    || "").localeCompare(b.start_date    || "");
      return (b.start_date || "").localeCompare(a.start_date || "");
    });
  }, [filtered, sortBy]);

  // Agrupa por merge_id pra renderizar campanhas mescladas dentro de um
  // único MergeGroupCardV2. Algoritmo:
  //   1) Itera `sorted` (já com filtro + ordenação aplicados).
  //   2) Primeira ocorrência de um merge_id vira ponto de inserção do grupo
  //      na ordem (preserva a posição que esse merge teria pelo critério
  //      de sort do admin).
  //   3) Membros adicionais do mesmo merge_id são anexados ao grupo, não
  //      criam outra entrada na lista — evita duplicação visual.
  // Resultado: array de items do tipo
  //   { kind: "single", campaign }                      | sem merge
  //   { kind: "group",  merge_id, members: Campaign[] } | com merge
  const groupedItems = useMemo(() => {
    const out = [];
    const groupIndex = new Map(); // merge_id -> índice em `out`
    for (const c of sorted) {
      if (!c.merge_id) {
        out.push({ kind: "single", campaign: c });
        continue;
      }
      const existing = groupIndex.get(c.merge_id);
      if (existing == null) {
        groupIndex.set(c.merge_id, out.length);
        out.push({ kind: "group", merge_id: c.merge_id, members: [c] });
      } else {
        out[existing].members.push(c);
      }
    }
    // Ordena membros DENTRO de cada grupo por start_date desc — admin lê
    // o mais recente primeiro (geralmente o ativo) sem precisar saber qual.
    for (const item of out) {
      if (item.kind === "group") {
        item.members.sort((a, b) =>
          (b.start_date || "").localeCompare(a.start_date || "")
        );
      }
    }
    return out;
  }, [sorted]);

  // Agrupa os groupedItems (single + merge) por mês de início pra
  // exibir as campanhas do cliente quebradas como na view "Por mês"
  // do menu principal. Itens sem `start_date` caem no bucket "no-date".
  //
  // Pra merge groups, usa o start_date do membro mais recente (members[0]
  // já vem ordenado desc dentro de cada grupo). Garante que o merge fica
  // no mês mais relevante visualmente.
  //
  // Ordem dos meses: mais recente primeiro, "no-date" no fim.
  const monthGroups = useMemo(() => {
    if (groupedItems.length === 0) return [];
    const acc = new Map();
    for (const item of groupedItems) {
      const startDate =
        item.kind === "single"
          ? item.campaign.start_date
          : item.members[0]?.start_date;
      const m = startDate?.slice(0, 7) || "no-date";
      if (!acc.has(m)) acc.set(m, []);
      acc.get(m).push(item);
    }
    const monthsSorted = [...acc.keys()].sort((a, b) => {
      if (a === "no-date") return 1;
      if (b === "no-date") return -1;
      return b.localeCompare(a);
    });
    return monthsSorted.map((m) => ({
      key: m,
      label: m === "no-date" ? "Sem data" : formatMonthLabel(m),
      items: acc.get(m),
    }));
  }, [groupedItems]);

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

  // Refaz o fetch após criar/desfazer merge — vários tokens podem ter
  // mudado de merge_id de uma vez (não dá pra reconciliar local sem
  // saber o estado novo). Custo: 1 round-trip após ação rara.
  const handleMergeSaved = useCallback(() => {
    setMergeModal(null);
    listCampaigns()
      .then((camps) => {
        writeCache("menu.campaigns", camps);
        setCampaigns(camps.filter((c) => normalizeSlug(c.client_name) === slug));
        setLastFetchedAt(Date.now());
      })
      .catch(() => { /* keep stale */ });
  }, [slug]);

  // Após toggle de ABS no drawer, refaz a lista (com refresh=true) pra
  // pegar `display_has_abs` / `video_has_abs` atualizados — o badge ABS
  // e o score do Top Performers dependem dessa flag.
  const handleAbsSaved = useCallback(() => {
    listCampaigns({ refresh: true })
      .then((camps) => {
        writeCache("menu.campaigns", camps);
        setCampaigns(camps.filter((c) => normalizeSlug(c.client_name) === slug));
        setLastFetchedAt(Date.now());
      })
      .catch(() => { /* keep stale */ });
  }, [slug]);

  return (
    <div className="min-h-screen w-full bg-canvas text-fg transition-colors">
      {/* Topbar */}
      <header className="sticky top-0 z-30 bg-canvas-elevated border-b border-border">
        <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              // Mesma key usada pelo CampaignMenuV2 (LAYOUT_STORAGE_KEY).
              // Grava "month" antes de navegar pro home, garantindo que
              // o menu monte direto na view por mês — independente do
              // layout que o admin estava usando antes.
              try { localStorage.setItem("hypr.admin.layout", "month"); } catch { /* ignore */ }
              onBack();
            }}
            className="flex items-center text-fg cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-elevated"
            aria-label="Voltar para visão por mês"
            title="Voltar para visão por mês"
          >
            <HyprReportCenterLogo height={32} />
          </button>
          <div className="flex items-center gap-3">
            <ThemeToggleV2 />
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
              {refreshing && !refreshError && lastFetchedAt && (
                <>
                  {" · "}
                  <span className="text-fg-subtle italic">atualizando…</span>
                </>
              )}
            </p>
          </div>
        </div>

        {/* Banner de "dados desatualizados" — refresh em background falhou. */}
        {refreshError && (
          <div className="mb-4 px-4 py-2.5 rounded-lg flex items-center justify-between gap-3"
               style={{
                 background: "var(--color-warning-soft)",
                 border: "1px solid var(--color-warning)",
               }}>
            <p className="text-[12px] text-fg">
              Não consegui atualizar os dados.{" "}
              {lastFetchedAt && (
                <span className="text-fg-muted">
                  Mostrando dados de {formatTimeAgo(lastFetchedAt)}.
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              disabled={refreshing}
              className="text-[11px] font-medium text-fg px-3 h-7 rounded-md border border-warning/40 hover:bg-warning/10 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {refreshing ? "Tentando…" : "Tentar de novo"}
            </button>
          </div>
        )}

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
        ) : (
          // Agrupado por mês (mesmo padrão do "Por mês" no menu principal).
          // filterSignature dispara auto-expand quando search/owner mudam.
          <MonthGroupedSections
            groups={monthGroups}
            filterSignature={[search.trim(), ownerFilter.join(",")]
              .filter(Boolean)
              .join("|")}
            renderItem={(item) =>
              item.kind === "group" ? (
                <MergeGroupCardV2
                  key={`merge-${item.merge_id}`}
                  members={item.members}
                  onOpen={setDrawerCampaign}
                  onOpenReport={onOpenReport}
                  teamMap={teamMap}
                />
              ) : (
                <CampaignCardV2
                  key={item.campaign.short_token}
                  campaign={item.campaign}
                  onOpen={setDrawerCampaign}
                  onOpenReport={onOpenReport}
                  teamMap={teamMap}
                />
              )
            }
          />
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
        onMerge={(c) => {
          setMergeModal(c);
          setDrawerCampaign(null);
        }}
        onNegotiation={(c, n, rd) => {
          setNegotiationModal({ short_token: c.short_token, negotiation: n, reportData: rd });
          setDrawerCampaign(null);
        }}
        onAbsChange={handleAbsSaved}
        onClosureChange={handleAbsSaved}
        onOpenReport={onOpenReport}
        teamMap={teamMap}
      />

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
      {ownerModal  && (
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
      <NegotiationModal
        open={!!negotiationModal}
        onOpenChange={(o) => !o && setNegotiationModal(null)}
        negotiationsByToken={negotiationModal ? { [negotiationModal.short_token]: negotiationModal.negotiation } : {}}
        members={negotiationModal ? [{ short_token: negotiationModal.short_token }] : []}
        defaultActiveToken={negotiationModal?.short_token}
        reportData={negotiationModal?.reportData}
      />
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
