// src/v2/dashboards/ClientDashboardV2.jsx
//
// Shell do dashboard V2 — redesenhado em PR-13 pra bater com o mockup.
//
// LAYOUT (top → bottom):
//   1. TopBarV2 — branding + selo de frescor real ("Dados até 22/09 ·
//      atualizado às 06:12") + share + tema
//   2. CampaignHeaderV2 — hero card; o vídeo explicativo (Loom) virou o chip
//      "Assistir resumo" ali (antes era uma aba)
//   3. Barra de controles FIXA (sticky abaixo do TopBar): abas + período +
//      filtros. Com páginas de 2-3 mil px, trocar período ou filtro não pode
//      exigir voltar ao topo.
//        Abas: Visão Geral / Display / Vídeo / Max Attention · PDOOH / RMND /
//        Brand Lift · (admin) DSPs · Base de dados (utilitário, no fim)
//   4. TabsContent — OverviewV2 / DisplayV2 / VideoV2 / MaxAttentionV2 /
//      PdoohV2 / RmndV2 / SurveyV2 / DetalhamentoV2
//
// Base de Dados (PR-16) é a tab dedicada à raw data completa (DataTableV2
// com filter Tudo/Display/Video). Antes vivia como CollapsibleSection na
// Visão Geral. Renomeada de "Detalhamento" pra "Base de Dados" — semântica
// mais clara. URL: value="base" (com alias backward-compat ?tab=detalhamento).
//
// RESPONSABILIDADES (mantidas da PR-10):
//   - Buscar dados via getCampaign(token)
//   - Gerenciar state global (mainRange, tab ativa, tactic Display, tactic Video)
//   - Sincronizar com URL (popstate)
//   - Renderizar loading state (Skeleton) e error state

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "../v2.css";
import "../../ui/typography";

import { getCampaign, getShareId, getCachedShareId } from "../../lib/api";
import { readCache, writeCache } from "../../lib/persistedCache";
import { gaPageView } from "../../shared/analytics";
import { computeAggregates, extractAudience, getCreativeLineKey } from "../../shared/aggregations";
import { computeDataUntil, formatFreshness } from "../../shared/freshness";
import { useLoadingTask } from "../../shared/loading";
import {
  readRangeFromUrl,
  writeRangeToUrl,
  readPresetFromUrl,
  writePresetToUrl,
  buildPresets,
  clampRangeToWindow,
} from "../../shared/dateFilter";

import { Skeleton } from "../../ui/Skeleton";
import { TooltipProvider } from "../../ui/Tooltip";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../ui/Tabs";

import { TopBarV2 } from "../components/TopBarV2";
import { CommentsDrawerV2 } from "../components/CommentsDrawerV2";
import { useReportComments } from "../hooks/useReportComments";
import { buildCommentThreads, threadForTab } from "../../shared/commentThreads";
import { CampaignHeaderV2 } from "../components/CampaignHeaderV2";
import { GlobalDataFilterBarV2 } from "../components/GlobalDataFilterBarV2";
import { useReportTracking } from "../hooks/useReportTracking";
import { ReportTrackingProvider } from "../contexts/ReportTrackingContext";
import { DateRangeFilterV2 } from "../components/DateRangeFilterV2";
import { CoreProductFilterV2 } from "../components/CoreProductFilterV2";

import OverviewV2 from "./OverviewV2";
import DisplayV2 from "./DisplayV2";
import VideoV2 from "./VideoV2";
import DetalhamentoV2 from "./DetalhamentoV2";
import RmndV2 from "./RmndV2";
import PdoohV2 from "./PdoohV2";
import SurveyV2 from "./SurveyV2";
import MaxAttentionV2 from "./MaxAttentionV2";
import DspHealthV2 from "./DspHealthV2";

// ─── Helpers de URL ────────────────────────────────────────────────────

const VALID_TABS = ["overview", "display", "video", "max-attention", "base", "rmnd", "pdooh", "survey", "dsps"];
const VALID_TACTICS = ["O2O", "OOH", "GROUNDFLOW"];

function readTabFromUrl() {
  if (typeof window === "undefined") return "overview";
  try {
    const t = new URLSearchParams(window.location.search).get("tab");
    // Backward compat: ?tab=detalhamento → base (renomeado em PR-16)
    if (t === "detalhamento") return "base";
    // Aliases da aba Max Attention (links colados à mão)
    if (t === "maxattention" || t === "ma") return "max-attention";
    return VALID_TABS.includes(t) ? t : "overview";
  } catch {
    return "overview";
  }
}

function writeTabToUrl(tab) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (tab === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* noop */
  }
}

// Link antigo com ?tab=loom: a aba Video Loom virou o chip "Assistir resumo"
// no header. Em vez de cair numa aba que não existe, abre o vídeo na carga.
function readLegacyLoomDeepLink() {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("tab") === "loom";
  } catch {
    return false;
  }
}

// Filtros globais na URL — o link compartilhado abre no mesmo recorte.
// Chaves curtas (aud, line, cl, size, fmt), valores separados por vírgula
// e codificados; vírgula dentro de um valor vai como %2C via encodeURIComponent.
const FILTER_URL_KEYS = { audiences: "aud", lineNames: "line", creativeLines: "cl", sizes: "size", formats: "fmt" };
function readListFromUrl(key) {
  if (typeof window === "undefined") return [];
  try {
    const raw = new URLSearchParams(window.location.search).get(key);
    if (!raw) return [];
    return raw.split(",").map((v) => decodeURIComponent(v)).filter(Boolean);
  } catch {
    return [];
  }
}
function writeListToUrl(key, list) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (!list || list.length === 0) url.searchParams.delete(key);
    else url.searchParams.set(key, list.map((v) => encodeURIComponent(v)).join(","));
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* noop */
  }
}

function readTacticFromUrl(paramKey) {
  if (typeof window === "undefined") return "O2O";
  try {
    const t = new URLSearchParams(window.location.search).get(paramKey);
    return VALID_TACTICS.includes(t) ? t : "O2O";
  } catch {
    return "O2O";
  }
}

function writeTacticToUrl(paramKey, tactic) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (tactic === "O2O") url.searchParams.delete(paramKey);
    else url.searchParams.set(paramKey, tactic);
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* noop */
  }
}

// Core Product (Visão Geral) — filtro O2O/OOH/Groundflow/Todos exclusivo da
// aba Visão Geral. Default "ALL" não vai pra URL (limpa). URL: ?core=o2o|ooh|groundflow.
const VALID_CORES = ["ALL", "O2O", "OOH", "GROUNDFLOW"];
function readCoreFromUrl() {
  if (typeof window === "undefined") return "ALL";
  try {
    const raw = new URLSearchParams(window.location.search).get("core");
    if (!raw) return "ALL";
    const upper = raw.toUpperCase();
    return VALID_CORES.includes(upper) ? upper : "ALL";
  } catch {
    return "ALL";
  }
}
function writeCoreToUrl(core) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (!core || core === "ALL") url.searchParams.delete("core");
    else url.searchParams.set("core", core.toLowerCase());
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* noop */
  }
}

// Merge Reports — `?view=<token>` permite drill-down dentro de um report
// agregado pra ver dados de um único membro do grupo. Sem view → modo
// agregado (default quando o token base pertence a um grupo).
function readViewFromUrl() {
  if (typeof window === "undefined") return null;
  try {
    const v = new URLSearchParams(window.location.search).get("view");
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function writeViewToUrl(view) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (!view) url.searchParams.delete("view");
    else      url.searchParams.set("view", view);
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* noop */
  }
}

// Estilo visual das tabs secundárias (RMND, PDOOH, Loom, Survey) — peso
// menor que as core. text-xs (12px vs sm 14px), font-medium (500 vs
// semibold 600), cor text-fg-subtle (mais apagada que muted).
// data-[state=active]:text-fg do componente base continua valendo no
// estado ativo.
const SECONDARY_TAB_CLASS =
  "text-xs font-medium text-fg-subtle hover:text-fg-muted";

// Detecta campanha 100% bonificada — todo o volume contratado é bônus
// (cortesia HYPR), sem `contracted_*` faturado. Quando true, a Visão
// Geral troca o hero "Custo Efetivo · Total" (que sempre mostraria
// R$ 0,00 e parece bug) por "Valor Bonificado", e o header ganha um
// selo "BONIFICADA".
function computeIsBonusOnly(data) {
  const t0 = (data?.totals || [])[0] || {};
  const contractedSum =
    (t0.contracted_o2o_display_impressions || 0) +
    (t0.contracted_ooh_display_impressions || 0) +
    (t0.contracted_groundflow_display_impressions || 0) +
    (t0.contracted_o2o_video_completions || 0) +
    (t0.contracted_ooh_video_completions || 0) +
    (t0.contracted_groundflow_video_completions || 0);
  const bonusSum =
    (t0.bonus_o2o_display_impressions || 0) +
    (t0.bonus_ooh_display_impressions || 0) +
    (t0.bonus_groundflow_display_impressions || 0) +
    (t0.bonus_o2o_video_completions || 0) +
    (t0.bonus_ooh_video_completions || 0) +
    (t0.bonus_groundflow_video_completions || 0);
  return contractedSum === 0 && bonusSum > 0;
}

// Detecta presença de O2O/OOH/Groundflow na campanha. Critério "tem frente":
// contrato (incl. bonus, em qualquer mídia) OU entrega real em data.totals.
// Aceita `data` null/undefined (cenário pré-carga) e devolve todos false.
function computeTacticAvailability(data) {
  if (!data) return { hasO2O: false, hasOOH: false, hasGROUNDFLOW: false };
  const t0 = (data.totals || [])[0] || {};
  const hasContract = (frente) =>
    (t0[`contracted_${frente}_display_impressions`] || 0) > 0 ||
    (t0[`bonus_${frente}_display_impressions`] || 0) > 0 ||
    (t0[`contracted_${frente}_video_completions`] || 0) > 0 ||
    (t0[`bonus_${frente}_video_completions`] || 0) > 0;
  const hasDelivery = (tac) => (data.totals || []).some((r) => r.tactic_type === tac);
  // Override de core products (curadoria admin): quando presente, esconde
  // frentes fora do set INCLUSIVE as que têm entrega. O backend já zerou o
  // contrato delas (hasContract cai sozinho); isto cobre o gating por entrega.
  const active = data.campaign?.active_core_products;
  const isActive = (frente) => !active || active.includes(frente);
  return {
    hasO2O:        isActive("O2O")        && (hasContract("o2o")        || hasDelivery("O2O")),
    hasOOH:        isActive("OOH")        && (hasContract("ooh")        || hasDelivery("OOH")),
    // Groundflow é frente SÓ com contrato. Entrega sem contrato = dark test
    // → conta como O2O/OOH (espelha o _GF_CONTRACT_GATE do backend). Por isso
    // NÃO usa hasDelivery aqui (≠ O2O/OOH).
    hasGROUNDFLOW: isActive("GROUNDFLOW") && hasContract("groundflow"),
  };
}

// TTL do payload persistido (localStorage, stale-while-revalidate) — 24h.
// A base consolidada só muda 1x/dia (~06h); o stale é sempre REVALIDADO em
// background, nunca servido como final. BUILD_ID + schema version do
// persistedCache já invalidam cross-deploy.
const REPORT_PERSIST_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Componente principal ──────────────────────────────────────────────

export default function ClientDashboardV2({ token, isAdmin, adminJwt }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // `refreshing` cobre qualquer refetch após a 1ª carga (troca de view,
  // troca de token sem reload, etc). Renderiza barra fina de progresso
  // sem mexer no skeleton inicial — UX de "algo tá vindo" sem flash.
  const [refreshing, setRefreshing] = useState(false);
  // Flag própria do reload pós-upload (reloadReport). Separada de
  // `refreshing` pra que o reset do ramo de cache hit (troca de view) não
  // apague a barra de progresso de um reload forçado que ainda está rodando.
  const [reloading, setReloading] = useState(false);
  // `switchingView` é um subset de `refreshing`: true só quando o usuário
  // troca de view (clica em pill ou hits back/forward com ?view= diferente).
  // Quando true, o conteúdo principal é dimado e fica não-clicável — sem
  // isso o cliente vê dados do mês antigo enquanto carrega o novo (UX ruim
  // descrita pelo usuário). Refetches passivos (mesmo view) NÃO disparam o
  // dim — só a barrinha discreta.
  const [switchingView, setSwitchingView] = useState(false);

  // 1ª carga (sem `data` ainda) e refetches em background entram no
  // contador global → barrinha no topo só aparece se demorar > 200ms.
  useLoadingTask((!data && !error) || refreshing || reloading);

  const [mainRange, setMainRangeState] = useState(() => readRangeFromUrl());
  // mainPresetId guarda a *intenção* do filtro (ex: "lastMonth"). Quando
  // setado, o range é recalculado ao trocar de view (via useEffect mais
  // abaixo) usando os limites do novo membro/campanha. Sem ele, o range
  // numérico colapsaria com outros presets nos limites apertados de um
  // membro (ex: "Mês passado" → "Últimos 30 dias" no membro Abril).
  const [mainPresetId, setMainPresetIdState] = useState(() => readPresetFromUrl());
  const [tab, setTabState] = useState(() => readTabFromUrl());
  const [displayTactic, setDisplayTacticState] = useState(() =>
    readTacticFromUrl("display_tactic"),
  );
  const [videoTactic, setVideoTacticState] = useState(() =>
    readTacticFromUrl("video_tactic"),
  );
  const [mainCore, setMainCoreState] = useState(() => readCoreFromUrl());
  const [view, setViewState] = useState(() => readViewFromUrl());

  // Filtros globais — compartilhados entre Visão Geral, Display e Video.
  // Substituem o estado per-tab (displayLines/videoLines/displayCreativeLines/
  // videoCreativeLines) que existia antes. Aplicados upstream em
  // computeAggregates via creativeFilters, então todas as 3 abas vêem
  // aggregates já recortados. Base de Dados NÃO usa esses — tem seus
  // próprios filtros internos (local ao DataTableV2).
  const [audiences, setAudiencesState] = useState(() => readListFromUrl(FILTER_URL_KEYS.audiences));
  const [lineNames, setLineNamesState] = useState(() => readListFromUrl(FILTER_URL_KEYS.lineNames));
  const [creativeLines, setCreativeLinesState] = useState(() => readListFromUrl(FILTER_URL_KEYS.creativeLines));
  const [sizes, setSizesState] = useState(() => readListFromUrl(FILTER_URL_KEYS.sizes));
  const [formats, setFormatsState] = useState(() => readListFromUrl(FILTER_URL_KEYS.formats));
  const setAudiences = (v) => { setAudiencesState(v); writeListToUrl(FILTER_URL_KEYS.audiences, v); };
  const setLineNames = (v) => { setLineNamesState(v); writeListToUrl(FILTER_URL_KEYS.lineNames, v); };
  const setCreativeLines = (v) => { setCreativeLinesState(v); writeListToUrl(FILTER_URL_KEYS.creativeLines, v); };
  const setSizes = (v) => { setSizesState(v); writeListToUrl(FILTER_URL_KEYS.sizes, v); };
  const setFormats = (v) => { setFormatsState(v); writeListToUrl(FILTER_URL_KEYS.formats, v); };
  const clearDataFilters = () => {
    setAudiences([]); setLineNames([]); setCreativeLines([]); setSizes([]); setFormats([]);
  };
  // Link antigo ?tab=loom — lido uma vez, na montagem.
  const [loomDeepLink] = useState(() => readLegacyLoomDeepLink());

  // Hook de tracking — moved up pra que `trackCta` esteja disponível
  // nos setters dos filtros logo abaixo. Hook tem skip-admin interno e
  // early return em !shortToken — inerte enquanto data não chega.
  // Ainda fica ANTES dos early returns (regra dos hooks).
  const { trackCta } = useReportTracking({
    shortToken:   data?.campaign?.short_token || null,
    shareId:      typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("share") : null,
    isAdmin,
    currentTabId: tab,
  });

  // setMainRange aceita opcionalmente o presetId que originou esse range.
  // Click em preset → passa o id; ajuste no calendar → passa null (custom).
  const setMainRange = (r, presetId = null) => {
    trackCta("period_change");
    setMainRangeState(r);
    setMainPresetIdState(presetId);
    writeRangeToUrl(r);
    writePresetToUrl(presetId);
  };
  const setTab = (t) => {
    setTabState(t);
    writeTabToUrl(t);
  };
  // Atalhos de dentro do conteúdo ("Ver Display →"): troca a aba e volta ao
  // topo, senão a aba nova abre no meio da rolagem da anterior.
  const navigateToTab = (t) => {
    setTab(t);
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      window.scrollTo(0, 0);
    }
  };
  const setDisplayTactic = (t) => {
    setDisplayTacticState(t);
    writeTacticToUrl("display_tactic", t);
  };
  const setVideoTactic = (t) => {
    setVideoTacticState(t);
    writeTacticToUrl("video_tactic", t);
  };
  const setMainCore = (c) => {
    trackCta("core_product_change");
    setMainCoreState(c);
    writeCoreToUrl(c);
  };
  const setView = (v) => {
    trackCta("merge_view_change");
    setViewState(v);
    writeViewToUrl(v);
  };

  // Ref pra detectar troca de view (vs. 1ª carga / refetch passivo). Comparar
  // antes do fetch resolver evita race condition: se o usuário clica em pill
  // duas vezes rápido, o cancelled flag descarta a primeira; o ref só
  // atualiza quando a fetch certa resolve.
  const loadedViewRef = useRef(view);
  const loadedTokenRef = useRef(token);

  // Cache em memória por (token, view) — revisitar uma view (ex: Mai → Abr
  // → Mai) é instantâneo em vez de pagar ~1s de fetch de novo. Em ref pra
  // não disparar re-render. Não há invalidação por TTL porque o payload
  // dum report não muda durante a sessão do cliente; uploads admin acontecem
  // em /admin/* (outra árvore React) e a navegação até /report/X é sempre
  // page-load fresco. Reload da página zera o Map naturalmente.
  const viewCacheRef = useRef(new Map());
  const cacheKey = `${token}::${view ?? ""}`;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    // Cache hit: aplica o payload direto, sem fetch e sem dim. É o caso
    // comum quando o cliente alterna entre views já visitadas na sessão.
    const cached = viewCacheRef.current.get(cacheKey);
    if (cached) {
      setData(cached);
      loadedViewRef.current = view;
      loadedTokenRef.current = token;
      // Limpa erros de uma tentativa anterior (improvável, mas defensivo).
      setError(null);
      // Zera o "carregando" de uma troca de view anterior que foi cancelada
      // no meio: A → B (B demora, dim liga em 250ms) → volta pra A antes de B
      // responder. O cleanup cancela B e o `.finally` dele não reseta nada
      // (early return por `cancelled`); sem estas duas linhas o conteúdo de A
      // ficava em opacity-40 + pointer-events-none até o F5.
      setRefreshing(false);
      setSwitchingView(false);
      return;
    }

    // Stale-while-revalidate: payload persistido de uma visita anterior
    // (localStorage, TTL 24h) pinta o report na hora — mata o skeleton de
    // 3-6s do primeiro acesso do dia — enquanto o refetch abaixo SEMPRE
    // roda e substitui pelos números frescos quando resolver.
    const persisted = readCache(`report.${cacheKey}`, REPORT_PERSIST_TTL_MS);
    const hasStale = persisted != null;
    if (hasStale) {
      setData(persisted.data);
      loadedViewRef.current = view;
      loadedTokenRef.current = token;
      setError(null);
    }

    // Não chamamos setData(null) aqui — manter o payload anterior durante
    // o refetch é melhor que flash de skeleton. Em troca de view, o dim
    // overlay + spinner na pill cobrem a comunicação "carregando novo
    // contexto" (ver switchingView).
    setRefreshing(true);

    // Dim com delay: só dima o conteúdo se o fetch passar de 250ms. Pra
    // requests rápidas (cache hit no backend, conexão boa), evita flicker
    // visual a cada troca. Pra fetches lentos (1s+, caso típico hoje),
    // sinaliza claramente "tô carregando" sem deixar dado antigo visível.
    // Com stale persistido já pintado, o dim não se aplica — o conteúdo
    // exibido já é o da view destino.
    const isViewSwitch =
      !hasStale &&
      loadedTokenRef.current === token && loadedViewRef.current !== view;
    let dimTimer = null;
    if (isViewSwitch) {
      dimTimer = setTimeout(() => {
        if (!cancelled) setSwitchingView(true);
      }, 250);
    }

    getCampaign(token, view ? { view } : undefined)
      .then((d) => {
        if (cancelled) return;
        viewCacheRef.current.set(cacheKey, d);
        writeCache(`report.${cacheKey}`, d);
        setData(d);
        loadedViewRef.current = view;
        loadedTokenRef.current = token;
        gaPageView(`/report/${token}`, token);
      })
      .catch((e) => {
        if (cancelled) return;
        // Com stale na tela, falha de revalidação não vira erro de página —
        // dado de ontem é melhor que um report em branco. Sem stale, o
        // comportamento original (error state) permanece.
        if (!hasStale) {
          setError(e?.message || "Erro ao carregar dados");
        } else {
          console.warn("[report] revalidação falhou; mantendo payload em cache", e);
        }
      })
      .finally(() => {
        if (cancelled) return;
        if (dimTimer) clearTimeout(dimTimer);
        setRefreshing(false);
        setSwitchingView(false);
      });
    return () => {
      cancelled = true;
      if (dimTimer) clearTimeout(dimTimer);
    };
  }, [token, view, cacheKey]);

  // Refetch forçado após upload de base (RMND/PDOOH). O modal grava no BQ e
  // mostra a base otimisticamente na hora; este reload confirma a VERDADE do
  // servidor (refresh=true fura o cache do backend) e corrige o payload —
  // `data.rmnd`/`data.pdooh` frescos descem pra aba via serverData. Sem isto,
  // "salvou" era só estado local: se a propagação falhasse, ninguém percebia.
  const reloadReport = useCallback(async () => {
    if (!token) return;
    try {
      setReloading(true);
      const d = await getCampaign(token, {
        ...(view ? { view } : {}),
        refresh: true,
      });
      viewCacheRef.current.set(cacheKey, d);
      writeCache(`report.${cacheKey}`, d);
      setData(d);
    } catch (e) {
      console.warn("[report] reload pós-upload falhou; mantendo payload atual", e);
    } finally {
      setReloading(false);
    }
  }, [token, view, cacheKey]);

  useEffect(() => {
    const onPop = () => {
      setMainRangeState(readRangeFromUrl());
      setMainPresetIdState(readPresetFromUrl());
      setTabState(readTabFromUrl());
      setDisplayTacticState(readTacticFromUrl("display_tactic"));
      setVideoTacticState(readTacticFromUrl("video_tactic"));
      setMainCoreState(readCoreFromUrl());
      setViewState(readViewFromUrl());
      setAudiencesState(readListFromUrl(FILTER_URL_KEYS.audiences));
      setLineNamesState(readListFromUrl(FILTER_URL_KEYS.lineNames));
      setCreativeLinesState(readListFromUrl(FILTER_URL_KEYS.creativeLines));
      setSizesState(readListFromUrl(FILTER_URL_KEYS.sizes));
      setFormatsState(readListFromUrl(FILTER_URL_KEYS.formats));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Reconcilia o range de data quando a view muda (troca de membro num
  // report agrupado) ou a campanha carrega. Dois casos:
  //
  //  A) Preset ativo ("Mês passado" etc.): recalcula o range do preset no
  //     contexto do novo membro. Se o preset não existe mais nesse contexto
  //     (ex: "Este mês" num membro que terminou no mês passado), cai pra
  //     "Todo o período".
  //  B) Range custom (presetId null/"all"): re-clampa aos limites do novo
  //     membro; sem interseção, cai pra "Todo o período". Isso impede que um
  //     range de outro mês vaze pro mês destino (causa do bug de números
  //     "congelados").
  useEffect(() => {
    if (!data) return;
    const camp = data.campaign;
    if (!camp?.start_date || !camp?.end_date) return;
    // Presets como "Toda a campanha" devem respeitar early_end_date quando
    // admin marcou encerramento antecipado — sem isso o usuário escolheria
    // datas depois do fim real (sem dados, visual confuso).
    const effEnd = camp.early_end_date || camp.end_date;

    // Caso A — preset ativo: recomputa o range do preset no contexto do
    // novo membro/campanha. Ex: "Mês passado" no agregado vira "Mês passado"
    // recomputado contra os limites do Abril.
    if (mainPresetId && mainPresetId !== "all") {
      const presets = buildPresets(new Date(), camp.start_date, effEnd);
      const p = presets.find(x => x.id === mainPresetId);
      if (p && p.range) {
        const newRange = p.range;
        const cur = mainRange;
        const sameRange = cur && cur.from?.getTime() === newRange.from.getTime()
          && cur.to?.getTime() === newRange.to.getTime();
        if (!sameRange) {
          setMainRangeState(newRange);
          writeRangeToUrl(newRange);
        }
      } else {
        // Preset não aplica neste contexto — fallback "Todo o período".
        setMainRangeState(null);
        setMainPresetIdState("all");
        writeRangeToUrl(null);
        writePresetToUrl("all");
      }
      return;
    }

    // Caso B — range custom (sem preset): re-clampa aos limites do novo
    // membro. Ao trocar de mês num report agrupado, um range escolhido em
    // outro mês persistia e não intersectava a janela do membro destino:
    // o detail filtrado ficava vazio e os KPIs de entrega caíam num
    // fallback que somava todos os meses (números "congelados"/repetidos —
    // bug reportado). Sem interseção, cai pra "Todo o período" (mês inteiro
    // do membro); com interseção parcial, recorta pro overlap.
    if (mainRange) {
      const clamped = clampRangeToWindow(mainRange, camp.start_date, effEnd);
      if (!clamped) {
        setMainRangeState(null);
        writeRangeToUrl(null);
      } else {
        const changed =
          clamped.from.getTime() !== mainRange.from?.getTime() ||
          clamped.to.getTime()   !== mainRange.to?.getTime();
        if (changed) {
          setMainRangeState(clamped);
          writeRangeToUrl(clamped);
        }
      }
    }
    // Dependemos só dos limites da campanha + presetId. mainRange muda
    // como efeito da própria recomputação — incluí-lo aqui causaria loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.campaign?.start_date, data?.campaign?.end_date, data?.campaign?.early_end_date, mainPresetId]);

  // Core Product filter (Visão Geral): só faz sentido quando a campanha
  // tem AS DUAS frentes (O2O e OOH). Critério: contrato (incl. bonus) em
  // qualquer mídia OU entrega real. Quando só uma frente existe, o
  // filtro é ruído visual e o effectiveMainCore vira "ALL" pra evitar
  // zerar agregados se o state vier de URL antiga (ex: ?core=OOH numa
  // campanha que só tem O2O). Computado aqui em cima pra ser usado
  // dentro do useMemo logo abaixo.
  const tacticAvail = computeTacticAvailability(data);
  // Frentes presentes na campanha (ordem fixa O2O → OOH → Groundflow).
  const availableCores = [
    tacticAvail.hasO2O        && "O2O",
    tacticAvail.hasOOH        && "OOH",
    tacticAvail.hasGROUNDFLOW && "GROUNDFLOW",
  ].filter(Boolean);
  // Filtro de Core só faz sentido com 2+ frentes (senão não há o que separar).
  const showCoreFilter = availableCores.length >= 2;
  const isBonusOnly = computeIsBonusOnly(data);
  const effectiveMainCore = showCoreFilter && availableCores.includes(mainCore)
    ? mainCore
    : "ALL";

  // mainCore só afeta a Visão Geral. Pra evitar que abrir Display/Video
  // veja dados filtrados, calculamos DOIS aggregates: um irrestrito
  // (consumido por todas as outras tabs) e um filtrado por core (só pro
  // OverviewV2). useMemo separa o custo — quando o user mexe só no core,
  // só `aggregatesOverview` recalcula.
  // creativeFilters memoizado: agrupa os 5 filtros num único objeto que
  // entra em computeAggregates. useMemo evita criar nova referência a cada
  // render quando os arrays não mudaram (importante porque computeAggregates
  // é caro e recomputa quando creativeFilters muda por identity).
  const creativeFilters = useMemo(
    () => ({ audiences, lineNames, sizes, formats, creativeLines }),
    [audiences, lineNames, sizes, formats, creativeLines],
  );

  // Options dos filtros — derivadas do data.detail BRUTO (não-filtrado).
  // Importante usar a fonte crua: se derivássemos do aggregates.detail
  // (que já é filtrado), as options encolheriam conforme o usuário
  // filtra, virando experiência ruim (não consegue ADICIONAR um valor
  // depois de filtrar). Ignora rows com line_name de survey/_(CONTROLE
  // |EXPOSTO) — backend já filtra mas defensive na ponta também.
  const filterOptions = useMemo(() => {
    if (!data?.detail) {
      return { audiences: [], lines: [], creativeLines: [], sizes: [], formats: [] };
    }
    const noSurvey = (r) =>
      !/survey/i.test(r.line_name || "") &&
      !/survey/i.test(r.creative_name || "") &&
      !/dark[ _-]?test/i.test(r.line_name || "");
    const aud = new Set();
    const lin = new Set();
    const cre = new Set();
    const siz = new Set();
    const fmt = new Set();
    for (const r of data.detail) {
      if (!noSurvey(r)) continue;
      const a = extractAudience(r.line_name);
      if (a && a !== "N/A") aud.add(a);
      if (r.line_name) lin.add(r.line_name);
      const ck = getCreativeLineKey(r);
      if (ck && ck !== "N/A") cre.add(ck);
      if (r.creative_size) siz.add(r.creative_size);
      if (r.media_type) fmt.add(r.media_type);
    }
    return {
      audiences: [...aud].sort((a, b) => a.localeCompare(b)),
      lines: [...lin].sort((a, b) => a.localeCompare(b)),
      creativeLines: [...cre].sort((a, b) => a.localeCompare(b)),
      sizes: [...siz].sort((a, b) => {
        const na = parseInt(a, 10);
        const nb = parseInt(b, 10);
        if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
        return a.localeCompare(b);
      }),
      formats: [...fmt].sort((a, b) => a.localeCompare(b)),
    };
  }, [data?.detail]);

  const aggregates = useMemo(
    () => (data ? computeAggregates(data, mainRange, "ALL", creativeFilters) : null),
    [data, mainRange, creativeFilters],
  );
  // Com o core em "ALL" (caso comum) o resultado é idêntico ao `aggregates`
  // acima — reaproveita em vez de varrer o detail inteiro de novo (3 regex
  // por linha) a cada troca de período/filtro de criativo.
  const aggregatesOverview = useMemo(
    () => {
      if (!data) return null;
      if (effectiveMainCore === "ALL") return aggregates;
      return computeAggregates(data, mainRange, effectiveMainCore, creativeFilters);
    },
    [data, aggregates, mainRange, effectiveMainCore, creativeFilters],
  );

  // shareState: "idle" | "copying" | "copied" | "error" — controla o ícone
  // e tooltip no TopBar. Resetado pra "idle" 2s após copied/error pra dar
  // tempo de o usuário ver o feedback sem virar permanente.
  const [shareState, setShareState] = useState("idle");

  // Comentários do report: um painel só (botão no topo) com as conversas
  // Geral, RMND, PDOOH e Brand Lift. O hook fica antes dos early returns.
  const [commentsOpen, setCommentsOpen] = useState(false);
  const reportComments = useReportComments({
    token,
    open: commentsOpen,
    viewer: isAdmin ? "HYPR" : "Cliente",
    // Report mesclado: conversas de Brand Lift gravadas por mês (membro).
    surveyTokens: data?.survey?.merged ? (data.survey.items || []).map((it) => it.short_token) : [],
  });
  const handleCommentsOpenChange = (next) => {
    setCommentsOpen(next);
    reportComments.markSeen();
  };

  const handleShare = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setShareState("error");
      setTimeout(() => setShareState("idle"), 2000);
      return;
    }
    // Sempre copia a URL pública (cliente): /report/<share_id>, SEM ?adm=
    // ou outros query params. window.location.href poderia ter ?adm=<jwt>
    // quando admin abre o report direto — colar isso pro cliente vazaria
    // sessão admin de 8h.
    const shortToken = data?.campaign?.short_token;
    if (!shortToken) {
      setShareState("error");
      setTimeout(() => setShareState("idle"), 2000);
      return;
    }
    try {
      // Fast path: cache hit (resolvido em sessão anterior). Evita round-trip
      // quando admin acabou de gerar o link pelo menu, por exemplo.
      let shareId = getCachedShareId(shortToken);
      if (!shareId) {
        setShareState("copying");
        shareId = await getShareId(shortToken);
      }
      if (!shareId) throw new Error("no share_id");
      const url = `${window.location.origin}/report/${shareId}`;
      await navigator.clipboard.writeText(url);
      setShareState("copied");
      setTimeout(() => setShareState("idle"), 2000);
    } catch {
      setShareState("error");
      setTimeout(() => setShareState("idle"), 2000);
    }
  };

  if (error) {
    return (
      <div className="min-h-screen bg-canvas text-fg font-sans flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center rounded-xl border border-border bg-surface p-8">
          <h1 className="text-xl font-bold text-fg mb-2">
            Não foi possível carregar a campanha
          </h1>
          <p className="text-sm text-fg-muted mb-6">{error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-sm font-semibold text-signature hover:text-signature-hover transition-colors cursor-pointer"
          >
            Tentar de novo →
          </button>
        </div>
      </div>
    );
  }

  if (!data || !aggregates) {
    return <DashboardSkeleton />;
  }

  const camp = data.campaign;

  // Selo de frescor: data da última entrega no payload + última carga da base
  // (anexada pelo backend em `data_updated_at`, ms). Ver shared/freshness.js.
  const freshness = formatFreshness({
    dataUntil: computeDataUntil(data),
    updatedAt: data.data_updated_at || null,
    campaignEnd: camp.early_end_date || camp.end_date || null,
  });

  // Abas complementares (RMND, PDOOH, Brand Lift) só aparecem pro cliente
  // quando o admin já inseriu dado. Admin sempre vê todas, pra poder fazer
  // upload/cadastro.
  const hasRmnd = !!data.rmnd;
  const hasPdooh = !!data.pdooh;
  const hasSurvey = !!data.survey;
  const showRmnd = isAdmin || hasRmnd;
  const showPdooh = isAdmin || hasPdooh;
  const showSurvey = isAdmin || hasSurvey;
  const hasAnySecondary = showRmnd || showPdooh || showSurvey || isAdmin;

  // Max Attention: aba principal quando a campanha tem peças vinculadas.
  // Admin vê sempre (é onde vincula as peças).
  const maLinks = data.max_attention?.links || [];
  const hasMaxAttention = maLinks.length > 0;
  const showMaxAttention = isAdmin || hasMaxAttention;

  // Display/Video escondem pra todos (cliente + admin) quando a campanha
  // NÃO tem nem contrato nem entrega da mídia. Contracts são denormalizados
  // em todas as rows de totals (lidos via totals[0]).
  const t0 = (data.totals || [])[0] || {};
  const hasDisplayContract =
    (t0.contracted_o2o_display_impressions || 0) > 0 ||
    (t0.contracted_ooh_display_impressions || 0) > 0 ||
    (t0.bonus_o2o_display_impressions || 0) > 0 ||
    (t0.bonus_ooh_display_impressions || 0) > 0;
  const hasVideoContract =
    (t0.contracted_o2o_video_completions || 0) > 0 ||
    (t0.contracted_ooh_video_completions || 0) > 0 ||
    (t0.bonus_o2o_video_completions || 0) > 0 ||
    (t0.bonus_ooh_video_completions || 0) > 0;
  const hasDisplayDelivery = (data.totals || []).some((r) => r.media_type === "DISPLAY");
  const hasVideoDelivery = (data.totals || []).some((r) => r.media_type === "VIDEO");
  const showDisplay = hasDisplayContract || hasDisplayDelivery;
  const showVideo = hasVideoContract || hasVideoDelivery;

  // Deep-link pra aba que esse user não vê → overview no render (sem
  // setState em effect, anti-padrão React 19).
  const effectiveTab =
    (tab === "display" && !showDisplay) ||
    (tab === "video" && !showVideo) ||
    (tab === "max-attention" && !showMaxAttention) ||
    (tab === "rmnd" && !showRmnd) ||
    (tab === "pdooh" && !showPdooh) ||
    (tab === "survey" && !showSurvey) ||
    (tab === "dsps" && !isAdmin)
      ? "overview"
      : tab;

  const usesDataFilters =
    effectiveTab === "overview" || effectiveTab === "display" || effectiveTab === "video";
  const activeFilterCount =
    audiences.length + lineNames.length + creativeLines.length + sizes.length + formats.length;

  return (
    <ReportTrackingProvider value={{ trackCta }}>
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-canvas text-fg font-sans">
        {/* Barra de progresso vem do GlobalProgressBar (montado no main.jsx),
          * alimentada via useLoadingTask acima. */}
        <TopBarV2
          updatedAtLabel={freshness.label}
          updatedAtShort={freshness.shortLabel}
          updatedAtTitle={freshness.title}
          onShare={handleShare}
          shareState={shareState}
          onOpenComments={() => handleCommentsOpenChange(true)}
          commentsUnread={reportComments.unread}
        />

        <CommentsDrawerV2
          open={commentsOpen}
          onOpenChange={handleCommentsOpenChange}
          threads={buildCommentThreads({
            visible: { RMND: showRmnd, PDOOH: showPdooh, SURVEY: showSurvey },
            comments: reportComments.comments,
          })}
          initialThread={threadForTab(effectiveTab)}
          comments={reportComments.comments}
          loaded={reportComments.loaded}
          isAdmin={isAdmin}
          onSend={({ thread, text }) =>
            reportComments.send({ thread, author: isAdmin ? "HYPR" : "Cliente", text, adminJwt })
          }
        />

        <div className="page-shell py-6 md:py-8 space-y-6">
          <CampaignHeaderV2
            campaignName={camp.campaign_name}
            clientName={camp.client_name}
            agency={camp.agency}
            logo={data.logo}
            startDate={camp.start_date}
            endDate={camp.early_end_date || camp.end_date}
            earlyEnded={!!camp.early_end_date}
            originalEndDate={camp.end_date}
            contractedBudget={camp.budget_contracted}
            shortToken={camp.short_token || token}
            mergeMeta={data.merge_meta}
            currentView={view}
            onViewChange={setView}
            switchingView={switchingView}
            isBonusOnly={isBonusOnly}
            legacyTotals={(data.totals || [])[0]}
            reportData={data}
            isAdmin={isAdmin}
            posVenda={data.pos_venda}
            loomUrl={data.loom || null}
            autoOpenLoom={loomDeepLink}
            onLoomOpen={() => trackCta("loom_open")}
          />

          {/* `switchingView`: durante troca de view (mês → agregada, etc) o
              container é dimado e fica não-clicável — sem isso o cliente veria
              dados do mês antigo enquanto o novo carrega. O header fica FORA
              desse wrapper: as pills continuam clicáveis. */}
          <div
            className={[
              "relative transition-opacity duration-200",
              switchingView ? "opacity-40 pointer-events-none select-none" : "",
            ].join(" ")}
            aria-busy={switchingView || undefined}
          >
          <Tabs value={effectiveTab} onValueChange={setTab}>
            {/* ─── Barra de controles fixa ────────────────────────────────
                Gruda logo abaixo do TopBar (h-16). Full-bleed pelo mesmo
                padding do page-shell (4/6/8) pra o fundo fosco cobrir a
                largura toda sem mexer no alinhamento do conteúdo. */}
            <div
              className={[
                "sticky top-16 z-20",
                "-mx-4 px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8",
                "bg-canvas/85 backdrop-blur-md border-b border-border",
              ].join(" ")}
            >
              <TabsList
                variant="underline"
                className="border-b-0 w-full md:w-full min-w-0"
                aria-label="Seções do report"
              >
                <TabsTrigger value="overview" iconLeft={<GridIcon />}>
                  Visão Geral
                </TabsTrigger>
                {showDisplay && (
                  <TabsTrigger value="display" iconLeft={<MonitorIcon />}>
                    Display
                  </TabsTrigger>
                )}
                {showVideo && (
                  <TabsTrigger value="video" iconLeft={<VideoIcon />}>
                    Vídeo
                  </TabsTrigger>
                )}
                {showMaxAttention && (
                  <TabsTrigger value="max-attention" iconLeft={<SparkIcon />}>
                    Max Attention
                  </TabsTrigger>
                )}

                {hasAnySecondary && (
                  <span className="self-center mx-2 h-6 w-px bg-border shrink-0" aria-hidden />
                )}

                {showPdooh && (
                  <TabsTrigger value="pdooh" iconLeft={<MapPinIcon />} className={SECONDARY_TAB_CLASS}>
                    PDOOH
                  </TabsTrigger>
                )}
                {showRmnd && (
                  <TabsTrigger value="rmnd" iconLeft={<ShoppingCartIcon />} className={SECONDARY_TAB_CLASS}>
                    RMND
                  </TabsTrigger>
                )}
                {showSurvey && (
                  <TabsTrigger value="survey" iconLeft={<ClipboardIcon />} className={SECONDARY_TAB_CLASS}>
                    Brand Lift
                  </TabsTrigger>
                )}
                {/* Aba interna admin-only: saúde da entrega por DSP. Cliente
                    nunca vê (gate aqui + endpoint admin-gated no backend). */}
                {isAdmin && (
                  <TabsTrigger value="dsps" iconLeft={<PulseIcon />} className={SECONDARY_TAB_CLASS}>
                    DSPs
                  </TabsTrigger>
                )}

                {/* Base de dados: ferramenta (auditoria e exportação), não
                    análise. Continua a um clique, com peso de utilitário no
                    fim da barra. */}
                <TabsTrigger
                  value="base"
                  iconLeft={<TableIcon />}
                  className={`${SECONDARY_TAB_CLASS} md:ml-auto`}
                >
                  Base de dados
                </TabsTrigger>
              </TabsList>

              {/* Linha de filtros: período primeiro (é o filtro que todo
                  leitor procura), depois frente (só Visão Geral, 2+ frentes)
                  e os filtros de dado (Visão Geral/Display/Vídeo). No celular
                  a linha rola na horizontal em vez de empilhar — a barra é
                  fixa e não pode crescer. */}
              <div className="flex items-center gap-2 py-2.5 overflow-x-auto scrollbar-hidden md:flex-wrap md:overflow-visible">
                <DateRangeFilterV2
                  value={mainRange}
                  presetId={mainPresetId}
                  campaignStart={camp.start_date}
                  campaignEnd={camp.early_end_date || camp.end_date}
                  availableDates={aggregates.availableDates}
                  onChange={setMainRange}
                />
                {effectiveTab === "overview" && showCoreFilter && (
                  <CoreProductFilterV2
                    value={effectiveMainCore}
                    onChange={setMainCore}
                    available={availableCores}
                  />
                )}
                {usesDataFilters && Object.values(filterOptions).some((o) => o?.length > 0) && (
                  <>
                    <span className="h-5 w-px bg-border shrink-0" aria-hidden />
                    <GlobalDataFilterBarV2
                      inline
                      audienceOptions={filterOptions.audiences}
                      audienceOverrideMap={data?.audience_overrides}
                      lineOptions={filterOptions.lines}
                      creativeLineOptions={filterOptions.creativeLines}
                      sizeOptions={filterOptions.sizes}
                      formatOptions={filterOptions.formats}
                      audiences={audiences}
                      setAudiences={setAudiences}
                      lineNames={lineNames}
                      setLineNames={setLineNames}
                      creativeLines={creativeLines}
                      setCreativeLines={setCreativeLines}
                      sizes={sizes}
                      setSizes={setSizes}
                      formats={formats}
                      setFormats={setFormats}
                      showFormatFilter={showDisplay && showVideo}
                    />
                    {activeFilterCount > 0 && (
                      <button
                        type="button"
                        onClick={() => { trackCta("filters_clear"); clearDataFilters(); }}
                        className="shrink-0 text-xs font-semibold text-signature hover:text-signature-hover px-2 py-1 rounded-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature"
                      >
                        Limpar filtros
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="pt-6">
            <TabsContent value="overview">
              <OverviewV2
                data={data}
                aggregates={aggregatesOverview}
                token={token}
                view={view}
                isAdmin={isAdmin}
                adminJwt={adminJwt}
                mergeMeta={data.merge_meta}
                coreFilter={effectiveMainCore}
                isBonusOnly={isBonusOnly}
                onNavigate={navigateToTab}
                showDisplayTab={showDisplay}
                showVideoTab={showVideo}
                showMaxAttentionTab={showMaxAttention}
                range={mainRange}
              />
            </TabsContent>

            <TabsContent value="display">
              <DisplayV2
                data={data}
                aggregates={aggregates}
                tactic={displayTactic}
                setTactic={setDisplayTactic}
                isAdmin={isAdmin}
              />
            </TabsContent>

            <TabsContent value="video">
              <VideoV2
                data={data}
                aggregates={aggregates}
                tactic={videoTactic}
                setTactic={setVideoTactic}
                isAdmin={isAdmin}
              />
            </TabsContent>

            {showMaxAttention && (
              <TabsContent value="max-attention">
                <MaxAttentionV2
                  token={token}
                  view={view}
                  data={data}
                  range={mainRange}
                  isAdmin={isAdmin}
                  adminJwt={adminJwt}
                  onLinksChanged={reloadReport}
                />
              </TabsContent>
            )}

            <TabsContent value="base">
              <DetalhamentoV2
                data={data}
                aggregates={aggregates}
                token={token}
                view={view}
                isAdmin={isAdmin}
                adminJwt={adminJwt}
              />
            </TabsContent>

            <TabsContent value="rmnd">
              <RmndV2
                token={token}
                data={data}
                isAdmin={isAdmin}
                adminJwt={adminJwt}
                onUploaded={reloadReport}
                range={mainRange}
              />
            </TabsContent>

            <TabsContent value="pdooh">
              <PdoohV2
                token={token}
                data={data}
                isAdmin={isAdmin}
                adminJwt={adminJwt}
                onUploaded={reloadReport}
                range={mainRange}
              />
            </TabsContent>

            <TabsContent value="survey">
              <SurveyV2
                token={token}
                data={data}
                isAdmin={isAdmin}
                adminJwt={adminJwt}
              />
            </TabsContent>

            {isAdmin && (
              <TabsContent value="dsps">
                <DspHealthV2
                  token={token}
                  data={data}
                  isAdmin={isAdmin}
                  adminJwt={adminJwt}
                />
              </TabsContent>
            )}
            </div>
          </Tabs>
          </div>
        </div>
      </div>
    </TooltipProvider>
    </ReportTrackingProvider>
  );
}

// ─── Loading state ────────────────────────────────────────────────────
function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-canvas text-fg font-sans">
      <TopBarV2 updatedAtLabel="Carregando..." />
      <div className="page-shell py-6 md:py-8 space-y-6">
        <div className="rounded-2xl border border-border-strong bg-surface-2 p-8 space-y-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-96" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="border-b border-border flex gap-2">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-10 w-24" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-surface-2 p-4">
              <Skeleton className="h-3 w-20 mb-3" />
              <Skeleton className="h-7 w-28" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Ícones para os tabs ──────────────────────────────────────────────
function GridIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

function ShoppingCartIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

function MapPinIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function ClipboardIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" ry="1" />
      <line x1="9" y1="12" x2="15" y2="12" />
      <line x1="9" y1="16" x2="13" y2="16" />
    </svg>
  );
}

function PulseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

// ─── TopProgressBar ────────────────────────────────────────────────────
//
// Barra fina (2px) fixa no topo da viewport, indeterminate animation
// signature-cor. Aparece só durante refetch (troca de view/token sem
// reload). Não intrusiva — mantém o conteúdo anterior visível enquanto
// sinaliza progresso.
//
// `visible` controla via classes em vez de unmount: assim, quando o
// fetch é instantâneo (cache hit), o user vê um pequeno flash e depois
// some — feedback consistente sem flicker.
function TopProgressBar({ visible }) {
  return (
    <div
      aria-hidden={!visible}
      className={`fixed top-0 left-0 right-0 z-[60] h-[2px] overflow-hidden pointer-events-none transition-opacity duration-150 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="topbar-progress-stripe absolute inset-y-0 w-1/3 bg-signature" />
    </div>
  );
}
