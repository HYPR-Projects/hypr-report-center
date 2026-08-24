// src/v2/admin/pages/CampaignMenuV2.jsx
//
// Reports de Campanhas — a rota raiz do admin. Cinco views sobre o mesmo
// conjunto de campanhas:
//
//   month       cards agrupados por mês de início
//   client      cards de cliente com sparkline + métricas agregadas
//   list        lista densa estilo Linear
//   performers  leaderboard de CS/CP
//   diagnostico tabela de pacing com status Ok/Over/Super Over/Under
//
// ── O que esta página deixou de fazer ────────────────────────────────────
// Header, navegação entre views e largura de coluna agora são do
// `AdminShell`. A `layout` chega por PROP (derivada da URL em App.jsx), não
// mais de `useState` + `localStorage`: cada view tem caminho próprio, então
// refresh, voltar/avançar e link compartilhável funcionam.
//
// Os filtros que viviam em quatro faixas separadas — toolbar (busca, owner,
// ordenação, direção), pill "Apenas ativas", dez pílulas de mês, três
// pílulas de worklist, mais o banner de "filtro ativo" que aparecia por
// cima de tudo — são uma `FilterBar` só. As funções de filtro e ordenação
// não mudaram uma linha; mudou quem as invoca.
//
// ── O que continua igual ─────────────────────────────────────────────────
//   - stale-while-revalidate do payload em localStorage
//   - lazy fetch de listClients (só na view "client")
//   - prefetch de detail/access/notes e o motor de alertas
//   - todas as ações de campanha (Loom, Survey, Logo, Owner, Merge,
//     Analytics, Negociação, uploads RMND/PDOOH, ABS, fechamento,
//     check-ups, pausa, encerramento antecipado) no CampaignDrawer

import { useState, useEffect, useMemo, useCallback, useSyncExternalStore } from "react";
// IMPORT CRÍTICO — sem isso o Tailwind+theme.css não chega no bundle do
// admin (v2.css é onde @import "tailwindcss" e tokens HYPR vivem). O
// ClientDashboardV2 já importa em outro chunk lazy, mas o admin é a
// rota raiz, então precisa importar explicitamente aqui.
import "../../v2.css";

import { listCampaigns, listTeamMembers, listClients, getShareId, getCachedShareId } from "../../../lib/api";
import { readCache, writeCache } from "../../../lib/persistedCache";
import {
  getOwnerFilter, setOwnerFilter as persistOwnerFilter,
  getSortBy as getSortByPref, setSortBy as setSortByPref,
  getSortDir as getSortDirPref, setSortDir as setSortDirPref,
} from "../../../shared/prefs";
import {
  CAMPAIGN_SORT_OPTIONS, CAMPAIGN_SORT_DEFAULT, CAMPAIGN_SORT_FIELDS, compareCampaigns,
  CLIENT_SORT_OPTIONS,   CLIENT_SORT_DEFAULT,   CLIENT_SORT_FIELDS,   compareClients,
  getDefaultDirection,
} from "../lib/sort";
import { createOwnerMatcher } from "../lib/ownerFilter";
import { useLoadingTask } from "../../../shared/loading";
import { useTheme } from "../../hooks/useTheme";
import { normalizeSlug, computeMetricsSummary, computeWorklist, computeHealthDistribution } from "../lib/aggregation";

import NewCampaignModal from "../../../components/modals/NewCampaignModal";
import LoomModal from "../../../components/modals/LoomModal";
import SurveyModal from "../../../components/modals/SurveyModal";
import LogoModal from "../../../components/modals/LogoModal";
import OwnerModal from "../../../components/modals/OwnerModal";
import MergeModal from "../../../components/modals/MergeModal";
import RmndUploadModal from "../../../components/modals/RmndUploadModal";
import PdoohUploadModal from "../../../components/modals/PdoohUploadModal";
import { NegotiationModal } from "../../components/NegotiationModal";
import { getOrIssueAdminJwt } from "../../../shared/auth";

import { Button } from "../../../ui/Button";
import { Skeleton } from "../../../ui/Skeleton";
import { DataFreshnessIndicator } from "../components/DataFreshnessIndicator";
import { DspHealthPanel } from "../components/DspHealthPanel";

import { MetricStrip, WorklistChips } from "../components/MetricStrip";
import { PerformersLayout } from "../components/TopPerformers";
import { MonthFilterPanel } from "../components/MonthFilterPills";
import { OwnerFilterPanel } from "../components/OwnerFilter";
import { KpiBoard } from "../components/KpiBoard";
import {
  FilterBar, FilterPanel, FilterOption, FilterPanelClear, SortChipFilter,
} from "../components/FilterBar";
import { ownerFilterLabel, monthFilterLabel, situationLabel, WORKLIST_LABELS } from "../lib/filterLabels";
import { PERIOD_PRESETS, formatPeriodLabel } from "../lib/period";
import { AdminShell } from "../shell/AdminShell";
import { PageHeader, MetaDot, MetaStat } from "../shell/PageHeader";
import { buildNavCounts, SECTION_REPORTS, viewMeta } from "../shell/navConfig";
import { ClientCard } from "../components/ClientCard";
import { CampaignCardV2 } from "../components/CampaignCardV2";
import { CampaignListV2 } from "../components/CampaignListV2";
import { CampaignDrawer } from "../components/CampaignDrawer";
import { ReportAnalyticsModal } from "../components/ReportAnalyticsModal";
import { prefetchAccessSummaries } from "../lib/accessSummaryCache";
import { prefetchNoteSummaries } from "../lib/notesSummaryCache";
import { MonthGroupedSections } from "../components/MonthGroupedSections";
import { formatMonthLabel, getCampaignStatus } from "../lib/format";
import { DiagnosticoLayout } from "../components/DiagnosticoLayout";
import { AlertsBell } from "../components/AlertsBell";
import { AlertCampaignSheet } from "../components/AlertCampaignSheet";
import { generateAlerts } from "../lib/alerts/engine";
import { SEVERITY } from "../lib/alerts/constants";
import { TooltipProvider } from "../../../ui/Tooltip";
import {
  schedulePrefetch,
  subscribeDetail,
  getAllPrefetchedDetails,
} from "../../../lib/prefetchReport";

export default function CampaignMenuV2({
  user, onLogout, onOpenReport, onOpenClient,
  // `layout` vem da URL (ver navConfig + App.jsx). A persistência em
  // localStorage continua existindo, mas em App.jsx no momento de navegar —
  // aqui a view é só leitura.
  layout = "month",
  onNavigateView,
}) {
  // ── Estado de dados ──────────────────────────────────────────────────────
  // Stale-while-revalidate: lemos o último payload bom do localStorage
  // *sincronamente* no primeiro render. Resultado: 2ª+ visita ao menu
  // pinta dados imediatamente, refetch corre em background e atualiza
  // quando voltar. Se o refetch falhar, mantemos o cache e mostramos
  // banner sutil. Resolve o bug de "0 campanhas" pós-blip de rede.
  //
  // Lazy listClients (perf): só fazemos fetch do `?action=list_clients`
  // (~43KB + query de timeseries no backend) quando o user efetivamente
  // entra no layout "client". Worklist e contagem de clientes são
  // derivados client-side a partir de `campaigns` no init —
  // funcionalmente equivalente ao backend (paridade testada em
  // aggregation.js).
  const [bootstrap] = useState(() => {
    const cachedCampaigns = readCache("menu.campaigns");
    const cachedClients   = readCache("menu.clients");
    const cachedTeam      = readCache("menu.team");
    // Kicka o prefetch de access summaries DENTRO do init de bootstrap.
    //
    // Por quê: quando vínhamos com cache de campanhas em localStorage,
    // o primeiro render acontecia com 273 cards montados ANTES do
    // useEffect inferior disparar prefetchAccessSummaries. No primeiro
    // render, cada AccessBadge consultava o módulo accessSummaryCache:
    //   - cache.has(token) = false     (Map zerado no reload)
    //   - inflight = null              (prefetch ainda não chamado)
    //   - requestedTokens.has = false  (idem)
    //   → isLoadingSummary() = false → badge renderizava `0` real.
    // Depois quando o prefetch resolvia, emit() rerenderizava com o
    // número certo. O user via o flash de zeros e atribuía a "às vezes
    // só hard refresh mostra o número".
    //
    // Disparando SÍNCRONO aqui, `inflight` está setado antes do React
    // pintar a primeira frame → badge renderiza skeleton → vai pro
    // valor real sem passar por 0. Cache do módulo deduplica com o
    // prefetch que o useEffect dispara depois (vê inflight, espera).
    if (cachedCampaigns?.data) {
      const tokens = cachedCampaigns.data
        .map((c) => c.short_token)
        .filter(Boolean);
      if (tokens.length > 0) {
        prefetchAccessSummaries(tokens).catch(() => { /* silencioso */ });
        prefetchNoteSummaries(tokens).catch(() => { /* silencioso */ });
      }
    }
    return {
      campaigns: cachedCampaigns,
      clients:   cachedClients,
      team:      cachedTeam,
    };
  });
  const [campaigns, setCampaigns]     = useState(bootstrap.campaigns?.data ?? []);
  const [clients, setClients]         = useState(bootstrap.clients?.data?.clients ?? []);
  // Worklist: prioriza cache do backend (mais recente em conteúdo);
  // se não houver, deriva do snapshot cacheado de campaigns; senão null
  // até a 1ª resposta de listCampaigns chegar.
  const [worklist, setWorklist] = useState(() => {
    if (bootstrap.clients?.data?.worklist) return bootstrap.clients.data.worklist;
    if (bootstrap.campaigns?.data) return computeWorklist(bootstrap.campaigns.data);
    return null;
  });
  // loading só vira skeleton quando NÃO temos cache (1ª visita ou cache wiped).
  const [loading, setLoading]         = useState(!bootstrap.campaigns);
  const [teamMembers, setTeamMembers] = useState(bootstrap.team?.data ?? { cps: [], css: [] });
  // Refresh em andamento (background) + erros do último refresh +
  // timestamp do dado atualmente em tela. Alimenta o banner de "stale".
  // `refreshing` começa true porque o useEffect inicial sempre dispara
  // um fetch — manter false aqui exigiria setRefreshing(true) síncrono
  // dentro do effect, o que viola react-hooks/set-state-in-effect.
  const [refreshing, setRefreshing]       = useState(true);
  const [refreshError, setRefreshError]   = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(bootstrap.campaigns?.ts ?? null);
  // Estado da listClients lazy — separado do refresh principal pra
  // não bloquear UI das outras layouts.
  const [clientsFetchedAt, setClientsFetchedAt] = useState(bootstrap.clients?.ts ?? null);
  const [clientsLoading, setClientsLoading]     = useState(false);

  // Cold load + refresh em background entram no contador global → barrinha
  // no topo só aparece se demorar > 200ms. Cobre o primeiro acesso do dia:
  // dados atualizam 1x/dia às 6h, o backend leva alguns segundos pra
  // recompor pacing/CTR/VTR, e o user vê feedback de que tá vindo.
  // listClients NÃO entra aqui (lazy, só dispara na view client).
  useLoadingTask(loading || refreshing);

  // ── Estado de UI ─────────────────────────────────────────────────────────
  const [search, setSearch]               = useState("");
  const [ownerFilter, setOwnerFilter]     = useState(() => getOwnerFilter());
  const [activeMonth, setActiveMonth]     = useState(null);
  // Toggle "apenas ativas" — filtra campanhas com status in_flight (não
  // pausadas, não encerradas). Composável com mês e owner: clicar "Mai 26"
  // + "Apenas ativas" mostra só ativas de maio. Default off pra preservar
  // a UX de "vejo tudo por padrão".
  const [onlyActive, setOnlyActive]       = useState(false);
  // Sort por escopo — campanhas e clientes têm conjuntos diferentes de
  // opções, e cada um persiste campo + direção separados.
  //
  // O `validate*` filtra valores stale do localStorage (ex: usuário voltou
  // depois da refatoração que renomeou "ecpm_desc" → field "ecpm" + dir
  // "desc"). Sem ele, sort silenciosamente vira default e o user vê algo
  // diferente do que tinha selecionado.
  const validateCampaignSort = (v) => CAMPAIGN_SORT_FIELDS.has(v) ? v : CAMPAIGN_SORT_DEFAULT;
  const validateClientSort   = (v) => CLIENT_SORT_FIELDS.has(v)   ? v : CLIENT_SORT_DEFAULT;

  const [campaignsSortBy,  setCampaignsSortBy]  = useState(() => validateCampaignSort(getSortByPref("campaigns", CAMPAIGN_SORT_DEFAULT)));
  const [campaignsSortDir, setCampaignsSortDir] = useState(() => getSortDirPref("campaigns", getDefaultDirection(CAMPAIGN_SORT_DEFAULT)));
  const [clientsSortBy,    setClientsSortBy]    = useState(() => validateClientSort(getSortByPref("clients",   CLIENT_SORT_DEFAULT)));
  const [clientsSortDir,   setClientsSortDir]   = useState(() => getSortDirPref("clients",   getDefaultDirection(CLIENT_SORT_DEFAULT)));
  const [activeWorklist, setActiveWorklist] = useState(null);
  // Controles do leaderboard. Vivem aqui (e não dentro do PerformersLayout)
  // porque viram chips da FilterBar — antes esta era a única view que
  // escondia a barra inteira e desenhava dois controles próprios.
  const [performerRole, setPerformerRole]     = useState("cs");
  const [performerPreset, setPerformerPreset] = useState("now");
  const [performerCustom, setPerformerCustom] = useState({ from: "", to: "" });
  const [drawerCampaign, setDrawerCampaign] = useState(null);
  const [copied, setCopied]               = useState(null);

  // Modais legacy reaproveitados
  const [showNewCampaign, setShowNewCampaign] = useState(false);
  const [loomModal, setLoomModal]         = useState(null);
  const [surveyModal, setSurveyModal]     = useState(null);
  const [logoModal, setLogoModal]         = useState(null);
  const [ownerModal, setOwnerModal]       = useState(null);
  const [mergeModal, setMergeModal]       = useState(null);
  const [rmndModal, setRmndModal]         = useState(null);
  const [pdoohModal, setPdoohModal]       = useState(null);
  const [negotiationModal, setNegotiationModal] = useState(null); // { short_token, negotiation }
  const [analyticsModal, setAnalyticsModal] = useState(null); // campaign obj
  const [adminJwtForUploads, setAdminJwtForUploads] = useState(null);

  // Theme — single source of truth via hook V2 (aplica data-theme no
  // <html>, persiste em localStorage com a key correta 'hypr_theme',
  // e sincroniza com prefers-color-scheme do OS quando user não tem
  // preferência salva).
  const [theme] = useTheme();
  const isDark = theme === "dark";

  // Persistência
  useEffect(() => { persistOwnerFilter(ownerFilter); }, [ownerFilter]);
  useEffect(() => { setSortByPref ("campaigns", campaignsSortBy);  }, [campaignsSortBy]);
  useEffect(() => { setSortDirPref("campaigns", campaignsSortDir); }, [campaignsSortDir]);
  useEffect(() => { setSortByPref ("clients",   clientsSortBy);    }, [clientsSortBy]);
  useEffect(() => { setSortDirPref("clients",   clientsSortDir);   }, [clientsSortDir]);

  // Handlers que setam campo + aplicam direção default daquele campo.
  // User pode flipar direção depois pelo botão de toggle.
  const handleCampaignsSortByChange = useCallback((field) => {
    setCampaignsSortBy(field);
    setCampaignsSortDir(getDefaultDirection(field));
  }, []);
  const handleClientsSortByChange = useCallback((field) => {
    setClientsSortBy(field);
    setClientsSortDir(getDefaultDirection(field));
  }, []);
  const toggleCampaignsSortDir = useCallback(() => {
    setCampaignsSortDir((d) => (d === "asc" ? "desc" : "asc"));
  }, []);
  const toggleClientsSortDir = useCallback(() => {
    setClientsSortDir((d) => (d === "asc" ? "desc" : "asc"));
  }, []);
  // teamMap pra resolver email → display name
  const teamMap = useMemo(() => {
    const m = {};
    teamMembers.cps.forEach((p) => { m[p.email] = p.name; });
    teamMembers.css.forEach((p) => { m[p.email] = p.name; });
    return m;
  }, [teamMembers]);

  // ── Carregamento / refresh ───────────────────────────────────────────────
  // Estratégia: usar Promise.allSettled (não Promise.all) pra que falha
  // de uma das duas queries não corrompa os dados da outra. Cada seção
  // que sucede é commitada e cacheada individualmente; falhas vão pro
  // `refreshError` que renderiza o banner de "dados desatualizados".
  //
  // Note que `listClients` NÃO está aqui — fetch é lazy via outro
  // useEffect quando o user troca pra layout "client". Worklist é
  // derivada de campaigns via computeWorklist.
  //
  // Importante: `runRefresh` NÃO chama setRefreshing(true). O caller é
  // responsável (a inicialização já é true via useState; o botão de
  // retry seta antes de invocar). Isso evita violação de
  // react-hooks/set-state-in-effect.
  const runRefresh = useCallback(() => {
    let cancelled = false;

    Promise.allSettled([
      listCampaigns(),
      listTeamMembers(),
    ]).then(([campsR, membersR]) => {
      if (cancelled) return;

      const errors = [];

      if (campsR.status === "fulfilled") {
        setCampaigns(campsR.value);
        writeCache("menu.campaigns", campsR.value);
        // Recalcula worklist client-side — paridade com backend
        // (testada em aggregation.js).
        setWorklist(computeWorklist(campsR.value));
        // Dispara prefetch dos access summaries pra alimentar os badges
        // dos cards. 1 request batched, dedup interno via cache.
        const tokens = (campsR.value || []).map((c) => c.short_token).filter(Boolean);
        prefetchAccessSummaries(tokens).catch(() => { /* silencioso */ });
        // Mesma ideia pro indicador de notas internas dos cards: 1 request
        // batched pro menu inteiro, nunca fetch por card.
        prefetchNoteSummaries(tokens).catch(() => { /* silencioso */ });
      } else {
        errors.push(`campaigns: ${campsR.reason?.message || campsR.reason}`);
      }

      if (membersR.status === "fulfilled") {
        setTeamMembers(membersR.value);
        writeCache("menu.team", membersR.value);
        const validEmails = new Set([
          ...membersR.value.cps.map((p) => p.email),
          ...membersR.value.css.map((p) => p.email),
        ]);
        // Filtra emails que sumiram do team (ex: pessoa removida da planilha).
        // Mantém os ainda válidos pra não derrubar a seleção do user inteira.
        setOwnerFilter((prev) => prev.filter((email) => validEmails.has(email)));
      } else {
        errors.push(`team: ${membersR.reason?.message || membersR.reason}`);
      }

      // Timestamp avança só se a query principal (campaigns) deu certo —
      // é a fonte de verdade do menu. Senão o banner de "atualizado há X"
      // mente.
      if (campsR.status === "fulfilled") setLastFetchedAt(Date.now());

      if (errors.length > 0) {
        setRefreshError(errors.join(" | "));
        console.warn("[menu] refresh failures:", errors);
      } else {
        setRefreshError(null);
      }

      setLoading(false);
      setRefreshing(false);
    });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const cancel = runRefresh();
    return cancel;
  }, [runRefresh]);

  // Lazy fetch da lista rica de clientes (com sparklines + trend).
  // Dispara apenas quando o user vai pra layout "client". TTL de 60s pra
  // não refazer fetch se trocar entre layouts. Se já tem cache fresco
  // (clientsFetchedAt < 60s), skip silencioso.
  //
  // setClientsLoading(true) entra via queueMicrotask pra não violar
  // react-hooks/set-state-in-effect — o cascade real é 1 render extra,
  // imperceptível, mas o microtask satisfaz o analisador estático e
  // mantém o skeleton aparecendo no mesmo frame.
  const CLIENTS_TTL_MS = 60_000;
  const fetchClients = useCallback(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setClientsLoading(true);
    });
    listClients().then((resp) => {
      if (cancelled) return;
      setClients(resp.clients);
      // Backend tem mesma régua de worklist que computeWorklist —
      // sobrescrever mantém os números consistentes (e prepara pro dia
      // que reports_not_viewed virar real no backend).
      setWorklist(resp.worklist);
      writeCache("menu.clients", { clients: resp.clients, worklist: resp.worklist });
      setClientsFetchedAt(Date.now());
    }).catch((err) => {
      if (cancelled) return;
      console.warn("[menu] listClients failed:", err.message);
      // Não setRefreshError aqui — o layout cliente é opcional, falha
      // não merece banner global. Cards do client tab caem no estado
      // vazio ou no cache stale, ambos aceitáveis.
    }).finally(() => {
      if (!cancelled) setClientsLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (layout !== "client") return;
    if (clientsFetchedAt && Date.now() - clientsFetchedAt < CLIENTS_TTL_MS) return;
    return fetchClients();
  }, [layout, clientsFetchedAt, fetchClients]);

  // ── Filtragem e ordenação ────────────────────────────────────────────────
  // Matcher de owners memoizado: split CP/CS feito uma vez por mudança de
  // ownerFilter ou teamMembers, não por campanha.
  const ownerMatcher = useMemo(
    () => createOwnerMatcher(ownerFilter, teamMembers),
    [ownerFilter, teamMembers]
  );

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
      // Multi-owner: AND entre papéis (CP + CS), OR dentro do mesmo papel.
      // Ver `createOwnerMatcher` em ../lib/ownerFilter.js pra detalhes.
      const matchOwner = ownerMatcher(c);
      // "Apenas ativas" — usa getCampaignStatus pra cobrir os 4 estados
      // (in_flight / paused / awaiting_closure / ended). Aqui só in_flight
      // passa: paused conta como "ativa em pausa" e foi decisão explícita
      // do user pausar — manter junto teria sentido, mas "apenas ativas"
      // soa estrito; se virar útil incluir pausadas, abre uma 2ª opção.
      const matchActive = !onlyActive ||
        getCampaignStatus(c.end_date, c.closed_at, c.paused_at, c.early_end_date) === "in_flight";
      return matchSearch && matchMonth && matchOwner && matchActive;
    });
  }, [campaigns, search, activeMonth, ownerMatcher, activeWorklist, worklist, onlyActive]);

  const sortedCampaigns = useMemo(() => {
    return [...filteredCampaigns].sort(compareCampaigns(campaignsSortBy, campaignsSortDir));
  }, [filteredCampaigns, campaignsSortBy, campaignsSortDir]);

  // Contagem global de campanhas ativas (in_flight) — independente dos
  // outros filtros. Mostrada no chip "Apenas ativas". Recomputa quando
  // a lista de campanhas muda; não depende de search/owner/mês.
  const activeCampaignsCount = useMemo(
    () => campaigns.filter((c) =>
      getCampaignStatus(c.end_date, c.closed_at, c.paused_at, c.early_end_date) === "in_flight"
    ).length,
    [campaigns]
  );

  // Agrupamento por mês (apenas layout=month).
  //
  // Sort se aplica DENTRO de cada grupo, não entre grupos. Os meses ficam
  // sempre em ordem cronológica decrescente (mais recente primeiro), porque
  // sortar grupos por "Maior ECPM" embaralharia os meses (mês com a campanha
  // de maior ECPM viraria o 1º grupo) — confuso pro user. Layout=list é o
  // lugar pra ver tudo ordenado globalmente.
  const monthGroups = useMemo(() => {
    if (layout !== "month") return [];
    const acc = new Map();
    for (const c of filteredCampaigns) {
      const m = c.start_date?.slice(0, 7) || "no-date";
      if (!acc.has(m)) acc.set(m, []);
      acc.get(m).push(c);
    }
    const monthsSorted = [...acc.keys()].sort((a, b) => {
      if (a === "no-date") return 1;
      if (b === "no-date") return -1;
      return b.localeCompare(a);
    });
    const cmp = compareCampaigns(campaignsSortBy, campaignsSortDir);
    return monthsSorted.map((m) => {
      const items = [...acc.get(m)].sort(cmp);
      // Sinaliza pro MonthGroupedSections que um mês passado com pelo
      // menos uma campanha in_flight deve abrir por default — caso típico:
      // campanha de Abril que esticou pra Maio. Sem isso, o user precisava
      // expandir manualmente todo mês passado pra achar as que ainda rodam.
      const hasActive = items.some((c) =>
        getCampaignStatus(c.end_date, c.closed_at, c.paused_at, c.early_end_date) === "in_flight"
      );
      return {
        key: m,
        label: m === "no-date" ? "Sem data" : formatMonthLabel(m),
        items,
        expandedByDefault: hasActive,
      };
    });
  }, [filteredCampaigns, layout, campaignsSortBy, campaignsSortDir]);

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

      if (ownerFilter.length > 0) {
        // Cliente passa se QUALQUER campanha sua bate com a regra do
        // ownerMatcher (AND entre papéis, OR dentro do mesmo papel).
        const hasOwner = clientCampaigns.some(ownerMatcher);
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
  }, [clients, campaigns, search, ownerFilter, ownerMatcher, activeWorklist, worklist]);

  const sortedClients = useMemo(() => {
    return [...filteredClients].sort(compareClients(clientsSortBy, clientsSortDir));
  }, [filteredClients, clientsSortBy, clientsSortDir]);

  // Enriquece cada cliente com `health_distribution` quando o backend
  // não retorna esse campo (ainda). O fallback `aggregateClients` já
  // inclui; o backend novo (clients.py) pode ou não — aqui garantimos
  // sem precisar deploy coordenado.
  //
  // Junta via `active_short_tokens` × `campaigns` (mapa de tokens).
  // Memoizado pra rodar 1× por mudança de campanhas/clients, não a
  // cada render do ClientLayout.
  const enrichedClients = useMemo(() => {
    if (!sortedClients?.length) return sortedClients;
    let tokenIndex = null;
    return sortedClients.map((client) => {
      if (client.health_distribution) return client;
      if (!tokenIndex) {
        tokenIndex = new Map(campaigns.map((c) => [c.short_token, c]));
      }
      const activeCampaigns = (client.active_short_tokens || [])
        .map((t) => tokenIndex.get(t))
        .filter(Boolean);
      return {
        ...client,
        health_distribution: computeHealthDistribution(activeCampaigns),
      };
    });
  }, [sortedClients, campaigns]);

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
  //
  // refresh:true é OBRIGATÓRIO aqui: a resposta de `?list=true` tem
  // `Cache-Control: private, max-age=30`, então o refetch (e até um F5
  // manual) dentro da janela de 30s seria servido do HTTP cache do browser
  // — corpo pré-merge, sem merge_id → o selo "agrupado" não aparece e a
  // ação parece que não surtiu efeito. O backend já invalidou seu cache;
  // faltava furar o do browser. Mesmo motivo do handleAbsSaved abaixo.
  const handleMergeSaved = useCallback(() => {
    setMergeModal(null);
    listCampaigns({ refresh: true })
      .then((camps) => {
        setCampaigns(camps);
        writeCache("menu.campaigns", camps);
        setWorklist(computeWorklist(camps));
        setLastFetchedAt(Date.now());
        // Invalida clients lazy: agregação derivada por cliente pode ter
        // mudado (membros de merge_id reagrupam). Próxima entrada no
        // layout "client" refaz fetch.
        setClientsFetchedAt(null);
      })
      .catch(() => { /* keep stale */ });
  }, []);

  // Após toggle de ABS no drawer, refaz a lista pra pegar `display_has_abs`
  // / `video_has_abs` atualizados — backend já invalidou cache, mas frontend
  // tem cópia local em `campaigns`. Usa refresh=true pra bypass de HTTP cache
  // (ETag/max-age) também. Top Performers re-deriva score automaticamente
  // do novo array.
  const handleAbsSaved = useCallback(() => {
    listCampaigns({ refresh: true })
      .then((camps) => {
        setCampaigns(camps);
        writeCache("menu.campaigns", camps);
        setLastFetchedAt(Date.now());
        setClientsFetchedAt(null);
      })
      .catch(() => { /* keep stale — toggle já mostrou "Salvo" */ });
  }, []);

  // Quando um "Reconstruir agora" termina (evento do DataFreshnessIndicator),
  // o backend já derrubou o _list_cache — refaz a lista com refresh:true pra
  // reaquecer o cache do servidor e mostrar a base recém-reconstruída (ex.:
  // campanha nova que acabou de entrar no checklist) sem esperar o warmup 3/3h.
  useEffect(() => {
    const onBasesRebuilt = () => {
      listCampaigns({ refresh: true })
        .then((camps) => {
          setCampaigns(camps);
          writeCache("menu.campaigns", camps);
          setLastFetchedAt(Date.now());
          setClientsFetchedAt(null);
        })
        .catch(() => { /* keep stale — indicador já mostrou o resultado da run */ });
    };
    window.addEventListener("hypr:bases-rebuilt", onBasesRebuilt);
    return () => window.removeEventListener("hypr:bases-rebuilt", onBasesRebuilt);
  }, []);

  // Fechamento manual da campanha — atualização otimista. NÃO refazemos a
  // lista imediatamente porque BigQuery tem read-after-write lag (~segundos):
  // o INSERT do `campaign_closures` pode não estar visível na próxima query,
  // e a campanha voltaria sem `closed_at` (badge âmbar persistiria).
  // Em vez disso, sobrescrevemos o estado local com closed_at=now — quando
  // o user navegar e a lista re-buscar (ou refresh manual), o BQ já enxerga.
  //
  // NÃO mexemos no drawerCampaign de propósito: se o drawer estiver aberto
  // pra essa campanha quando o user clicar "Marcar como encerrada", manter
  // `awaiting=true` localmente garante que o botão fica montado e a animação
  // de sucesso roda. Quando o user fechar e reabrir, o campaign vem da lista
  // já com closed_at e o botão some naturalmente.
  const handleClosureSaved = useCallback((short_token) => {
    const closedAtIso = new Date().toISOString();
    setCampaigns((prev) => {
      const next = prev.map((c) =>
        c.short_token === short_token ? { ...c, closed_at: closedAtIso } : c
      );
      writeCache("menu.campaigns", next);
      return next;
    });
  }, []);

  // Check-ups semanais salvos no drawer — patch otimista do chip "check-ups
  // N/M" do card. Não refazemos a lista (BQ tem read-after-write lag de
  // segundos; o MERGE pode não estar visível ainda e o chip regrediria).
  // Atualiza também o drawerCampaign aberto pra o chip ficar consistente.
  const handleCheckupsSaved = useCallback((short_token, log) => {
    const arr = Array.isArray(log) ? log : [];
    const applyTo = (c) =>
      c.short_token === short_token
        ? { ...c, weekly_checkup_log: arr, weekly_checkups: arr.length }
        : c;
    setCampaigns((prev) => {
      const next = prev.map(applyTo);
      writeCache("menu.campaigns", next);
      return next;
    });
    setDrawerCampaign((prev) => (prev ? applyTo(prev) : prev));
  }, []);

  // Pausa/retomada da campanha — update otimista similar ao closure.
  // Quando `paused=true`, grava paused_at=now; quando false, remove o campo.
  // Atualiza também o drawerCampaign aberto pra o botão refletir o novo
  // estado (Pausar ↔ Retomar) imediatamente — diferente do closure, aqui
  // não há animação de sucesso a preservar, e o botão DEVE virar pra refletir
  // que o toggle aplicou.
  const handlePauseSaved = useCallback((short_token, nextPaused, reason) => {
    const pausedAtIso = nextPaused ? new Date().toISOString() : null;
    const cleanReason = nextPaused && reason ? String(reason).trim() : "";
    const applyTo = (c) => {
      if (c.short_token !== short_token) return c;
      const { paused_at: _a, paused_reason: _r, ...rest } = c;
      if (!pausedAtIso) return rest; // retomada — remove ambos
      const next = { ...rest, paused_at: pausedAtIso };
      if (cleanReason) next.paused_reason = cleanReason;
      return next;
    };
    setCampaigns((prev) => {
      const next = prev.map(applyTo);
      writeCache("menu.campaigns", next);
      return next;
    });
    setDrawerCampaign((prev) => (prev ? applyTo(prev) : prev));
  }, []);

  // Encerramento antecipado — update otimista + reconcile com refresh=true.
  // `payload` é null quando revertendo, ou {early_end_date, early_end_reason}
  // quando setando. Atualiza array local + drawerCampaign aberto pra refletir
  // o badge e o bloco de observação imediatamente.
  //
  // Diferente do closure (handleClosureSaved): aqui REFAZEMOS a lista logo
  // após o patch otimista. O save bate em `campaign_early_ends` via MERGE/
  // DELETE (DML, strongly consistent no BQ) — não há read-after-write lag,
  // então o refetch enxerga o early_end recém-gravado. Sem isso, o mount
  // (listCampaigns sem refresh) podia servir o `_list_cache` do backend
  // (TTL 15min, per-instância) ainda sem o early_end e sobrescrever o patch
  // otimista — encerramento "sumia" após F5.
  const handleEarlyEndSaved = useCallback((short_token, payload) => {
    const applyTo = (c) => {
      if (c.short_token !== short_token) return c;
      const { early_end_date: _d, early_end_reason: _r, ...rest } = c;
      if (!payload) return rest;
      const next = { ...rest, early_end_date: payload.early_end_date };
      if (payload.early_end_reason) next.early_end_reason = payload.early_end_reason;
      return next;
    };
    setCampaigns((prev) => {
      const next = prev.map(applyTo);
      writeCache("menu.campaigns", next);
      return next;
    });
    setDrawerCampaign((prev) => (prev ? applyTo(prev) : prev));

    // Reconcilia com a fonte de verdade — refresh=true bypassa o _list_cache.
    listCampaigns({ refresh: true })
      .then((camps) => {
        setCampaigns(camps);
        writeCache("menu.campaigns", camps);
        setWorklist(computeWorklist(camps));
        setLastFetchedAt(Date.now());
        setClientsFetchedAt(null);
      })
      .catch(() => { /* keep stale — patch otimista já refletiu */ });
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

  // totalClients derivado de campaigns (slug único) em vez de
  // `clients.length` — clients é lazy e fica vazio até o user entrar no
  // layout "client". A contagem por slug bate com `aggregateClients`.
  const totalClients = useMemo(() => {
    const slugs = new Set();
    for (const c of campaigns) {
      const s = normalizeSlug(c.client_name);
      if (s) slugs.add(s);
    }
    return slugs.size;
  }, [campaigns]);
  const totalCampaigns = campaigns.length;

  // KPIs agregados por cohort do mês (campanhas que iniciaram em `activeMonth`,
  // default = mês corrente). Comparação é vs cohort do mês anterior, e a
  // projeção do Tech Cost só roda quando o mês selecionado é o corrente.
  // Filtro de chips de mês alimenta direto a strip — clicar "Abr 26" troca os
  // números sem mudar de aba.
  const metricsSummary = useMemo(
    () => computeMetricsSummary(campaigns, { monthKey: activeMonth }),
    [campaigns, activeMonth]
  );

  // Bulk-prefetch de detail pra todas as campanhas in_flight assim que a
  // lista carrega. Sem isso, a regra A6 (frente desbalanceada) só dispara
  // quando o user passa o mouse em cada card — admin pode não chegar perto
  // do card que tá com problema, e o alerta nunca sobe pro sino.
  //
  // Concorrência: o teto vive no `prefetchReport` (fila global de 4 em voo),
  // não aqui. Antes o controle era um escalonamento de 40ms por token, que não
  // limita nada de fato — com ~41 ativas e ~2s por report, sobravam ~40 requests
  // abertas ao mesmo tempo. Essa rajada derrubou uma instância do backend em
  // 04/08. Enfileirar tudo de uma vez agora é seguro: quem segura é a fila.
  // `schedulePrefetch` já tem TTL 50s + dedup por token, então re-chamadas
  // (mount, refetch da lista) viram no-op naturalmente.
  useEffect(() => {
    if (!campaigns?.length) return;
    for (const c of campaigns) {
      if (getCampaignStatus(c.end_date, c.closed_at, c.paused_at, c.early_end_date) === "in_flight") {
        schedulePrefetch(c.short_token);
      }
    }
  }, [campaigns]);

  // Snapshot reativo do detailCache — re-renderiza quando qualquer detail
  // novo chega. Estável via getSnapshot referencial (objeto novo a cada
  // notify) — useSyncExternalStore só dispara quando o serverSnapshot muda,
  // e como buildAlerts é memoized abaixo em [detailMap], react só re-roda
  // quando o snapshot referência muda.
  const detailMap = useSyncExternalStore(
    subscribeDetail,
    getAllPrefetchedDetails,
    () => ({}),
  );

  // Engine de alertas — gera lista priorizada de riscos (A + C + E + H).
  // Memoiza em `campaigns + teamMap + detailMap` pra recomputar quando o
  // detalhe de cada campanha chega (A6 depende disso).
  const alerts = useMemo(
    () => generateAlerts(campaigns, getCampaignStatus, teamMap, detailMap),
    [campaigns, teamMap, detailMap]
  );

  // Contagem de críticos pro selo do rail no item "Diagnóstico". Usa a
  // mesma régua do sino (severidade CRITICAL), sem descontar os já lidos: o
  // rail informa o estado da OPERAÇÃO, o sino informa o que falta você ver.
  const criticalAlertCount = useMemo(
    () => alerts.filter((a) => a.severity === SEVERITY.CRITICAL).length,
    [alerts]
  );

  // Atalho do rodapé do popover de alertas — leva pra view Diagnóstico. Agora
  // é navegação de rota (a view tem URL própria), então o back do browser
  // volta pra onde o admin estava. O scroll é responsabilidade do shell.
  const handleOpenDiagnosticoFromAlert = useCallback(() => {
    onNavigateView?.(SECTION_REPORTS, "diagnostico");
  }, [onNavigateView]);

  // ── Sheet de deep-dive da campanha (vive no nível do menu pra ser
  //    invocado tanto pelo AlertsBell quanto pelas rows do Diagnóstico).
  //    Manter UM estado evita dois sheets concorrendo + permite expandir
  //    pra outros callers (Por mês, Lista) no futuro sem refactor.
  const [drillToken, setDrillToken] = useState(null);
  const drillCampaign = useMemo(
    () => drillToken ? campaigns.find((c) => c.short_token === drillToken) : null,
    [drillToken, campaigns]
  );
  const drillAlerts = useMemo(
    () => drillToken ? alerts.filter((a) => a.campaign?.short_token === drillToken) : [],
    [drillToken, alerts]
  );
  const handleDrillCampaign = useCallback((token) => setDrillToken(token), []);
  const handleCloseDrill = useCallback(() => setDrillToken(null), []);

  // ── Derivados de UI ──────────────────────────────────────────────────────
  // Filtros que a barra declara. Ficam fora do JSX pra que a lista de chips
  // e a lista de chips-ativos sejam lidas lado a lado — elas têm que
  // concordar, e concordar é mais fácil de conferir aqui do que espalhado
  // por 80 linhas de markup.
  const isClientView     = layout === "client";
  const showMonthFilter  = layout === "month";
  const showSituation    = layout === "month" || layout === "list" || layout === "diagnostico";
  // Performers é leaderboard: ordenar por outra coisa não faz sentido (a
  // métrica JÁ é a ordem). Diagnóstico ordena por header de coluna na
  // própria tabela. Nos dois casos o chip de ordenação sairia sobrando —
  // antes a solução era passar `undefined` em cinco props do toolbar.
  const showSort         = layout !== "performers" && layout !== "diagnostico";

  const sortBy    = isClientView ? clientsSortBy  : campaignsSortBy;
  const sortDir   = isClientView ? clientsSortDir : campaignsSortDir;
  const sortOpts  = isClientView ? CLIENT_SORT_OPTIONS : CAMPAIGN_SORT_OPTIONS;
  const onSortBy  = isClientView ? handleClientsSortByChange : handleCampaignsSortByChange;
  const onSortDir = isClientView ? toggleClientsSortDir : toggleCampaignsSortDir;
  const sortDefault    = isClientView ? CLIENT_SORT_DEFAULT : CAMPAIGN_SORT_DEFAULT;
  const sortDefaultDir = getDefaultDirection(sortDefault);

  const filterChips = [];
  if (teamMembers) {
    filterChips.push({
      id: "owner",
      label: "Owner",
      value: ownerFilterLabel(ownerFilter, teamMembers),
      icon: <PersonGlyph />,
      panel: () => (
        <OwnerFilterPanel
          selected={ownerFilter}
          onChange={setOwnerFilter}
          teamMembers={teamMembers}
        />
      ),
    });
  }
  if (showMonthFilter) {
    filterChips.push({
      id: "period",
      label: "Período",
      value: monthFilterLabel(activeMonth),
      icon: <CalendarGlyph />,
      panel: (close) => (
        <MonthFilterPanel
          campaigns={campaigns}
          activeMonth={activeMonth}
          onChange={setActiveMonth}
          onClose={close}
        />
      ),
    });
  }
  if (layout === "performers") {
    filterChips.push({
      id: "role",
      label: "Papel",
      value: performerRole === "cs" ? "CS" : "CP",
      icon: <PersonGlyph />,
      panel: (close) => (
        <FilterPanel title="Tipo de owner">
          <FilterOption
            label="Customer Success"
            sub="ranking entre CSs"
            selected={performerRole === "cs"}
            onSelect={() => { setPerformerRole("cs"); close(); }}
          />
          <FilterOption
            label="Customer Planner"
            sub="ranking entre CPs"
            selected={performerRole === "cp"}
            onSelect={() => { setPerformerRole("cp"); close(); }}
          />
        </FilterPanel>
      ),
    });
    filterChips.push({
      id: "performerPeriod",
      label: "Período",
      value: performerPreset === "now"
        ? undefined
        : formatPeriodLabel(performerPreset, performerCustom.from, performerCustom.to),
      icon: <CalendarGlyph />,
      panel: (close) => (
        <FilterPanel title="Janela do ranking">
          {PERIOD_PRESETS.filter((o) => o.id !== "custom").map((o) => (
            <FilterOption
              key={o.id}
              label={o.label}
              selected={performerPreset === o.id}
              onSelect={() => { setPerformerPreset(o.id); close(); }}
            />
          ))}
        </FilterPanel>
      ),
    });
  }
  if (showSituation) {
    filterChips.push({
      id: "situation",
      label: "Situação",
      value: situationLabel({ onlyActive, worklistKey: activeWorklist, worklistLabels: WORKLIST_LABELS }),
      icon: <ClockGlyph />,
      panel: () => (
        <FilterPanel
          title="Recorte da operação"
          footer={
            <FilterPanelClear
              onClear={() => { setOnlyActive(false); setActiveWorklist(null); }}
              disabled={!onlyActive && !activeWorklist}
            />
          }
        >
          <FilterOption
            multi
            label="Apenas ativas"
            sub="em veiculação — sem pausadas nem encerradas"
            count={activeCampaignsCount}
            selected={onlyActive}
            onSelect={() => setOnlyActive((v) => !v)}
          />
          {WORKLIST_KEYS.map((key) => {
            const bucket = worklist?.[key];
            if (!bucket?.count) return null;
            return (
              <FilterOption
                key={key}
                label={WORKLIST_LABELS[key]}
                count={bucket.count}
                selected={activeWorklist === key}
                onSelect={() => setActiveWorklist(activeWorklist === key ? null : key)}
              />
            );
          })}
        </FilterPanel>
      ),
    });
  }

  // Chips ativos — um por filtro que está de fato restringindo o conjunto.
  // A busca entra aqui também: era o único filtro sem representação visível
  // fora do próprio campo, e num campo de 240px um termo longo fica
  // truncado sem aviso.
  const activeFilters = [];
  if (search.trim()) {
    activeFilters.push({
      id: "search",
      label: `Busca: ${search.trim()}`,
      onClear: () => setSearch(""),
    });
  }
  if (ownerFilter.length > 0) {
    activeFilters.push({
      id: "owner",
      label: `Owner: ${ownerFilterLabel(ownerFilter, teamMembers)}`,
      onClear: () => setOwnerFilter([]),
    });
  }
  if (showMonthFilter && activeMonth) {
    activeFilters.push({
      id: "period",
      label: monthFilterLabel(activeMonth),
      onClear: () => setActiveMonth(null),
    });
  }
  if (showSituation && onlyActive) {
    activeFilters.push({
      id: "onlyActive",
      label: "Apenas ativas",
      onClear: () => setOnlyActive(false),
    });
  }
  if (showSituation && activeWorklist) {
    activeFilters.push({
      id: "worklist",
      label: WORKLIST_LABELS[activeWorklist] || activeWorklist,
      onClear: () => setActiveWorklist(null),
    });
  }

  const clearAllFilters = useCallback(() => {
    setSearch("");
    setOwnerFilter([]);
    setActiveMonth(null);
    setOnlyActive(false);
    setActiveWorklist(null);
  }, []);

  // "4 de 490 campanhas" — a leitura que não existia em nenhuma das cinco
  // views. Sem ela, um filtro ativo e um dataset pequeno são
  // indistinguíveis: você vê quatro cards e não sabe se são todos.
  const visibleCount = isClientView ? enrichedClients.length : filteredCampaigns.length;
  const totalForView = isClientView ? clients.length : totalCampaigns;
  const resultLabel  = activeFilters.length > 0 && totalForView > 0
    ? `${visibleCount} de ${totalForView} ${isClientView ? "clientes" : "campanhas"}`
    : null;

  const navCounts = buildNavCounts({
    campaigns: totalCampaigns || undefined,
    clients:   totalClients   || undefined,
    critical:  criticalAlertCount || undefined,
  });

  const meta = viewMeta(SECTION_REPORTS, layout);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <TooltipProvider delayDuration={200}>
    <AdminShell
      section={SECTION_REPORTS}
      layout={layout}
      navCounts={navCounts}
      onNavigate={onNavigateView}
      viewLabel={meta?.label}
      tally={
        totalCampaigns > 0
          ? `${totalCampaigns} campanhas · ${totalClients} clientes`
          : undefined
      }
      busy={refreshing && !loading}
      user={user}
      onLogout={onLogout}
      operationSlots={
        <>
          {/* Sino de alertas — o motor prioriza riscos por severidade ×
              impacto BRL. Admin-only por estar dentro do gate do App.jsx. */}
          <AlertsBell
            variant="rail"
            alerts={alerts}
            teamMap={teamMap}
            onDrillCampaign={handleDrillCampaign}
            onOpenDiagnostico={handleOpenDiagnosticoFromAlert}
          />
          {/* Frescor do rollup diário das bases (pipeline). */}
          <DataFreshnessIndicator variant="rail" user={user} />
          {/* Saúde de ENTREGA por DSP (volume/negócio) — complementa o
              indicador acima, que cobre pipeline/frescor. */}
          <DspHealthPanel variant="rail" onOpenReport={onOpenReport} />
        </>
      }
      actions={
        <Button variant="primary" size="sm" onClick={() => setShowNewCampaign(true)}>
          <PlusGlyph />
          <span className="hidden sm:inline">Novo Report</span>
        </Button>
      }
    >
      <PageHeader
        eyebrow={`Reports · ${meta?.label || ""}`}
        title={PAGE_TITLES[layout] || "Reports de Campanhas"}
        meta={
          <>
            <MetaStat value={totalCampaigns} label="campanhas" />
            <MetaDot />
            <MetaStat value={totalClients} label="clientes" />
            {activeCampaignsCount > 0 && (
              <>
                <MetaDot />
                <MetaStat value={activeCampaignsCount} label="ativas" tone="success" />
              </>
            )}
            <MetaDot />
            <span>{new Date().getFullYear()}</span>
          </>
        }
      />

      {/* Banner de dado stale. O estado `refreshError`/`lastFetchedAt` já
          existia e era alimentado corretamente pelo runRefresh — mas NADA
          renderizava. Resultado: quando o refresh falhava, o menu seguia
          mostrando os números do localStorage sem nenhum sinal, e o time lia
          isso como "o report não atualiza". Silêncio é o pior estado
          possível aqui: o número está na tela, parece atual, e não é. */}
      {refreshError && !refreshing && (
        <div
          role="status"
          className="mb-4 flex items-center justify-between gap-3 flex-wrap rounded-lg border border-warning/30 bg-warning-soft px-3 py-2"
        >
          <p className="text-xs text-fg">
            <span className="font-semibold">Dados desatualizados.</span>{" "}
            Não consegui atualizar agora — mostrando o último carregamento
            {lastFetchedAt ? ` (${new Date(lastFetchedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}).` : "."}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setRefreshing(true); setRefreshError(null); runRefresh(); }}
          >
            Tentar de novo
          </Button>
        </div>
      )}

      {/* KPIs + recortes operacionais, num board colapsável com memória.
          Antes: 110px fixos de grade em todas as views (inclusive Lista e
          Diagnóstico, onde o assunto é a linha, não o agregado) mais 62px de
          pílulas de alerta que pareciam legenda dos números mas eram
          filtros. Agora é um bloco só, e quem varre tabela pode fechá-lo. */}
      {!loading && totalCampaigns > 0 && (
        <KpiBoard
          scope="reports"
          title={`Desempenho${activeMonth ? ` · ${monthFilterLabel(activeMonth)}` : " · mês corrente"}`}
          summary={kpiSummaryLine(metricsSummary)}
          alerts={
            <WorklistChips
              worklist={worklist}
              activeKey={activeWorklist}
              onSelect={setActiveWorklist}
            />
          }
        >
          <MetricStrip summary={metricsSummary} />
        </KpiBoard>
      )}

      <FilterBar
        search={search}
        // Performers é um leaderboard de ~10 owners: buscar por nome numa
        // lista que caberia inteira na tela é controle sem função. Omitir o
        // handler faz o campo não renderizar — a barra continua no lugar,
        // com os filtros que a view tem.
        onSearchChange={layout === "performers" ? undefined : setSearch}
        searchPlaceholder={
          isClientView ? "Buscar cliente…" : "Buscar cliente, campanha ou token…"
        }
        chips={filterChips}
        trailing={
          showSort ? (
            <SortChipFilter
              options={sortOpts}
              value={sortBy}
              dir={sortDir}
              onValueChange={onSortBy}
              onDirToggle={onSortDir}
              defaultValue={sortDefault}
              defaultDir={sortDefaultDir}
            />
          ) : null
        }
        active={activeFilters}
        onClearAll={clearAllFilters}
        resultLabel={resultLabel}
      />

      {/* Conteúdo principal por view.
          `key={layout}` força remount ao trocar de view, então o fade-in de
          220ms roda em cada troca — antes era hard-cut. */}
      {loading ? (
        <LoadingState layout={layout} />
      ) : (
        <div key={layout} className="content-fade-in pt-1">
          {layout === "month" ? (
            <MonthLayout
              groups={monthGroups}
              onOpen={handleOpenDrawer}
              onOpenReport={onOpenReport}
              teamMap={teamMap}
              filterSignature={[
                search.trim(),
                ownerFilter.join(","),
                activeWorklist || "",
                onlyActive ? "only-active" : "",
              ]
                .filter(Boolean)
                .join("|")}
            />
          ) : layout === "client" ? (
            // Lazy: sem clients e carregando → skeleton. Com cache (mesmo
            // stale), mostra os cards e o refetch corre em background.
            clientsLoading && clients.length === 0
              ? <LoadingState layout="client" />
              : <ClientLayout clients={enrichedClients} onOpen={handleOpenClient} />
          ) : layout === "performers" ? (
            <PerformersLayout
              campaigns={campaigns}
              teamMap={teamMap}
              onOpenReport={onOpenReport}
              role={performerRole}
              onRoleChange={setPerformerRole}
              preset={performerPreset}
              onPresetChange={setPerformerPreset}
              custom={performerCustom}
              onCustomChange={setPerformerCustom}
            />
          ) : layout === "diagnostico" ? (
            <DiagnosticoLayout
              campaigns={campaigns}
              teamMap={teamMap}
              onOpenReport={onOpenReport}
              onOpenCampaign={handleDrillCampaign}
              search={search}
              ownerMatcher={ownerMatcher}
            />
          ) : (
            <CampaignListV2
              campaigns={sortedCampaigns}
              onOpen={handleOpenDrawer}
              onOpenReport={onOpenReport}
              teamMap={teamMap}
            />
          )}
        </div>
      )}

      {/* Sheet de deep-dive de campanha — análise focada em alertas + métricas.
          Aberto pelo AlertsBell (clique em item) ou DiagnosticoLayout (clique
          em row). Distinto do CampaignDrawer (ações admin tipo Loom, Survey). */}
      <AlertCampaignSheet
        open={!!drillToken}
        onOpenChange={(o) => { if (!o) handleCloseDrill(); }}
        campaign={drillCampaign}
        alerts={drillAlerts}
        teamMap={teamMap}
        onOpenReport={onOpenReport}
        onOpenAdminDrawer={handleOpenDrawer}
      />

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
        onRmnd={async (t) => {
          handleCloseDrawer();
          try { setAdminJwtForUploads(await getOrIssueAdminJwt()); } catch { /* fallback: modal usa cookie */ }
          setRmndModal(t);
        }}
        onPdooh={async (t) => {
          handleCloseDrawer();
          try { setAdminJwtForUploads(await getOrIssueAdminJwt()); } catch { /* fallback: modal usa cookie */ }
          setPdoohModal(t);
        }}
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
        onAnalytics={(c) => {
          setAnalyticsModal(c);
          handleCloseDrawer();
        }}
        onNegotiation={(c, n, rd) => {
          setNegotiationModal({ short_token: c.short_token, negotiation: n, reportData: rd });
          handleCloseDrawer();
        }}
        onAbsChange={handleAbsSaved}
        onClosureChange={handleClosureSaved}
        onCheckupsSaved={handleCheckupsSaved}
        onPauseChange={handlePauseSaved}
        onEarlyEndChange={handleEarlyEndSaved}
        onOpenReport={onOpenReport}
        teamMap={teamMap}
        user={user}
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
      {rmndModal && (
        <RmndUploadModal
          shortToken={rmndModal}
          adminJwt={adminJwtForUploads}
          onClose={() => setRmndModal(null)}
          onSaved={() => setRmndModal(null)}
          theme={legacyModalTheme(isDark)}
        />
      )}
      {pdoohModal && (
        <PdoohUploadModal
          shortToken={pdoohModal}
          adminJwt={adminJwtForUploads}
          onClose={() => setPdoohModal(null)}
          onSaved={() => setPdoohModal(null)}
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
      <ReportAnalyticsModal
        open={!!analyticsModal}
        onOpenChange={(o) => !o && setAnalyticsModal(null)}
        campaign={analyticsModal}
      />
    </AdminShell>
    </TooltipProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-componentes
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Rótulos e derivações da página
// ─────────────────────────────────────────────────────────────────────────────
// Título por view. Antes as cinco views compartilhavam "Reports de
// Campanhas" — o H1 não dizia o que você estava olhando, e a única pista era
// o segmentado tintado 400px abaixo. Com o rail marcando a view e o eyebrow
// repetindo o rastro, o H1 pode nomear o conteúdo de fato.
const PAGE_TITLES = {
  month:       "Reports de Campanhas",
  client:      "Carteira de Clientes",
  list:        "Reports de Campanhas",
  performers:  "Top Performers",
  diagnostico: "Diagnóstico de Pacing",
};

// Ordem dos buckets no chip "Situação". `reports_not_viewed` fica de fora
// porque o backend ainda não popula o bucket — entra aqui no dia que popular,
// sem mexer no resto.
const WORKLIST_KEYS = ["pacing_critical", "no_owner", "ending_soon"];

/**
 * Resumo de uma linha do KpiBoard fechado. Quatro números, escolhidos por
 * responderem "como está o mês" sem abrir a grade: quantas rodando, se o
 * ritmo está certo, se o criativo está performando, e quanto a operação
 * está custando.
 */
function kpiSummaryLine(summary) {
  if (!summary) return [];
  const line = [];
  if (summary.active_count != null) {
    line.push({ label: "Ativas", value: Math.round(summary.active_count) });
  }
  if (summary.dsp_pacing != null) {
    line.push({
      label: "Pacing",
      value: `${Math.round(summary.dsp_pacing)}%`,
      tone: summary.dsp_pacing < 90 ? "danger" : summary.dsp_pacing < 100 ? "warning" : "success",
    });
  }
  if (summary.ctr != null) {
    line.push({
      label: "CTR",
      value: `${summary.ctr.toFixed(2).replace(".", ",")}%`,
      tone: summary.ctr >= 0.70 ? "success" : summary.ctr >= 0.50 ? "warning" : "danger",
    });
  }
  if (summary.tech_cost != null) {
    line.push({
      label: "Tech",
      value: `${summary.tech_cost.toFixed(2).replace(".", ",")}%`,
    });
  }
  return line;
}

// Glifos dos chips de filtro. Inline porque são três, e cada um só aparece
// numa posição — um módulo de ícones pra isso seria indireção sem ganho.
function PersonGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 21v-1a7 7 0 0 1 14 0v1" />
    </svg>
  );
}

function CalendarGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MonthLayout({ groups, onOpen, onOpenReport, teamMap, filterSignature = "" }) {
  // Toda a lógica de colapso/expansão/auto-expand foi movida pro
  // MonthGroupedSections — esse wrapper só liga renderItem a CampaignCardV2.
  return (
    <MonthGroupedSections groups={groups} filterSignature={filterSignature}
      renderItem={(c) => (
        <CampaignCardV2
          key={c.short_token}
          campaign={c}
          onOpen={onOpen}
          onOpenReport={onOpenReport}
          teamMap={teamMap}
        />
      )}
    />
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
