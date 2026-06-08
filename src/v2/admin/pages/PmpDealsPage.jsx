// src/v2/admin/pages/PmpDealsPage.jsx — v3
//
// Refatoração completa baseada no padrão visual do CampaignMenuV2.
// Resolve: hierarquia visual (spacing, tipografia), separação clara entre
// estados (live vs ended vs archived) e múltiplas views específicas.
//
// 4 views (LayoutToggle):
//   📋 Lista       — densidade alta estilo Linear (default)
//   🟢 Ao vivo     — cards ricos pra lines com delivery <7d
//   👥 Por cliente — accordion: card cliente → lines dentro
//   📂 Histórico   — lifetime: tudo (encerradas, ativas, arquivadas)
//
// Mutations preservadas: drawer de edição, popup de auto-vinculação.

import { useState, useEffect, useMemo, useCallback } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import { ptBR } from "date-fns/locale";
import "react-day-picker/style.css";
import "../../components/DateRangeFilterV2.css";
import "../../v2.css";

import {
  listPmpLines, savePmpLineOverrides, syncPmpV2,
  suggestPmpLinks, linkPmpCommand, getPmpLine,
} from "../../../lib/api";
import { Button } from "../../../ui/Button";
import { Skeleton } from "../../../ui/Skeleton";
import {
  Drawer, DrawerContent, DrawerHeader, DrawerBody, DrawerFooter,
} from "../../../ui/Drawer";
import { cn } from "../../../ui/cn";
import { ymd, parseYmd } from "../../../shared/dateFilter";
import HyprReportCenterLogo from "../../../components/HyprReportCenterLogo";
import { ThemeToggleV2 } from "../../components/ThemeToggleV2";
import { TooltipProvider } from "../../../ui/Tooltip";
import {
  PMP_STATUSES, statusPillClass,
  LIVE_STATUSES, HISTORY_STATUSES, effectiveDeliveryMeta,
  bidTypeLabel,
  formatBRL, formatBRLCompact, formatInt, formatIntCompact, formatRatioPct,
  comparePmpLines, formatLastDelivery,
  pctEntrega, groupPctEntrega,
  effectiveStatus, isPmpEditor,
} from "../lib/pmpFormat";
import {
  PmpLayoutToggle, PmpKpiStrip,
  PmpLiveCard, PmpLiveGroupCard, PmpCustomerAccordion,
  PmpLineRow, PmpLineRowHeader, PmpLineGroupCard,
} from "../components/PmpComponents";
import { GroupLinesModal } from "../components/GroupLinesModal";
import { PmpFreshnessIndicator } from "../components/PmpFreshnessIndicator";

const ALL = "__ALL__";

export default function PmpDealsPage({ user, onLogout, onBackToMenu }) {
  // Permissão de edição — só uma lista curada de operadores pode mutar
  // status/PI/command/overrides/notas/grupo. Demais usuários veem tudo
  // em modo somente-leitura. Gate é frontend-only (guard rail UX).
  const canEdit = isPmpEditor(user);

  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Saves em voo (multi-save paralelo). Set de line_ids com save pendente.
  const [savingLineIds, setSavingLineIds] = useState(() => new Set());
  const startSaving = (id) => setSavingLineIds(prev => { const n = new Set(prev); n.add(id); return n; });
  const finishSaving = (id) => setSavingLineIds(prev => { const n = new Set(prev); n.delete(id); return n; });

  // Layout
  const [layout, setLayout] = useState(() => {
    try {
      const saved = localStorage.getItem("hypr.pmp.layout");
      // "worklist" foi removida; migra storage antigo pra default.
      if (saved && saved !== "worklist") return saved;
      return "client";
    } catch { return "client"; }
  });
  useEffect(() => {
    try { localStorage.setItem("hypr.pmp.layout", layout); } catch { /* ignore */ }
  }, [layout]);

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
      };
    } catch { return null; }
  })();
  // Cliente é multi-select: array de nomes. Vazio = todos.
  const [customer, setCustomer] = useState(persistedFilters?.customer || []);
  const [bidType, setBidType] = useState(persistedFilters?.bidType || ALL);
  // Status é multi-select: array. Vazio = todos.
  const [status, setStatus]   = useState(persistedFilters?.status || []);
  useEffect(() => {
    try {
      localStorage.setItem("hypr.pmp.filters", JSON.stringify({ customer, bidType, status }));
    } catch { /* ignore */ }
  }, [customer, bidType, status]);

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
      const list = await listPmpLines({ includeArchived: true, onlyActive: false });
      setLines(list);
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
      if (status.length > 0 && !status.includes(effectiveStatus(l))) return false;
      if (term) {
        const hay = [l.line_id, l.line_name, l.customer, l.campaign_name, l.agency,
                      l.short_token, l.io_name, l.cp_email, l.cs_email].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  };
  const liveFiltered      = useMemo(() => applyFilters(partitions.live),    [partitions.live, search, customer, bidType, status]);
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

  const allLinesFiltered = useMemo(() => {
    const base = applyFilters(lines);
    const { from, to } = histPeriod;
    const bucketRanges = [...quarterRanges, ...monthRanges];
    if (!from && !to && bucketRanges.length === 0) return base;
    // Filtra pelo start_date (ativação) com fallback pra last_delivery_day.
    return base.filter(l => {
      const ref = l.start_date || l.last_delivery_day;
      if (!ref) return false;
      // Período (AND com buckets de trim/mês).
      if (from && ref < from) return false;
      if (to   && ref > to)   return false;
      // Trimestres ∪ meses: line precisa estar em PELO MENOS 1 range.
      if (bucketRanges.length > 0) {
        const inAny = bucketRanges.some(r => ref >= r.from && ref <= r.to);
        if (!inAny) return false;
      }
      return true;
    });
  }, [lines, search, customer, bidType, status, histPeriod, quarterRanges, monthRanges]);

  const allFiltered = useMemo(() => applyFilters([...partitions.live, ...partitions.other]), [partitions, search, customer, bidType, status]);

  // Conjunto exibido na aba atual — KPIs e contagens refletem isso.
  // Por cliente é uma view LIFETIME (mostra todas as lines do cliente,
  // incluindo encerradas) — usa o mesmo dataset do Histórico pra que os
  // big numbers no topo somem tudo que está exposto abaixo, não só ativas.
  const visibleLines = useMemo(() => {
    if (layout === "live")     return liveFiltered;
    if (layout === "history")  return allLinesFiltered;
    if (layout === "client")   return allLinesFiltered;
    return allFiltered;
  }, [layout, liveFiltered, allLinesFiltered, allFiltered]);

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
      extraRevenue,
      extraLinesCount,
    };
  }, [visibleLines]);

  // ── Contagens por layout (mostradas no toggle) ────────────────────────────
  // Refletem os filtros aplicados — cada badge mostra quantas lines apareceriam
  // se você clicasse na aba agora. Histórico vira "lifetime" (tudo).
  const counts = useMemo(() => ({
    live:     liveFiltered.length,
    client:   new Set(allFiltered.map(l => l.customer || "(sem)")).size,
    list:     allFiltered.length,
    history:  allLinesFiltered.length,
  }), [liveFiltered, allFiltered, allLinesFiltered]);

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

  const lastSyncedAt = useMemo(() => {
    let max = null;
    for (const l of lines) if (l.last_synced_at && (!max || l.last_synced_at > max)) max = l.last_synced_at;
    return max;
  }, [lines]);

  // Última data de entrega coberta pelo sync — usado no popover do
  // indicador de frescor pra dar contexto do que tá na base.
  const latestDeliveryDay = useMemo(() => {
    let max = null;
    for (const l of lines) if (l.last_delivery_day && (!max || l.last_delivery_day > max)) max = l.last_delivery_day;
    return max;
  }, [lines]);

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
      "PI (R$)": Number(l.pi_brl || 0),
      "Revenue (R$)": Number(l.curator_revenue || 0),
      "Margem (R$)": Number(l.curator_margin || 0),
      "Margin %": l.effective_margin_pct == null ? "" : Number(l.effective_margin_pct),
      "% Entrega": (() => { const p = pctEntrega(l); return p == null ? "" : Number(p); })(),
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
    arr.sort((a, b) => comparePmpLines(a, b, sortBy, sortDir));
    return arr;
  }, [allFiltered, sortBy, sortDir]);

  // ── Grouping por cliente (Por Cliente view) ───────────────────────────────
  // Inclui TODAS as lines (live + history + other) — view lifetime do
  // cliente. Encerradas ficam no mesmo accordion porque o user quer
  // contexto completo: "quanto a HYPR já faturou com esse cliente?".
  const byCustomer = useMemo(() => {
    const map = new Map();
    for (const l of lines) {
      if (l.is_archived) continue;  // testes/seeds arquivadas: só no Histórico
      if (search || customer.length > 0 || bidType !== ALL || status.length > 0) {
        if (!applyFilters([l]).length) continue;
      }
      const key = l.customer || "(sem cliente)";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(l);
    }
    // Ordena clientes: 1º os com mais lines no ar, depois por revenue total
    return [...map.entries()].sort(([ka, la], [kb, lb]) => {
      const liveA = la.filter(x => LIVE_STATUSES.has(x.delivery_status)).length;
      const liveB = lb.filter(x => LIVE_STATUSES.has(x.delivery_status)).length;
      if (liveA !== liveB) return liveB - liveA;
      const revA = la.reduce((s, x) => s + Number(x.curator_revenue || 0), 0);
      const revB = lb.reduce((s, x) => s + Number(x.curator_revenue || 0), 0);
      if (revA !== revB) return revB - revA;
      return ka.localeCompare(kb);
    });
  }, [lines, search, customer, bidType, status]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <TooltipProvider delayDuration={200}>
    <div className="min-h-screen w-full bg-canvas text-fg transition-colors">
      <header className="sticky top-0 z-30 bg-canvas-elevated border-b border-border">
        <div className="max-w-[1600px] mx-auto px-4 md:px-8 h-16 flex items-center justify-between gap-3">
          <button type="button" onClick={onBackToMenu}
                  className="flex items-center text-fg cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-elevated min-w-0"
                  aria-label="Voltar">
            <HyprReportCenterLogo height={32} />
          </button>
          <div className="flex items-center gap-2 md:gap-3">
            {/* Status do sync Xandr Curate · ação "Sincronizar agora" mora
                dentro do popover. Slot espelha o DataFreshnessIndicator do
                menu admin pra manter consistência entre as duas headers. */}
            <PmpFreshnessIndicator
              lastSyncedAt={lastSyncedAt}
              latestDeliveryDay={latestDeliveryDay}
              linesCount={lines.length || null}
              onSync={onSync}
              syncing={syncing}
            />
            <ThemeToggleV2 />
            {user?.picture && (
              <img src={user.picture} alt="" referrerPolicy="no-referrer"
                   className="w-7 h-7 rounded-full ring-2 ring-signature shrink-0" />
            )}
            <span className="text-xs text-fg-muted hidden md:inline truncate max-w-[180px]">{user?.name}</span>
            <button onClick={onLogout}
                    className="text-xs text-fg-muted hover:text-fg px-3 h-9 md:h-8 rounded-md border border-border hover:bg-surface transition-colors shrink-0">
              Sair
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-4 md:px-8 py-8 md:py-10">
        {/* Hero — generoso */}
        <div className="flex items-end justify-between gap-4 flex-wrap mb-8">
          <div>
            <div className="flex items-center gap-2 text-xs text-fg-subtle uppercase tracking-widest mb-2">
              <button onClick={onBackToMenu} className="hover:text-fg transition-colors">Admin</button>
              <span>/</span>
              <span className="text-fg-muted">PMP Lines</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-fg leading-tight">
              Deals de Pagamento
            </h1>
            <p className="text-sm text-fg-muted mt-2 flex items-center gap-2 flex-wrap">
              <span><span className="font-semibold text-fg tabular-nums">{partitions.live.length}</span> no ar</span>
              <span className="w-0.5 h-0.5 rounded-full bg-fg-subtle" />
              <span><span className="font-semibold text-fg tabular-nums">{lines.length}</span> totais</span>
              <span className="w-0.5 h-0.5 rounded-full bg-fg-subtle" />
              <span>Análise das entregas Xandr Curate × Hypr Command</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {savingLineIds.size > 0 && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-signature tabular-nums"
                    title="Saves em andamento — você pode continuar editando outras lines">
                <span className="w-1.5 h-1.5 rounded-full bg-signature animate-pulse" />
                Salvando {savingLineIds.size > 1 ? `${savingLineIds.size} alterações` : "alteração"}…
              </span>
            )}
            <Button variant="primary" size="md" onClick={onExport} disabled={!allFiltered.length}>
              Exportar
            </Button>
          </div>
        </div>

        {/* KPIs */}
        {lines.length > 0 && (
          <div className="mb-6">
            <PmpKpiStrip kpis={kpis} livesCount={partitions.live.length} totalCount={lines.length}
                         showExtra={layout === "history" || layout === "client"} />
          </div>
        )}


        {/* Sync toast */}
        {syncResult && <SyncToast result={syncResult} onDismiss={() => setSyncResult(null)} />}

        {/* Layout toggle + filtros de período (Histórico) na mesma linha */}
        <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
          <PmpLayoutToggle value={layout} onChange={setLayout} counts={counts} />
          {layout === "history" && (
            <div className="flex flex-wrap items-center gap-2">
              <PeriodFilterPill value={histPeriod} onChange={setHistPeriod} />
              <QuarterFilterPill values={histQuarters} onChange={setHistQuarters} availableYears={historyYears} />
              <MonthFilterPill values={histMonths} onChange={setHistMonths} availableYears={historyYears} />
              <SortChip
                visible={histSortBy !== HIST_DEFAULT_SORT.by || histSortDir !== HIST_DEFAULT_SORT.dir}
                field={histSortBy}
                dir={histSortDir}
                onClear={() => { setHistSortBy(HIST_DEFAULT_SORT.by); setHistSortDir(HIST_DEFAULT_SORT.dir); }}
              />
              {(histPeriod.from || histPeriod.to || histQuarters.length > 0 || histMonths.length > 0) && (
                <button onClick={() => { setHistPeriod({ presetId: "all", from: null, to: null }); setHistQuarters([]); setHistMonths([]); }}
                        className="text-xs text-fg-muted hover:text-fg underline-offset-2 hover:underline">
                  Limpar
                </button>
              )}
            </div>
          )}
          {layout === "list" && (sortBy !== LIST_DEFAULT_SORT.by || sortDir !== LIST_DEFAULT_SORT.dir) && (
            <div className="flex flex-wrap items-center gap-2">
              <SortChip
                visible
                field={sortBy}
                dir={sortDir}
                onClear={() => { setSortBy(LIST_DEFAULT_SORT.by); setSortDir(LIST_DEFAULT_SORT.dir); }}
              />
            </div>
          )}
        </div>

        {/* Filtros sticky */}
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <SearchInput value={search} onChange={setSearch} />
          <FilterMultiSelect label="Cliente" values={customer} onChange={setCustomer} options={customersAll} />
          <FilterSelect label="Bid"     value={bidType}  onChange={setBidType}  options={["flex","fixed"]} />
          <FilterMultiSelect label="Status" values={status} onChange={setStatus} options={PMP_STATUSES} />
          {(search || customer.length > 0 || bidType !== ALL || status.length > 0) && (
            <button onClick={() => { setSearch(""); setCustomer([]); setBidType(ALL); setStatus([]); }}
                    className="text-xs text-fg-muted hover:text-fg underline-offset-2 hover:underline ml-1">
              Limpar
            </button>
          )}
        </div>

        {/* Views — skeleton só no load inicial; reload em background mantém a grid visível */}
        {(loading && lines.length === 0) ? <LinesSkeleton />
          : error  ? <ErrorState message={error} onRetry={reload} />
          : (
            <>
              {layout === "live"     && <LiveView     lines={liveOrdered}     onLineClick={setEditing} onLinkClick={canEdit ? setLinking : undefined} />}
              {layout === "client"   && <ClientView   groups={byCustomer}     onLineClick={setEditing} onLinkClick={canEdit ? setLinking : undefined} />}
              {layout === "list"     && <ListView     lines={allSorted}       sortBy={sortBy} sortDir={sortDir}
                                                       onColumnClick={(f) => {
                                                         // Ciclo 3-estado: desc → asc → default
                                                         if (f !== sortBy) { setSortBy(f); setSortDir("desc"); }
                                                         else if (sortDir === "desc") setSortDir("asc");
                                                         else { setSortBy(LIST_DEFAULT_SORT.by); setSortDir(LIST_DEFAULT_SORT.dir); }
                                                       }}
                                                       onLineClick={setEditing} onLinkClick={canEdit ? setLinking : undefined} />}
              {layout === "history"  && <HistoryView  lines={allLinesFiltered}
                                                       sortBy={histSortBy} sortDir={histSortDir}
                                                       onColumnClick={(f) => {
                                                         // Ciclo 3-estado: desc → asc → default
                                                         if (f !== histSortBy) { setHistSortBy(f); setHistSortDir("desc"); }
                                                         else if (histSortDir === "desc") setHistSortDir("asc");
                                                         else { setHistSortBy(HIST_DEFAULT_SORT.by); setHistSortDir(HIST_DEFAULT_SORT.dir); }
                                                       }}
                                                       onLineClick={setEditing} onLinkClick={canEdit ? setLinking : undefined} />}
            </>
          )
        }
      </main>

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
    </div>
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

function ClientView({ groups, onLineClick, onLinkClick }) {
  if (groups.length === 0) {
    return <EmptyFilters />;
  }
  return (
    <div className="space-y-3">
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
        <div className="md:min-w-[1160px]">
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
                              groupPctReceber={groupPctReceber} />
                ))}
              </div>
              <InlineGroupSubtotal members={it.members} groupPi={groupPi} groupPctReceber={groupPctReceber} />
            </div>
          );
        })}
          </div>
        </div>
      </div>
    </div>
  );
}

// Grupo compartilha 1 PI. No backend o `group_pi_brl` ainda não é exposto,
// então resolvemos no frontend: pegamos o primeiro PI não-nulo entre os
// membros (todos deveriam compartilhar o mesmo, por definição do agrupamento).
function resolveGroupPi(members) {
  for (const m of members) {
    if (m.pi_brl != null && m.pi_brl > 0) return m.pi_brl;
  }
  return null;
}

// Mapa de campo per-line → campo agregado do grupo. Pro sort de grupos
// pegar o valor "real" do grupo (PI compartilhado, revenue/margin/cost
// somados) em vez do membro arbitrário no índice 0.
const GROUP_FIELD_MAP = {
  curator_total_cost:   "group_curator_total_cost",
  curator_revenue:      "group_curator_revenue",
  curator_margin:       "group_curator_margin",
  effective_margin_pct: "group_effective_margin_pct",
  pct_a_receber:        "group_pct_a_receber",
};

function itemSortValue(item, field) {
  if (item.kind === "single") return item.line[field];
  const members = item.members;
  if (field === "pi_brl") return resolveGroupPi(members);
  if (field === "hours_since_last_delivery") {
    // Grupo herda o MAIS RECENTE (menor hours) entre os membros.
    let min = Infinity;
    for (const m of members) {
      const v = m.hours_since_last_delivery;
      if (v != null && v < min) min = v;
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
  out.sort((a, b) => {
    const va = itemSortValue(a, field);
    const vb = itemSortValue(b, field);
    const aN = va == null || va === "";
    const bN = vb == null || vb === "";
    if (aN && bN) return 0;
    if (aN) return 1;
    if (bN) return -1;
    if (typeof va === "number" && typeof vb === "number") {
      return dir === "asc" ? va - vb : vb - va;
    }
    const sa = String(va).toLowerCase(), sb = String(vb).toLowerCase();
    if (sa < sb) return dir === "asc" ? -1 : 1;
    if (sa > sb) return dir === "asc" ? 1 : -1;
    return 0;
  });
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
        <div className="md:min-w-[1160px]">
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
                              groupPctReceber={groupPctReceber} />
                ))}
              </div>
              <InlineGroupSubtotal members={it.members} groupPi={groupPi} groupPctReceber={groupPctReceber} />
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
function InlineGroupSubtotal({ members, groupPi, groupPctReceber }) {
  const first = members[0];
  const grid = "grid grid-cols-[12px_minmax(0,1.45fr)_minmax(110px,0.4fr)_88px_140px_140px_140px_150px_60px_72px_minmax(82px,0.5fr)] gap-x-4";
  return (
    <div className={cn(grid, "hidden md:grid px-5 py-2.5 items-center border-t border-border/40 bg-surface/40 text-[12px]")}>
      <div />
      <div className="text-[10px] uppercase tracking-widest font-semibold text-fg-muted">
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

function FilterSelect({ label, value, onChange, options }) {
  const opts = options.map(o => typeof o === "string" ? { value: o, label: o } : o);
  return (
    <label className="inline-flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle hidden sm:inline">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
              className="appearance-none h-9 pl-3 pr-8 rounded-lg bg-surface border border-border text-sm text-fg hover:bg-surface-strong cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature"
              style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center" }}>
        <option value={ALL}>Todos</option>
        {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

// Multi-select com popover: trigger igual ao FilterSelect (mesma altura/borda)
// + dropdown com search, checkbox por item, ações Selecionar tudo / Limpar.
// `values=[]` significa "Todos" — evita força bruta de marcar tudo no estado.
function FilterMultiSelect({ label, values, onChange, options }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const opts = useMemo(
    () => options.map(o => typeof o === "string" ? { value: o, label: o } : o),
    [options],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return opts;
    return opts.filter(o => o.label.toLowerCase().includes(q));
  }, [opts, query]);

  const isAll = values.length === 0;
  const summary = isAll
    ? "Todos"
    : values.length === 1
      ? (opts.find(o => o.value === values[0])?.label || values[0])
      : `${values.length} selecionados`;

  const toggle = (v) => {
    if (values.includes(v)) onChange(values.filter(x => x !== v));
    else onChange([...values, v]);
  };

  // Reset busca quando fecha — UX limpa na próxima abertura.
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <label className="inline-flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle hidden sm:inline">{label}</span>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex items-center justify-between gap-2 h-9 pl-3 pr-2.5 min-w-[140px]",
              "rounded-lg bg-surface border text-sm cursor-pointer",
              "hover:bg-surface-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
              isAll ? "border-border text-fg" : "border-signature/50 text-fg",
            )}
          >
            <span className={cn("truncate", !isAll && "font-medium")}>{summary}</span>
            {!isAll && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-signature/20 text-signature text-[10px] font-bold tabular-nums shrink-0">
                {values.length}
              </span>
            )}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                 className="text-fg-subtle shrink-0">
              <path d="m6 9 6 6 6-6"/>
            </svg>
          </button>
        </Popover.Trigger>
      </label>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          collisionPadding={16}
          className={cn(
            "z-50 w-[280px] max-w-[calc(100vw-32px)]",
            "rounded-lg border border-border bg-canvas-elevated shadow-lg overflow-hidden",
            "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
            "focus-visible:outline-none",
          )}
        >
          <div className="px-3 pt-3 pb-2 border-b border-border">
            <div className="relative">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                   className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
              </svg>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar cliente…"
                autoFocus
                className="w-full h-8 pl-7 pr-2 rounded-md bg-surface border border-border text-xs text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature"
              />
            </div>
          </div>

          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border text-[11px]">
            <button
              type="button"
              onClick={() => onChange(opts.map(o => o.value))}
              disabled={values.length === opts.length}
              className="text-fg-muted hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Selecionar tudo
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={isAll}
              className="text-fg-muted hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Limpar
            </button>
          </div>

          <div className="max-h-[280px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-xs text-fg-subtle italic text-center">
                Nenhum cliente encontrado
              </div>
            ) : filtered.map(o => {
              const checked = values.includes(o.value);
              return (
                <label
                  key={o.value}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors",
                    checked ? "bg-signature/10 hover:bg-signature/20" : "hover:bg-surface",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(o.value)}
                    className="sr-only peer"
                  />
                  <span
                    aria-hidden="true"
                    className={cn(
                      "shrink-0 w-4 h-4 rounded-[4px] border-2 inline-flex items-center justify-center transition-colors",
                      checked ? "bg-signature border-signature" : "border-fg-subtle",
                      "peer-focus-visible:ring-2 peer-focus-visible:ring-signature peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-canvas-elevated",
                    )}
                  >
                    {checked && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="white"
                           strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1.5 5.5L4 8L8.5 2"/>
                      </svg>
                    )}
                  </span>
                  <span className={cn(
                    "text-sm flex-1 min-w-0 truncate",
                    checked ? "text-fg font-medium" : "text-fg-muted",
                  )}>
                    {o.label}
                  </span>
                </label>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ───── Filtros de período do Histórico ──────────────────────────────────────
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
const SORT_FIELD_LABELS = {
  customer:                  "Cliente",
  pi_brl:                    "PI",
  curator_total_cost:        "Cost",
  curator_revenue:           "Revenue",
  curator_margin:            "Margem",
  effective_margin_pct:      "Mgm %",
  pct_a_receber:             "% Entr",
  hours_since_last_delivery: "Delivery",
  start_date:                "Início",
};

// Chip "Ordenado: Margem ↓ ×" — fica visível quando a sort diverge do default
// da view. Click no chip inteiro limpa (volta pro default). Atalho mais
// óbvio que ficar lembrando do "clique 3× pra limpar" no header.
function SortChip({ visible, field, dir, onClear }) {
  if (!visible) return null;
  const label = SORT_FIELD_LABELS[field] || field;
  const arrow = dir === "asc" ? "↑" : "↓";
  return (
    <button
      type="button"
      onClick={onClear}
      title="Voltar pra ordem padrão"
      className="group inline-flex items-center gap-1.5 h-9 pl-2.5 pr-2 rounded-lg border border-signature/50 bg-signature/10 text-signature text-xs hover:bg-signature/15 transition-colors"
    >
      <span className="text-[10px] uppercase tracking-widest font-bold opacity-70">Ordenado</span>
      <span className="font-medium">{label} {arrow}</span>
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-signature/20 group-hover:bg-signature/30 text-[12px] leading-none transition-colors">×</span>
    </button>
  );
}

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
        <button className={cn(
          "inline-flex items-center gap-2 h-9 px-3 rounded-lg border text-sm transition-colors",
          isActive
            ? "border-signature/40 bg-signature/10 text-signature"
            : "border-border bg-surface text-fg hover:bg-surface-strong",
        )}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
          </svg>
          <span>{currentLabel}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={cn("transition-transform", open && "rotate-180")}>
            <path d="m6 9 6 6 6-6"/>
          </svg>
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
                          className="px-3 h-7 rounded-md text-xs font-semibold bg-signature text-white hover:bg-signature/90 disabled:bg-surface-strong disabled:text-fg-subtle">
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
        <button className={cn(
          "inline-flex items-center gap-2 h-9 px-3 rounded-lg border text-sm transition-colors",
          isActive
            ? "border-signature/50 bg-signature/10 text-signature"
            : "border-border bg-surface text-fg hover:bg-surface-strong",
        )}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          <span>{label}</span>
          {isActive && values.length > 1 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-signature/20 text-signature text-[10px] font-bold tabular-nums">
              {values.length}
            </span>
          )}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={cn("transition-transform", open && "rotate-180")}>
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={8}
          className="z-50 rounded-xl border border-border bg-surface-2 shadow-2xl p-4 w-[260px] data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">Ano</div>
            <div className="inline-flex items-center gap-1">
              <button onClick={() => setYear(y => y - 1)} className="w-7 h-7 inline-flex items-center justify-center rounded-md text-fg-muted hover:bg-surface-strong">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <select value={year} onChange={e => setYear(Number(e.target.value))}
                      className="h-7 px-2 rounded-md bg-surface border border-border text-sm text-fg cursor-pointer">
                {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
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
        <button className={cn(
          "inline-flex items-center gap-2 h-9 px-3 rounded-lg border text-sm transition-colors",
          isActive
            ? "border-signature/50 bg-signature/10 text-signature"
            : "border-border bg-surface text-fg hover:bg-surface-strong",
        )}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <path d="M16 2v4M8 2v4M3 10h18"/>
          </svg>
          <span>{label}</span>
          {isActive && values.length > 1 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-signature/20 text-signature text-[10px] font-bold tabular-nums">
              {values.length}
            </span>
          )}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={cn("transition-transform", open && "rotate-180")}>
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={8}
          className="z-50 rounded-xl border border-border bg-surface-2 shadow-2xl p-4 w-[300px] data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">Ano</div>
            <div className="inline-flex items-center gap-1">
              <button onClick={() => setYear(y => y - 1)} className="w-7 h-7 inline-flex items-center justify-center rounded-md text-fg-muted hover:bg-surface-strong">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <select value={year} onChange={e => setYear(Number(e.target.value))}
                      className="h-7 px-2 rounded-md bg-surface border border-border text-sm text-fg cursor-pointer">
                {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
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
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle">{k}</div>
        <div className={cn("text-[12px] text-fg truncate tabular-nums", mono && "font-mono")}
             title={String(v ?? "")}>{v || "—"}</div>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3 text-[11px]">
      <span className="text-fg-subtle uppercase tracking-wider shrink-0">{k}</span>
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
          <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
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
                    "px-2 h-6 rounded text-[10.5px] uppercase tracking-wider font-semibold transition-colors",
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
  const cls = isUp   ? "bg-emerald-500/10 text-emerald-400"
            : isDown ? "bg-rose-500/10 text-rose-400"
            :          "bg-surface-2 text-fg-subtle";
  const arrow = isUp ? "↑" : isDown ? "↓" : "≈";
  const text = isFlat ? "flat" : `${Math.abs(rounded)}%`;
  return (
    <span className={cn("inline-flex items-center gap-0.5 px-1.5 h-4 rounded text-[10px] font-semibold tabular-nums",
                        cls)}
          title={`Variação vs 7d anteriores: ${pct.toFixed(1)}%`}>
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
          <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">{label}</div>
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
          <div className="text-[10px] uppercase tracking-widest font-bold text-signature">
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
      <label className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle mb-1.5 block">{label}</label>
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
              <div className="text-[10px] uppercase tracking-widest text-fg-subtle font-bold">Sugestões automáticas</div>
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
                        {linkingThis ? "vinculando…" : `match ${(s.score * 100).toFixed(0)}%`}
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
            <div className="text-[10px] uppercase tracking-widest text-fg-subtle font-bold">Vincular manualmente</div>
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
            <div className="mt-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-400">
              {err}
              {conflict && (
                <button onClick={() => tryLink(manual || suggestions[0]?.short_token, true)}
                        disabled={isLinking}
                        className="block mt-2 text-amber-400 underline-offset-2 hover:underline text-xs disabled:opacity-40 disabled:no-underline">
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
         className="fixed bottom-6 right-6 z-[60] max-w-[360px] rounded-lg border border-emerald-500/30 bg-emerald-500/[0.08] backdrop-blur-md px-3.5 py-2.5 shadow-xl animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center mt-px">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-300">
            <path d="M20 6 9 17l-5-5"/>
          </svg>
        </div>
        <div className="min-w-0 flex-1 text-[12.5px] text-emerald-100">
          <div>
            <span className="font-mono font-semibold text-emerald-300">{toast.token}</span>
            <span className="text-emerald-200/80"> vinculado</span>
          </div>
          <div className="text-[11px] text-emerald-200/60 truncate mt-0.5" title={toast.lineLabel}>
            {toast.lineLabel}
          </div>
        </div>
        <button onClick={onDismiss}
                aria-label="Fechar"
                className="shrink-0 -mt-0.5 -mr-1 w-6 h-6 rounded-md text-emerald-200/60 hover:text-emerald-200 hover:bg-emerald-500/10 inline-flex items-center justify-center">
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
      ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
         : "border-rose-500/30 bg-rose-500/10 text-rose-300")} role="status">
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
    <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-6 text-center">
      <div className="text-rose-400 text-sm">{message}</div>
      <Button variant="ghost" size="md" onClick={onRetry} className="mt-3">Tentar de novo</Button>
    </div>
  );
}
