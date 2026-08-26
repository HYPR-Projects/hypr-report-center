// src/v2/admin/pages/PmpDealsPage.jsx — v3
//
// Refatoração completa baseada no padrão visual do CampaignMenuV2.
// Resolve: hierarquia visual (spacing, tipografia), separação clara entre
// estados (live vs ended vs archived) e múltiplas views específicas.
//
// 5 views, agora navegadas pelo rail do AdminShell:
//   Lista      — densidade alta estilo Linear
//   No ar      — cards ricos pra lines com delivery <7d
//   Carteira   — accordion por cliente ou por campanha
//   Histórico  — lifetime: tudo (encerradas, ativas, arquivadas)
//   Analytics  — série diária (lazy, carrega recharts)
//
// ── O que mudou com o AdminShell ─────────────────────────────────────────
// Esta era a página onde a inconsistência doía mais. Ela usava
// `page-shell-wide` (1600px) enquanto o menu usava `page-shell` (1440px), e
// o app trocava de largura quando você entrava aqui. O header repetia o do
// menu à mão, com um conjunto diferente de widgets. E três nomes conviviam
// pra mesma coisa: "PMP Deals" no botão do herói, "PMP LINES" no breadcrumb
// e "Deals de Pagamento" no H1.
//
// Os filtros eram o pior caso do admin: busca + Cliente + Bid + Fonte +
// Status numa faixa, período/trimestre/mês do Histórico noutra, o SortChip
// numa terceira, situação/ciclo da Carteira numa quarta — e DOIS links
// "Limpar" separados, cada um zerando um subconjunto diferente. Agora é uma
// `FilterBar` com chips declarados por view.
//
// Mutations preservadas: drawer de edição, popup de auto-vinculação,
// modal de agrupamento, export, Compplan Sheet.

import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from "react";
import { fmt } from "../../../shared/format";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import { ptBR } from "date-fns/locale";
import "react-day-picker/style.css";
import "../../components/DateRangeFilterV2.css";
import "../../v2.css";

import {
  listPmpLines, savePmpLineOverrides, syncPmpV2, syncPmpPubmatic,
  suggestPmpLinks, linkPmpCommand, getPmpLine, pmpLineWindowMetrics,
  pmpLinesTimeseries,
} from "../../../lib/api";

// Analytics carrega recharts — lazy pra não pesar o chunk da Lista pra quem
// nunca abre a aba.
const PmpAnalytics = lazy(() => import("../components/PmpAnalytics"));
import { Button } from "../../../ui/Button";
import { Skeleton } from "../../../ui/Skeleton";
import { Select } from "../../../ui/Select";
import {
  Drawer, DrawerContent, DrawerHeader, DrawerBody, DrawerFooter,
} from "../../../ui/Drawer";
import { cn } from "../../../ui/cn";
import { CountBadge } from "../../../ui/CountBadge";
import { ymd, parseYmd } from "../../../shared/dateFilter";
import { TooltipProvider } from "../../../ui/Tooltip";
import { AdminShell } from "../shell/AdminShell";
import { PageHeader, MetaDot, MetaStat } from "../shell/PageHeader";
import { buildNavCounts, writeNavCountsCache, SECTION_PMP, viewMeta } from "../shell/navConfig";
import {
  FilterBar, FilterPanel, FilterOption, FilterPanelClear, SortChipFilter,
  FilterChipChevron, FilterChipValue,
} from "../components/FilterBar";
import { filterChipClass } from "../components/filterChipStyle";
import { KpiBoard } from "../components/KpiBoard";
import {
  PMP_STATUSES, statusPillClass,
  LIVE_STATUSES, HISTORY_STATUSES, effectiveDeliveryMeta,
  bidTypeLabel,
  formatBRL, formatBRLCompact, formatInt, formatIntCompact, formatRatioPct,
  comparePmpLines, compareSortValues, formatLastDelivery,
  pctEntrega, groupPctEntrega,
  pctEntregaRev, groupPctEntregaRev,
  resolveGroupPi, lineKey,
  effectiveStatus, isPmpEditor,
} from "../lib/pmpFormat";
import {
  buildCampaigns, CAMPAIGN_SORTS, countCampaignBuckets, filterCampaigns, sortCampaigns,
  CAMPAIGN_SITUATIONS, CAMPAIGN_CYCLES,
} from "../lib/pmpCampaign";
import {
  PmpKpiStrip,
  PmpLiveCard, PmpLiveGroupCard, PmpCustomerAccordion,
  PmpLineRow, PmpLineRowHeader, PmpLineGroupCard,
} from "../components/PmpComponents";
import { PmpCampaignView } from "../components/PmpCampaignView";
import { GroupLinesModal } from "../components/GroupLinesModal";
import { buildCompplanRows, applyCompplanFormats } from "../lib/compplanExport";
import CompplanSheetCard from "../components/CompplanSheetCard";
import { PmpFreshnessIndicator } from "../components/PmpFreshnessIndicator";
import { isFeatureAdmin } from "../../../shared/auth";

const ALL = "__ALL__";

// Auto-recovery do frescor (ver o efeito no PmpDealsPage). Cooldown por
// navegador: recarregar a página 10 vezes não vira 10 syncs.
const AUTO_RECOVERY_COOLDOWN_MS = 30 * 60 * 1000;
const AUTO_RECOVERY_KEY = "pmp:autoRecovery:lastAttempt";

// Data BR de N dias atrás, como "YYYY-MM-DD" — mesma grandeza das colunas DATE
// que o backend devolve (start_date, end_date, last_delivery_day).
function isoDaysAgo(n) {
  const br = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const d = new Date(`${br}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Status workflow que são decisão HUMANA de "está fora do ar".
const OFF_AIR_STATUSES = new Set(["Finalizado", "Cancelado", "Pausado"]);

// Esta line DEVERIA ter entregue em `day`? Alimenta o `expectsDelivery` do
// painel de frescor: sem pelo menos uma line assim, atraso de dado não é
// alarme, é fim de campanha.
//
// Julga por FLIGHT e WORKFLOW, nunca por dado de entrega — de propósito.
// `delivery_status` e `effectiveStatus` derivam do `last_delivery_day`, então
// usá-los aqui faria o alarme se auto-desarmar exatamente quando o atraso
// cresce: uma base 10 dias velha rebaixa a line pra 'stopped', que sairia da
// conta e apagaria o alerta justo no caso mais grave.
function shouldBeDelivering(line, day) {
  if (!line || line.is_archived) return false;
  if (OFF_AIR_STATUSES.has(line.status)) return false;
  if (line.state === "inactive") return false;
  // Sem start_date não há como afirmar que o flight já começou.
  if (!line.start_date || line.start_date > day) return false;
  // end_date nulo = flight aberto (deal PubMatic sem checklist vinculado).
  if (line.end_date && line.end_date < day) return false;
  return true;
}

// Sobrepõe nas lines as métricas agregadas DENTRO da janela escolhida
// (cost/revenue/margem/imps), tipo filtro de Excel. PI e margem configurada
// ficam intactos (contrato, não filtram). Lines sem delivery na janela viram
// zeros. Re-deriva também as somas de grupo e os % a partir dos valores
// janelados pra que tudo (tabela + KPIs + export) leia o mesmo número.
function applyWindowMetrics(lines, metrics) {
  if (!metrics) return lines;
  // Chave nova = "<fonte>:<line_id>"; backend antigo ainda responde só com o
  // line_id (ver window_metrics em pmp_lines.py).
  const pick = (l) => metrics[lineKey(l)] || metrics[String(l.line_id)];
  // 1) Somas por grupo dentro da janela. Custo e impressões entram junto —
  //    sem eles o subtotal do grupo misturava Custo/Imps LIFETIME com
  //    Receita/Margem do período, e a linha não fechava com as próprias rows.
  const gMargin = {}, gRevenue = {}, gCost = {}, gImps = {};
  for (const l of lines) {
    if (!l.group_id) continue;
    const m = pick(l);
    gMargin[l.group_id]  = (gMargin[l.group_id]  || 0) + (m ? Number(m.curator_margin     || 0) : 0);
    gRevenue[l.group_id] = (gRevenue[l.group_id] || 0) + (m ? Number(m.curator_revenue    || 0) : 0);
    gCost[l.group_id]    = (gCost[l.group_id]    || 0) + (m ? Number(m.curator_total_cost || 0) : 0);
    gImps[l.group_id]    = (gImps[l.group_id]    || 0) + (m ? Number(m.imps               || 0) : 0);
  }
  // 2) Overlay por line.
  return lines.map(l => {
    const m = pick(l) || {};
    const cost    = Number(m.curator_total_cost || 0);
    const revenue = Number(m.curator_revenue    || 0);
    const margin  = Number(m.curator_margin     || 0);
    const imps    = Number(m.imps               || 0);
    const pi      = l.pi_brl != null ? Number(l.pi_brl) : null;
    const grpM    = l.group_id ? (gMargin[l.group_id]  || 0) : null;
    const grpR    = l.group_id ? (gRevenue[l.group_id] || 0) : null;
    return {
      ...l,
      curator_total_cost: cost,
      curator_revenue: revenue,
      curator_margin: margin,
      imps,
      effective_margin_pct: revenue > 0 ? margin / revenue : null,
      pct_a_receber: (pi && pi > 0) ? margin / pi : null,
      pct_a_receber_rev: (pi && pi > 0) ? revenue / pi : null,
      ecpm: imps > 0 ? (revenue * 1000) / imps : null,
      group_curator_margin: grpM,
      group_curator_revenue: grpR,
      group_curator_total_cost: l.group_id ? (gCost[l.group_id] || 0) : null,
      group_imps: l.group_id ? (gImps[l.group_id] || 0) : null,
      group_effective_margin_pct: (grpR && grpR > 0) ? grpM / grpR : null,
      group_pct_a_receber: (grpM != null && pi && pi > 0) ? grpM / pi : l.group_pct_a_receber,
      group_pct_a_receber_rev: (grpR != null && pi && pi > 0) ? grpR / pi : null,
      _windowed: true,
    };
  });
}

export default function PmpDealsPage({
  user, onLogout,
  // `layout` vem da URL (ver navConfig + App.jsx).
  layout = "list",
  onNavigateView,
}) {
  // Permissão de edição — só uma lista curada de operadores pode mutar
  // status/PI/command/overrides/notas/grupo. Demais usuários veem tudo
  // em modo somente-leitura. Gate é frontend-only (guard rail UX).
  const canEdit = isPmpEditor(user);
  // "Sincronizar agora" (rebuild do Xandr Curate) — restrito à mesma
  // lista FEATURE_ADMINS do "Reconstruir agora" do menu. Sem onSync, o
  // PmpFreshnessIndicator esconde o botão e mantém só o status.
  const canSync = isFeatureAdmin(user);

  const [lines, setLines] = useState([]);
  // Ledger de execuções do sync por fonte (pmp_sync_runs). Vem no mesmo
  // payload das lines; alimenta o painel de frescor do header.
  const [syncRuns, setSyncRuns] = useState([]);
  // Histórico das últimas execuções (todas as fontes, mais recente primeiro).
  // Responde "as sondagens do dia rodaram?" — que a última execução sozinha
  // não responde: base velha por fonte lenta e base velha por Scheduler morto
  // produzem a MESMA linha, e pedem consertos opostos.
  const [syncRunsRecent, setSyncRunsRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Card da planilha Google do compplan — fechado por default pra não
  // ocupar o hero; toggle no botão ao lado do Exportar (só editores).
  const [showCompplan, setShowCompplan] = useState(false);
  // Saves em voo (multi-save paralelo). Set de line_ids com save pendente.
  const [savingLineIds, setSavingLineIds] = useState(() => new Set());
  const startSaving = (id) => setSavingLineIds(prev => { const n = new Set(prev); n.add(id); return n; });
  const finishSaving = (id) => setSavingLineIds(prev => { const n = new Set(prev); n.delete(id); return n; });

  // Carteira (aba "client") tem duas hierarquias sobre o MESMO dataset:
  //   cliente   → accordion por cliente, campanhas/lines dentro
  //   campanha  → accordion por campanha (PI, receita, margem, custo, entrega),
  //               flights e lines dentro
  // Vive num toggle em vez de virar uma 6ª aba: mesmo recorte, mesmos filtros,
  // mesmos KPIs — só muda o eixo de leitura.
  const [carteiraGroup, setCarteiraGroup] = useState(() => {
    try { return localStorage.getItem("hypr.pmp.carteira") || "client"; } catch { return "client"; }
  });
  // Recorte da Carteira em dois eixos (ver CAMPAIGN_SITUATIONS/CYCLES).
  // Não persiste entre sessões de propósito: é recorte de análise, e voltar
  // no dia seguinte com "Pararam" ativo faria a carteira parecer vazia.
  const [carteiraSituation, setCarteiraSituation] = useState("all");
  const [carteiraCycle, setCarteiraCycle] = useState("all");
  const [campaignSort, setCampaignSort] = useState("recent_start");
  useEffect(() => {
    try { localStorage.setItem("hypr.pmp.carteira", carteiraGroup); } catch { /* ignore */ }
  }, [carteiraGroup]);

  // Série diária pro Analytics — fetch lazy (só ao abrir a aba). Estado:
  // idle|loading|ready|error. Declarado APÓS `layout` (o effect depende dele).
  const [timeseries, setTimeseries] = useState([]);
  const [tsStatus, setTsStatus] = useState("idle");
  const loadTimeseries = useCallback(async () => {
    setTsStatus("loading");
    try {
      // Histórico completo (~5 anos → hoje). A tabela de entrega diária inteira
      // tem ~1.200 rows desde jul/2023, então puxar tudo custa quase nada — e é
      // condição pro Fechamento mensal fechar a conta por SAFRA: com janela de
      // 18 meses, os PIs mais antigos apareciam sem o consumo do próprio mês.
      // O backend só devolve dias com delivery, então o Analytics deriva os
      // bounds reais (e o filtro de período) das rows.
      const today = new Date();
      const floor = new Date(today); floor.setDate(floor.getDate() - 1825);
      const rows = await pmpLinesTimeseries({ dateFrom: ymd(floor), dateTo: ymd(today) });
      setTimeseries(rows);
      setTsStatus("ready");
    } catch (e) {
      console.error("[pmp] timeseries", e);
      setTsStatus("error");
    }
  }, []);
  // Dispara o fetch quando a aba Analytics abre pela 1ª vez.
  useEffect(() => {
    if (layout === "analytics" && tsStatus === "idle" && lines.length > 0) loadTimeseries();
  }, [layout, tsStatus, lines.length, loadTimeseries]);

  // Filtros transversais
  const [search, setSearch]   = useState("");
  // Filtros de catálogo (cliente, bid, status) persistem entre sessões no
  // mesmo browser/usuário — UX: usuário operacional volta pro mesmo recorte
  // sem reaplicar. Search e período/trimestre NÃO persistem por serem
  // contexto da sessão.
  const persistedFilters = (() => {
    try {
      const raw = localStorage.getItem("hypr.pmp.filters");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return {
        customer: Array.isArray(parsed.customer) ? parsed.customer : [],
        bidType:  typeof parsed.bidType === "string" ? parsed.bidType : ALL,
        status:   Array.isArray(parsed.status) ? parsed.status : [],
        source:   typeof parsed.source === "string" ? parsed.source : ALL,
      };
    } catch { return null; }
  })();
  // Cliente é multi-select: array de nomes. Vazio = todos.
  const [customer, setCustomer] = useState(persistedFilters?.customer || []);
  const [bidType, setBidType] = useState(persistedFilters?.bidType || ALL);
  // Status é multi-select: array. Vazio = todos.
  const [status, setStatus]   = useState(persistedFilters?.status || []);
  // Fonte de curadoria (Xandr Curate × PubMatic). ALL = todas.
  const [sourceFilter, setSourceFilter] = useState(persistedFilters?.source || ALL);
  useEffect(() => {
    try {
      localStorage.setItem("hypr.pmp.filters", JSON.stringify({ customer, bidType, status, source: sourceFilter }));
    } catch { /* ignore */ }
  }, [customer, bidType, status, sourceFilter]);

  // Filtros temporais — só aplicam na aba Histórico.
  //   histPeriod    = { from: "YYYY-MM-DD"|null, to: "YYYY-MM-DD"|null, presetId }
  //   histQuarters  = [{ year: 2026, q: 2 }, ...] (multi). [] = sem filtro.
  //   histMonths    = [{ year: 2026, month: 5 }, ...] (multi, 1-12). [] = sem filtro.
  // Composição:
  //   • Período AND (trimestres ∪ meses)
  //   • Trimestres e meses são UNION entre si — line passa se cai em qualquer
  //     range. Permite "Q1 + Mai/26" ou múltiplos meses sem precisar selecionar
  //     o trimestre inteiro.
  const [histPeriod, setHistPeriod] = useState({ presetId: "all", from: null, to: null });
  const [histQuarters, setHistQuarters] = useState([]);
  const [histMonths, setHistMonths]     = useState([]);
  // Métricas janeladas (tipo Excel): mapa line_id → agregado da janela.
  // null = sem janela ativa (números lifetime).
  const [windowMetrics, setWindowMetrics] = useState(null);
  const [windowLoading, setWindowLoading] = useState(false);

  // Sort — duas instâncias separadas porque os defaults fazem sentido
  // diferentes em cada view (Lista: mais stale primeiro; Histórico:
  // ativação mais recente primeiro).
  const [sortBy, setSortBy]   = useState("hours_since_last_delivery");
  const [sortDir, setSortDir] = useState("asc");
  const [histSortBy, setHistSortBy]   = useState("start_date");
  const [histSortDir, setHistSortDir] = useState("desc");
  // Defaults pra checar quando voltar pro estado "sem sort manual" (chip
  // "Ordenado:" só aparece quando há divergência do default).
  const LIST_DEFAULT_SORT = { by: "hours_since_last_delivery", dir: "asc" };
  const HIST_DEFAULT_SORT = { by: "start_date", dir: "desc" };

  // Modals
  const [editing, setEditing] = useState(null);
  const [linking, setLinking] = useState(null);
  const [grouping, setGrouping] = useState(null);  // line objeto, abre GroupLinesModal

  // Toast pós-vinculação. Popup fecha imediatamente após sucesso, então sem
  // toast o operador fica em dúvida se a operação completou. Auto-dismiss 4s.
  const [linkToast, setLinkToast] = useState(null);  // { token, lineLabel } | null
  useEffect(() => {
    if (!linkToast) return;
    const t = setTimeout(() => setLinkToast(null), 4000);
    return () => clearTimeout(t);
  }, [linkToast]);

  // Sync
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // include_archived=true porque a view Histórico precisa ver tudo
      const { lines: list, syncRuns: runs, syncRunsRecent: recent } =
        await listPmpLines({ includeArchived: true, onlyActive: false });
      setLines(list);
      setSyncRuns(runs);
      setSyncRunsRecent(recent || []);
    } catch (e) {
      console.error("[pmp v3]", e);
      setError(e.message || "Erro ao carregar lines");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // ── Partições por delivery_status (grupos PEGAJOSOS) ──────────────────────
  // Regra dos grupos: se PELO MENOS UM membro qualifica pra uma view, o GRUPO
  // INTEIRO aparece lá. Ex: grupo com 1 line ativa + 1 encerrada → o grupo
  // completo aparece em Lista E Histórico. Isso preserva o contexto de A/B
  // test (você nunca olha pra metade do grupo).
  const partitions = useMemo(() => {
    // Status workflow terminal: line "Finalizado"/"Cancelado" sai de Lista/Ao vivo
    // mesmo que o Xandr ainda mostre delivery — o admin marcou como fora de
    // operação, então só deve aparecer em Histórico.
    const isWorkflowTerminal = (l) => {
      const eff = effectiveStatus(l);
      return eff === "Finalizado" || eff === "Cancelado";
    };
    // 1. Mapa group_id → todos os membros
    const groupLines = new Map();
    for (const l of lines) {
      if (l.group_id) {
        if (!groupLines.has(l.group_id)) groupLines.set(l.group_id, []);
        groupLines.get(l.group_id).push(l);
      }
    }
    // 2. Pra cada grupo, descobre em quais views ele qualifica
    const groupViews = new Map();
    for (const [gid, members] of groupLines) {
      const views = new Set();
      for (const m of members) {
        if (m.is_archived) views.add("history");
        else if (isWorkflowTerminal(m)) views.add("history");
        else if (LIVE_STATUSES.has(m.delivery_status)) views.add("live");
        else if (HISTORY_STATUSES.has(m.delivery_status)) views.add("history");
        else views.add("other");
      }
      groupViews.set(gid, views);
    }
    // 3. Particiona — lines em grupo seguem o veredicto do grupo (qualquer
    //    membro qualifica = todos aparecem); lines soltas seguem o próprio status.
    const live = [], history = [], other = [];
    const seenIn = { live: new Set(), history: new Set(), other: new Set() };
    const pushOnce = (bucket, name, line) => {
      if (!seenIn[name].has(line.line_id)) {
        bucket.push(line);
        seenIn[name].add(line.line_id);
      }
    };
    for (const l of lines) {
      if (l.group_id) {
        const views = groupViews.get(l.group_id) || new Set();
        if (views.has("live"))    pushOnce(live,    "live",    l);
        if (views.has("history")) pushOnce(history, "history", l);
        if (views.has("other") && !views.has("live") && !views.has("history"))
          pushOnce(other, "other", l);
      } else {
        if (l.is_archived) pushOnce(history, "history", l);
        else if (isWorkflowTerminal(l)) pushOnce(history, "history", l);
        else if (LIVE_STATUSES.has(l.delivery_status))    pushOnce(live, "live", l);
        else if (HISTORY_STATUSES.has(l.delivery_status)) pushOnce(history, "history", l);
        else                                              pushOnce(other, "other", l);
      }
    }
    return { live, history, other };
  }, [lines]);

  // ── Filtros aplicados ─────────────────────────────────────────────────────
  const applyFilters = (arr) => {
    const term = search.trim().toLowerCase();
    return arr.filter(l => {
      if (customer.length > 0 && !customer.includes(l.customer)) return false;
      if (bidType  !== ALL && (l.bid_type || "—") !== bidType) return false;
      if (sourceFilter !== ALL && (l.source || "xandr") !== sourceFilter) return false;
      if (status.length > 0 && !status.includes(effectiveStatus(l))) return false;
      if (term) {
        const hay = [l.line_id, l.line_name, l.customer, l.campaign_name, l.agency,
                      l.short_token, l.io_name, l.cp_email, l.cs_email].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  };
  const liveFiltered      = useMemo(() => applyFilters(partitions.live),    [partitions.live, search, customer, bidType, status, sourceFilter]);
  // Histórico passa a ser LIFETIME: mostra TODOS os deals (ativos + encerrados
  // + arquivados), com filtros aplicados. Vira a aba "tudo".
  // Filtros de período/trimestre só aplicam na aba Histórico, e fazem intersecção.
  // Trimestres selecionados viram lista de ranges [{from, to}]. Multi-Q é
  // UNION (line passa se cair em qualquer range) — permite seleção não
  // contígua como Q1 + Q3.
  const quarterRanges = useMemo(() => {
    return histQuarters.map(({ year, q }) => {
      const qFrom = `${year}-${String((q-1)*3 + 1).padStart(2,"0")}-01`;
      const qToMonth = q*3;
      const qToLastDay = new Date(year, qToMonth, 0).getDate();
      const qTo = `${year}-${String(qToMonth).padStart(2,"0")}-${String(qToLastDay).padStart(2,"0")}`;
      return { from: qFrom, to: qTo };
    });
  }, [histQuarters]);

  const monthRanges = useMemo(() => {
    return histMonths.map(({ year, month }) => {
      const lastDay = new Date(year, month, 0).getDate();
      const mm = String(month).padStart(2,"0");
      return {
        from: `${year}-${mm}-01`,
        to:   `${year}-${mm}-${String(lastDay).padStart(2,"0")}`,
      };
    });
  }, [histMonths]);

  // Janela ativa pras MÉTRICAS (só no Histórico). Bounds do período escolhido:
  // custom range, preset (from/to concretos) ou união de buckets (min→max).
  // "Tudo" → null (números lifetime). Buckets não-contíguos viram um range
  // único min→max (inclui o vão) — limitação aceita; uso comum é 1 bucket/range.
  const metricWindow = useMemo(() => {
    if (layout !== "history") return null;
    const ranges = [...quarterRanges, ...monthRanges];
    const froms = [histPeriod.from, ...ranges.map(r => r.from)].filter(Boolean).sort();
    const tos   = [histPeriod.to,   ...ranges.map(r => r.to)].filter(Boolean).sort();
    let from = froms[0] || null;
    let to   = tos[tos.length - 1] || null;
    if (!from && !to) return null;          // "Tudo" → sem janela
    if (from && !to) to = ymd(new Date());  // aberto até hoje
    if (!from && to) return null;           // só "até" sem início → não janela
    return { from, to };
  }, [layout, histPeriod, quarterRanges, monthRanges]);

  // Busca as métricas da janela quando os bounds mudam.
  useEffect(() => {
    if (!metricWindow) { setWindowMetrics(null); return; }
    let cancelled = false;
    setWindowLoading(true);
    pmpLineWindowMetrics({ dateFrom: metricWindow.from, dateTo: metricWindow.to })
      .then(m => { if (!cancelled) setWindowMetrics(m); })
      .catch(() => { if (!cancelled) setWindowMetrics(null); })
      .finally(() => { if (!cancelled) setWindowLoading(false); });
    return () => { cancelled = true; };
  }, [metricWindow]);

  const allLinesFiltered = useMemo(() => {
    const base = applyFilters(lines);
    const { from, to } = histPeriod;
    const bucketRanges = [...quarterRanges, ...monthRanges];
    if (!from && !to && bucketRanges.length === 0) return base;
    // Filtra por ENTREGA na janela, não por data de início: a line aparece se
    // o período em que ela entregou [first_delivery_day, last_delivery_day]
    // cruzar o range escolhido. Assim uma campanha que começou meses atrás mas
    // entregou nos últimos dias continua aparecendo. Lines sem entrega
    // registrada (pending/scheduled) não entregaram em janela nenhuma → saem.
    return base.filter(l => {
      const dFrom = l.first_delivery_day;
      const dTo   = l.last_delivery_day;
      if (!dFrom || !dTo) return false;
      // Overlap com o range custom (AND com buckets de trim/mês).
      if (to   && dFrom > to)   return false; // entrega começou depois da janela
      if (from && dTo   < from) return false; // entrega terminou antes da janela
      // Trimestres ∪ meses: entrega precisa cruzar PELO MENOS 1 range.
      if (bucketRanges.length > 0) {
        const inAny = bucketRanges.some(r => dFrom <= r.to && dTo >= r.from);
        if (!inAny) return false;
      }
      return true;
    });
  }, [lines, search, customer, bidType, status, sourceFilter, histPeriod, quarterRanges, monthRanges]);

  // Histórico com métricas janeladas quando há janela ativa e dado carregado.
  // Exige mapa não-vazio: se o endpoint ainda não existir no backend (ou
  // falhar), windowMetrics fica null/{} e caímos de volta nos números lifetime
  // em vez de zerar tudo.
  const windowed = !!(metricWindow && windowMetrics && Object.keys(windowMetrics).length > 0);
  const histLines = useMemo(
    () => (windowed ? applyWindowMetrics(allLinesFiltered, windowMetrics) : allLinesFiltered),
    [allLinesFiltered, windowed, windowMetrics],
  );

  const allFiltered = useMemo(() => applyFilters([...partitions.live, ...partitions.other]), [partitions, search, customer, bidType, status, sourceFilter]);

  // Dataset da aba Por cliente: lifetime SEM arquivadas (testes/seeds só no
  // Histórico) e SEM o filtro de período do Histórico (que sobrevive no
  // allLinesFiltered mesmo fora da aba). É o que os accordions agrupam —
  // KPIs e badge da aba leem este MESMO conjunto pra nunca divergirem do
  // que está exposto abaixo.
  const clientLines = useMemo(
    () => applyFilters(lines.filter(l => !l.is_archived)),
    [lines, search, customer, bidType, status, sourceFilter],
  );

  // Campanhas da Carteira — mesmo dataset dos accordions por cliente, só que
  // agrupado por campanha (flights de 1 PI dentro). Ver lib/pmpCampaign.js.
  const campaigns = useMemo(() => buildCampaigns(clientLines), [clientLines]);
  // Contagem por bucket ANTES do recorte: cada chip mostra quantas campanhas
  // apareceriam se fosse clicado agora.
  const carteiraCounts = useMemo(() => countCampaignBuckets(campaigns), [campaigns]);
  const campaignsFiltered = useMemo(
    () => filterCampaigns(campaigns, { situation: carteiraSituation, cycle: carteiraCycle }),
    [campaigns, carteiraSituation, carteiraCycle],
  );
  // Lines que sobreviveram ao recorte de campanha. É o dataset da aba inteira:
  // alimenta os dois agrupamentos, os KPIs e o badge — assim "No ar · 12" e o
  // número no topo nunca contam coisas diferentes.
  const carteiraLines = useMemo(
    () => campaignsFiltered.flatMap(c => c.lines),
    [campaignsFiltered],
  );

  // Fontes de curadoria presentes no dataset. O filtro "Fonte" só aparece
  // quando há mais de uma (ex: Xandr + PubMatic) — senão é ruído.
  const sourcesPresent = useMemo(
    () => Array.from(new Set(lines.map(l => (l.source || "xandr")))).sort(),
    [lines],
  );
  const SOURCE_LABELS = { xandr: "Xandr Curate", pubmatic: "PubMatic" };

  // Conjunto exibido na aba atual — KPIs e contagens refletem isso.
  // Por cliente é uma view LIFETIME (mostra todas as lines do cliente,
  // incluindo encerradas).
  const visibleLines = useMemo(() => {
    if (layout === "live")     return liveFiltered;
    if (layout === "history")  return histLines;
    if (layout === "client")   return carteiraLines;
    return allFiltered;
  }, [layout, liveFiltered, histLines, carteiraLines, allFiltered]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  // Big numbers refletem o dataset visível na aba ativa (com filtros).
  // % entrega = margem ÷ PI.
  const kpis = useMemo(() => {
    let pi = 0, revenue = 0, margin = 0, imps = 0, revenue7d = 0, margin7d = 0;
    let withPi = 0;
    // extraRevenue = Σ (margem_realizada − PI × margem_configurada)
    //   • Base 0 = PI × margem_configurada (ex: 350k × 85% = 297,5k esperado).
    //   • Positivo = ganhamos acima do esperado pro investimento total.
    //   • Negativo = abaixo do esperado (pode ser line ainda mid-flight).
    //   • Em GRUPO: PI é compartilhado, então usa group_curator_margin
    //     (Σ margens das lines do grupo) contra o PI único do grupo —
    //     evita comparar margem somada contra PI multiplicado.
    //   • Só conta unidades-de-conta (grupo ou line standalone) com PI
    //     e margem configurada definidos.
    let extraRevenue = 0;
    let extraLinesCount = 0;
    // Regras de agregação:
    //   • Canceladas saem do total (não somam PI, revenue, margem).
    //   • PI é COMPARTILHADO no grupo — dedup por group_id pra contar 1×.
    //   • Revenue/margem/imps por-line (cada line entrega o seu).
    //   • % entrega = Σ Margem HYPR ÷ Σ Total PI (global, não média de ratios).
    //
    // CUIDADO: nem todo membro do grupo tem `pi_brl` setado (só os com Command
    // vinculado). Marcar o grupo como "visto" no primeiro membro pode esconder
    // o PI se ele estiver num membro seguinte. Solução: só consumir o grupo
    // quando encontrar um membro com PI não-nulo.
    const seenGroups = new Set();
    for (const l of visibleLines) {
      if (effectiveStatus(l) === "Cancelado") continue;
      revenue += Number(l.curator_revenue || 0);
      margin  += Number(l.curator_margin  || 0);
      imps    += Number(l.imps            || 0);
      revenue7d += Number(l.revenue_last_7d || 0);
      margin7d  += Number(l.margin_last_7d  || 0);
      if (l.group_id) {
        if (seenGroups.has(l.group_id)) continue;
        if (l.pi_brl == null) continue;     // espera um membro do grupo com PI
        seenGroups.add(l.group_id);
        pi += Number(l.pi_brl);
        withPi++;
        // Extra do grupo: margem agregada do grupo vs PI × pct configurada.
        // Usa group_curator_margin (já agregado pelo backend) pra evitar
        // somar margem das lines em outros passos.
        if (l.curator_margin_pct != null) {
          const expected = Number(l.pi_brl) * (Number(l.curator_margin_pct) / 100);
          const realized = Number(l.group_curator_margin || 0);
          extraRevenue += (realized - expected);
          extraLinesCount++;
        }
      } else if (l.pi_brl != null) {
        pi += Number(l.pi_brl);
        withPi++;
        if (l.curator_margin_pct != null) {
          const expected = Number(l.pi_brl) * (Number(l.curator_margin_pct) / 100);
          const realized = Number(l.curator_margin || 0);
          extraRevenue += (realized - expected);
          extraLinesCount++;
        }
      }
    }
    return {
      pi, revenue, margin, imps, revenue7d, margin7d,
      countWithPi: withPi,
      pctReceber: pi > 0 ? margin / pi : null,
      pctReceberRev: pi > 0 ? revenue / pi : null,
      extraRevenue,
      extraLinesCount,
    };
  }, [visibleLines]);

  // ── Contagens por layout (mostradas no toggle) ────────────────────────────
  // Refletem os filtros aplicados — cada badge mostra quantas lines apareceriam
  // se você clicasse na aba agora. Histórico vira "lifetime" (tudo).
  const counts = useMemo(() => ({
    live:     liveFiltered.length,
    // Mesmo dataset que a aba renderiza (byCustomer/campaigns agrupam
    // clientLines) — antes contava só clientes com lines ativas e divergia
    // dos accordions. O badge segue a hierarquia ativa da Carteira.
    client:   carteiraGroup === "campaign"
                ? campaignsFiltered.length
                : new Set(carteiraLines.map(l => l.customer || "(sem cliente)")).size,
    list:     allFiltered.length,
    history:  allLinesFiltered.length,
  }), [liveFiltered, carteiraLines, campaignsFiltered, carteiraGroup, allFiltered, allLinesFiltered]);

  const customersAll = useMemo(() => {
    const s = new Set();
    for (const l of lines) if (l.customer) s.add(l.customer);
    return [...s].sort();
  }, [lines]);

  // Anos disponíveis no Histórico (pro seletor de trimestre). Tira a partir
  // de start_date das lines + sempre inclui o ano corrente.
  const historyYears = useMemo(() => {
    const ys = new Set([new Date().getFullYear()]);
    for (const l of lines) {
      const d = l.start_date || l.last_delivery_day;
      if (d && d.length >= 4) ys.add(Number(d.slice(0, 4)));
    }
    return [...ys].sort((a, b) => b - a);
  }, [lines]);

  // Frescor por fonte de curadoria. TRÊS afirmações INDEPENDENTES por fonte:
  //   • o JOB rodou?      → ledger pmp_sync_runs (lastRunAt/status/erro)
  //   • o DADO chegou?    → api_last_day/lag_days do ledger (frescor da fonte)
  //   • houve ENTREGA?    → last_delivery_day das lines
  // Antes só existia a terceira, derivada do `last_synced_at` das linhas de
  // entrega — e como o conector pula dias zerados, deal encerrado congelava o
  // indicador (falso alarme) e sync quebrado ficava idêntico a deal encerrado
  // (alarme que nunca toca). Foi assim que o 401 da PubMatic passou 3 dias
  // despercebido em ago/26. `lastSyncedAt` continua indo como fallback pra
  // quando o backend ainda não tiver o ledger.
  //
  // A segunda entrou em 24/08: o job da PubMatic rodava verde e a base ficava
  // 2 dias atrás (às 04h BRT a fonte não fechou D-1, e dia zerado é
  // descartado). "Rodou" nunca foi o mesmo que "está fresco".
  const SOURCE_NOTES = {
    pubmatic: "Sync às 04h + re-sync 10/14/18/22h — a fonte fecha D-1 ao longo do dia.",
  };
  const recentBySource = useMemo(() => {
    const by = new Map();
    for (const r of syncRunsRecent) {
      const key = r.source || "xandr";
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(r);
    }
    return by;
  }, [syncRunsRecent]);

  const syncSources = useMemo(() => {
    const by = new Map();
    const blank = (key) => ({
      key, lastSyncedAt: null, latestDeliveryDay: null, linesCount: 0,
      expectsDelivery: false,
    });
    // D-1: o dia que a fonte já deveria ter fechado.
    const expectedDay = isoDaysAgo(1);
    for (const l of lines) {
      const key = l.source || "xandr";
      let s = by.get(key);
      if (!s) { s = blank(key); by.set(key, s); }
      s.linesCount += 1;
      if (l.last_synced_at && (!s.lastSyncedAt || l.last_synced_at > s.lastSyncedAt)) s.lastSyncedAt = l.last_synced_at;
      if (l.last_delivery_day && (!s.latestDeliveryDay || l.last_delivery_day > s.latestDeliveryDay)) s.latestDeliveryDay = l.last_delivery_day;
      if (shouldBeDelivering(l, expectedDay)) s.expectsDelivery = true;
    }
    // Fonte que só existe no ledger (ex: sync falhando ANTES de criar qualquer
    // line) também precisa aparecer — senão a fonte quebrada some do painel.
    for (const r of syncRuns) {
      const key = r.source || "xandr";
      if (!by.has(key)) by.set(key, blank(key));
    }
    const runByKey = new Map(syncRuns.map((r) => [r.source || "xandr", r]));
    return Array.from(by.values())
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((s) => {
        const run = runByKey.get(s.key);
        return {
          ...s,
          label: SOURCE_LABELS[s.key] || s.key,
          note: SOURCE_NOTES[s.key],
          lastRunAt:     run?.last_run_at || null,
          lastRunStatus: run?.last_run_status || null,
          lastError:     run?.last_error || null,
          lastOkAt:      run?.last_ok_at || null,
          credential:    run?.credential || null,
          apiLastDay:    run?.api_last_day || null,
          lagDays:       run?.lag_days ?? null,
          // Distingue "o ledger mediu e não há dado" de "este backend nem sabe
          // medir" — o indicador trata os dois casos de forma diferente.
          hasFreshness:  !!run && "api_last_day" in run,
          recentRuns:    recentBySource.get(s.key) || [],
        };
      });
  }, [lines, syncRuns, recentBySource]);

  // ── Auto-recovery do frescor ──────────────────────────────────────────────
  //
  // O problema que isto resolve, em uma frase: o cron das 04h roda ANTES de a
  // PubMatic fechar D-1, e quem abre o hub cedo pega a base um dia atrás —
  // todo santo dia, mesmo com o Cloud Scheduler 100% saudável.
  //
  // Consertar o horário do cron é o certo, mas mora no Cloud Scheduler (fora
  // deste repo) e depende de alguém com acesso ao GCP. Enquanto isso, a página
  // pode se virar: quem abriu /admin/pmp é admin, o endpoint PubMatic-only
  // aceita JWT de admin, e o sync é barato (1 request de report + MERGE
  // idempotente). Então em vez de mostrar "1 dia atrás" e esperar o próximo
  // horário do cron, ela vai buscar.
  //
  // Guardas, porque auto-disparo em page load merece paranoia:
  //   • só quando o atraso é REAL e MEDIDO (lagDays >= 1 vindo do ledger) —
  //     nunca por palpite;
  //   • só pra quem pode sincronizar (mesma régua do botão manual);
  //   • no máximo 1 tentativa por AUTO_RECOVERY_COOLDOWN_MS por navegador,
  //     persistido em localStorage — recarregar a página 10 vezes não vira 10
  //     syncs, e vários admins juntos custam no máximo um sync cada;
  //   • uma vez por montagem (ref), pra um re-render não re-disparar;
  //   • falha é silenciosa: isto é conveniência, e o painel já mostra o atraso
  //     de verdade. Barulhar aqui só empilharia ruído sobre um problema que já
  //     está sinalizado.
  const autoRecoveryTried = useRef(false);

  useEffect(() => {
    if (!canSync || loading || autoRecoveryTried.current) return;
    // Atraso medido pelo próprio sync (api_last_day/lag_days do ledger). Sem
    // medida não há o que recuperar — e agir sobre desconhecimento é como este
    // pipeline ficou velho em silêncio da primeira vez.
    const stale = syncRuns.some(
      (r) => r.source === "pubmatic" && Number(r.lag_days) >= 1,
    );
    if (!stale) return;

    let last = 0;
    try { last = Number(localStorage.getItem(AUTO_RECOVERY_KEY)) || 0; } catch { /* storage bloqueado */ }
    if (Date.now() - last < AUTO_RECOVERY_COOLDOWN_MS) return;

    autoRecoveryTried.current = true;
    try { localStorage.setItem(AUTO_RECOVERY_KEY, String(Date.now())); } catch { /* idem */ }

    // Sem estado de "recuperando" de propósito: setState síncrono dentro de
    // efeito dispara render em cascata (o lint do repo marca como erro), e o
    // feedback que importa é o número mudando quando o reload entra.
    syncPmpPubmatic()
      .then((res) => {
        // Só recarrega se a fonte de fato avançou — senão seria um reload à
        // toa por cima de quem está lendo a tela.
        if (res?.advanced) return reload();
      })
      .catch((e) => console.warn("[pmp auto-recovery]", e?.message || e));
  }, [canSync, loading, syncRuns, reload]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const onSync = async () => {
    setSyncing(true); setSyncResult(null);
    try {
      const r = await syncPmpV2({ interval: "last_7_days" });
      setSyncResult({ ok: true, summary: r });
      await reload();
      setTimeout(() => setSyncResult(null), 7000);
    } catch (e) {
      setSyncResult({ ok: false, error: e.message });
    } finally { setSyncing(false); }
  };

  const onSaveOverrides = async (fields) => {
    // Snapshot da line + grupo ANTES de fechar o drawer.
    const targetLine = editing;
    const groupMemberIds = targetLine.group_id
      ? lines.filter(l => l.group_id === targetLine.group_id).map(l => l.line_id)
      : [targetLine.line_id];
    // Campos que fazem sentido propagar pros membros do grupo (compartilham PI):
    //   • status        — finalizar uma = finalizar todas
    //   • is_archived   — arquivar idem
    //   • client_pi_amount_override — PI é compartilhado
    // Demais (notes, campaign/agency overrides) ficam per-line.
    const groupPropagate = {};
    for (const k of ["status", "is_archived", "client_pi_amount_override"]) {
      if (k in fields) groupPropagate[k] = fields[k];
    }

    // Optimistic UI: fecha drawer já e atualiza localmente antes do server
    // responder. Save roda em background — bloquear o user nos ~3-5s do BQ
    // é o que parecia "trava". Múltiplos saves rodam em paralelo (Set de
    // savingLineIds dá feedback global no header).
    setEditing(null);
    setLines(prev => prev.map(l => {
      if (l.line_id === targetLine.line_id) return { ...l, ...fields };
      if (groupMemberIds.includes(l.line_id) && Object.keys(groupPropagate).length > 0) {
        return { ...l, ...groupPropagate };
      }
      return l;
    }));

    startSaving(targetLine.line_id);
    try {
      const updated = await savePmpLineOverrides({ line_id: targetLine.line_id, ...fields });
      // Sincroniza com o server (sobrescreve valores derivados / timestamps).
      setLines(prev => prev.map(l => l.line_id === updated.line_id ? { ...l, ...updated } : l));
      // Se propagou no grupo, recarrega em background pra refletir o resto
      // (server já fez o UPDATE em massa). Reload NÃO mostra skeleton —
      // grid fica visível, indicador sutil no header.
      if (targetLine.group_id && Object.keys(groupPropagate).length > 0) {
        reload();
      }
    } catch (e) {
      alert("Erro ao salvar: " + e.message);
    } finally {
      finishSaving(targetLine.line_id);
    }
  };

  const onLinkCommand = async (short_token, opts = {}) => {
    // Snapshot do nome ANTES de fechar o popup (setLinking(null) zera linking).
    const lineLabel = linking?.line_name || linking?.campaign_name || `Line ${linking?.line_id}`;
    const updated = await linkPmpCommand({ line_id: linking.line_id, short_token, force: opts.force || false });
    setLines(prev => prev.map(l => l.line_id === updated.line_id ? { ...l, ...updated } : l));
    setLinking(null);
    setLinkToast({ token: short_token, lineLabel });
  };

  const onExport = async () => {
    const XLSX = await import("xlsx");
    // Export segue o dataset visível na aba ativa.
    const arr = visibleLines;
    const rows = arr.map(l => ({
      "Customer": l.customer || "", "Campaign": l.campaign_name || "",
      "Agency": l.agency || "", "Line ID": l.line_id, "Token": l.short_token || "",
      "Status workflow": effectiveStatus(l),
      "Estado entrega": effectiveDeliveryMeta(l).label,
      "Bid": bidTypeLabel(l.bid_type) || "—",
      "Fonte": SOURCE_LABELS[l.source || "xandr"] || l.source || "",
      // Mesmo vocabulário da tela (ver METRIC em pmpFormat.js).
      "PI (R$)": Number(l.pi_brl || 0),
      "Custo (R$)": Number(l.curator_total_cost || 0),
      "Receita Bruta (R$)": Number(l.curator_revenue || 0),
      "Margem HYPR (R$)": Number(l.curator_margin || 0),
      "Margem %": l.effective_margin_pct == null ? "" : Number(l.effective_margin_pct),
      "% Entrega (Margem)": (() => { const p = pctEntrega(l); return p == null ? "" : Number(p); })(),
      "% Entrega (Receita)": (() => { const p = pctEntregaRev(l); return p == null ? "" : Number(p); })(),
      "Impressões": Number(l.imps || 0),
      "eCPM (R$)": l.ecpm == null ? "" : Number(l.ecpm),
      "Início": l.start_date || "", "Fim": l.end_date || "",
      "Dias rest.": l.days_remaining ?? "",
      "Última delivery": l.last_delivery_day || "",
      "CP": l.cp_email || "", "CS": l.cs_email || "",
      "IO": l.io_name || "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    // Aba Compplan primeiro — modelo da planilha HYPR_PMP_Deals_All-Time
    // (1 row por deal, all-time, independente da aba/filtros ativos).
    const compRows = buildCompplanRows(lines);
    const wsComp = XLSX.utils.json_to_sheet(compRows);
    applyCompplanFormats(XLSX, wsComp, compRows.length);
    XLSX.utils.book_append_sheet(wb, wsComp, "Compplan");
    XLSX.utils.book_append_sheet(wb, ws, "PMP Lines");
    XLSX.writeFile(wb, `pmp-lines-${layout}-${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  // ── Lines por view ────────────────────────────────────────────────────────
  // Ordenação default por última delivery (mais recente primeiro pra Live)
  const sortByLastDelivery = (arr) => [...arr].sort((a, b) => {
    const ah = a.hours_since_last_delivery, bh = b.hours_since_last_delivery;
    if (ah == null && bh == null) return 0;
    if (ah == null) return 1;
    if (bh == null) return -1;
    return ah - bh;
  });

  const liveOrdered = useMemo(() => sortByLastDelivery(liveFiltered), [liveFiltered]);
  const allSorted   = useMemo(() => {
    const arr = [...allFiltered];
    // % entrega: ordena pelo MESMO valor que a coluna exibe (helpers do
    // front) — pct_a_receber_rev nem existe na line fora do caminho
    // janelado, e os helpers garantem a mesma fórmula em qualquer overlay.
    if (sortBy === "pct_a_receber" || sortBy === "pct_a_receber_rev") {
      const getter = sortBy === "pct_a_receber" ? pctEntrega : pctEntregaRev;
      arr.sort((a, b) => compareSortValues(getter(a), getter(b), sortDir));
    } else {
      arr.sort((a, b) => comparePmpLines(a, b, sortBy, sortDir));
    }
    return arr;
  }, [allFiltered, sortBy, sortDir]);

  // ── Grouping por cliente (Por Cliente view) ───────────────────────────────
  // Inclui TODAS as lines (live + history + other) — view lifetime do
  // cliente. Encerradas ficam no mesmo accordion porque o user quer
  // contexto completo: "quanto a HYPR já faturou com esse cliente?".
  // Agrega as CAMPANHAS por cliente (em vez de agrupar lines cruas): o cliente
  // herda os mesmos números da visão por campanha — PI contado uma vez por
  // flight, canceladas fora — e passa a responder ao MESMO seletor de
  // ordenação, inclusive "mais recente → mais antiga".
  const byCustomer = useMemo(() => {
    const map = new Map();
    for (const c of campaignsFiltered) {
      const key = c.customer || "(sem cliente)";
      let e = map.get(key);
      if (!e) {
        e = { name: key, lines: [], revenue: 0, margin: 0, pi: 0,
              startDate: null, hoursSinceLastDelivery: null };
        map.set(key, e);
      }
      e.lines.push(...c.lines);
      e.revenue += c.revenue; e.margin += c.margin; e.pi += c.pi;
      // Cliente herda a ativação MAIS RECENTE e a entrega MAIS RECENTE
      // (menor "horas desde") entre suas campanhas.
      if (c.startDate && (!e.startDate || c.startDate > e.startDate)) e.startDate = c.startDate;
      if (c.hoursSinceLastDelivery != null
          && (e.hoursSinceLastDelivery == null || c.hoursSinceLastDelivery < e.hoursSinceLastDelivery)) {
        e.hoursSinceLastDelivery = c.hoursSinceLastDelivery;
      }
    }
    const rows = [...map.values()].map(e => ({ ...e, pctMargin: e.pi > 0 ? e.margin / e.pi : null }));
    return sortCampaigns(rows, campaignSort).map(e => [e.name, e.lines]);
  }, [campaignsFiltered, campaignSort]);

  // ── Chips de filtro por view ──────────────────────────────────────────────
  // Antes: quatro faixas horizontais. Uma com busca + Cliente + Bid + Fonte +
  // Status; uma com período/trimestre/mês (só no Histórico); uma com o
  // SortChip; uma com situação/ciclo (só na Carteira). Mais DOIS links
  // "Limpar" em linhas diferentes, cada um zerando um subconjunto. Agora é
  // uma barra, e o que muda por view é a LISTA de chips.
  const isHistory   = layout === "history";
  const isCarteira  = layout === "client";
  const showList    = layout === "list";

  const filterChips = [];

  filterChips.push({
    id: "customer",
    label: "Cliente",
    value: customer.length === 0
      ? undefined
      : customer.length === 1 ? customer[0] : `${customer[0]} +${customer.length - 1}`,
    panel: () => (
      <FilterPanel
        title={customer.length ? `${customer.length} de ${customersAll.length}` : "Todos os clientes"}
        footer={<FilterPanelClear onClear={() => setCustomer([])} disabled={!customer.length} />}
      >
        {customersAll.map((c) => (
          <FilterOption
            key={c}
            multi
            label={c}
            selected={customer.includes(c)}
            onSelect={() =>
              setCustomer(customer.includes(c) ? customer.filter((x) => x !== c) : [...customer, c])
            }
          />
        ))}
      </FilterPanel>
    ),
  });

  filterChips.push({
    id: "status",
    label: "Status",
    value: status.length === 0
      ? undefined
      : status.length === 1 ? status[0] : `${status.length} status`,
    panel: () => (
      <FilterPanel
        title={status.length ? `${status.length} de ${PMP_STATUSES.length}` : "Todos os status"}
        footer={<FilterPanelClear onClear={() => setStatus([])} disabled={!status.length} />}
      >
        {PMP_STATUSES.map((st) => (
          <FilterOption
            key={st}
            multi
            label={st}
            selected={status.includes(st)}
            onSelect={() =>
              setStatus(status.includes(st) ? status.filter((x) => x !== st) : [...status, st])
            }
          />
        ))}
      </FilterPanel>
    ),
  });

  filterChips.push({
    id: "bid",
    label: "Bid",
    value: bidType === ALL ? undefined : bidTypeLabel(bidType),
    panel: (close) => (
      <FilterPanel title="Tipo de bid">
        <FilterOption
          label="Todos"
          selected={bidType === ALL}
          onSelect={() => { setBidType(ALL); close(); }}
        />
        {["flex", "fixed"].map((b) => (
          <FilterOption
            key={b}
            label={bidTypeLabel(b)}
            selected={bidType === b}
            onSelect={() => { setBidType(b); close(); }}
          />
        ))}
      </FilterPanel>
    ),
  });

  // Fonte só existe como decisão quando há mais de uma curadoria no dataset.
  if (sourcesPresent.length > 1) {
    filterChips.push({
      id: "source",
      label: "Fonte",
      value: sourceFilter === ALL ? undefined : (SOURCE_LABELS[sourceFilter] || sourceFilter),
      panel: (close) => (
        <FilterPanel title="Fonte de curadoria">
          <FilterOption
            label="Todas"
            selected={sourceFilter === ALL}
            onSelect={() => { setSourceFilter(ALL); close(); }}
          />
          {sourcesPresent.map((src) => (
            <FilterOption
              key={src}
              label={SOURCE_LABELS[src] || src}
              selected={sourceFilter === src}
              onSelect={() => { setSourceFilter(src); close(); }}
            />
          ))}
        </FilterPanel>
      ),
    });
  }

  if (isCarteira) {
    filterChips.push({
      id: "axis",
      label: "Agrupar",
      value: CARTEIRA_AXES.find((a) => a.value === carteiraGroup)?.label,
      panel: (close) => (
        <FilterPanel title="Eixo de leitura">
          {CARTEIRA_AXES.map((a) => (
            <FilterOption
              key={a.value}
              label={a.label}
              sub={a.sub}
              selected={carteiraGroup === a.value}
              onSelect={() => { setCarteiraGroup(a.value); close(); }}
            />
          ))}
        </FilterPanel>
      ),
    });
    filterChips.push({
      id: "situation",
      label: "Situação",
      value: carteiraSituation === "all"
        ? undefined
        : CAMPAIGN_SITUATIONS.find((o) => o.value === carteiraSituation)?.label,
      panel: (close) => (
        <FilterPanel title="Está rodando?">
          {CAMPAIGN_SITUATIONS.map((o) => {
            const n = carteiraCounts.situation?.[o.value] ?? 0;
            return (
              <FilterOption
                key={o.value}
                label={o.label}
                sub={o.hint}
                count={n}
                selected={carteiraSituation === o.value}
                onSelect={() => { setCarteiraSituation(o.value); close(); }}
              />
            );
          })}
        </FilterPanel>
      ),
    });
    filterChips.push({
      id: "cycle",
      label: "Ciclo",
      value: carteiraCycle === "all"
        ? undefined
        : CAMPAIGN_CYCLES.find((o) => o.value === carteiraCycle)?.label,
      panel: (close) => (
        <FilterPanel title="Entregou o contratado?">
          {CAMPAIGN_CYCLES.map((o) => {
            const n = carteiraCounts.cycle?.[o.value] ?? 0;
            return (
              <FilterOption
                key={o.value}
                label={o.label}
                sub={o.hint}
                count={n}
                selected={carteiraCycle === o.value}
                onSelect={() => { setCarteiraCycle(o.value); close(); }}
              />
            );
          })}
        </FilterPanel>
      ),
    });
  }

  // Chips ativos. A regra é a mesma do menu: um chip por restrição real, com
  // remoção individual, e um "Limpar tudo" único — antes eram dois links
  // separados que zeravam conjuntos diferentes, e nenhum zerava os dois.
  const activeFilters = [];
  if (search.trim()) {
    activeFilters.push({ id: "search", label: `Busca: ${search.trim()}`, onClear: () => setSearch("") });
  }
  if (customer.length > 0) {
    activeFilters.push({
      id: "customer",
      label: customer.length === 1 ? customer[0] : `${customer.length} clientes`,
      onClear: () => setCustomer([]),
    });
  }
  if (status.length > 0) {
    activeFilters.push({
      id: "status",
      label: status.length === 1 ? status[0] : `${status.length} status`,
      onClear: () => setStatus([]),
    });
  }
  if (bidType !== ALL) {
    activeFilters.push({ id: "bid", label: `Bid: ${bidTypeLabel(bidType)}`, onClear: () => setBidType(ALL) });
  }
  if (sourceFilter !== ALL) {
    activeFilters.push({
      id: "source",
      label: SOURCE_LABELS[sourceFilter] || sourceFilter,
      onClear: () => setSourceFilter(ALL),
    });
  }
  if (isCarteira && carteiraSituation !== "all") {
    activeFilters.push({
      id: "situation",
      label: CAMPAIGN_SITUATIONS.find((o) => o.value === carteiraSituation)?.label || carteiraSituation,
      onClear: () => setCarteiraSituation("all"),
    });
  }
  if (isCarteira && carteiraCycle !== "all") {
    activeFilters.push({
      id: "cycle",
      label: CAMPAIGN_CYCLES.find((o) => o.value === carteiraCycle)?.label || carteiraCycle,
      onClear: () => setCarteiraCycle("all"),
    });
  }
  if (isHistory && (histPeriod.from || histPeriod.to)) {
    activeFilters.push({
      id: "period",
      label: formatRangeCompact(histPeriod.from, histPeriod.to),
      onClear: () => setHistPeriod({ presetId: "all", from: null, to: null }),
    });
  }
  if (isHistory && histQuarters.length > 0) {
    activeFilters.push({
      id: "quarters",
      label: histQuarters.length === 1
        ? `Q${histQuarters[0].q} ${String(histQuarters[0].year).slice(2)}`
        : `${histQuarters.length} trimestres`,
      onClear: () => setHistQuarters([]),
    });
  }
  if (isHistory && histMonths.length > 0) {
    activeFilters.push({
      id: "months",
      label: histMonths.length === 1
        ? `${MONTH_ABBR[histMonths[0].month - 1]}/${String(histMonths[0].year).slice(-2)}`
        : `${histMonths.length} meses`,
      onClear: () => setHistMonths([]),
    });
  }

  const clearAllFilters = () => {
    setSearch(""); setCustomer([]); setBidType(ALL); setStatus([]); setSourceFilter(ALL);
    if (isCarteira) { setCarteiraSituation("all"); setCarteiraCycle("all"); }
    if (isHistory) {
      setHistPeriod({ presetId: "all", from: null, to: null });
      setHistQuarters([]); setHistMonths([]);
    }
  };

  // "10 de 99 lines" — não existia em nenhuma das cinco views.
  const viewTotals = {
    list:      { shown: allFiltered.length,      total: lines.length,   noun: "lines" },
    live:      { shown: liveFiltered.length,     total: counts.live,    noun: "lines no ar" },
    client:    { shown: counts.client,           total: counts.client,  noun: carteiraGroup === "campaign" ? "campanhas" : "clientes" },
    history:   { shown: allLinesFiltered.length, total: lines.length,   noun: "lines" },
    analytics: null,
  }[layout];
  const resultLabel = viewTotals && activeFilters.length > 0
    ? `${viewTotals.shown} de ${viewTotals.total} ${viewTotals.noun}`
    : null;

  const meta = viewMeta(SECTION_PMP, layout);
  // As quatro contagens do PMP só existem aqui — publica pro rail das
  // outras rotas (ver writeNavCountsCache em navConfig).
  useEffect(() => {
    if (!lines.length) return;
    writeNavCountsCache({
      pmpList:    counts.list    || undefined,
      pmpLive:    counts.live    || undefined,
      pmpClient:  counts.client  || undefined,
      pmpHistory: counts.history || undefined,
    });
  }, [lines.length, counts]);

  const navCounts = buildNavCounts({
    pmp: {
      list:    counts.list    || undefined,
      live:    counts.live    || undefined,
      client:  counts.client  || undefined,
      history: counts.history || undefined,
    },
  });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <TooltipProvider delayDuration={200}>
    <AdminShell
      section={SECTION_PMP}
      layout={layout}
      navCounts={navCounts}
      onNavigate={onNavigateView}
      viewLabel={meta?.label}
      tally={
        lines.length
          ? `${partitions.live.length} no ar · ${lines.length} lines`
          : undefined
      }
      busy={loading && lines.length > 0}
      user={user}
      onLogout={onLogout}
      operationSlots={
        <PmpFreshnessIndicator
          variant="rail"
          sources={syncSources}
          onSync={canSync ? onSync : undefined}
          syncing={syncing}
        />
      }
      actions={
        <>
          {savingLineIds.size > 0 && (
            <span
              role="status"
              className="hidden md:inline-flex items-center gap-1.5 text-[11px] text-signature tabular-nums"
              title="Saves em andamento — você pode continuar editando outras lines"
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-signature animate-pulse" />
              Salvando {savingLineIds.size > 1 ? `${savingLineIds.size} alterações` : "alteração"}…
            </span>
          )}
          {canEdit && (
            <Button variant="ghost" size="sm" onClick={() => setShowCompplan(v => !v)}>
              <span className="hidden lg:inline">Compplan Sheet</span>
              <span className="lg:hidden">Compplan</span>
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={onExport} disabled={!allFiltered.length}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
            </svg>
            <span className="hidden sm:inline">Exportar</span>
          </Button>
        </>
      }
    >
      <PageHeader
        eyebrow={`PMP Deals · ${meta?.label || ""}`}
        title={PMP_PAGE_TITLES[layout] || "Deals de Pagamento"}
        meta={
          <>
            <MetaStat value={partitions.live.length} label="no ar" tone={partitions.live.length ? "success" : undefined} />
            <MetaDot />
            <MetaStat value={lines.length} label="lines totais" />
            <MetaDot />
            <span>
              Entregas {sourcesPresent.map(s => SOURCE_LABELS[s] || s).join(" × ")} × Hypr Command
            </span>
          </>
        }
      />

      {/* Planilha Google auto-atualizada do compplan (só editores) */}
      {canEdit && showCompplan && (
        <div className="mb-4">
          <CompplanSheetCard />
        </div>
      )}

      {/* KPIs num board colapsável com memória. Antes, `layout !== "analytics"`
          escondia a faixa por completo naquela aba — um bloco que aparece e
          desaparece conforme a aba impede o usuário de saber onde as coisas
          moram, e não dava escolha a quem QUERIA ver os números ali. Agora
          Analytics tem os KPIs como todas as outras, e quem não quer fecha. */}
      {lines.length > 0 && (
        <KpiBoard
          scope="pmp"
          title={`Faturamento${windowed ? ` · ${formatRangeCompact(metricWindow.from, metricWindow.to)}` : " · acumulado"}`}
          summary={pmpSummaryLine(kpis, partitions.live.length)}
        >
          <PmpKpiStrip
            kpis={kpis}
            livesCount={partitions.live.length}
            totalCount={lines.length}
            showExtra={isHistory || isCarteira}
            windowed={windowed}
            windowLabel={windowed ? formatRangeCompact(metricWindow.from, metricWindow.to) : null}
            windowLoading={windowLoading}
          />
        </KpiBoard>
      )}

      {/* Sync toast */}
      {syncResult && <SyncToast result={syncResult} onDismiss={() => setSyncResult(null)} />}

      <FilterBar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar cliente, campanha, line, token…"
        chips={filterChips}
        trailing={
          <>
            {/* Recortes de data do Histórico. Mantêm o próprio Popover (a
                lógica de presets, range e multi-pick não cabe no contrato
                `panel(close)`) mas herdam a forma via filterChipClass. */}
            {isHistory && (
              <>
                <PeriodFilterPill value={histPeriod} onChange={setHistPeriod} />
                <QuarterFilterPill values={histQuarters} onChange={setHistQuarters} availableYears={historyYears} />
                <MonthFilterPill values={histMonths} onChange={setHistMonths} availableYears={historyYears} />
              </>
            )}
            {showList && (
              <SortChipFilter
                options={LIST_SORT_OPTIONS}
                value={sortBy}
                dir={sortDir}
                onValueChange={setSortBy}
                onDirToggle={() => setSortDir(d => (d === "asc" ? "desc" : "asc"))}
                defaultValue={LIST_DEFAULT_SORT.by}
                defaultDir={LIST_DEFAULT_SORT.dir}
              />
            )}
            {isHistory && (
              <SortChipFilter
                options={HIST_SORT_OPTIONS}
                value={histSortBy}
                dir={histSortDir}
                onValueChange={setHistSortBy}
                onDirToggle={() => setHistSortDir(d => (d === "asc" ? "desc" : "asc"))}
                defaultValue={HIST_DEFAULT_SORT.by}
                defaultDir={HIST_DEFAULT_SORT.dir}
              />
            )}
            {isCarteira && (
              <SortChipFilter
                options={CAMPAIGN_SORT_OPTIONS}
                value={campaignSort}
                dir="desc"
                onValueChange={setCampaignSort}
                onDirToggle={() => {}}
                defaultValue="recent_start"
                defaultDir="desc"
              />
            )}
          </>
        }
        active={activeFilters}
        onClearAll={clearAllFilters}
        resultLabel={resultLabel}
        // O aviso de janela era uma QUARTA faixa solta entre os filtros e a
        // tabela, com `-mt-1` pra compensar o espaçamento. Ele é consequência
        // do filtro de período — então encosta na linha que mostra esse filtro.
        notice={
          isHistory && windowed ? (
            <>
              Custo, Receita e Margem refletem o período
              {windowLoading && " · calculando…"}
              {" · "}
              <span className="text-fg-subtle">PI é valor de contrato e não filtra</span>
            </>
          ) : null
        }
      />

        {/* Views — skeleton só no load inicial; reload em background mantém a grid visível */}
        {(loading && lines.length === 0) ? <LinesSkeleton />
          : error  ? <ErrorState message={error} onRetry={reload} />
          : (
            <>
              {layout === "live"     && <LiveView     lines={liveOrdered}     onLineClick={setEditing} onLinkClick={canEdit ? setLinking : undefined} />}
              {layout === "client"   && (carteiraGroup === "campaign"
                ? <PmpCampaignView campaigns={campaignsFiltered} sortBy={campaignSort}
                                   onLineClick={setEditing} onLinkClick={canEdit ? setLinking : undefined} />
                : <ClientView      groups={byCustomer}
                                   summary={{
                                     campaigns: campaignsFiltered.length,
                                     lines: carteiraLines.length,
                                     live: campaignsFiltered.reduce((s, c) => s + c.liveCount, 0),
                                   }}
                                   onLineClick={setEditing} onLinkClick={canEdit ? setLinking : undefined} />)}
              {layout === "list"     && <ListView     lines={allSorted}       sortBy={sortBy} sortDir={sortDir}
                                                       onColumnClick={(f) => {
                                                         // Ciclo 3-estado: desc → asc → default
                                                         if (f !== sortBy) { setSortBy(f); setSortDir("desc"); }
                                                         else if (sortDir === "desc") setSortDir("asc");
                                                         else { setSortBy(LIST_DEFAULT_SORT.by); setSortDir(LIST_DEFAULT_SORT.dir); }
                                                       }}
                                                       onLineClick={setEditing} onLinkClick={canEdit ? setLinking : undefined} />}
              {layout === "history"  && <HistoryView  lines={histLines}
                                                       sortBy={histSortBy} sortDir={histSortDir}
                                                       onColumnClick={(f) => {
                                                         // Ciclo 3-estado: desc → asc → default
                                                         if (f !== histSortBy) { setHistSortBy(f); setHistSortDir("desc"); }
                                                         else if (histSortDir === "desc") setHistSortDir("asc");
                                                         else { setHistSortBy(HIST_DEFAULT_SORT.by); setHistSortDir(HIST_DEFAULT_SORT.dir); }
                                                       }}
                                                       onLineClick={setEditing} onLinkClick={canEdit ? setLinking : undefined} />}
              {layout === "analytics" && (
                <Suspense fallback={
                  <div className="rounded-2xl border border-border bg-canvas-elevated p-12 flex items-center justify-center">
                    <span className="size-5 rounded-full border-2 border-current border-t-transparent animate-spin text-signature" aria-hidden />
                  </div>
                }>
                  <PmpAnalytics lines={lines} timeseries={timeseries} tsStatus={tsStatus} onRetry={loadTimeseries} />
                </Suspense>
              )}
            </>
          )
        }

      {/* Drawer + popups */}
      <PmpLineDrawer open={!!editing} onOpenChange={o => { if (!o) setEditing(null); }}
                     line={editing} onSave={onSaveOverrides}
                     canEdit={canEdit}
                     onLinkClick={() => { if (!canEdit) return; setLinking(editing); setEditing(null); }}
                     onGroupClick={() => { if (!canEdit) return; setGrouping(editing); setEditing(null); }} />
      <LinkCommandPopup open={!!linking} onOpenChange={o => { if (!o) setLinking(null); }}
                        line={linking} onLink={onLinkCommand} />
      <GroupLinesModal open={!!grouping} onOpenChange={o => { if (!o) setGrouping(null); }}
                       line={grouping} onGroupCreated={() => reload()} />
      <LinkSuccessToast toast={linkToast} onDismiss={() => setLinkToast(null)} />
    </AdminShell>
    </TooltipProvider>
  );
}


// ───── Views ─────────────────────────────────────────────────────────────────
function LiveView({ lines, onLineClick, onLinkClick }) {
  if (lines.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-canvas-elevated px-6 py-16 text-center">
        <div className="text-fg-muted text-sm">Nenhuma line no ar no momento.</div>
        <div className="text-fg-subtle text-xs mt-2">Lines "no ar" são as que tiveram delivery nos últimos 7 dias.</div>
      </div>
    );
  }
  // Particiona em grupos + singles, mantendo a ordem do array externo.
  // Cada grupo vira 1 tile no grid 2-col, mesmo formato visual de um single.
  const byGroup = new Map();
  for (const l of lines) {
    if (l.group_id) {
      if (!byGroup.has(l.group_id)) byGroup.set(l.group_id, []);
      byGroup.get(l.group_id).push(l);
    }
  }
  // Grupos com <2 membros visíveis (órfãos) renderizam como single card.
  const items = [];
  const seenGroups = new Set();
  for (const l of lines) {
    if (l.group_id) {
      const members = byGroup.get(l.group_id);
      if (members.length < 2) {
        items.push({ kind: "single", line: l });
        continue;
      }
      if (seenGroups.has(l.group_id)) continue;
      seenGroups.add(l.group_id);
      items.push({ kind: "group", group_id: l.group_id, members });
    } else {
      items.push({ kind: "single", line: l });
    }
  }
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {items.map((it) =>
        it.kind === "single"
          ? <PmpLiveCard      key={it.line.line_id} line={it.line} onClick={onLineClick} onLinkClick={onLinkClick} />
          : <PmpLiveGroupCard key={it.group_id}     members={it.members} onLineClick={onLineClick} />
      )}
    </div>
  );
}

function ClientView({ groups, onLineClick, onLinkClick, summary }) {
  if (groups.length === 0) {
    return <EmptyFilters />;
  }
  return (
    <div className="space-y-3">
      {/* Mesma linha-resumo da visão por campanha: os chips de recorte contam
          CAMPANHAS, então sem isto o "No ar · 8" ficava sem explicação ao lado
          de um badge de 5 clientes. */}
      {summary && (
        <p className="px-1 text-[11.5px] text-fg-muted tabular-nums">
          <span className="font-semibold text-fg">{groups.length}</span>
          {groups.length === 1 ? " cliente" : " clientes"}
          <span className="mx-1.5 text-fg-subtle">·</span>
          {summary.campaigns} {summary.campaigns === 1 ? "campanha" : "campanhas"}
          <span className="mx-1.5 text-fg-subtle">·</span>
          {summary.lines} {summary.lines === 1 ? "line" : "lines"}
          {summary.live > 0 && (
            <>
              <span className="mx-1.5 text-fg-subtle">·</span>
              <span className="text-success dark:text-success">{summary.live} no ar</span>
            </>
          )}
        </p>
      )}
      {groups.map(([customer, lines], i) => (
        <PmpCustomerAccordion key={customer || i} customer={customer} lines={lines}
                              onLineClick={onLineClick} onLinkClick={onLinkClick}
                              defaultOpen={i < 2} />
      ))}
    </div>
  );
}

function ListView({ lines, sortBy, sortDir, onColumnClick, onLineClick, onLinkClick }) {
  if (lines.length === 0) return <EmptyFilters />;

  // Mesmo padrão do HistoryView: agrupa por group_id INLINE (sem box azul
  // separado). Grupos viram um stretch contínuo de rows com border-left
  // signature + linha de subtotal no fim.
  const byGroup = new Map();
  for (const l of lines) {
    if (l.group_id) {
      if (!byGroup.has(l.group_id)) byGroup.set(l.group_id, []);
      byGroup.get(l.group_id).push(l);
    }
  }
  // Mantém a ordem do array externo. A âncora do grupo é a primeira ocorrência.
  // Grupos com <2 membros visíveis (órfãos) renderizam como singles —
  // sem container tintado nem subtotal, evita "grupo fantasma" no UI.
  const items = [];
  const seenGroups = new Set();
  for (const l of lines) {
    if (l.group_id) {
      const members = byGroup.get(l.group_id);
      if (members.length < 2) {
        items.push({ kind: "single", line: l });
        continue;
      }
      if (seenGroups.has(l.group_id)) continue;
      seenGroups.add(l.group_id);
      items.push({ kind: "group", group_id: l.group_id, members });
    } else {
      items.push({ kind: "single", line: l });
    }
  }

  return (
    <div className="rounded-xl border border-border bg-canvas-elevated overflow-hidden">
      {/* Scroll horizontal em mobile: o grid das rows tem ~1160px e estoura o
          viewport <768px. Mesmo padrão do CampaignListV2 — wrapper externo
          preserva o border-radius, min-w mantém as colunas legíveis e o swipe
          horizontal é UX padrão pra tabelas densas (Linear/Notion/Stripe).
          Inert no desktop (o conteúdo cabe e a barra não aparece). */}
      <div className="overflow-x-auto scrollbar-hidden">
        <div className="md:min-w-[1330px]">
          <PmpLineRowHeader sortBy={sortBy} sortDir={sortDir} onColumnClick={onColumnClick} />
          <div className="divide-y divide-border/60">
        {items.map((it) => {
          if (it.kind === "single") {
            return <PmpLineRow key={it.line.line_id} line={it.line}
                                onClick={onLineClick} onLinkClick={onLinkClick} />;
          }
          const groupPi = resolveGroupPi(it.members);
          // % entrega do grupo = margem agregada ÷ PI compartilhado
          const groupPctReceber = groupPctEntrega(it.members[0], groupPi);
          // % entrega Rev do grupo = revenue agregado ÷ PI compartilhado
          const groupPctReceberRev = groupPctEntregaRev(it.members[0], groupPi);
          return (
            <div key={it.group_id} className="relative bg-signature/[0.03] ring-1 ring-inset ring-signature/15">
              <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-signature/70 pointer-events-none z-[1]" />
              <div className="divide-y divide-signature/10">
                {it.members.map((m, i) => (
                  <PmpLineRow key={m.line_id} line={m}
                              onClick={onLineClick} onLinkClick={onLinkClick}
                              compact
                              groupBadge={i === 0 ? (m.group_name || "Grupo") : null}
                              isFirstGroupMember={i === 0}
                              groupPi={groupPi}
                              groupPctReceber={groupPctReceber}
                              groupPctReceberRev={groupPctReceberRev} />
                ))}
              </div>
              <InlineGroupSubtotal members={it.members} groupPi={groupPi} groupPctReceber={groupPctReceber} groupPctReceberRev={groupPctReceberRev} />
            </div>
          );
        })}
          </div>
        </div>
      </div>
    </div>
  );
}

// Mapa de campo per-line → campo agregado do grupo. Pro sort de grupos
// pegar o valor "real" do grupo (PI compartilhado, revenue/margin/cost
// somados) em vez do membro arbitrário no índice 0.
const GROUP_FIELD_MAP = {
  curator_total_cost:   "group_curator_total_cost",
  curator_revenue:      "group_curator_revenue",
  curator_margin:       "group_curator_margin",
  effective_margin_pct: "group_effective_margin_pct",
};

function itemSortValue(item, field) {
  // % entrega (Mgm e Rev): computa na hora com os MESMOS helpers que a
  // coluna exibe — pct_a_receber_rev nem existe na line fora do caminho
  // janelado, e os helpers garantem a mesma fórmula em qualquer overlay.
  if (field === "pct_a_receber") {
    if (item.kind === "single") return pctEntrega(item.line);
    const groupPi = resolveGroupPi(item.members);
    return groupPctEntrega(item.members[0], groupPi);
  }
  if (field === "pct_a_receber_rev") {
    if (item.kind === "single") return pctEntregaRev(item.line);
    const groupPi = resolveGroupPi(item.members);
    return groupPctEntregaRev(item.members[0], groupPi);
  }
  if (item.kind === "single") return item.line[field];
  const members = item.members;
  if (field === "pi_brl") return resolveGroupPi(members);
  if (field === "hours_since_last_delivery") {
    // Grupo herda o MAIS RECENTE (menor hours) entre os membros.
    let min = Infinity;
    for (const m of members) {
      const raw = m.hours_since_last_delivery;
      if (raw == null || raw === "") continue;
      const v = Number(raw);
      if (Number.isFinite(v) && v < min) min = v;
    }
    return min === Infinity ? null : min;
  }
  if (field === "start_date" || field === "last_delivery_day" || field === "end_date") {
    // Datas no grupo: pega a MAIS RECENTE entre membros (a ativação/entrega
    // mais nova representa o grupo no histórico).
    let max = "";
    for (const m of members) {
      const v = m[field] || "";
      if (v > max) max = v;
    }
    return max || null;
  }
  const aggField = GROUP_FIELD_MAP[field];
  if (aggField && members[0][aggField] != null) return members[0][aggField];
  return members[0][field];
}

function sortItems(items, field, dir) {
  if (!field) return items;
  const out = [...items];
  out.sort((a, b) => compareSortValues(itemSortValue(a, field), itemSortValue(b, field), dir));
  return out;
}

function HistoryView({ lines, sortBy, sortDir, onColumnClick, onLineClick, onLinkClick }) {
  if (lines.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-canvas-elevated px-6 py-16 text-center">
        <div className="text-fg-muted text-sm">Nenhuma line no histórico.</div>
      </div>
    );
  }

  // 1. Particiona em grupos e soltas. Grupos com <2 membros visíveis
  //    (órfãos no DB ou filtrados) viram singles — evita renderizar um
  //    container "fantasma" com 1 line dentro.
  const byGroup = new Map();
  const singles = [];
  for (const l of lines) {
    if (l.group_id) {
      if (!byGroup.has(l.group_id)) byGroup.set(l.group_id, []);
      byGroup.get(l.group_id).push(l);
    } else {
      singles.push(l);
    }
  }
  for (const [gid, members] of byGroup) {
    if (members.length < 2) {
      for (const m of members) singles.push(m);
      byGroup.delete(gid);
    }
  }

  // 2. Cria items pra render. Sort dinâmico pelo header clicado;
  //    default = start_date desc (ativação mais nova no topo).
  const items = [];
  for (const [gid, members] of byGroup) {
    items.push({ kind: "group", group_id: gid, members });
  }
  for (const l of singles) {
    items.push({ kind: "single", line: l });
  }
  const sorted = sortItems(items, sortBy || "start_date", sortDir || "desc");

  return (
    <div className="rounded-xl border border-border bg-canvas-elevated overflow-hidden">
      {/* Scroll horizontal em mobile (vide ListView). O overflow-y do corpo
          fica aninhado dentro do min-w pra preservar o cabeçalho fixo + a
          altura máxima da lista no desktop. */}
      <div className="overflow-x-auto scrollbar-hidden">
        <div className="md:min-w-[1330px]">
          <PmpLineRowHeader sortBy={sortBy} sortDir={sortDir} onColumnClick={onColumnClick} />
          <div className="divide-y divide-border/60 max-h-[calc(100vh-380px)] overflow-y-auto">
        {sorted.map((it) => {
          if (it.kind === "single") {
            return <PmpLineRow key={it.line.line_id} line={it.line} onClick={onLineClick} onLinkClick={onLinkClick} />;
          }
          // GROUP: container tintado + barra signature + lines + subtotal.
          // Tom de fundo levanta o grupo visualmente do resto da lista, igual
          // thread agrupada do Gmail/Linear, sem precisar de header pesado.
          const groupPi = resolveGroupPi(it.members);
          // % entrega do grupo = margem agregada ÷ PI compartilhado
          const groupPctReceber = groupPctEntrega(it.members[0], groupPi);
          // % entrega Rev do grupo = revenue agregado ÷ PI compartilhado
          const groupPctReceberRev = groupPctEntregaRev(it.members[0], groupPi);
          return (
            <div key={it.group_id} className="relative bg-signature/[0.03] ring-1 ring-inset ring-signature/15">
              <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-signature/70 pointer-events-none z-[1]" />
              <div className="divide-y divide-signature/10">
                {it.members.map((m, i) => (
                  <PmpLineRow key={m.line_id} line={m} onClick={onLineClick} onLinkClick={onLinkClick}
                              compact
                              groupBadge={i === 0 ? (m.group_name || "Grupo · 1 PI") : null}
                              isFirstGroupMember={i === 0}
                              groupPi={groupPi}
                              groupPctReceber={groupPctReceber}
                              groupPctReceberRev={groupPctReceberRev} />
                ))}
              </div>
              <InlineGroupSubtotal members={it.members} groupPi={groupPi} groupPctReceber={groupPctReceber} groupPctReceberRev={groupPctReceberRev} />
            </div>
          );
        })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Subtotal inline minimalista (mesmo grid do row, sem cores berrantes) ───
function InlineGroupSubtotal({ members, groupPi, groupPctReceber, groupPctReceberRev }) {
  const first = members[0];
  const grid = "grid grid-cols-[12px_minmax(220px,2.4fr)_minmax(104px,0.36fr)_84px_112px_112px_128px_136px_58px_72px_72px_minmax(88px,0.44fr)] gap-x-3";
  return (
    <div className={cn(grid, "hidden md:grid px-5 py-2.5 items-center border-t border-border/40 bg-surface/40 text-[12px]")}>
      <div />
      <div className="lbl-section text-fg-muted">
        Subtotal do grupo · {members.length} lines
      </div>
      <div /> {/* bid/status */}
      <div /> {/* início */}
      <div className="text-right tabular-nums text-fg font-bold">
        {groupPi != null ? formatBRL(groupPi) : "—"}
      </div>
      <div className="text-right tabular-nums text-fg-subtle font-bold">
        {formatBRL(first.group_curator_total_cost)}
      </div>
      <div className="text-right tabular-nums text-fg font-bold">
        {formatBRL(first.group_curator_revenue)}
      </div>
      <div className="text-right tabular-nums text-fg font-bold">
        {formatBRL(first.group_curator_margin)}
      </div>
      <div className="text-right tabular-nums text-fg font-semibold">
        {formatRatioPct(first.group_effective_margin_pct, 0)}
      </div>
      <div className="text-right tabular-nums text-fg font-bold">
        {groupPctReceber != null ? formatRatioPct(groupPctReceber, 0) : "—"}
      </div>
      <div className="text-right tabular-nums text-fg font-bold">
        {groupPctReceberRev != null ? formatRatioPct(groupPctReceberRev, 0) : "—"}
      </div>
      <div />
    </div>
  );
}

function EmptyFilters() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-canvas-elevated px-6 py-16 text-center">
      <div className="text-fg-muted text-sm">Nenhuma line corresponde aos filtros.</div>
    </div>
  );
}


// ───── UI helpers ───────────────────────────────────────────────────────────
function SearchInput({ value, onChange }) {
  return (
    <div className="flex items-center gap-2 flex-1 min-w-[260px] h-9 px-3 rounded-lg bg-surface border border-border focus-within:border-signature/60 transition-colors">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-fg-subtle shrink-0">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" strokeLinecap="round" />
      </svg>
      <input type="search" value={value} onChange={e => onChange(e.target.value)}
             placeholder="Buscar cliente, campanha, token, owner..."
             className="flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle outline-none" />
    </div>
  );
}

// FilterSelect e FilterMultiSelect viviam aqui. Foram absorvidos pelos chips
// da FilterBar (`Cliente`, `Status`, `Bid`, `Fonte`): mesmo comportamento,
// uma geometria só, e sem o `<select>` que carregava um chevron em
// `stroke='%23999'` cravado em `style` inline — cinza fixo, cego a tema, ao
// lado de controles que respondiam a light/dark. Quando um `<select>` nativo
// for de fato o controle certo, use `src/ui/Select.jsx`.

const HIST_PERIOD_PRESETS = [
  { id: "all",        label: "Tudo" },
  { id: "30d",        label: "Últimos 30 dias" },
  { id: "90d",        label: "Últimos 90 dias" },
  { id: "ytd",        label: "Este ano" },
  { id: "this_month", label: "Este mês" },
  { id: "last_month", label: "Mês passado" },
  { id: "custom",     label: "Personalizado…" },
];

function resolveHistPreset(presetId) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  if (presetId === "all")        return { from: null, to: null };
  if (presetId === "30d")        return { from: iso(addDays(today, -29)), to: iso(today) };
  if (presetId === "90d")        return { from: iso(addDays(today, -89)), to: iso(today) };
  if (presetId === "ytd")        return { from: `${today.getFullYear()}-01-01`, to: iso(today) };
  if (presetId === "this_month") return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today) };
  if (presetId === "last_month") {
    const firstThis = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastPrev  = addDays(firstThis, -1);
    const firstPrev = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 1);
    return { from: iso(firstPrev), to: iso(lastPrev) };
  }
  return { from: null, to: null };
}

function formatRangeCompact(from, to) {
  if (!from || !to) return "—";
  const [yf, mf, df] = from.split("-");
  const [yt, mt, dt] = to.split("-");
  const sameYear = yf === yt;
  return sameYear ? `${df}/${mf} → ${dt}/${mt}` : `${df}/${mf}/${yf.slice(-2)} → ${dt}/${mt}/${yt.slice(-2)}`;
}

// Label humano por campo sortable — usado no chip "Ordenado: X" pra
// indicar de forma clara qual coluna tá ativa.
// Títulos por view. As cinco compartilhavam "Deals de Pagamento" — o H1 não
// dizia o que você estava olhando, e a única pista era o segmentado tintado
// mais abaixo na página.
const PMP_PAGE_TITLES = {
  list:      "Deals de Pagamento",
  live:      "Lines no Ar",
  client:    "Carteira PMP",
  history:   "Histórico de Lines",
  analytics: "Analytics de Faturamento",
};

// Eixo de leitura da Carteira: mesmo dataset, duas hierarquias.
//
// Era um segmentado com rótulo externo ("Agrupar por") numa linha própria,
// acima dos filtros. Virou chip: mostra o eixo ativo (`Agrupar · Cliente`) e
// entra na mesma fileira dos outros recortes da Carteira, que é onde a
// decisão acontece. O segmentado não estava errado como componente — estava
// errado como QUINTA geometria de controle na mesma tela.
const CARTEIRA_AXES = [
  { value: "client",   label: "Cliente",  sub: "clientes, com campanhas e lines dentro" },
  { value: "campaign", label: "Campanha", sub: "campanhas, com flights e lines dentro" },
];

/**
 * Resumo de uma linha do KpiBoard fechado. Quatro números: quantas lines
 * estão vivas, quanto foi contratado, quanto sobrou pra HYPR, e se a entrega
 * está no alvo.
 */
function pmpSummaryLine(kpis, liveCount) {
  if (!kpis) return [];
  const line = [{ label: "No ar", value: liveCount, tone: liveCount ? "success" : undefined }];
  if (kpis.pi != null)     line.push({ label: "PI", value: formatBRLCompact(kpis.pi) });
  if (kpis.margin != null) line.push({ label: "Margem", value: formatBRLCompact(kpis.margin), tone: "success" });
  if (kpis.pctReceber != null) {
    line.push({
      label: "% Entrega",
      value: formatRatioPct(kpis.pctReceber),
      tone: kpis.pctReceber >= 0.85 ? "success" : "warning",
    });
  }
  return line;
}

const SORT_FIELD_LABELS = {
  customer:                  "Cliente",
  pi_brl:                    "PI",
  curator_total_cost:        "Custo",
  curator_revenue:           "Receita Bruta",
  curator_margin:            "Margem",
  effective_margin_pct:      "Margem %",
  pct_a_receber:             "% Entrega (margem)",
  pct_a_receber_rev:         "% Entrega (receita)",
  hours_since_last_delivery: "Entrega",
  start_date:                "Início",
};

// Os campos ordenáveis de cada view, no formato que o SortChipFilter espera.
// Os headers de coluna continuam ordenáveis (ciclo desc → asc → default); o
// chip existe porque em tabelas de 11 colunas com scroll horizontal a coluna
// que você quer ordenar pode estar fora da tela.
const LIST_SORT_FIELDS = [
  "hours_since_last_delivery", "customer", "start_date", "pi_brl",
  "curator_total_cost", "curator_revenue", "curator_margin",
  "pct_a_receber", "pct_a_receber_rev",
];
const HIST_SORT_FIELDS = [
  "start_date", "customer", "pi_brl", "curator_total_cost",
  "curator_revenue", "curator_margin", "effective_margin_pct", "pct_a_receber",
];
const toSortOptions = (fields) =>
  fields.map((f) => ({ value: f, label: SORT_FIELD_LABELS[f] || f }));
const LIST_SORT_OPTIONS = toSortOptions(LIST_SORT_FIELDS);
const HIST_SORT_OPTIONS = toSortOptions(HIST_SORT_FIELDS);
// A Carteira ordena os accordions pela mesma régua das campanhas.
const CAMPAIGN_SORT_OPTIONS = CAMPAIGN_SORTS.map((o) => ({ value: o.value, label: o.label }));

function PeriodFilterPill({ value, onChange }) {
  const [open, setOpen] = useState(false);
  // showCustom decide se o calendário aparece. Independente do value.presetId
  // pra que clicar "Personalizado" mostre o calendar mesmo sem ainda ter um
  // range aplicado (caso contrário ficaria invisível).
  const [showCustom, setShowCustom] = useState(false);
  const [draftRange, setDraftRange] = useState(null);
  const isActive = !!(value.from || value.to);
  const currentLabel = isActive
    ? (value.presetId !== "custom" && value.presetId !== "all"
        ? (HIST_PERIOD_PRESETS.find(p => p.id === value.presetId)?.label || "Período")
        : formatRangeCompact(value.from, value.to))
    : "Período";

  const handleOpenChange = (o) => {
    if (o) {
      setShowCustom(value.presetId === "custom");
      setDraftRange(value.from && value.to
        ? { from: parseYmd(value.from), to: parseYmd(value.to) }
        : null);
    }
    setOpen(o);
  };
  const pickPreset = (presetId) => {
    if (presetId === "custom") {
      setShowCustom(true); // mostra o calendar sem fechar
      return;
    }
    setShowCustom(false);
    const r = resolveHistPreset(presetId);
    onChange({ presetId, ...r });
    setOpen(false);
  };
  const applyCustom = () => {
    if (draftRange?.from && draftRange?.to) {
      onChange({ presetId: "custom", from: ymd(draftRange.from), to: ymd(draftRange.to) });
      setOpen(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        {/* Mantém o próprio Popover — presets + DayPicker de range não cabem
            no contrato `panel(close)` do FilterChip sem reescrever a
            validação de datas — mas herda a FORMA via filterChipClass. */}
        <button type="button" aria-expanded={open} className={filterChipClass({ isSet: isActive })}>
          <span aria-hidden="true" className={cn("shrink-0 grid place-items-center", isActive ? "text-signature" : "text-fg-subtle")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
            </svg>
          </span>
          <span className={isActive ? "font-semibold" : undefined}>Período</span>
          {isActive && <FilterChipValue>{currentLabel}</FilterChipValue>}
          <FilterChipChevron open={open} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={8}
          className="z-50 rounded-xl border border-border bg-surface-2 shadow-2xl overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2">
          <div className="flex">
            <div className="flex flex-col p-2 border-r border-border min-w-[180px]">
              {HIST_PERIOD_PRESETS.map(p => {
                const selected = p.id === "custom"
                  ? (showCustom || value.presetId === "custom")
                  : (value.presetId === p.id && !showCustom);
                return (
                  <button key={p.id} onClick={() => pickPreset(p.id)}
                          className={cn(
                            "text-left px-3 py-1.5 rounded-md text-sm transition-colors",
                            selected
                              ? "bg-signature/15 text-signature font-medium"
                              : "text-fg-muted hover:bg-surface-strong hover:text-fg",
                          )}>
                    {p.label}
                  </button>
                );
              })}
            </div>
            {showCustom && (
              <div className="p-3 rdp-hypr">
                <DayPicker mode="range" locale={ptBR} numberOfMonths={2} pagedNavigation
                           selected={draftRange} onSelect={setDraftRange}
                           disabled={{ after: new Date() }} weekStartsOn={0} />
                <div className="flex justify-end gap-2 pt-2 border-t border-border mt-2">
                  <button onClick={() => setOpen(false)} className="px-3 h-7 rounded-md text-xs text-fg-muted hover:bg-surface-strong">Cancelar</button>
                  <button onClick={applyCustom} disabled={!draftRange?.from || !draftRange?.to}
                          className="px-3 h-7 rounded-md text-xs font-semibold bg-signature-fill text-white hover:bg-signature-fill/90 disabled:bg-surface-strong disabled:text-fg-subtle">
                    Aplicar
                  </button>
                </div>
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Multi-select de trimestres. `values` = array de { year, q }. Permite mix
// não-contíguo (Q1 + Q3) e cross-ano (Q4 2025 + Q1 2026). Cada Q vira um
// toggle no grid; popover não fecha ao selecionar (multi-pick fluido).
function QuarterFilterPill({ values, onChange, availableYears }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => values[0]?.year || availableYears[0] || new Date().getFullYear());
  const isActive = values.length > 0;
  const sameYear = isActive && values.every(v => v.year === values[0].year);
  const label =
    !isActive               ? "Trimestre"
    : values.length === 1   ? `Q${values[0].q} ${values[0].year}`
    : sameYear              ? `${values.length} trim. ${values[0].year}`
                            : `${values.length} trimestres`;

  const isSelected = (year, q) => values.some(v => v.year === year && v.q === q);
  const toggle = (year, q) => {
    if (isSelected(year, q)) {
      onChange(values.filter(v => !(v.year === year && v.q === q)));
    } else {
      onChange([...values, { year, q }]);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-expanded={open} className={filterChipClass({ isSet: isActive })}>
          <span aria-hidden="true" className={cn("shrink-0 grid place-items-center", isActive ? "text-signature" : "text-fg-subtle")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
              <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
            </svg>
          </span>
          <span className={isActive ? "font-semibold" : undefined}>Trimestre</span>
          {isActive && <FilterChipValue>{label}</FilterChipValue>}
          <FilterChipChevron open={open} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={8}
          className="z-50 rounded-xl border border-border bg-surface-2 shadow-2xl p-4 w-[260px] data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2">
          <div className="flex items-center justify-between mb-3">
            <div className="lbl-section">Ano</div>
            <div className="inline-flex items-center gap-1">
              <button onClick={() => setYear(y => y - 1)} className="w-7 h-7 inline-flex items-center justify-center rounded-md text-fg-muted hover:bg-surface-strong">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              {/* Select do DS: o nativo aqui renderizava a seta do sistema
                  operacional — cinza fixo no macOS, triângulo no Windows,
                  nenhum dos dois seguindo o tema. */}
              <Select
                size="xs"
                ariaLabel="Ano"
                value={String(year)}
                onChange={(v) => setYear(Number(v))}
                options={availableYears.map((y) => ({ value: String(y), label: String(y) }))}
              />
              <button onClick={() => setYear(y => y + 1)} className="w-7 h-7 inline-flex items-center justify-center rounded-md text-fg-muted hover:bg-surface-strong">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6"/></svg>
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {[1,2,3,4].map(q => {
              const active = isSelected(year, q);
              const months = ["Jan-Mar","Abr-Jun","Jul-Set","Out-Dez"][q-1];
              return (
                <button key={q} onClick={() => toggle(year, q)}
                        className={cn(
                          "relative flex flex-col items-center gap-0.5 py-3 rounded-lg border transition-colors",
                          active
                            ? "border-signature bg-signature/15 text-signature"
                            : "border-border bg-surface hover:bg-surface-strong text-fg",
                        )}>
                  {active && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                         className="absolute top-1.5 right-1.5 text-signature">
                      <path d="M20 6 9 17l-5-5"/>
                    </svg>
                  )}
                  <span className="text-base font-bold">Q{q}</span>
                  <span className="text-[10px] text-fg-subtle">{months}</span>
                </button>
              );
            })}
          </div>
          {/* Resumo de seleção fora do ano corrente — ajuda o user a lembrar
              que tem trimestres de outros anos selecionados (não vê no grid). */}
          {isActive && values.some(v => v.year !== year) && (
            <div className="mb-3 px-2.5 py-1.5 rounded-md bg-surface text-[11px] text-fg-muted flex items-center justify-between gap-2">
              <span className="truncate">
                Outros anos: {values.filter(v => v.year !== year).map(v => `Q${v.q} ${v.year}`).join(", ")}
              </span>
            </div>
          )}
          {isActive && (
            <button onClick={() => { onChange([]); setOpen(false); }}
                    className="w-full h-8 rounded-md text-xs text-fg-muted hover:bg-surface-strong">
              Limpar trimestres
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const MONTH_ABBR = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

function MonthFilterPill({ values, onChange, availableYears }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => values[0]?.year || availableYears[0] || new Date().getFullYear());
  const isActive = values.length > 0;
  const sameYear = isActive && values.every(v => v.year === values[0].year);
  const fmtMonth = ({ year, month }) => `${MONTH_ABBR[month-1]}/${String(year).slice(-2)}`;
  const label =
    !isActive             ? "Mês"
    : values.length === 1 ? fmtMonth(values[0])
    : sameYear            ? `${values.length} meses ${String(values[0].year).slice(-2)}`
                          : `${values.length} meses`;

  const isSelected = (year, month) => values.some(v => v.year === year && v.month === month);
  const toggle = (year, month) => {
    if (isSelected(year, month)) {
      onChange(values.filter(v => !(v.year === year && v.month === month)));
    } else {
      onChange([...values, { year, month }]);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-expanded={open} className={filterChipClass({ isSet: isActive })}>
          <span aria-hidden="true" className={cn("shrink-0 grid place-items-center", isActive ? "text-signature" : "text-fg-subtle")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2"/>
              <path d="M16 2v4M8 2v4M3 10h18"/>
            </svg>
          </span>
          <span className={isActive ? "font-semibold" : undefined}>Mês</span>
          {isActive && <FilterChipValue>{label}</FilterChipValue>}
          <FilterChipChevron open={open} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={8}
          className="z-50 rounded-xl border border-border bg-surface-2 shadow-2xl p-4 w-[300px] data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2">
          <div className="flex items-center justify-between mb-3">
            <div className="lbl-section">Ano</div>
            <div className="inline-flex items-center gap-1">
              <button onClick={() => setYear(y => y - 1)} className="w-7 h-7 inline-flex items-center justify-center rounded-md text-fg-muted hover:bg-surface-strong">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              {/* Select do DS: o nativo aqui renderizava a seta do sistema
                  operacional — cinza fixo no macOS, triângulo no Windows,
                  nenhum dos dois seguindo o tema. */}
              <Select
                size="xs"
                ariaLabel="Ano"
                value={String(year)}
                onChange={(v) => setYear(Number(v))}
                options={availableYears.map((y) => ({ value: String(y), label: String(y) }))}
              />
              <button onClick={() => setYear(y => y + 1)} className="w-7 h-7 inline-flex items-center justify-center rounded-md text-fg-muted hover:bg-surface-strong">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6"/></svg>
              </button>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1.5 mb-3">
            {MONTH_ABBR.map((label, idx) => {
              const month = idx + 1;
              const active = isSelected(year, month);
              return (
                <button key={month} onClick={() => toggle(year, month)}
                        className={cn(
                          "py-2 rounded-md border text-[12px] font-medium transition-colors",
                          active
                            ? "border-signature bg-signature/15 text-signature"
                            : "border-border bg-surface hover:bg-surface-strong text-fg",
                        )}>
                  {label}
                </button>
              );
            })}
          </div>
          {isActive && values.some(v => v.year !== year) && (
            <div className="mb-3 px-2.5 py-1.5 rounded-md bg-surface text-[11px] text-fg-muted">
              <span className="truncate">
                Outros anos: {values.filter(v => v.year !== year).map(fmtMonth).join(", ")}
              </span>
            </div>
          )}
          {isActive && (
            <button onClick={() => { onChange([]); setOpen(false); }}
                    className="w-full h-8 rounded-md text-xs text-fg-muted hover:bg-surface-strong">
              Limpar meses
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}


// ───── Drawer / Popup / Toast ───────────────────────────────────────────────
// Formata o array de deal_ids vindo do BQ (pode chegar como array, string
// "[1,2,3]" ou null). Vira "1234567 · 7654321" pra exibir no drawer.
function formatDealIds(line) {
  let ids = line.deal_ids;
  if (typeof ids === "string") {
    try { ids = JSON.parse(ids); } catch { ids = ids.split(/[,\s]+/).filter(Boolean); }
  }
  if (!Array.isArray(ids) || ids.length === 0) return "—";
  return ids.join(" · ");
}

function PmpLineDrawer({ open, onOpenChange, line, onSave, onLinkClick, onGroupClick, canEdit = false }) {
  const [form, setForm] = useState({});
  // Timeseries diária da line (impressões + margem). null = ainda carregando,
  // [] = sem dado. Refetch a cada line nova; cancelado se trocar antes da
  // resposta. O endpoint `pmp_line_get` já agrupa por dia no backend.
  const [daily, setDaily] = useState(null);

  useEffect(() => {
    if (line) {
      setForm({
        status: line.status || "Pendente",
        notes:  line.notes  || "",
        client_pi_amount_override: line.client_pi_amount_override ?? "",
        campaign_name_override:    line.campaign_name_override || "",
        agency_override:           line.agency_override || "",
      });
    }
  }, [line]);

  useEffect(() => {
    if (!line?.line_id) { setDaily(null); return; }
    let cancelled = false;
    setDaily(null);
    getPmpLine(line.line_id)
      .then(d => { if (!cancelled) setDaily(Array.isArray(d?.daily) ? d.daily : []); })
      .catch(() => { if (!cancelled) setDaily([]); });
    return () => { cancelled = true; };
  }, [line?.line_id]);

  if (!line) return null;
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  // Fire-and-forget: o pai (onSaveOverrides) fecha o drawer otimisticamente e
  // toca o save em background. Sem `saving` local — evita vazamento entre
  // lines (drawer não desmonta, só renderiza null) que travava o botão como
  // "Salvando..." disabled na próxima edição.
  const handleSave = () => {
    const p = { ...form };
    for (const k of Object.keys(p)) if (p[k] === "") p[k] = null;
    if (p.client_pi_amount_override != null) p.client_pi_amount_override = Number(p.client_pi_amount_override);
    onSave(p);
  };
  const dm = effectiveDeliveryMeta(line);

  // Classes de input em modo read-only: tira contraste (opacity 70) e
  // remove hover/focus ring pra sinalizar visualmente que não dá pra editar.
  // `disabled` no input já bloqueia interação; o styling só comunica isso.
  const inputCls = (extra = "") => cn(
    "w-full h-9 px-3 rounded-md bg-surface border border-border text-sm text-fg",
    !canEdit && "opacity-70 cursor-not-allowed",
    extra,
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent widthClass="sm:w-[520px]">
        <DrawerHeader title={line.line_name || line.campaign_name || "Line"}
                      titleClassName="text-base font-mono break-all leading-snug"
                      subtitle={`${line.customer || "?"} · Line ${line.line_id} · ${dm.label}`} />
        <DrawerBody>
          <div className="space-y-5">
            {/* Pill "Somente leitura" pra não-editores — explica por que os
                campos abaixo estão disabled. Posicionada no topo do body
                pra ser vista antes do operador tentar editar e frustrar. */}
            {!canEdit && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface/40 text-[11px] text-fg-muted">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect width="18" height="11" x="3" y="11" rx="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                <span>Modo somente leitura — apenas operadores PMP editam status, PI, command e overrides.</span>
              </div>
            )}

            {/* Gráfico de entrega — destaque visual do drawer. Tem toggle
                Imps/Margem e tooltip on-hover com os dois valores do dia. */}
            <DeliveryChart daily={daily} />

            {/* Status — sempre visível, é a edição mais frequente */}
            <FieldGroup label="Status workflow">
              <select value={form.status} onChange={e => set("status", e.target.value)}
                      disabled={!canEdit}
                      className={inputCls()}>
                {PMP_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {form.status === "Pendente" && effectiveStatus(line) !== "Pendente" && (
                <div className="mt-1.5 text-[11px] text-fg-subtle">
                  Automático: <span className="text-fg font-medium">{effectiveStatus(line)}</span>
                  {canEdit && (
                    <span className="ml-1">(baseado na última entrega — selecione outro pra fixar manual)</span>
                  )}
                </div>
              )}
            </FieldGroup>

            {/* Grupo (PI compartilhado) — sempre visível, ação contextual */}
            <GroupBlock line={line} onGroupClick={onGroupClick} canEdit={canEdit} />

            {/* Detalhes da line — colapsado por padrão. Informação de
                referência (IO, deal IDs, bid type, datas) que o operador
                consulta ocasionalmente mas não precisa ver toda vez. */}
            <Accordion label="Detalhes da line"
                       summary={detailsSummary(line)}>
              <div className="space-y-3 pt-1">
                <MetaRow k="IO" v={line.io_name} />
                <MetaRow k="Deal IDs" v={formatDealIds(line)} mono />
                <MetaRow k="Command" v={line.short_token || "—"} mono />
                <MetaRow k="CP / CS" v={line.cp_email && line.cs_email
                  ? `${line.cp_email} / ${line.cs_email}` : "—"} />
                {!line.short_token && canEdit && (
                  <button onClick={onLinkClick}
                          className="mt-1 w-full h-8 rounded-md border border-signature/40 bg-signature/10 text-signature text-xs hover:bg-signature/20 transition-colors">
                    🔗 Vincular ao Hypr Command
                  </button>
                )}
                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 pt-2 border-t border-border">
                  <MetaRow k="Bid type" v={bidTypeLabel(line.bid_type) || "—"} compact />
                  <MetaRow k="Revenue type" v={line.revenue_type || "—"} compact />
                  {/* Pricing strategy crua do Xandr Curate — visível quando o
                      sync já tiver puxado (versão pós-deploy backend). */}
                  {line.pricing_strategy && (
                    <MetaRow k="Pricing strategy" v={line.pricing_strategy} compact />
                  )}
                  {/* Preço configurado no Xandr (campo "Price" da UI). Setado
                      quando Pricing Strategy = Fixed Price / Market Price. */}
                  {line.revenue_value != null && (
                    <MetaRow k="Preço" v={formatBRL(line.revenue_value)} compact />
                  )}
                  <MetaRow k="Margem curator"
                           v={line.curator_margin_pct != null ? `${line.curator_margin_pct}%` : "—"}
                           compact />
                  <MetaRow k="Floor / Teto"
                           v={(line.min_revenue_value != null || line.max_revenue_value != null)
                                ? `${line.min_revenue_value != null ? formatBRL(line.min_revenue_value) : "—"} / ${line.max_revenue_value != null ? formatBRL(line.max_revenue_value) : "—"}`
                                : "—"}
                           compact />
                  <MetaRow k="Início" v={formatYmdShort(line.start_date) || "—"} compact />
                  <MetaRow k="Fim" v={formatYmdShort(line.end_date) || "—"} compact />
                  <MetaRow k="Última entrega" v={formatYmdShort(line.last_delivery_day) || "—"} compact />
                </div>
              </div>
            </Accordion>

            {/* Overrides avançados — colapsados. PI/Campaign/Agência são
                exceções; default é deixar o Command mandar. */}
            <Accordion label="Overrides avançados"
                       summary={overrideSummary(line, form)}>
              <div className="space-y-3 pt-1">
                <FieldGroup label={`PI Override (BRL)${line.pi_brl != null && !line.pi_overridden ? ` — Command tem ${formatBRL(line.pi_brl)}` : ""}`}>
                  <CurrencyInput value={form.client_pi_amount_override}
                                 onChange={v => set("client_pi_amount_override", v)}
                                 disabled={!canEdit}
                                 placeholder={line.pi_brl != null ? "deixe vazio pra usar o do Command" : "0,00"}
                                 className={inputCls("tabular-nums")} />
                </FieldGroup>
                <FieldGroup label="Campaign override">
                  <input type="text" value={form.campaign_name_override}
                         onChange={e => set("campaign_name_override", e.target.value)}
                         disabled={!canEdit}
                         placeholder={line.campaign_name || ""}
                         className={inputCls()} />
                </FieldGroup>
                <FieldGroup label="Agência override">
                  <input type="text" value={form.agency_override}
                         onChange={e => set("agency_override", e.target.value)}
                         disabled={!canEdit}
                         placeholder={line.agency || ""}
                         className={inputCls()} />
                </FieldGroup>
              </div>
            </Accordion>

            <FieldGroup label="Notas">
              <textarea value={form.notes} onChange={e => set("notes", e.target.value)} rows={3}
                        disabled={!canEdit}
                        placeholder={canEdit ? "Anote contexto, alinhamentos, próximos passos…" : ""}
                        className={cn(
                          "w-full px-3 py-2 rounded-md bg-surface border border-border text-sm text-fg resize-none",
                          !canEdit && "opacity-70 cursor-not-allowed",
                        )} />
            </FieldGroup>
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>
            {canEdit ? "Cancelar" : "Fechar"}
          </Button>
          {canEdit && (
            <Button variant="primary" size="md" onClick={handleSave}>Salvar</Button>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

// ─── Componentes auxiliares do drawer ────────────────────────────────────────
// Linha key/value padrão. `compact` reduz pra layout de 2 colunas (label em
// cima, valor embaixo) — bom pra grids densos. `mono` aplica fonte mono pro
// valor (IDs, tokens).
function MetaRow({ k, v, mono, compact }) {
  if (compact) {
    return (
      <div className="min-w-0">
        <div className="lbl-section">{k}</div>
        <div className={cn("text-[12px] text-fg truncate tabular-nums", mono && "font-mono")}
             title={String(v ?? "")}>{v || "—"}</div>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3 text-[11px]">
      <span className="lbl-section shrink-0">{k}</span>
      <span className={cn("text-fg text-right max-w-[300px]",
                          mono ? "font-mono break-all" : "truncate")}
            title={String(v ?? "")}>{v || "—"}</span>
    </div>
  );
}

// Formata "2026-05-20" → "20/05" pra usar nos campos de data do drawer.
// Retorna null se input não bate. Não inclui ano pra economizar espaço — em
// PMP a referência temporal típica é o mês corrente.
function formatYmdShort(ymdStr) {
  if (!ymdStr || typeof ymdStr !== "string" || ymdStr.length < 10) return null;
  const [, m, d] = ymdStr.split("-");
  if (!m || !d) return null;
  return `${d}/${m}`;
}

// ─── Gráfico de entrega (7 dias) ────────────────────────────────────────────
// Chart grande, único, full-width do drawer. Toggle entre Impressões e
// Margem; sempre mostra ambos no tooltip on-hover (a métrica selecionada
// dita só a forma das barras + o KPI grande do topo). Bar chart porque
// "entrega diária" é variável discreta (1 valor por dia) — linhas dariam
// falsa impressão de continuidade.
const METRICS = {
  imps:   { key: "imps",           label: "Impressões",  color: "var(--color-signature)", fmt: formatIntCompact, fmtFull: formatInt },
  margin: { key: "curator_margin", label: "Margem HYPR", color: "rgb(52, 211, 153)",      fmt: formatBRLCompact, fmtFull: formatBRL },
};

function DeliveryChart({ daily }) {
  const [metric, setMetric] = useState("imps");
  const [hoverIdx, setHoverIdx] = useState(null);
  const loading = daily == null;
  const series = daily || [];

  // Últimos 7 dias com padding zero à esquerda quando a line é nova. Mantém
  // 7 colunas sempre — assim o leitor compara o "shape" entre lines.
  const last7raw = series.slice(-7);
  const lastDayStr = last7raw[last7raw.length - 1]?.day;
  const today = lastDayStr ? parseYmd(lastDayStr) : new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const t = new Date(today);
    t.setDate(t.getDate() - i);
    const d = ymd(t);
    const found = last7raw.find(x => x.day === d);
    days.push({
      day: d,
      imps:           found ? Number(found.imps) || 0           : 0,
      curator_margin: found ? Number(found.curator_margin) || 0 : 0,
      missing: !found,
    });
  }

  // Delta vs 7 dias anteriores (só calculado se temos histórico ≥14 dias —
  // senão mostraria "+∞%" pra qualquer line nova e seria ruído).
  const prev7 = series.length >= 14 ? series.slice(-14, -7) : [];
  const cur7Sum  = days.reduce((s, d) => s + d[METRICS[metric].key], 0);
  const prev7Sum = prev7.reduce((s, d) => s + (Number(d[METRICS[metric].key]) || 0), 0);
  const delta = prev7Sum > 0 ? ((cur7Sum - prev7Sum) / prev7Sum) * 100 : null;

  const meta   = METRICS[metric];
  const values = days.map(d => d[meta.key]);
  const max    = Math.max(...values, 1);

  return (
    <section className="rounded-xl border border-border bg-surface/40">
      {/* Header — KPI grande à esquerda, toggle à direita */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
        <div className="min-w-0">
          <div className="lbl-section">
            {meta.label} · 7 dias
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <div className="text-[22px] leading-none font-semibold text-fg tabular-nums">
              {loading
                ? <span className="inline-block h-[20px] w-20 rounded bg-surface-2 animate-pulse" />
                : meta.fmt(cur7Sum)}
            </div>
            {!loading && delta != null && Number.isFinite(delta) && <DeltaPill pct={delta} />}
          </div>
        </div>
        <MetricToggle value={metric} onChange={setMetric} />
      </div>

      {/* Chart area. SVG escala via viewBox; hover via overlay de hit-zones
          que cobrem 1/7 da largura cada — assim mira não precisa ser exata
          na barra. Tooltip flutua acima da barra com translateX pra ficar
          ancorado nos extremos sem overflow. */}
      <div className="relative h-[140px] mx-4 mb-2"
           onMouseLeave={() => setHoverIdx(null)}>
        {loading ? (
          <div className="absolute inset-0 rounded-md bg-surface-2/40 animate-pulse" />
        ) : (
          <>
            <svg viewBox="0 0 700 140" preserveAspectRatio="none"
                 className="absolute inset-0 w-full h-full" aria-hidden>
              {/* Gridlines horizontais sutis — 4 linhas (0, 33%, 66%, 100%) */}
              {[0, 0.33, 0.66, 1].map((p, i) => (
                <line key={i} x1="0" x2="700"
                      y1={(140 - 14) - (140 - 14) * p + 7}
                      y2={(140 - 14) - (140 - 14) * p + 7}
                      stroke="currentColor" className="text-border" strokeWidth="1"
                      strokeDasharray={p === 0 ? "0" : "2 3"} opacity={p === 0 ? 0.6 : 0.35} />
              ))}
              {/* Barras — uma por dia. Width = 1/7 da área menos gap.
                  Cor sólida na barra hovered, transparente nas outras. */}
              {days.map((d, i) => {
                const slot = 700 / 7;
                const bw   = slot * 0.62;
                const bx   = i * slot + (slot - bw) / 2;
                const v    = d[meta.key];
                const usableH = 140 - 14; // gap top/bottom pra labels
                const bh   = max > 0 ? (v / max) * usableH : 0;
                const by   = 140 - 7 - bh;
                const isHover = hoverIdx === i;
                const isEmpty = v === 0;
                return (
                  <g key={i}>
                    {/* Trilha cinza da altura total — ajuda a "ler" 0 mesmo
                        quando a barra é minúscula. Sutil. */}
                    <rect x={bx} y={7} width={bw} height={usableH} rx="2"
                          fill="currentColor" className="text-border" opacity="0.18" />
                    <rect x={bx} y={by} width={bw} height={Math.max(bh, isEmpty ? 0 : 2)} rx="2"
                          fill={meta.color}
                          opacity={isHover ? 1 : (hoverIdx == null ? 0.85 : 0.45)}
                          style={{ transition: "opacity 120ms" }} />
                  </g>
                );
              })}
            </svg>
            {/* Hit zones — 7 divs cobrindo a largura. Captura hover por
                coluna. Mantém pointer-cursor pra sinalizar interatividade. */}
            <div className="absolute inset-0 flex">
              {days.map((_, i) => (
                <div key={i} className="flex-1 cursor-default"
                     onMouseEnter={() => setHoverIdx(i)} />
              ))}
            </div>
            {/* Tooltip — mostra dia + AMBAS as métricas. Posicionamento:
                topo da barra hovered, mas com piso de 8px do topo do chart
                pra nunca sair (quando a barra é a mais alta, o tooltip
                sobrepõe levemente o topo dela em vez de escapar do card).
                translateX nas pontas pra não overflow lateral. */}
            {hoverIdx != null && days[hoverIdx] && (() => {
              const d = days[hoverIdx];
              const xPct = ((hoverIdx + 0.5) / 7) * 100;
              const anchor = hoverIdx <= 1 ? "translateX(0)"
                          : hoverIdx >= 5  ? "translateX(-100%)"
                          :                  "translateX(-50%)";
              // bottom-pct: distância da base da barra ao topo da área do
              // chart, em % da altura visível. Garante mínimo 60% pra que o
              // tooltip nunca cole na barra ou desça muito.
              const v = d[meta.key];
              const usableH = 140 - 14;
              const bh = max > 0 ? (v / max) * usableH : 0;
              const barTopPx = 140 - 7 - bh; // y do topo da barra
              // Tooltip ancora 4px ACIMA do topo da barra; mas se isso passar
              // do topo do chart, usa 4px do topo. Sem translateY — fica
              // dentro do container sempre.
              const tooltipTop = Math.max(4, barTopPx - 68);
              return (
                <div className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md bg-fg text-canvas-elevated px-3 py-2 text-[12px] shadow-lg ring-1 ring-black/10"
                     style={{ left: `${xPct}%`, top: `${tooltipTop}px`, transform: anchor }}>
                  <div className="font-mono text-[11px] opacity-60 mb-1">
                    {formatYmdWeekday(d.day)}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: METRICS.imps.color }} />
                    <span>{formatInt(d.imps)} imp.</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: METRICS.margin.color }} />
                    <span>{formatBRL(d.curator_margin)}</span>
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>

      {/* Eixo X — dd/mm em todos. Hoje/ontem ganham label relativo quando
          corresponderem à data real (importante: a sync tem política D-1
          então o dia mais recente do gráfico é, em geral, ontem — rotular
          de "hoje" às cegas mente sobre a referência temporal). */}
      <div className="flex px-4 pb-3 text-[10px] text-fg-subtle font-mono tabular-nums">
        {(() => {
          const todayStr = ymd(new Date());
          const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStr = ymd(yesterday);
          return days.map((d, i) => {
            const label = d.day === todayStr     ? "hoje"
                       : d.day === yesterdayStr  ? "ontem"
                       :                           formatYmdShort(d.day);
            return (
              <div key={i} className="flex-1 text-center">
                <div className={cn("leading-none", hoverIdx === i && "text-fg")}>
                  {label}
                </div>
              </div>
            );
          });
        })()}
      </div>
    </section>
  );
}

function MetricToggle({ value, onChange }) {
  return (
    <div className="inline-flex shrink-0 items-center rounded-md border border-border bg-surface p-0.5"
         role="tablist">
      {Object.entries(METRICS).map(([k, m]) => {
        const active = value === k;
        return (
          <button key={k} role="tab" aria-selected={active}
                  onClick={() => onChange(k)}
                  className={cn(
                    "lbl-section px-2 h-6 rounded transition-colors",
                    active
                      ? "bg-surface-2 text-fg shadow-sm"
                      : "text-fg-subtle hover:text-fg",
                  )}>
            {k === "imps" ? "Imps" : "Margem"}
          </button>
        );
      })}
    </div>
  );
}

function DeltaPill({ pct }) {
  // Pílula compacta de variação. <1% mostra "flat" pra evitar ruído de
  // centésimos quando o número é praticamente igual ao anterior.
  const rounded = Math.round(pct);
  const isFlat  = Math.abs(pct) < 1;
  const isUp    = !isFlat && rounded > 0;
  const isDown  = !isFlat && rounded < 0;
  const cls = isUp   ? "bg-success/10 text-success"
            : isDown ? "bg-danger/10 text-danger"
            :          "bg-surface-2 text-fg-subtle";
  const arrow = isUp ? "↑" : isDown ? "↓" : "≈";
  const text = isFlat ? "flat" : `${Math.abs(rounded)}%`;
  return (
    <span className={cn("inline-flex items-center gap-0.5 px-1.5 h-4 rounded text-[10px] font-semibold tabular-nums",
                        cls)}
          title={`Variação vs 7d anteriores: ${fmt(pct, 1)}%`}>
      <span aria-hidden>{arrow}</span>{text}
    </span>
  );
}

// ─── Accordion (drawer) ──────────────────────────────────────────────────────
// Seção colapsável usando <details>/<summary> nativos — dá animação,
// keyboard support, aria-expanded grátis e zero JS de estado. Custo:
// styling do summary precisa esconder o disclosure triangle padrão.
function Accordion({ label, summary, defaultOpen = false, children }) {
  return (
    <details className="group rounded-lg border border-border bg-surface/40 [&[open]>summary>.chev]:rotate-180"
             open={defaultOpen}>
      <summary className="flex items-center justify-between gap-3 cursor-pointer select-none list-none px-4 py-2.5 hover:bg-surface/60 transition-colors [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <div className="lbl-section">{label}</div>
          {summary && (
            <div className="text-[11px] text-fg-muted mt-0.5 truncate" title={summary}>{summary}</div>
          )}
        </div>
        <svg className="chev shrink-0 transition-transform text-fg-subtle"
             width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </summary>
      <div className="px-4 pb-3">{children}</div>
    </details>
  );
}

// ─── Grupo block ─────────────────────────────────────────────────────────────
// Card destacado em signature pra chamar atenção quando a line é parte de
// grupo (PI compartilhado). Quando não é grupo, mostra CTA pra agrupar de
// forma mais discreta — não polui o drawer das lines individuais.
function GroupBlock({ line, onGroupClick, canEdit = true }) {
  if (line.group_id) {
    return (
      <div className="rounded-lg border border-signature/30 bg-signature/[0.05] px-4 py-3">
        <div className="flex items-center justify-between mb-1.5">
          <div className="lbl-section text-signature">
            Grupo · PI compartilhado
          </div>
          <span className="font-mono text-[10px] text-signature">{line.group_id}</span>
        </div>
        <div className="text-sm text-fg">{line.group_name || "—"}</div>
        <div className="text-[11px] text-fg-muted mt-1 tabular-nums">
          {line.group_member_count} lines · {formatRatioPct(line.group_pct_a_receber)} entrega ·
          Margem {formatBRL(line.group_curator_margin)}
        </div>
        {canEdit && (
          <button onClick={onGroupClick}
                  className="mt-2.5 inline-flex h-7 items-center gap-1.5 px-2.5 rounded-md border border-signature/40 bg-signature/10 text-signature text-[11px] hover:bg-signature/20 transition-colors">
            ⚙️ Editar grupo
          </button>
        )}
      </div>
    );
  }
  // Sem grupo + sem permissão = nada a mostrar (esconde o CTA discreto).
  if (!canEdit) return null;
  return (
    <button onClick={onGroupClick}
            className="w-full flex items-center justify-between gap-2 px-3.5 py-2 rounded-lg border border-dashed border-border text-[11px] text-fg-muted hover:bg-surface/60 hover:border-signature/40 hover:text-fg transition-colors">
      <span className="flex items-center gap-2">
        <span className="text-fg-subtle">🔗</span>
        Agrupar com outras lines do mesmo PI
      </span>
      <span className="text-fg-subtle">›</span>
    </button>
  );
}

// "dom 14/05" — dia da semana + dd/mm. Pro tooltip do gráfico.
const WEEKDAYS_PT = ["dom","seg","ter","qua","qui","sex","sáb"];
function formatYmdWeekday(ymdStr) {
  const d = parseYmd(ymdStr);
  if (!d) return ymdStr;
  return `${WEEKDAYS_PT[d.getDay()]} ${formatYmdShort(ymdStr)}`;
}

// Summary 1-linha pro accordion de detalhes. Mostra IO e tipo, suficiente
// pra reconhecer a line sem expandir.
function detailsSummary(line) {
  const parts = [];
  if (line.io_name) parts.push(line.io_name);
  const bid = bidTypeLabel(line.bid_type);
  if (bid) parts.push(bid);
  if (line.curator_margin_pct != null) parts.push(`${line.curator_margin_pct}%`);
  return parts.join(" · ") || "—";
}

// Summary 1-linha pro accordion de overrides. Lista quais campos estão
// efetivamente overrided. Vazio = "nenhum override aplicado".
function overrideSummary(line, form) {
  const flags = [];
  const piVal = form?.client_pi_amount_override;
  if (piVal != null && piVal !== "") flags.push("PI");
  if (form?.campaign_name_override) flags.push("Campaign");
  if (form?.agency_override) flags.push("Agência");
  if (flags.length === 0 && line) {
    if (line.pi_overridden) flags.push("PI");
    if (line.campaign_name_override) flags.push("Campaign");
    if (line.agency_override) flags.push("Agência");
  }
  return flags.length === 0 ? "Nenhum override aplicado" : `Override: ${flags.join(", ")}`;
}

function FieldGroup({ label, children }) {
  return (
    <div>
      <label className="lbl-section mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

// CurrencyInput — máscara estilo BR (vai preenchendo de trás pra frente, igual
// terminal de banco/POS). Digitar "1" → "0,01", "1234" → "12,34", "1234567" →
// "12.345,67". Aceita o valor inicial em string numérica ("1234.56") e devolve
// no mesmo formato (string numérica). Cursor permanece no final naturalmente
// porque o input é uma string controlada que cresce só pela direita.
function CurrencyInput({ value, onChange, placeholder, className, disabled = false }) {
  const [display, setDisplay] = useState("");

  // Sincroniza display quando o valor externo muda (ex: reset de formulário,
  // troca de line no drawer).
  useEffect(() => {
    if (value === "" || value == null) { setDisplay(""); return; }
    const n = Number(value);
    if (isNaN(n)) { setDisplay(""); return; }
    setDisplay(formatCents(Math.round(n * 100)));
  }, [value]);

  const handleChange = (e) => {
    const digits = e.target.value.replace(/\D/g, "");
    if (!digits) {
      setDisplay("");
      onChange("");
      return;
    }
    const cents = Number(digits);
    setDisplay(formatCents(cents));
    onChange((cents / 100).toString());
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={display}
      onChange={handleChange}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
    />
  );
}

function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100);
  const decimal = abs % 100;
  const reaisStr = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${reaisStr},${String(decimal).padStart(2, "0")}`;
}

function LinkCommandPopup({ open, onOpenChange, line, onLink }) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState("");
  const [err, setErr] = useState(null);
  const [conflict, setConflict] = useState(null);
  // Token sendo linkado AGORA (string ou null). Drives all UI feedback:
  // spinner no card clicado, opacity-40 nos outros, disabled no input
  // manual, label "Vinculando…" no botão. Limpa em catch (no success o
  // popup desmonta antes via setLinking(null) no parent).
  const [linkingToken, setLinkingToken] = useState(null);
  useEffect(() => {
    if (!line) return;
    setLoading(true); setErr(null); setConflict(null); setManual(""); setLinkingToken(null);
    suggestPmpLinks(line.line_id).then(setSuggestions).catch(e => setErr(e.message)).finally(() => setLoading(false));
  }, [line]);
  if (!line) return null;
  const tryLink = async (token, force = false) => {
    if (!token || linkingToken) return; // ignora cliques durante operação em voo
    setErr(null); setConflict(null); setLinkingToken(token);
    try { await onLink(token, { force }); }
    catch (e) {
      setLinkingToken(null);
      if (e.is_conflict) { setConflict(e.conflict_line_id); setErr(e.message); }
      else setErr(e.message);
    }
  };
  const isLinking = linkingToken != null;
  return (
    <Drawer open={open} onOpenChange={isLinking ? () => {} : onOpenChange}>
      <DrawerContent widthClass="sm:w-[540px]">
        <DrawerHeader title="Vincular ao Hypr Command" subtitle={`Line ${line.line_id} · ${line.line_name || ""}`} />
        <DrawerBody>
          <div className="text-xs text-fg-muted mb-5 leading-relaxed">
            Escolha o checklist do Command. Vai escrever o token no campo <code className="text-fg bg-surface px-1 rounded">code</code> da line no Xandr
            e puxar PI, agência e owners automaticamente.
          </div>
          {loading && <Skeleton className="h-16 w-full rounded-md" />}
          {!loading && suggestions.length > 0 && (
            <div className="space-y-2 mb-5">
              <div className="lbl-section">Sugestões automáticas</div>
              {suggestions.map(s => {
                const linkingThis = linkingToken === s.short_token;
                const dimmed = isLinking && !linkingThis;
                return (
                  <button key={s.short_token} onClick={() => tryLink(s.short_token)}
                          disabled={isLinking}
                          className={cn(
                            "w-full text-left rounded-lg border px-4 py-3 transition-all",
                            linkingThis ? "border-signature/60 bg-signature/[0.08]"
                                        : "border-border bg-surface/40",
                            !isLinking && "hover:bg-surface hover:border-border-strong cursor-pointer",
                            dimmed && "opacity-40",
                            isLinking && "cursor-default",
                          )}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-mono text-xs text-signature">
                        {linkingThis && <SpinnerIcon className="text-signature" />}
                        {s.short_token}
                      </div>
                      <div className={cn(
                            "text-[10px] tabular-nums",
                            linkingThis ? "text-signature font-semibold" : "text-fg-subtle",
                          )}>
                        {linkingThis ? "vinculando…" : `match ${fmt(s.score * 100, 0)}%`}
                      </div>
                    </div>
                    <div className="text-sm text-fg mt-1">{s.client} <span className="text-fg-subtle mx-1">·</span> {s.campaign_name}</div>
                    <div className="text-[11px] text-fg-muted mt-0.5">
                      {s.agency || "—"} · PI {formatBRL(s.investment)} · {s.cp_name || "?"} / {s.cs_name || "?"}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {!loading && suggestions.length === 0 && !err && (
            <div className="text-xs text-fg-muted mb-5">Nenhuma sugestão automática encontrada.</div>
          )}
          <div className="space-y-2">
            <div className="lbl-section">Vincular manualmente</div>
            <div className="flex items-center gap-2">
              <input type="text" value={manual} onChange={e => setManual(e.target.value.toUpperCase())}
                     placeholder="ex: NO2015"
                     disabled={isLinking}
                     className={cn(
                       "flex-1 h-10 px-3 rounded-md bg-surface border border-border text-sm text-fg uppercase font-mono",
                       isLinking && "opacity-60 cursor-not-allowed",
                     )} />
              <Button variant="primary" size="md"
                      onClick={() => tryLink(manual)}
                      disabled={!manual.trim() || isLinking}>
                {linkingToken === manual ? (
                  <span className="inline-flex items-center gap-1.5"><SpinnerIcon /> Vinculando…</span>
                ) : "Vincular"}
              </Button>
            </div>
          </div>
          {err && (
            <div className="mt-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {err}
              {conflict && (
                <button onClick={() => tryLink(manual || suggestions[0]?.short_token, true)}
                        disabled={isLinking}
                        className="block mt-2 text-warning underline-offset-2 hover:underline text-xs disabled:opacity-40 disabled:no-underline">
                  {isLinking ? "Sobrescrevendo…" : `Sobrescrever — desvincular da line ${conflict} e vincular aqui`}
                </button>
              )}
            </div>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

// Spinner SVG inline — 12px, usa currentColor pra herdar cor do contexto.
// Tailwind animate-spin + path com strokeOpacity criando arco "girante".
function SpinnerIcon({ className }) {
  return (
    <svg className={cn("animate-spin", className)} width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3.5" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

// Toast flutuante pós-vinculação. Fica no canto inferior direito, fora do
// fluxo do drawer (que já fechou). Auto-dismiss vem do effect no parent.
// Tem botão "fechar" pra dismiss manual antes do timeout.
function LinkSuccessToast({ toast, onDismiss }) {
  if (!toast) return null;
  return (
    <div role="status"
         className="fixed bottom-6 right-6 z-[60] max-w-[360px] rounded-lg border border-success/30 bg-success/[0.08] backdrop-blur-md px-3.5 py-2.5 shadow-xl animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 w-5 h-5 rounded-full bg-success/20 flex items-center justify-center mt-px">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-success">
            <path d="M20 6 9 17l-5-5"/>
          </svg>
        </div>
        <div className="min-w-0 flex-1 text-[12.5px] text-success">
          <div>
            <span className="font-mono font-semibold text-success">{toast.token}</span>
            <span className="text-success/80"> vinculado</span>
          </div>
          <div className="text-[11px] text-success/60 truncate mt-0.5" title={toast.lineLabel}>
            {toast.lineLabel}
          </div>
        </div>
        <button onClick={onDismiss}
                aria-label="Fechar"
                className="shrink-0 -mt-0.5 -mr-1 w-6 h-6 rounded-md text-success/60 hover:text-success hover:bg-success/10 inline-flex items-center justify-center">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

function SyncToast({ result, onDismiss }) {
  const ok = result.ok, s = result.summary;
  return (
    <div className={cn("mb-6 rounded-xl border px-4 py-3 text-sm flex items-start gap-3",
      ok ? "border-success/30 bg-success/10 text-success"
         : "border-danger/30 bg-danger/10 text-danger")} role="status">
      <div className="flex-1 min-w-0">
        {ok ? (
          <>
            <div className="font-semibold">Sync concluído</div>
            <div className="text-[12px] text-fg-muted mt-0.5">
              IOs: {s.insertion_orders?.ios_processed || 0} ({s.insertion_orders?.ios_active || 0} ativos)
              {" · "}Lines: {s.line_items?.lines_processed || 0} ({s.line_items?.lines_active || 0} ativas, {s.line_items?.lines_with_token || 0} c/ token)
              {" · "}Delivery: {s.delivery?.rows_processed || 0} linhas em {s.delivery?.duration_sec || "?"}s
            </div>
          </>
        ) : (
          <><div className="font-semibold">Falha no sync</div>
            <div className="text-[12px] mt-0.5">{result.error}</div></>
        )}
      </div>
      <button onClick={onDismiss} className="text-fg-subtle hover:text-fg shrink-0" aria-label="Fechar">✕</button>
    </div>
  );
}

function LinesSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-6 text-center">
      <div className="text-danger text-sm">{message}</div>
      <Button variant="ghost" size="md" onClick={onRetry} className="mt-3">Tentar de novo</Button>
    </div>
  );
}
