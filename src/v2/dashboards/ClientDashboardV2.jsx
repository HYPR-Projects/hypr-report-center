// src/v2/dashboards/ClientDashboardV2.jsx
//
// Shell do dashboard V2 — redesenhado em PR-13 pra bater com o mockup.
//
// LAYOUT (top → bottom):
//   1. TopBarV2 — branding "Report Center" + share + voltar à versão atual
//   2. CampaignHeaderV2 — hero card com gradient + nome campanha + token badge
//   3. Filtro de período (compacto, alinhado à direita)
//   4. Tabs Radix com ícones: Visão Geral / Display / Video / Base de Dados /
//      RMND / PDOOH / Video Loom / Survey
//   5. TabsContent — OverviewV2 / DisplayV2 / VideoV2 / DetalhamentoV2 /
//      RmndV2 / PdoohV2 / LoomV2 / SurveyV2
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

import { useEffect, useMemo, useState } from "react";

import "../v2.css";
import "../../ui/typography";

import { getCampaign } from "../../lib/api";
import { gaPageView } from "../../shared/analytics";
import { computeAggregates } from "../../shared/aggregations";
import { useLoadingTask } from "../../shared/loading";
import {
  readRangeFromUrl,
  writeRangeToUrl,
  readPresetFromUrl,
  writePresetToUrl,
  buildPresets,
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
import { CampaignHeaderV2 } from "../components/CampaignHeaderV2";
import { DateRangeFilterV2 } from "../components/DateRangeFilterV2";
import { CoreProductFilterV2 } from "../components/CoreProductFilterV2";

import OverviewV2 from "./OverviewV2";
import DisplayV2 from "./DisplayV2";
import VideoV2 from "./VideoV2";
import DetalhamentoV2 from "./DetalhamentoV2";
import RmndV2 from "./RmndV2";
import PdoohV2 from "./PdoohV2";
import LoomV2 from "./LoomV2";
import SurveyV2 from "./SurveyV2";

// ─── Helpers de URL ────────────────────────────────────────────────────

const VALID_TABS = ["overview", "display", "video", "base", "rmnd", "pdooh", "loom", "survey"];
const VALID_TACTICS = ["O2O", "OOH"];

function readTabFromUrl() {
  if (typeof window === "undefined") return "overview";
  try {
    const t = new URLSearchParams(window.location.search).get("tab");
    // Backward compat: ?tab=detalhamento → base (renomeado em PR-16)
    if (t === "detalhamento") return "base";
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

// Core Product (Visão Geral) — filtro O2O/OOH/Todos exclusivo da aba
// Visão Geral. Default "ALL" não vai pra URL (limpa). URL: ?core=o2o|ooh.
const VALID_CORES = ["ALL", "O2O", "OOH"];
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

// ─── Componente principal ──────────────────────────────────────────────

export default function ClientDashboardV2({ token, isAdmin, adminJwt }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // `refreshing` cobre qualquer refetch após a 1ª carga (troca de view,
  // troca de token sem reload, etc). Renderiza barra fina de progresso
  // sem mexer no skeleton inicial — UX de "algo tá vindo" sem flash.
  const [refreshing, setRefreshing] = useState(false);

  // 1ª carga (sem `data` ainda) e refetches em background entram no
  // contador global → barrinha no topo só aparece se demorar > 200ms.
  useLoadingTask((!data && !error) || refreshing);

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

  const [displayLines, setDisplayLines] = useState([]);
  const [videoLines, setVideoLines] = useState([]);
  const [displayCreativeLines, setDisplayCreativeLines] = useState([]);
  const [videoCreativeLines, setVideoCreativeLines] = useState([]);

  // setMainRange aceita opcionalmente o presetId que originou esse range.
  // Click em preset → passa o id; ajuste no calendar → passa null (custom).
  const setMainRange = (r, presetId = null) => {
    setMainRangeState(r);
    setMainPresetIdState(presetId);
    writeRangeToUrl(r);
    writePresetToUrl(presetId);
  };
  const setTab = (t) => {
    setTabState(t);
    writeTabToUrl(t);
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
    setMainCoreState(c);
    writeCoreToUrl(c);
  };
  const setView = (v) => {
    setViewState(v);
    writeViewToUrl(v);
  };

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // Não chamamos setData(null) aqui — manter o payload anterior durante
    // o refetch (ex: trocar de visão agregada → Fev) é UX melhor que flash
    // de skeleton. Em vez disso, sinalizamos `refreshing=true` pra TopProgressBar.
    setRefreshing(true);
    getCampaign(token, view ? { view } : undefined)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        gaPageView(`/report/${token}`, token);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message || "Erro ao carregar dados");
      })
      .finally(() => {
        if (cancelled) return;
        setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, view]);

  useEffect(() => {
    const onPop = () => {
      setMainRangeState(readRangeFromUrl());
      setMainPresetIdState(readPresetFromUrl());
      setTabState(readTabFromUrl());
      setDisplayTacticState(readTacticFromUrl("display_tactic"));
      setVideoTacticState(readTacticFromUrl("video_tactic"));
      setMainCoreState(readCoreFromUrl());
      setViewState(readViewFromUrl());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Quando a view muda e o usuário tinha um preset escolhido, recalcula
  // o range no contexto do novo membro/campanha. Ex: "Mês passado" no
  // agregado vira "Mês passado" no Abril (recomputado contra os limites
  // do Abril) — sem isso, o range numérico antigo poderia bater com
  // outro preset.
  //
  // Se o preset não existe mais no novo contexto (ex: "Este mês" num
  // membro que terminou no mês passado), cai pra "Todo o período" em vez
  // de manter um range incoerente. Custom (presetId=null) e "all" não
  // disparam recompute.
  useEffect(() => {
    if (!data || !mainPresetId || mainPresetId === "all") return;
    const camp = data.campaign;
    if (!camp?.start_date || !camp?.end_date) return;
    const presets = buildPresets(new Date(), camp.start_date, camp.end_date);
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
    // Dependemos só dos limites da campanha + presetId. mainRange muda
    // como efeito da própria recomputação — incluí-lo aqui causaria loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.campaign?.start_date, data?.campaign?.end_date, mainPresetId]);

  // mainCore só afeta a Visão Geral. Pra evitar que abrir Display/Video
  // veja dados filtrados, calculamos DOIS aggregates: um irrestrito
  // (consumido por todas as outras tabs) e um filtrado por core (só pro
  // OverviewV2). useMemo separa o custo — quando o user mexe só no core,
  // só `aggregatesOverview` recalcula.
  const aggregates = useMemo(
    () => (data ? computeAggregates(data, mainRange) : null),
    [data, mainRange],
  );
  const aggregatesOverview = useMemo(
    () => (data ? computeAggregates(data, mainRange, mainCore) : null),
    [data, mainRange, mainCore],
  );

  const handleShare = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(window.location.href).catch(() => {
      /* silently fail */
    });
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

  // Tabs auxiliares (RMND, PDOOH, Loom, Survey) são complementos opcionais —
  // só aparecem pro cliente quando o admin já inseriu dado. Admin sempre vê
  // todas, pra poder fazer upload/cadastro. Diretiva PR-16: separar core
  // (Visão Geral / Display / Video / Detalhamento) de plus visualmente.
  const hasRmnd = !!data.rmnd;
  const hasPdooh = !!data.pdooh;
  const hasLoom = !!data.loom;
  const hasSurvey = !!data.survey;
  const showRmnd = isAdmin || hasRmnd;
  const showPdooh = isAdmin || hasPdooh;
  const showLoom = isAdmin || hasLoom;
  const showSurvey = isAdmin || hasSurvey;
  const hasAnySecondary = showRmnd || showPdooh || showLoom || showSurvey;

  // Display/Video escondem pra todos (cliente + admin) quando a campanha
  // NÃO tem nem contrato nem entrega da mídia. Regra: se há valor
  // contratado (contracted_*_display_impressions, contracted_*_video_completions
  // ou bonus_*) > 0, mostra mesmo sem entrega ainda (campanha recém-lançada).
  // Se não tem contrato e não tem entrega, esconde — não faz sentido pro
  // cliente ver uma aba que sempre vai estar vazia, nem pro admin (não tem
  // o que configurar nessa aba; setup é via admin panel, não pelo dashboard).
  //
  // Contracts são denormalizados em todas as rows de totals (lidos via
  // totals[0]), então qualquer row de qualquer mídia carrega o contrato
  // de todas. Quando totals está totalmente vazio, hasContract degrada pra
  // false — caso de campanha brand-new sem delivery em nada (raro).
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

  // Se deep-link aponta pra tab que esse user não vê (cliente sem dado
  // cadastrado), downgrade pra overview no render — evita tela vazia
  // sem trigger ativo no menu. URL pode ficar momentaneamente fora de
  // sync com a UI até o próximo clique em tab; preço aceitável pra
  // evitar setState em effect (anti-padrão React 19).
  const effectiveTab =
    (tab === "display" && !showDisplay) ||
    (tab === "video" && !showVideo) ||
    (tab === "rmnd" && !showRmnd) ||
    (tab === "pdooh" && !showPdooh) ||
    (tab === "loom" && !showLoom) ||
    (tab === "survey" && !showSurvey)
      ? "overview"
      : tab;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-canvas text-fg font-sans">
        {/* Barra de progresso vem do GlobalProgressBar (montado no main.jsx),
          * alimentada via useLoadingTask acima. O TopProgressBar local virou
          * redundante. */}
        <TopBarV2
          updatedAtLabel="Atualizado agora"
          onShare={handleShare}
        />

        <div className="mx-auto max-w-[1440px] px-4 md:px-6 lg:px-8 py-6 md:py-8 space-y-6">
          <CampaignHeaderV2
            campaignName={camp.campaign_name}
            clientName={camp.client_name}
            logo={data.logo}
            startDate={camp.start_date}
            endDate={camp.end_date}
            shortToken={camp.short_token || token}
            mergeMeta={data.merge_meta}
            currentView={view}
            onViewChange={setView}
          />

          {/* Tabs com filtro de período alinhado à direita */}
          <Tabs value={effectiveTab} onValueChange={setTab}>
            <div className="flex items-end justify-between gap-4 flex-wrap border-b border-border">
              <TabsList variant="underline" className="border-b-0">
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
                    Video
                  </TabsTrigger>
                )}
                <TabsTrigger value="base" iconLeft={<TableIcon />}>
                  Base de Dados
                </TabsTrigger>

                {hasAnySecondary && (
                  <span
                    className="self-center mx-2 h-6 w-px bg-border"
                    aria-hidden
                  />
                )}

                {showRmnd && (
                  <TabsTrigger
                    value="rmnd"
                    iconLeft={<ShoppingCartIcon />}
                    className={SECONDARY_TAB_CLASS}
                  >
                    RMND
                  </TabsTrigger>
                )}
                {showPdooh && (
                  <TabsTrigger
                    value="pdooh"
                    iconLeft={<MapPinIcon />}
                    className={SECONDARY_TAB_CLASS}
                  >
                    PDOOH
                  </TabsTrigger>
                )}
                {showLoom && (
                  <TabsTrigger
                    value="loom"
                    iconLeft={<FilmIcon />}
                    className={SECONDARY_TAB_CLASS}
                  >
                    Video Loom
                  </TabsTrigger>
                )}
                {showSurvey && (
                  <TabsTrigger
                    value="survey"
                    iconLeft={<ClipboardIcon />}
                    className={SECONDARY_TAB_CLASS}
                  >
                    Survey
                  </TabsTrigger>
                )}
              </TabsList>

              {/* Filtros à direita das tabs. Core Product é exclusivo da
                  Visão Geral — sai quando outra tab fica ativa pra não
                  poluir e pra evitar confundir o user (Display/Video tem
                  seus próprios toggles internos). */}
              <div className="pb-2 flex items-center gap-2">
                {effectiveTab === "overview" && (
                  <CoreProductFilterV2
                    value={mainCore}
                    onChange={setMainCore}
                  />
                )}
                <DateRangeFilterV2
                  value={mainRange}
                  presetId={mainPresetId}
                  campaignStart={camp.start_date}
                  campaignEnd={camp.end_date}
                  availableDates={aggregates.availableDates}
                  onChange={setMainRange}
                />
              </div>
            </div>

            <TabsContent value="overview">
              <OverviewV2
                data={data}
                aggregates={aggregatesOverview}
                token={token}
                isAdmin={isAdmin}
                adminJwt={adminJwt}
                mergeMeta={data.merge_meta}
                coreFilter={mainCore}
              />
            </TabsContent>

            <TabsContent value="display">
              <DisplayV2
                data={data}
                aggregates={aggregates}
                tactic={displayTactic}
                setTactic={setDisplayTactic}
                lines={displayLines}
                setLines={setDisplayLines}
                creativeLines={displayCreativeLines}
                setCreativeLines={setDisplayCreativeLines}
              />
            </TabsContent>

            <TabsContent value="video">
              <VideoV2
                data={data}
                aggregates={aggregates}
                tactic={videoTactic}
                setTactic={setVideoTactic}
                lines={videoLines}
                setLines={setVideoLines}
                creativeLines={videoCreativeLines}
                setCreativeLines={setVideoCreativeLines}
              />
            </TabsContent>

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
              />
            </TabsContent>

            <TabsContent value="pdooh">
              <PdoohV2
                token={token}
                data={data}
                isAdmin={isAdmin}
                adminJwt={adminJwt}
              />
            </TabsContent>

            <TabsContent value="loom">
              <LoomV2 loomUrl={data.loom} />
            </TabsContent>

            <TabsContent value="survey">
              <SurveyV2
                token={token}
                data={data}
                isAdmin={isAdmin}
                adminJwt={adminJwt}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </TooltipProvider>
  );
}

// ─── Loading state ────────────────────────────────────────────────────
function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-canvas text-fg font-sans">
      <TopBarV2 updatedAtLabel="Carregando..." />
      <div className="mx-auto max-w-[1440px] px-4 md:px-6 lg:px-8 py-6 md:py-8 space-y-6">
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

function FilmIcon() {
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
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
      <line x1="7" y1="2" x2="7" y2="22" />
      <line x1="17" y1="2" x2="17" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="2" y1="7" x2="7" y2="7" />
      <line x1="2" y1="17" x2="7" y2="17" />
      <line x1="17" y1="17" x2="22" y2="17" />
      <line x1="17" y1="7" x2="22" y2="7" />
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
