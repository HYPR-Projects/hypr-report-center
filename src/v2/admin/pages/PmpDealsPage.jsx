// src/v2/admin/pages/PmpDealsPage.jsx — v3
//
// Refatoração completa baseada no padrão visual do CampaignMenuV2.
// Resolve: hierarquia visual (spacing, tipografia), separação clara entre
// estados (live vs ended vs archived), múltiplas views específicas, e
// foco em ação imediata via Worklist.
//
// 5 views (LayoutToggle):
//   🟢 Ao vivo     — cards ricos pra lines com delivery <7d (default)
//   👥 Por cliente — accordion: card cliente → lines dentro
//   📋 Lista       — densidade alta estilo Linear
//   🎯 Worklist    — 4 buckets de ação imediata (pararam, sem PI, over-PI, encerrando)
//   📂 Histórico   — lines encerradas/arquivadas (cinza, sob demanda)
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
  suggestPmpLinks, linkPmpCommand,
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
import { formatTimeAgo } from "../lib/format";
import {
  PMP_STATUSES, statusPillClass,
  LIVE_STATUSES, HISTORY_STATUSES, effectiveDeliveryMeta,
  bidTypeLabel,
  formatBRL, formatInt, formatRatioPct,
  comparePmpLines, formatLastDelivery,
  pctEntrega, groupPctEntrega,
  effectiveStatus,
} from "../lib/pmpFormat";
import {
  PmpLayoutToggle, PmpKpiStrip, PmpAlertsBar,
  PmpLiveCard, PmpLiveGroupCard, PmpCustomerAccordion,
  PmpLineRow, PmpLineRowHeader, PmpLineGroupCard,
  PmpWorklistView,
} from "../components/PmpComponents";
import { GroupLinesModal } from "../components/GroupLinesModal";

const ALL = "__ALL__";

export default function PmpDealsPage({ user, onLogout, onBackToMenu }) {
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Layout
  const [layout, setLayout] = useState(() => {
    try { return localStorage.getItem("hypr.pmp.layout") || "client"; } catch { return "client"; }
  });
  useEffect(() => {
    try { localStorage.setItem("hypr.pmp.layout", layout); } catch { /* ignore */ }
  }, [layout]);

  // Filtros transversais
  const [search, setSearch]   = useState("");
  const [customer, setCustomer] = useState(ALL);
  const [bidType, setBidType] = useState(ALL);
  const [status, setStatus]   = useState(ALL);
  const [focusBucket, setFocusBucket] = useState(null);

  // Filtros temporais — só aplicam na aba Histórico.
  //   histPeriod = { from: "YYYY-MM-DD"|null, to: "YYYY-MM-DD"|null, presetId }
  //   histQuarter = { year: 2026, q: 2 } ou null
  // Quando ambos setados: intersecção (AND).
  const [histPeriod, setHistPeriod] = useState({ presetId: "all", from: null, to: null });
  const [histQuarter, setHistQuarter] = useState(null);

  // Sort (só pra layout lista)
  const [sortBy, setSortBy]   = useState("hours_since_last_delivery");
  const [sortDir, setSortDir] = useState("asc");

  // Modals
  const [editing, setEditing] = useState(null);
  const [linking, setLinking] = useState(null);
  const [grouping, setGrouping] = useState(null);  // line objeto, abre GroupLinesModal

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
      if (customer !== ALL && l.customer !== customer) return false;
      if (bidType  !== ALL && (l.bid_type || "—") !== bidType) return false;
      if (status   !== ALL && effectiveStatus(l) !== status) return false;
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
  const dateRangeFromHistFilters = useMemo(() => {
    let from = histPeriod.from, to = histPeriod.to;
    if (histQuarter) {
      const { year, q } = histQuarter;
      const qFrom = `${year}-${String((q-1)*3 + 1).padStart(2,"0")}-01`;
      const qToMonth = q*3;
      const qToLastDay = new Date(year, qToMonth, 0).getDate();
      const qTo = `${year}-${String(qToMonth).padStart(2,"0")}-${String(qToLastDay).padStart(2,"0")}`;
      from = from && from > qFrom ? from : qFrom;
      to   = to   && to   < qTo   ? to   : qTo;
    }
    return { from, to };
  }, [histPeriod, histQuarter]);

  const allLinesFiltered = useMemo(() => {
    const base = applyFilters(lines);
    const { from, to } = dateRangeFromHistFilters;
    if (!from && !to) return base;
    // Filtra pelo start_date (ativação) com fallback pra last_delivery_day.
    return base.filter(l => {
      const ref = l.start_date || l.last_delivery_day;
      if (!ref) return false;
      if (from && ref < from) return false;
      if (to   && ref > to)   return false;
      return true;
    });
  }, [lines, search, customer, bidType, status, dateRangeFromHistFilters]);

  const allFiltered = useMemo(() => applyFilters([...partitions.live, ...partitions.other]), [partitions, search, customer, bidType, status]);
  // Worklist olha a BASE INTEIRA (não só partitions.live) — pega line com
  // state=active no Xandr mesmo que já tenha sido classificada como "ended".
  // Critérios: pararam de entregar (stopped) ou no ar sem PI vinculado.
  const worklistFiltered = useMemo(() => {
    const base = applyFilters(lines);
    return base.filter(l =>
      l.delivery_status === "stopped" ||
      (LIVE_STATUSES.has(l.delivery_status) && l.pi_brl == null)
    );
  }, [lines, search, customer, bidType, status]);

  // Conjunto exibido na aba atual — KPIs e contagens refletem isso.
  const visibleLines = useMemo(() => {
    if (layout === "live")     return liveFiltered;
    if (layout === "history")  return allLinesFiltered;
    if (layout === "worklist") return worklistFiltered;
    return allFiltered;
  }, [layout, liveFiltered, allLinesFiltered, allFiltered, worklistFiltered]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  // Big numbers refletem o dataset visível na aba ativa (com filtros).
  // % entrega = margem ÷ PI.
  const kpis = useMemo(() => {
    let pi = 0, revenue = 0, margin = 0, imps = 0, revenue7d = 0;
    let withPi = 0, pctSum = 0, pctCount = 0;
    for (const l of visibleLines) {
      pi      += Number(l.pi_brl          || 0);
      revenue += Number(l.curator_revenue || 0);
      margin  += Number(l.curator_margin  || 0);
      imps    += Number(l.imps            || 0);
      revenue7d += Number(l.revenue_last_7d || 0);
      if (l.pi_brl != null) {
        withPi++;
        const p = pctEntrega(l);
        if (p != null) { pctSum += p; pctCount++; }
      }
    }
    return {
      pi, revenue, margin, imps, revenue7d,
      countWithPi: withPi,
      avgPctReceber: pctCount > 0 ? pctSum / pctCount : null,
    };
  }, [visibleLines]);

  // ── Alertas ───────────────────────────────────────────────────────────────
  const alerts = useMemo(() => {
    const out = [];
    const stopped = partitions.live.filter(l => l.delivery_status === "stopped");
    if (stopped.length)
      out.push({ kind: "danger", bucket: "stopped",
        text: `${stopped.length} line${stopped.length === 1 ? "" : "s"} parou de entregar` });
    const noPi = partitions.live.filter(l => l.pi_brl == null);
    if (noPi.length)
      out.push({ kind: "warn", bucket: "no_pi",
        text: `${noPi.length} line${noPi.length === 1 ? "" : "s"} ativa${noPi.length === 1 ? "" : "s"} sem PI vinculado` });
    return out;
  }, [partitions.live]);

  // ── Contagens por layout (mostradas no toggle) ────────────────────────────
  // Refletem os filtros aplicados — cada badge mostra quantas lines apareceriam
  // se você clicasse na aba agora. Histórico vira "lifetime" (tudo).
  const counts = useMemo(() => ({
    live:     liveFiltered.length,
    client:   new Set(allFiltered.map(l => l.customer || "(sem)")).size,
    list:     allFiltered.length,
    worklist: worklistFiltered.length,
    history:  allLinesFiltered.length,
  }), [liveFiltered, allFiltered, allLinesFiltered, worklistFiltered]);

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
    // é o que parecia "trava".
    setEditing(null);
    setLines(prev => prev.map(l => {
      if (l.line_id === targetLine.line_id) return { ...l, ...fields };
      if (groupMemberIds.includes(l.line_id) && Object.keys(groupPropagate).length > 0) {
        return { ...l, ...groupPropagate };
      }
      return l;
    }));

    try {
      const updated = await savePmpLineOverrides({ line_id: targetLine.line_id, ...fields });
      // Sincroniza com o server (sobrescreve valores derivados / timestamps).
      setLines(prev => prev.map(l => l.line_id === updated.line_id ? { ...l, ...updated } : l));
      // Se propagou no grupo, recarrega tudo pra refletir o resto (server
      // já fez o UPDATE em massa).
      if (targetLine.group_id && Object.keys(groupPropagate).length > 0) {
        reload();
      }
    } catch (e) {
      alert("Erro ao salvar: " + e.message);
    }
  };

  const onLinkCommand = async (short_token, opts = {}) => {
    const updated = await linkPmpCommand({ line_id: linking.line_id, short_token, force: opts.force || false });
    setLines(prev => prev.map(l => l.line_id === updated.line_id ? { ...l, ...updated } : l));
    setLinking(null);
  };

  const onAlertClick = (bucket) => {
    setLayout("worklist");
    setFocusBucket(bucket);
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
      if (search || customer !== ALL || bidType !== ALL || status !== ALL) {
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
              <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-signature/15 text-signature">v3</span>
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
            {lastSyncedAt && (
              <span className="text-[11px] text-fg-subtle hidden md:inline tabular-nums"
                    title={`Última sync: ${new Date(lastSyncedAt).toLocaleString("pt-BR")}`}>
                Xandr {formatTimeAgo(lastSyncedAt)}
              </span>
            )}
            <Button variant="ghost" size="md" onClick={onSync} disabled={syncing || loading}>
              {syncing ? "Sincronizando..." : "Sync Xandr"}
            </Button>
            <Button variant="ghost" size="md" onClick={reload} disabled={loading}>
              Recarregar
            </Button>
            <Button variant="primary" size="md" onClick={onExport} disabled={!allFiltered.length}>
              Exportar
            </Button>
          </div>
        </div>

        {/* KPIs */}
        {!loading && lines.length > 0 && (
          <div className="mb-6">
            <PmpKpiStrip kpis={kpis} livesCount={partitions.live.length} totalCount={lines.length} />
          </div>
        )}

        {/* Alertas (chips clicáveis → worklist) */}
        {!loading && alerts.length > 0 && (
          <div className="mb-8">
            <PmpAlertsBar alerts={alerts} onClickAlert={onAlertClick} />
          </div>
        )}

        {/* Sync toast */}
        {syncResult && <SyncToast result={syncResult} onDismiss={() => setSyncResult(null)} />}

        {/* Layout toggle + filtros de período (Histórico) na mesma linha */}
        <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
          <PmpLayoutToggle value={layout} onChange={(v) => { setLayout(v); setFocusBucket(null); }} counts={counts} />
          {layout === "history" && (
            <div className="flex flex-wrap items-center gap-2">
              <PeriodFilterPill value={histPeriod} onChange={setHistPeriod} />
              <QuarterFilterPill value={histQuarter} onChange={setHistQuarter} availableYears={historyYears} />
              {(histPeriod.from || histPeriod.to || histQuarter) && (
                <button onClick={() => { setHistPeriod({ presetId: "all", from: null, to: null }); setHistQuarter(null); }}
                        className="text-xs text-fg-muted hover:text-fg underline-offset-2 hover:underline">
                  Limpar
                </button>
              )}
            </div>
          )}
        </div>

        {/* Filtros sticky */}
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <SearchInput value={search} onChange={setSearch} />
          <FilterSelect label="Cliente" value={customer} onChange={setCustomer} options={customersAll} />
          <FilterSelect label="Bid"     value={bidType}  onChange={setBidType}  options={["flex","fixed"]} />
          <FilterSelect label="Status"  value={status}   onChange={setStatus}   options={PMP_STATUSES} />
          {(search || customer !== ALL || bidType !== ALL || status !== ALL) && (
            <button onClick={() => { setSearch(""); setCustomer(ALL); setBidType(ALL); setStatus(ALL); }}
                    className="text-xs text-fg-muted hover:text-fg underline-offset-2 hover:underline ml-1">
              Limpar
            </button>
          )}
        </div>

        {/* Views */}
        {loading ? <LinesSkeleton />
          : error  ? <ErrorState message={error} onRetry={reload} />
          : (
            <>
              {layout === "live"     && <LiveView     lines={liveOrdered}     onLineClick={setEditing} onLinkClick={setLinking} />}
              {layout === "client"   && <ClientView   groups={byCustomer}     onLineClick={setEditing} onLinkClick={setLinking} />}
              {layout === "list"     && <ListView     lines={allSorted}       sortBy={sortBy} sortDir={sortDir}
                                                       onColumnClick={(f) => {
                                                         if (f === sortBy) setSortDir(sortDir === "asc" ? "desc" : "asc");
                                                         else { setSortBy(f); setSortDir("desc"); }
                                                       }}
                                                       onLineClick={setEditing} onLinkClick={setLinking} />}
              {layout === "worklist" && <PmpWorklistView lines={worklistFiltered} focusBucket={focusBucket}
                                                          onLineClick={setEditing} onLinkClick={setLinking} />}
              {layout === "history"  && <HistoryView  lines={allLinesFiltered} onLineClick={setEditing} onLinkClick={setLinking} />}
            </>
          )
        }
      </main>

      {/* Drawer + popups */}
      <PmpLineDrawer open={!!editing} onOpenChange={o => { if (!o) setEditing(null); }}
                     line={editing} onSave={onSaveOverrides}
                     onLinkClick={() => { setLinking(editing); setEditing(null); }}
                     onGroupClick={() => { setGrouping(editing); setEditing(null); }} />
      <LinkCommandPopup open={!!linking} onOpenChange={o => { if (!o) setLinking(null); }}
                        line={linking} onLink={onLinkCommand} />
      <GroupLinesModal open={!!grouping} onOpenChange={o => { if (!o) setGrouping(null); }}
                       line={grouping} onGroupCreated={() => reload()} />
    </div>
    </TooltipProvider>
  );
}


// ───── Views ─────────────────────────────────────────────────────────────────
function LiveView({ lines, onLineClick, onLinkClick }) {
  if (lines.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-canvas-elevated px-6 py-16 text-center">
        <div className="text-fg-muted text-sm">Nenhuma line ao vivo no momento.</div>
        <div className="text-fg-subtle text-xs mt-2">Lines "ao vivo" são as que tiveram delivery nos últimos 7 dias.</div>
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
      <PmpLineRowHeader />
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

function HistoryView({ lines, onLineClick, onLinkClick }) {
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

  // 2. Cria "items" pra render — cada item é {kind:"group"|"single", ...sort_key}
  //    Sort key = start_date (data de ativação). Grupo usa o MAIS RECENTE
  //    entre seus membros (= a ativação mais nova representa o grupo).
  //    Fallback pra last_delivery_day / end_date se start_date ausente.
  const items = [];
  const sortKeyOf = (l) => l.start_date || l.last_delivery_day || l.end_date || "";
  for (const [gid, members] of byGroup) {
    const sortKey = members.reduce((max, m) => {
      const k = sortKeyOf(m);
      return k > max ? k : max;
    }, "");
    items.push({ kind: "group", group_id: gid, members, sortKey });
  }
  for (const l of singles) {
    items.push({ kind: "single", line: l, sortKey: sortKeyOf(l) });
  }
  // 3. Sort items por sortKey DESC (ativação mais recente no topo)
  items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  return (
    <div className="rounded-xl border border-border bg-canvas-elevated overflow-hidden">
      <PmpLineRowHeader />
      <div className="divide-y divide-border/60 max-h-[calc(100vh-380px)] overflow-y-auto">
        {items.map((it) => {
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
  );
}

// ─── Subtotal inline minimalista (mesmo grid do row, sem cores berrantes) ───
function InlineGroupSubtotal({ members, groupPi, groupPctReceber }) {
  const first = members[0];
  const grid = "grid grid-cols-[12px_minmax(0,1.7fr)_minmax(110px,0.8fr)_60px_140px_140px_140px_160px_64px_64px_minmax(72px,0.8fr)] gap-x-4";
  return (
    <div className={cn(grid, "px-5 py-2.5 items-center border-t border-border/40 bg-surface/40 text-[12px]")}>
      <div />
      <div className="text-[10px] uppercase tracking-widest font-semibold text-fg-muted">
        Subtotal do grupo · {members.length} lines
      </div>
      <div /> {/* bid/status */}
      <div /> {/* dias */}
      <div className="text-right tabular-nums text-fg font-bold">
        {groupPi != null ? formatBRL(groupPi) : "—"}
      </div>
      <div className="text-right tabular-nums text-fg-subtle font-bold">
        {formatBRL(first.group_curator_total_cost)}
      </div>
      <div className="text-right tabular-nums text-fg font-bold">
        {formatBRL(first.group_curator_revenue)}
      </div>
      <div className="text-right tabular-nums text-emerald-400 font-bold">
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

function QuarterFilterPill({ value, onChange, availableYears }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => value?.year || availableYears[0] || new Date().getFullYear());
  const isActive = !!value;
  const label = isActive ? `Q${value.q} ${value.year}` : "Trimestre";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className={cn(
          "inline-flex items-center gap-2 h-9 px-3 rounded-lg border text-sm transition-colors",
          isActive
            ? "border-signature/40 bg-signature/10 text-signature"
            : "border-border bg-surface text-fg hover:bg-surface-strong",
        )}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          <span>{label}</span>
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
              const active = value && value.year === year && value.q === q;
              const months = ["Jan-Mar","Abr-Jun","Jul-Set","Out-Dez"][q-1];
              return (
                <button key={q} onClick={() => { onChange({ year, q }); setOpen(false); }}
                        className={cn(
                          "flex flex-col items-center gap-0.5 py-3 rounded-lg border transition-colors",
                          active
                            ? "border-signature bg-signature/15 text-signature"
                            : "border-border bg-surface hover:bg-surface-strong text-fg",
                        )}>
                  <span className="text-base font-bold">Q{q}</span>
                  <span className="text-[10px] text-fg-subtle">{months}</span>
                </button>
              );
            })}
          </div>
          {isActive && (
            <button onClick={() => { onChange(null); setOpen(false); }}
                    className="w-full h-8 rounded-md text-xs text-fg-muted hover:bg-surface-strong">
              Remover filtro de trimestre
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

function PmpLineDrawer({ open, onOpenChange, line, onSave, onLinkClick, onGroupClick }) {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (line) {
      setForm({
        status: line.status || "Pendente",
        notes:  line.notes  || "",
        client_pi_amount_override: line.client_pi_amount_override ?? "",
        campaign_name_override:    line.campaign_name_override || "",
        agency_override:           line.agency_override || "",
      });
      setErr(null);
    }
  }, [line]);
  if (!line) return null;
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const handleSave = async () => {
    setSaving(true); setErr(null);
    try {
      const p = { ...form };
      for (const k of Object.keys(p)) if (p[k] === "") p[k] = null;
      if (p.client_pi_amount_override != null) p.client_pi_amount_override = Number(p.client_pi_amount_override);
      await onSave(p);
    } catch (e) { setErr(e.message || "Erro"); }
    finally { setSaving(false); }
  };
  const dm = effectiveDeliveryMeta(line);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent widthClass="sm:w-[520px]">
        <DrawerHeader title={line.line_name || line.campaign_name || "Line"}
                      titleClassName="text-base font-mono break-all leading-snug"
                      subtitle={`${line.customer || "?"} · Line ${line.line_id} · ${dm.label}`} />
        <DrawerBody>
          <div className="space-y-5">
            <div className="rounded-lg border border-border bg-surface/40 px-4 py-3 text-[11px] space-y-1.5">
              {[
                ["IO", line.io_name],
                ["Deal ID(s)", formatDealIds(line)],
                ["Bid type", bidTypeLabel(line.bid_type) || "—"],
                ["Margem curator", line.curator_margin_pct != null ? `${line.curator_margin_pct}%` : "—"],
                ["Revenue type", line.revenue_type || "—"],
                ["Floor / Teto", `${line.min_revenue_value ?? "—"} / ${line.max_revenue_value ?? "—"}`],
                ["Início → Fim", `${line.start_date || "—"} → ${line.end_date || "—"}`],
                ["Última entrega", line.last_delivery_day || "—"],
                ["Token Command", line.short_token || "—"],
                ["CP / CS", line.cp_email && line.cs_email ? `${line.cp_email} / ${line.cs_email}` : "—"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-3">
                  <span className="text-fg-subtle uppercase tracking-wider shrink-0">{k}</span>
                  <span className={cn(
                          "text-fg text-right max-w-[300px]",
                          k === "Deal ID(s)" ? "font-mono break-all" : "truncate",
                        )}
                        title={String(v ?? "")}>{v || "—"}</span>
                </div>
              ))}
              {!line.short_token && (
                <button onClick={onLinkClick}
                        className="mt-2 w-full h-8 rounded-md border border-signature/40 bg-signature/10 text-signature text-xs hover:bg-signature/20 transition-colors">
                  🔗 Vincular ao Hypr Command
                </button>
              )}
            </div>

            {/* Seção Grupo */}
            <div className="rounded-lg border border-signature/30 bg-signature/[0.04] px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] uppercase tracking-widest font-bold text-signature">
                  Grupo (PI compartilhado)
                </div>
                {line.group_id && (
                  <span className="font-mono text-[10px] text-signature">{line.group_id}</span>
                )}
              </div>
              {line.group_id ? (
                <>
                  <div className="text-sm text-fg">{line.group_name || "—"}</div>
                  <div className="text-[11px] text-fg-muted mt-1 tabular-nums">
                    {line.group_member_count} lines · {formatRatioPct(line.group_pct_a_receber)} entrega ·
                    Margem {formatBRL(line.group_curator_margin)}
                  </div>
                  <button onClick={onGroupClick}
                          className="mt-3 w-full h-8 rounded-md border border-signature/40 bg-signature/10 text-signature text-xs hover:bg-signature/20 transition-colors">
                    ⚙️ Editar grupo / desagrupar
                  </button>
                </>
              ) : (
                <>
                  <div className="text-[11px] text-fg-muted leading-relaxed">
                    Esta line não está agrupada. Agrupe com outras lines do mesmo cliente que compartilham o mesmo PI.
                  </div>
                  <button onClick={onGroupClick}
                          className="mt-2 w-full h-8 rounded-md border border-signature/40 bg-signature/10 text-signature text-xs hover:bg-signature/20 transition-colors">
                    🔗 Agrupar com outras lines
                  </button>
                </>
              )}
            </div>

            <FieldGroup label="Status workflow">
              <select value={form.status} onChange={e => set("status", e.target.value)}
                      className="w-full h-9 px-3 rounded-md bg-surface border border-border text-sm text-fg">
                {PMP_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {form.status === "Pendente" && effectiveStatus(line) !== "Pendente" && (
                <div className="mt-1.5 text-[11px] text-fg-subtle">
                  Automático: <span className="text-fg font-medium">{effectiveStatus(line)}</span>
                  <span className="ml-1">(baseado na última entrega — selecione outro pra fixar manual)</span>
                </div>
              )}
            </FieldGroup>

            <FieldGroup label={`PI Override (BRL)${line.pi_brl != null && !line.pi_overridden ? ` — Command tem ${formatBRL(line.pi_brl)}` : ""}`}>
              <CurrencyInput value={form.client_pi_amount_override}
                             onChange={v => set("client_pi_amount_override", v)}
                             placeholder={line.pi_brl != null ? "deixe vazio pra usar o do Command" : "0,00"}
                             className="w-full h-9 px-3 rounded-md bg-surface border border-border text-sm text-fg tabular-nums" />
            </FieldGroup>

            <FieldGroup label="Campaign override">
              <input type="text" value={form.campaign_name_override}
                     onChange={e => set("campaign_name_override", e.target.value)}
                     placeholder={line.campaign_name || ""}
                     className="w-full h-9 px-3 rounded-md bg-surface border border-border text-sm text-fg" />
            </FieldGroup>
            <FieldGroup label="Agência override">
              <input type="text" value={form.agency_override}
                     onChange={e => set("agency_override", e.target.value)}
                     placeholder={line.agency || ""}
                     className="w-full h-9 px-3 rounded-md bg-surface border border-border text-sm text-fg" />
            </FieldGroup>
            <FieldGroup label="Notas">
              <textarea value={form.notes} onChange={e => set("notes", e.target.value)} rows={3}
                        className="w-full px-3 py-2 rounded-md bg-surface border border-border text-sm text-fg resize-none" />
            </FieldGroup>
            {err && <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{err}</div>}
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="primary" size="md" onClick={handleSave} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
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
function CurrencyInput({ value, onChange, placeholder, className }) {
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
  useEffect(() => {
    if (!line) return;
    setLoading(true); setErr(null); setConflict(null); setManual("");
    suggestPmpLinks(line.line_id).then(setSuggestions).catch(e => setErr(e.message)).finally(() => setLoading(false));
  }, [line]);
  if (!line) return null;
  const tryLink = async (token, force = false) => {
    setErr(null); setConflict(null);
    try { await onLink(token, { force }); }
    catch (e) {
      if (e.is_conflict) { setConflict(e.conflict_line_id); setErr(e.message); }
      else setErr(e.message);
    }
  };
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
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
              {suggestions.map(s => (
                <button key={s.short_token} onClick={() => tryLink(s.short_token)}
                        className="w-full text-left rounded-lg border border-border bg-surface/40 hover:bg-surface px-4 py-3 transition-colors">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-xs text-signature">{s.short_token}</div>
                    <div className="text-[10px] text-fg-subtle">match {(s.score * 100).toFixed(0)}%</div>
                  </div>
                  <div className="text-sm text-fg mt-1">{s.client} <span className="text-fg-subtle mx-1">·</span> {s.campaign_name}</div>
                  <div className="text-[11px] text-fg-muted mt-0.5">
                    {s.agency || "—"} · PI {formatBRL(s.investment)} · {s.cp_name || "?"} / {s.cs_name || "?"}
                  </div>
                </button>
              ))}
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
                     className="flex-1 h-10 px-3 rounded-md bg-surface border border-border text-sm text-fg uppercase font-mono" />
              <Button variant="primary" size="md" onClick={() => tryLink(manual)} disabled={!manual.trim()}>Vincular</Button>
            </div>
          </div>
          {err && (
            <div className="mt-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-400">
              {err}
              {conflict && (
                <button onClick={() => tryLink(manual || suggestions[0]?.short_token, true)}
                        className="block mt-2 text-amber-400 underline-offset-2 hover:underline text-xs">
                  Sobrescrever — desvincular da line {conflict} e vincular aqui
                </button>
              )}
            </div>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
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
