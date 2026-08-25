// src/v2/admin/pages/ClientDetailPage.jsx
//
// Página de drilldown do cliente — `/admin/client/:slug`.
//
// Visual:
//   - Cabeçalho: nome do cliente + contador (12 campanhas · 3 ativas)
//   - 4 KPIs agregados (ativas, pacing médio, CTR médio, VTR médio)
//   - FilterBar (busca + owner + ordenação)
//   - Cards de campanha agrupados por mês (mesmo CampaignCardV2 da home)
//
// Reusa CampaignCardV2 e CampaignDrawer pra manter coerência visual.
//
// ── O que mudou com o AdminShell ─────────────────────────────────────────
// Esta página tinha o header MENOS completo das três: sem indicador de
// frescor, sem sino de alertas, sem saúde de DSP. Quem estava no drilldown
// de um cliente não tinha como saber se o dado era de hoje. Agora o rail é
// o mesmo em toda rota admin, então o contexto operacional vem de graça.
//
// O breadcrumb "← Reports de Campanhas", que era um botão solto acima do
// H1, virou o rastro da barra de contexto — onde sobrevive ao scroll.

import { useState, useEffect, useMemo, useCallback } from "react";
// Mesmo motivo do CampaignMenuV2: precisa do v2.css explícito porque
// é uma rota raiz acessada direto via /admin/client/:slug.
import "../../v2.css";

import { listCampaigns, listTeamMembers, getShareId, getCachedShareId } from "../../../lib/api";
import { readCache, writeCache } from "../../../lib/persistedCache";
import { useTheme } from "../../hooks/useTheme";
import { normalizeSlug } from "../lib/aggregation";
import { createOwnerMatcher } from "../lib/ownerFilter";

import LoomModal from "../../../components/modals/LoomModal";
import SurveyModal from "../../../components/modals/SurveyModal";
import LogoModal from "../../../components/modals/LogoModal";
import OwnerModal from "../../../components/modals/OwnerModal";
import MergeModal from "../../../components/modals/MergeModal";
import { NegotiationModal } from "../../components/NegotiationModal";

import { Button } from "../../../ui/Button";
import { Skeleton } from "../../../ui/Skeleton";

import { ClientPortalDrawer } from "../../portal/ClientPortalDrawer";
import { FilterBar, SortChipFilter } from "../components/FilterBar";
import { KpiBoard } from "../components/KpiBoard";
import { OwnerFilterPanel } from "../components/OwnerFilter";
import { ownerFilterLabel } from "../lib/filterLabels";
import { AdminShell } from "../shell/AdminShell";
import { PageHeader, MetaDot, MetaStat } from "../shell/PageHeader";
import { SECTION_CLIENT, buildNavCounts } from "../shell/navConfig";
import { DataFreshnessIndicator } from "../components/DataFreshnessIndicator";
import { DspHealthPanel } from "../components/DspHealthPanel";
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
import { TooltipProvider } from "../../../ui/Tooltip";

export default function ClientDetailPage({
  slug, user, onLogout, onOpenReport, onNavigateView,
}) {
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
  // Totais GLOBAIS (não os deste cliente) — o rail lista destinos, e a
  // contagem ao lado de "Por mês" tem que ser a mesma em qualquer rota.
  // Antes esta página passava o total local e o rail dizia "Por mês 2" aqui
  // e "Por mês 9" no menu.
  const [globalTotals, setGlobalTotals] = useState(() => {
    const cached = bootstrap.campaigns?.data ?? [];
    if (!cached.length) return { campaigns: undefined, clients: undefined };
    return {
      campaigns: cached.length,
      clients: new Set(cached.map((c) => normalizeSlug(c.client_name)).filter(Boolean)).size,
    };
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
  // Direção de ordenação — o drilldown era a única superfície admin sem
  // ela: o `ToolbarV2` recebia `sortBy` mas nunca `sortDir`, então o botão
  // de inverter não renderizava e o cliente ficava preso em decrescente.
  const [sortDir, setSortDir]         = useState("desc");

  const [drawerCampaign, setDrawerCampaign] = useState(null);
  const [copied, setCopied]                 = useState(null);
  const [loomModal, setLoomModal]           = useState(null);
  const [surveyModal, setSurveyModal]       = useState(null);
  const [logoModal, setLogoModal]           = useState(null);
  const [ownerModal, setOwnerModal]         = useState(null);
  const [mergeModal, setMergeModal]         = useState(null);
  const [negotiationModal, setNegotiationModal] = useState(null); // { short_token, negotiation }
  const [portalOpen, setPortalOpen] = useState(false); // drawer "Link compartilhado"

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

  // `dirMul` inverte a comparação sem duplicar cada `localeCompare`. As
  // funções base ordenam ASC; `desc` multiplica por -1.
  const dirMul = sortDir === "asc" ? 1 : -1;

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortBy === "alpha")      return dirMul * (a.campaign_name || "").localeCompare(b.campaign_name || "");
      if (sortBy === "start_date") return dirMul * (a.start_date    || "").localeCompare(b.start_date    || "");
      // "month" (default): por data de início. O agrupamento visual por mês
      // vem do MonthGroupedSections; aqui é a ordem DENTRO do grupo.
      return dirMul * (a.start_date || "").localeCompare(b.start_date || "");
    });
  }, [filtered, sortBy, dirMul]);

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
    // refresh:true é OBRIGATÓRIO: `?list=true` tem Cache-Control max-age=30,
    // então sem forçar refresh o refetch (e um F5) dentro de 30s viria do
    // HTTP cache do browser — payload pré-merge sem merge_id → o grupo não
    // renderiza no MergeGroupCardV2. Mesmo motivo do handleMergeSaved do
    // CampaignMenuV2 e do handleAbsSaved abaixo.
    listCampaigns({ refresh: true })
      .then((camps) => {
        writeCache("menu.campaigns", camps);
        setCampaigns(camps.filter((c) => normalizeSlug(c.client_name) === slug));
        setGlobalTotals({
          campaigns: camps.length,
          clients: new Set(camps.map((c) => normalizeSlug(c.client_name)).filter(Boolean)).size,
        });
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
        setGlobalTotals({
          campaigns: camps.length,
          clients: new Set(camps.map((c) => normalizeSlug(c.client_name)).filter(Boolean)).size,
        });
        setLastFetchedAt(Date.now());
      })
      .catch(() => { /* keep stale */ });
  }, [slug]);

  // Fechamento manual — atualização otimista local pra contornar o
  // read-after-write delay do BigQuery. Sobrescreve `closed_at` no objeto
  // da campanha no array local; o getCampaignStatus do card já enxerga e
  // troca o badge âmbar → cinza "encerrada" sem refresh da página.
  //
  // drawerCampaign NÃO é tocado de propósito — ver comentário equivalente
  // em CampaignMenuV2: mantém o botão "Marcar como encerrada" montado pra
  // a animação de sucesso completar.
  const handleClosureSaved = useCallback((short_token) => {
    const closedAtIso = new Date().toISOString();
    setCampaigns((prev) =>
      prev.map((c) =>
        c.short_token === short_token ? { ...c, closed_at: closedAtIso } : c
      )
    );
  }, []);

  // Check-ups semanais salvos no drawer — patch otimista do chip do card
  // (espelha CampaignMenuV2.handleCheckupsSaved). Sem refetch: BQ tem
  // read-after-write lag e o chip regrediria.
  const handleCheckupsSaved = useCallback((short_token, log) => {
    const arr = Array.isArray(log) ? log : [];
    const applyTo = (c) =>
      c.short_token === short_token
        ? { ...c, weekly_checkup_log: arr, weekly_checkups: arr.length }
        : c;
    setCampaigns((prev) => prev.map(applyTo));
    setDrawerCampaign((prev) => (prev ? applyTo(prev) : prev));
  }, []);

  // Pausa/retomada otimista — espelha CampaignMenuV2.handlePauseSaved.
  // Atualiza array local + drawerCampaign aberto pra refletir Pausar↔Retomar
  // sem esperar refresh do BQ (read-after-write delay).
  const handlePauseSaved = useCallback((short_token, nextPaused, reason) => {
    const pausedAtIso = nextPaused ? new Date().toISOString() : null;
    const cleanReason = nextPaused && reason ? String(reason).trim() : "";
    const applyTo = (c) => {
      if (c.short_token !== short_token) return c;
      const { paused_at: _a, paused_reason: _r, ...rest } = c;
      if (!pausedAtIso) return rest;
      const next = { ...rest, paused_at: pausedAtIso };
      if (cleanReason) next.paused_reason = cleanReason;
      return next;
    };
    setCampaigns((prev) => prev.map(applyTo));
    setDrawerCampaign((prev) => (prev ? applyTo(prev) : prev));
  }, []);

  // Encerramento antecipado otimista + reconcile — espelha
  // CampaignMenuV2.handleEarlyEndSaved. O patch otimista reflete na hora; o
  // refetch (refresh=true) reconcilia com o BQ pra o estado sobreviver ao
  // F5. Seguro porque o save usa MERGE/DELETE (DML, strongly consistent) —
  // sem read-after-write lag — e refresh=true bypassa o _list_cache.
  const handleEarlyEndSaved = useCallback((short_token, payload) => {
    const applyTo = (c) => {
      if (c.short_token !== short_token) return c;
      const { early_end_date: _d, early_end_reason: _r, ...rest } = c;
      if (!payload) return rest;
      const next = { ...rest, early_end_date: payload.early_end_date };
      if (payload.early_end_reason) next.early_end_reason = payload.early_end_reason;
      return next;
    };
    setCampaigns((prev) => prev.map(applyTo));
    setDrawerCampaign((prev) => (prev ? applyTo(prev) : prev));

    listCampaigns({ refresh: true })
      .then((camps) => {
        writeCache("menu.campaigns", camps);
        setCampaigns(camps.filter((c) => normalizeSlug(c.client_name) === slug));
        setGlobalTotals({
          campaigns: camps.length,
          clients: new Set(camps.map((c) => normalizeSlug(c.client_name)).filter(Boolean)).size,
        });
        setLastFetchedAt(Date.now());
      })
      .catch(() => { /* keep stale — patch otimista já refletiu */ });
  }, [slug]);

  const navCounts = buildNavCounts(globalTotals);

  const activeFilters = [];
  if (search.trim()) {
    activeFilters.push({ id: "search", label: `Busca: ${search.trim()}`, onClear: () => setSearch("") });
  }
  if (ownerFilter.length > 0) {
    activeFilters.push({
      id: "owner",
      label: `Owner: ${ownerFilterLabel(ownerFilter, teamMembers)}`,
      onClear: () => setOwnerFilter([]),
    });
  }

  const goToReports = useCallback(() => {
    onNavigateView?.("reports", "month");
  }, [onNavigateView]);

  return (
    <TooltipProvider delayDuration={200}>
    <AdminShell
      section={SECTION_CLIENT}
      layout={null}
      navCounts={navCounts}
      onNavigate={onNavigateView}
      viewLabel={displayName}
      tally={
        kpis.totalCampaigns
          ? `${kpis.totalCampaigns} campanhas${kpis.activeCampaigns ? ` · ${kpis.activeCampaigns} ativas` : ""}`
          : undefined
      }
      busy={refreshing && !refreshError}
      user={user}
      onLogout={onLogout}
      wide={false}
      operationSlots={
        <>
          <DataFreshnessIndicator variant="rail" user={user} />
          <DspHealthPanel variant="rail" onOpenReport={onOpenReport} />
        </>
      }
      // Button do DS, não um <button> com classes à mão: a ação primária do
      // drilldown precisa ter a MESMA geometria de "+ Novo Report" e
      // "Exportar", que são as primárias das outras duas rotas.
      actions={
        <Button variant="primary" size="sm" onClick={() => setPortalOpen(true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <span className="hidden sm:inline">Link compartilhado</span>
        </Button>
      }
    >
      <PageHeader
        eyebrow={
          <button
            type="button"
            onClick={goToReports}
            className="inline-flex items-center gap-1 hover:text-fg-muted transition-colors cursor-pointer border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature rounded"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Reports
          </button>
        }
        title={displayName}
        meta={
          <>
            <MetaStat value={kpis.totalCampaigns} label="campanhas no total" />
            {kpis.activeCampaigns > 0 && (
              <>
                <MetaDot />
                <MetaStat value={kpis.activeCampaigns} label="rodando agora" tone="success" />
              </>
            )}
          </>
        }
      />

      {/* Banner de "dados desatualizados" — refresh em background falhou.
          Mesma receita do menu (tokens `warning`, não style inline). */}
      {refreshError && (
        <div
          role="status"
          className="mb-4 flex items-center justify-between gap-3 flex-wrap rounded-lg border border-warning/30 bg-warning-soft px-3 py-2"
        >
          <p className="text-xs text-fg">
            <span className="font-semibold">Dados desatualizados.</span>{" "}
            Não consegui atualizar agora
            {lastFetchedAt ? ` — mostrando dados de ${formatTimeAgo(lastFetchedAt)}.` : "."}
          </p>
          {/* Mesmo Button do banner equivalente no menu — os dois avisos de
              "dado desatualizado" agora são o mesmo objeto nas duas rotas. */}
          <Button variant="ghost" size="sm" onClick={handleRetry} disabled={refreshing}>
            {refreshing ? "Tentando…" : "Tentar de novo"}
          </Button>
        </div>
      )}

      {/* KPIs do cliente — mesmo board colapsável e mesmas células com filete
          do menu e do PMP. Antes eram quatro Cards bordados soltos: a mesma
          informação, num terceiro tratamento visual, na terceira rota. */}
      <KpiBoard
        scope="client"
        title={`Desempenho · ${displayName}`}
        summary={[
          { label: "Ativas", value: kpis.activeCampaigns ?? "—" },
          { label: "Pacing", value: formatPacingValue(kpis.avgPacing) },
          { label: "CTR", value: formatPct(kpis.avgCtr, 2) },
          { label: "VTR", value: formatPct(kpis.avgVtr, 1) },
        ]}
      >
        <div className="grid grid-cols-2 @min-[560px]:grid-cols-4 gap-px bg-border">
          <KpiCell label="Campanhas ativas" value={kpis.activeCampaigns ?? "—"} />
          <KpiCell label="Pacing médio"     value={formatPacingValue(kpis.avgPacing)} colorClass={pacingColorClass(kpis.avgPacing)} />
          <KpiCell label="CTR médio"        value={formatPct(kpis.avgCtr, 2)} colorClass="text-success" />
          <KpiCell label="VTR médio"        value={formatPct(kpis.avgVtr, 1)} colorClass="text-success" />
        </div>
      </KpiBoard>

      <FilterBar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar campanha ou token…"
        chips={teamMembers ? [{
          id: "owner",
          label: "Owner",
          value: ownerFilterLabel(ownerFilter, teamMembers),
          panel: () => (
            <OwnerFilterPanel
              selected={ownerFilter}
              onChange={setOwnerFilter}
              teamMembers={teamMembers}
            />
          ),
        }] : []}
        trailing={
          <SortChipFilter
            options={CLIENT_DETAIL_SORTS}
            value={sortBy}
            dir={sortDir}
            onValueChange={setSortBy}
            onDirToggle={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            defaultValue="month"
            defaultDir="desc"
          />
        }
        active={activeFilters}
        onClearAll={() => { setSearch(""); setOwnerFilter([]); }}
        resultLabel={
          activeFilters.length > 0 && kpis.totalCampaigns
            ? `${sorted.length} de ${kpis.totalCampaigns} campanhas`
            : null
        }
      />

        {/* Sem cabeçalho de seção aqui: o H1 já diz o cliente, a barra de
            filtros já diz "N de M campanhas", e o cabeçalho de cada mês
            repete a contagem logo abaixo. Eram três lugares dizendo o mesmo
            número em 60px de altura. */}

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
        onClosureChange={handleClosureSaved}
        onCheckupsSaved={handleCheckupsSaved}
        onPauseChange={handlePauseSaved}
        onEarlyEndChange={handleEarlyEndSaved}
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

      <ClientPortalDrawer
        open={portalOpen}
        onOpenChange={setPortalOpen}
        slug={slug}
        displayName={displayName}
        clientCampaigns={campaigns}
      />
    </AdminShell>
    </TooltipProvider>
  );
}

// Ordenação do drilldown. O `ToolbarV2` recebia `sortBy` mas nunca
// `sortOptions`, então o dropdown listava as opções do MENU — incluindo
// campos que esta página não implementa (ECPM, pacing, investimento). Aqui
// são só os três critérios que o `sorted` de fato aplica.
const CLIENT_DETAIL_SORTS = [
  { value: "month",      label: "Mês de início" },
  { value: "start_date", label: "Data de início" },
  { value: "alpha",      label: "Nome da campanha" },
];

/**
 * Célula do board de KPIs. Mesma receita das células do MetricStrip (menu) e
 * do PmpKpiStrip: rótulo em `lbl-section`, valor em tabular-nums, fundo
 * `canvas-elevated` e o filete vindo do `gap-px` sobre `bg-border` da grade.
 */
function KpiCell({ label, value, colorClass }) {
  return (
    <div className="bg-canvas-elevated px-3.5 py-3">
      <div className="lbl-section">{label}</div>
      <div className={`text-xl font-extrabold tracking-tight tabular-nums mt-1.5 ${colorClass || "text-fg"}`}>
        {value}
      </div>
    </div>
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
