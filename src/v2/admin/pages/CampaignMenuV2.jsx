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

import HyprReportCenterLogo from "../../../components/HyprReportCenterLogo";
import NewCampaignModal from "../../../components/modals/NewCampaignModal";
import LoomModal from "../../../components/modals/LoomModal";
import SurveyModal from "../../../components/modals/SurveyModal";
import LogoModal from "../../../components/modals/LogoModal";
import OwnerModal from "../../../components/modals/OwnerModal";
import MergeModal from "../../../components/modals/MergeModal";
import RmndUploadModal from "../../../components/modals/RmndUploadModal";
import SimpleUploadModal from "../../../components/modals/SimpleUploadModal";
import { NegotiationModal } from "../../components/NegotiationModal";
import { getOrIssueAdminJwt } from "../../../shared/auth";

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
import { MonthGroupedSections } from "../components/MonthGroupedSections";
import { formatMonthLabel } from "../lib/format";
import { TooltipProvider } from "../../../ui/Tooltip";

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
  const [bootstrap] = useState(() => ({
    campaigns: readCache("menu.campaigns"),
    clients:   readCache("menu.clients"),
    team:      readCache("menu.team"),
  }));
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
  const [layout, setLayout]               = useState(getInitialLayout);
  const [search, setSearch]               = useState("");
  const [ownerFilter, setOwnerFilter]     = useState(() => getOwnerFilter());
  const [activeMonth, setActiveMonth]     = useState(null);
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
      return matchSearch && matchMonth && matchOwner;
    });
  }, [campaigns, search, activeMonth, ownerMatcher, activeWorklist, worklist]);

  const sortedCampaigns = useMemo(() => {
    return [...filteredCampaigns].sort(compareCampaigns(campaignsSortBy, campaignsSortDir));
  }, [filteredCampaigns, campaignsSortBy, campaignsSortDir]);

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
    return monthsSorted.map((m) => ({
      key: m,
      label: m === "no-date" ? "Sem data" : formatMonthLabel(m),
      items: [...acc.get(m)].sort(cmp),
    }));
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
  const handleMergeSaved = useCallback(() => {
    setMergeModal(null);
    listCampaigns()
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

  // Encerramento antecipado — update otimista. `payload` é null quando
  // revertendo, ou {early_end_date, early_end_reason} quando setando.
  // Atualiza array local + drawerCampaign aberto pra refletir o badge e
  // o bloco de observação imediatamente.
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

  // KPIs agregados das campanhas ativas — alimenta a MetricStrip do topo.
  const metricsSummary = useMemo(() => computeMetricsSummary(campaigns), [campaigns]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <TooltipProvider delayDuration={200}>
    <div className="min-h-screen w-full bg-canvas text-fg transition-colors">
      {/* ── Topbar ──────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 bg-canvas-elevated border-b border-border">
        <div className="max-w-[1400px] mx-auto px-4 md:px-6 h-16 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              setLayout("month");
              setActiveWorklist(null);
              if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            className="flex items-center text-fg cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-elevated min-w-0"
            aria-label="Voltar para visão por mês"
            title="Voltar para visão por mês"
          >
            <HyprReportCenterLogo height={32} />
          </button>
          <div className="flex items-center gap-2 md:gap-3">
            <ThemeToggleV2 />
            {user?.picture && (
              <img
                src={user.picture}
                alt=""
                referrerPolicy="no-referrer"
                className="w-7 h-7 rounded-full ring-2 ring-signature shrink-0"
              />
            )}
            <span className="text-xs text-fg-muted hidden md:inline truncate max-w-[180px]">{user?.name}</span>
            <button
              onClick={onLogout}
              className="text-xs text-fg-muted hover:text-fg px-3 h-9 md:h-8 rounded-md border border-border hover:bg-surface transition-colors shrink-0"
            >
              Sair
            </button>
          </div>
        </div>
      </header>

      {/* ── Conteúdo ─────────────────────────────────────────────────────── */}
      <main className="max-w-[1400px] mx-auto px-4 md:px-6 py-6 md:py-8">
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
          <div className="flex items-center gap-2">
            {/* Atalho pro report demo (`/report/DEMO`) — payload mockado em
                shared/demoData.js, sem custo de backend. Vendedor abre,
                apresenta, fecha. */}
            <Button
              variant="ghost"
              size="md"
              onClick={() => window.open("/report/DEMO", "_blank")}
              title="Abre o report de demonstração em nova aba"
            >
              Abrir Demo
            </Button>
            <Button variant="primary" size="md" onClick={() => setShowNewCampaign(true)}>
              + Novo Report
            </Button>
          </div>
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
              sortBy={layout === "client" ? clientsSortBy : campaignsSortBy}
              onSortByChange={layout === "client" ? handleClientsSortByChange : handleCampaignsSortByChange}
              sortDir={layout === "client" ? clientsSortDir : campaignsSortDir}
              onSortDirToggle={layout === "client" ? toggleClientsSortDir : toggleCampaignsSortDir}
              sortOptions={layout === "client" ? CLIENT_SORT_OPTIONS : CAMPAIGN_SORT_OPTIONS}
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

        {/* Conteúdo principal por layout.
            Wrapper `content-fade-in` aplica fade-in 220ms quando o conteúdo
            real monta (após o skeleton sumir, ou ao trocar de layout). A
            `key={layout}` força remount ao trocar de aba, então a animação
            roda em cada troca — antes era hard-cut, agora suaviza. */}
        {loading ? (
          <LoadingState layout={layout} />
        ) : (
          <div key={layout} className="content-fade-in">
            {layout === "month" ? (
              <MonthLayout
                groups={monthGroups}
                onOpen={handleOpenDrawer}
                onOpenReport={onOpenReport}
                teamMap={teamMap}
                filterSignature={[search.trim(), ownerFilter.join(","), activeWorklist || ""]
                  .filter(Boolean)
                  .join("|")}
              />
            ) : layout === "client" ? (
              // Lazy: se não temos clients ainda E está carregando, mostra
              // skeleton em vez de empty state. Se temos cache (mesmo stale),
              // mostra os cards e refetch corre em background.
              clientsLoading && clients.length === 0
                ? <LoadingState layout="client" />
                : <ClientLayout clients={enrichedClients} onOpen={handleOpenClient} />
            ) : layout === "performers" ? (
              <PerformersLayout campaigns={campaigns} teamMap={teamMap} onOpenReport={onOpenReport} />
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
        onNegotiation={(c, n, rd) => {
          setNegotiationModal({ short_token: c.short_token, negotiation: n, reportData: rd });
          handleCloseDrawer();
        }}
        onAbsChange={handleAbsSaved}
        onClosureChange={handleClosureSaved}
        onPauseChange={handlePauseSaved}
        onEarlyEndChange={handleEarlyEndSaved}
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
        <SimpleUploadModal
          shortToken={pdoohModal}
          type="PDOOH"
          adminJwt={adminJwtForUploads}
          onClose={() => setPdoohModal(null)}
          onSaved={() => setPdoohModal(null)}
          theme={legacyModalTheme(isDark)}
          description="Suba o relatório PDOOH (.csv ou .xlsx) para "
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
    </TooltipProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-componentes
// ─────────────────────────────────────────────────────────────────────────────

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
