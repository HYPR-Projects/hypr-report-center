// src/v2/admin/components/ReportAnalyticsModal.jsx
//
// Modal de analytics de acessos ao report compartilhado.
//
// Data flow:
//   1. Modal abre → useReportAnalyticsData(shortToken, range) dispara
//      duas requests em paralelo: getReportAnalytics + getReportAuditLog.
//   2. Enquanto carrega, mostra skeleton.
//   3. Em erro/timeout, cai num estado "Tracking ainda inativo" com
//      disclaimer claro.
//   4. Quando o report tem 0 events (tracking acabou de ser deploy ou
//      campanha nova sem acesso), renderiza normal com zeros — o
//      disclaimer no rodapé explica.
//
// Estrutura (top → bottom):
//   1. Header — cliente · campanha · token · seletor de período
//   2. KPIs   — total / únicos / tempo médio / último acesso (com delta)
//   3. Timeline — acessos diários (área chart) + anotações de eventos
//   4. Grid 2 col — abas mais vistas | breakdown de device
//   5. Horários de pico — heatmap dia × hora (compacto)
//   6. Últimas sessões — lista com tempo, device, abas visitadas
//   7. Log de mudanças (admin) — changelog real do report_audit_log
//   8. Disclaimer "Tracking iniciado em DD/MM" enquanto data < 90d

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../../ui/cn";
import { SparklineV2 } from "../../components/SparklineV2";
import { getReportAnalytics, getReportAuditLog } from "../../../lib/api";

// ─── Hook real ──────────────────────────────────────────────────────────
//
// Dispara em paralelo: analytics (KPIs/timeline/tabs/devices/heatmap/sessions)
// + audit_log (changelog). Combina num único objeto pro modal.
//
// Range muda → re-fetch de analytics, mas changelog (não depende de range)
// só carrega 1x por abertura do modal.
function useReportAnalyticsData(shortToken, rangeDays, isOpen) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    analytics: null,
    changelog: [],
  });

  // Trackeia inputs anteriores pra detectar mudança DURANTE o render e
  // resetar o state na mesma fase de commit. Sem isso, o reset acontece
  // só no useEffect — que roda depois do render — e o admin vê 1 frame
  // com dados da campanha anterior. Padrão "derived state from props"
  // oficial do React (https://react.dev/learn/you-might-not-need-an-effect).
  const [prevInputs, setPrevInputs] = useState({ shortToken, rangeDays, isOpen });
  const inputsChanged =
    prevInputs.shortToken !== shortToken ||
    prevInputs.rangeDays !== rangeDays ||
    prevInputs.isOpen !== isOpen;
  if (inputsChanged) {
    setPrevInputs({ shortToken, rangeDays, isOpen });
    // Só reseta se reabrir com token válido — caso contrário deixa state
    // como está (modal fechando não precisa zerar).
    if (isOpen && shortToken) {
      setState({ loading: true, error: null, analytics: null, changelog: [] });
    }
  }

  useEffect(() => {
    if (!isOpen || !shortToken) return;
    let cancelled = false;

    Promise.allSettled([
      getReportAnalytics({ short_token: shortToken, range_days: rangeDays }),
      getReportAuditLog({ short_token: shortToken, limit: 50 }),
    ]).then(([analyticsR, changelogR]) => {
      if (cancelled) return;
      const analytics = analyticsR.status === "fulfilled" ? analyticsR.value : null;
      const changelog = changelogR.status === "fulfilled" ? changelogR.value : [];
      const error = analyticsR.status === "rejected" ? analyticsR.reason : null;
      setState({ loading: false, error, analytics, changelog });
    });

    return () => { cancelled = true; };
  }, [shortToken, rangeDays, isOpen]);

  return state;
}

// ─── Adapter: backend payload → shape esperado pelos sub-componentes ────
//
// O backend devolve { summary, timeline, tabs, devices, heatmap,
// recent_sessions, tracking_start_date }. Os sub-componentes (TimelineCard,
// TabsCard, DeviceCard, etc) foram desenhados pra um shape específico
// quando estavam consumindo mock; este adapter é a camada fina entre os
// dois pra não precisar reescrever os componentes de UI.
function adaptAnalytics(payload, changelog) {
  if (!payload) {
    return {
      series:      [],
      annotations: [],
      tabs:        [],
      ctas:        [],
      devices:     [],
      heatmap:     Array.from({ length: 7 }, () => Array(24).fill(0)),
      sessions:    [],
      changelog:   changelog || [],
      kpis: {
        totalAccesses: 0,
        totalAccessesDelta: null,
        uniqueSessions: 0,
        uniqueSessionsDelta: null,
        avgDurationSec: 0,
        avgDurationDelta: null,
        lastAccessMinutesAgo: null,
      },
      trackingStartDate: null,
    };
  }

  const summary = payload.summary || {};
  const timeline = Array.isArray(payload.timeline) ? payload.timeline : [];

  // Series shape: { day, accesses, sessions } — já bate com o backend.
  // Mantemos os labels do eixo X consistentes com o range.
  const series = timeline.map((t) => ({
    day:      t.day,
    accesses: Number(t.accesses) || 0,
    sessions: Number(t.sessions) || 0,
  }));

  // Annotations: derivamos do changelog. Cada entrada relevante (link
  // reenviado, criativo novo, Loom adicionado) vira uma anotação no
  // timeline na posição do `daysAgo` correspondente. Mapeia tipos do
  // backend pra tone+label do chart.
  const annotations = (changelog || [])
    .filter((ev) => ANNOTATION_EVENT_TYPES[ev.event_type])
    .map((ev) => {
      const daysAgo = computeDaysAgo(ev.created_at);
      const day = series.length - 1 - daysAgo;
      if (day < 0 || day >= series.length) return null;
      const meta = ANNOTATION_EVENT_TYPES[ev.event_type];
      return { day, label: meta.label, tone: meta.tone };
    })
    .filter(Boolean)
    // Dedup de anotações próximas (várias do mesmo dia ficariam sobrepostas)
    .reduce((acc, anno) => {
      if (!acc.some((a) => a.day === anno.day)) acc.push(anno);
      return acc;
    }, []);

  // KPIs com delta vs período anterior — backend não devolve delta
  // hoje (poderia adicionar futuramente). Por enquanto retornamos null,
  // que o componente Kpi renderiza como "—".
  const totalAccesses  = Number(summary.total_pageviews)  || 0;
  const uniqueSessions = Number(summary.unique_sessions)  || 0;
  const avgDurationSec = Math.round(Number(summary.avg_duration_sec) || 0);
  const lastAccessMinutesAgo = computeMinutesAgo(summary.last_access_at);

  return {
    series,
    annotations,
    tabs: (payload.tabs || []).map((t) => ({
      name:  t.tab_id || "—",
      views: Number(t.views) || 0,
    })),
    // CTAs: backend devolve { cta_id, clicks }. Adapter humaniza o ID
    // pra label legível ("sheets_open" → "Abrir no Google Sheets").
    ctas: (payload.ctas || []).map((c) => ({
      id:     c.cta_id,
      label:  CTA_LABELS[c.cta_id] || c.cta_id,
      clicks: Number(c.clicks) || 0,
    })),
    devices: (payload.devices || []).map((d) => ({
      name:  d.device_family || "Unknown",
      share: Number(d.share) || 0,
    })),
    heatmap: payload.heatmap || Array.from({ length: 7 }, () => Array(24).fill(0)),
    sessions: (payload.recent_sessions || []).map((s, i) => ({
      id:           s.session_id || `s-${i}`,
      minutesAgo:   computeMinutesAgo(s.last_at),
      durationSec:  Math.round(Number(s.duration_sec) || 0),
      device:       s.device_family || "Desktop",
      tabs:         Array.isArray(s.tabs) ? s.tabs : [],
      internal:     Boolean(s.is_internal),
    })),
    changelog: (changelog || []).map((ev) => ({
      id:          ev.event_id,
      daysAgo:     computeDaysAgo(ev.created_at),
      author:      ev.actor_email ? humanizeAuthor(ev.actor_email) : "Sistema",
      type:        ev.event_type,
      msg:         ev.message || defaultMessage(ev.event_type),
      synthetic:   Boolean(ev.synthetic),
    })),
    kpis: {
      totalAccesses,
      totalAccessesDelta:  null, // backend não devolve delta ainda
      uniqueSessions,
      uniqueSessionsDelta: null,
      avgDurationSec,
      avgDurationDelta:    null,
      lastAccessMinutesAgo,
    },
    trackingStartDate: payload.tracking_start_date || null,
  };
}

// Mapa de event_type → annotation visual no timeline. Só os "destacáveis"
// viram anotações — outras ações ficam no changelog mas não no chart pra
// não poluir.
// Labels humanizados pros IDs de CTA gravados no backend. Adicionar
// linhas aqui quando um CTA novo for plugado no frontend. IDs não
// listados caem pro fallback (o próprio cta_id como label).
const CTA_LABELS = {
  sheets_open:           "Abrir no Google Sheets",
  csv_download:          "Download CSV",
  loom_open_external:    "Abrir no Loom",
  period_change:         "Filtro de período",
  tactic_change_display: "Filtro de tática (Display)",
  tactic_change_video:   "Filtro de tática (Vídeo)",
  core_product_change:   "Filtro de Core Product",
  audience_filter_change:"Filtro de audiência",
  creative_line_change:  "Filtro de linha criativa",
  merge_view_change:     "Trocar visão (agregada/mês)",
};

const ANNOTATION_EVENT_TYPES = {
  loom_added:        { label: "Loom adicionado",    tone: "signature" },
  loom_replaced:     { label: "Loom atualizado",    tone: "signature" },
  survey_created:    { label: "Survey criada",      tone: "signature" },
  merge_linked:      { label: "Agrupado",           tone: "success" },
  campaign_paused:   { label: "Pausada",            tone: "signature" },
  campaign_resumed:  { label: "Retomada",           tone: "success" },
  campaign_closed:   { label: "Encerrada",          tone: "signature" },
};

// Fallback de message — quando a row do audit_log foi inserida sem
// message (raríssimo), gera texto razoável a partir do event_type.
const DEFAULT_MESSAGES = {
  loom_added:                  "adicionou um vídeo Loom",
  loom_replaced:               "trocou o vídeo Loom",
  loom_removed:                "removeu o Loom",
  survey_created:              "criou uma Survey",
  survey_updated:              "ajustou perguntas da Survey",
  survey_removed:              "removeu a Survey",
  logo_changed:                "trocou o logo do cliente",
  owner_changed:               "alterou owners",
  merge_linked:                "agrupou tokens",
  merge_unlinked:              "removeu do agrupamento",
  campaign_closed:             "encerrou a campanha",
  campaign_reopened:           "reabriu a campanha",
  campaign_paused:             "pausou a campanha",
  campaign_resumed:            "retomou a campanha",
  campaign_early_ended:        "encerrou antecipadamente",
  campaign_early_end_reverted: "reverteu encerramento antecipado",
  abs_toggled:                 "alterou Pre-bid ABS",
  rmnd_uploaded:               "subiu CSV do Amazon Ads",
  pdooh_uploaded:              "subiu relatório PDOOH",
};

function defaultMessage(eventType) {
  return DEFAULT_MESSAGES[eventType] || "fez uma alteração";
}

// Email → primeiro nome capitalizado. "joao.buzolin@hypr.mobi" → "João B."
function humanizeAuthor(email) {
  if (!email) return "Sistema";
  const local = email.split("@")[0] || "";
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length === 0) return email;
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
  const lastInitial = parts[1] ? ` ${parts[1].charAt(0).toUpperCase()}.` : "";
  return first + lastInitial;
}

function computeMinutesAgo(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
}

// Diff de calendário (meia-noite local → meia-noite local), não janelas
// de 24h corridas. Sem isso, um evento de ontem 22h visto hoje 08h dá
// floor(10h / 24h) = 0 e o changelog mostra "hoje" pra algo que claramente
// foi ontem. Round em cima do diff em ms cobre fronteiras de horário de
// verão (dias com 23h ou 25h) sem ficar 1 dia errado.
function computeDaysAgo(isoString) {
  if (!isoString) return 0;
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return 0;
  const then  = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today.getTime() - then.getTime()) / 86_400_000));
}


// ─── Formatters ─────────────────────────────────────────────────────────
const fmtDelta = (pct) => {
  if (pct == null || !isFinite(pct)) return null;
  const sign = pct >= 0 ? "▲" : "▼";
  return `${sign} ${Math.abs(pct).toFixed(0)}%`;
};

const fmtDuration = (sec) => {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}min` : `${m}m ${String(s).padStart(2, "0")}s`;
};

const fmtRelative = (minutesAgo) => {
  if (minutesAgo == null) return "Sem acessos";
  if (minutesAgo < 1) return "agora";
  if (minutesAgo < 60) return `há ${minutesAgo} min`;
  const h = Math.floor(minutesAgo / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.floor(h / 24);
  return `há ${d}d`;
};

// ─── Componente principal ──────────────────────────────────────────────
export function ReportAnalyticsModal({ open, onOpenChange, campaign }) {
  const [range, setRange] = useState(30); // 7 | 30 | 90

  // Toggle Externo/Todos foi removido — admin não dispara tracking (hook
  // tem `if (isAdmin) return`), então 100% dos eventos já são externos.
  // Botão "Todos" não mudava nada nos dados. Quando time HYPR começar a
  // abrir reports em modo cliente pra QA, restaurar passando
  // include_internal=true no fetch.
  const { loading, error, analytics, changelog } = useReportAnalyticsData(
    campaign?.short_token,
    range,
    open,
  );

  // Adapter roda só quando algum dos inputs muda, evita recomputar
  // shape a cada render.
  const data = useMemo(
    () => adaptAnalytics(analytics, changelog),
    [analytics, changelog],
  );

  if (!campaign) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-40 bg-black/60 backdrop-blur-[3px]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "duration-200",
          )}
        />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50",
            "-translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-32px)] max-w-[880px]",
            "max-h-[calc(100vh-48px)] overflow-hidden",
            "rounded-2xl border border-border-strong bg-canvas-elevated shadow-2xl",
            "flex flex-col outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            "duration-200",
          )}
        >
          <Header
            campaign={campaign}
            range={range}
            onRangeChange={setRange}
          />
          <div className="flex-1 overflow-y-auto px-6 md:px-8 pb-8 pt-6 space-y-7">
            {error && !loading && <ErrorBanner />}
            <KpiRow kpis={data.kpis} loading={loading} />
            <TimelineCard
              series={data.series}
              annotations={data.annotations}
              range={range}
              loading={loading}
            />
            <div className="grid grid-cols-1 md:grid-cols-5 gap-5">
              <div className="md:col-span-3">
                <TabsCard tabs={data.tabs} loading={loading} />
              </div>
              <div className="md:col-span-2">
                <DeviceCard devices={data.devices} loading={loading} />
              </div>
            </div>
            <CtasCard ctas={data.ctas} loading={loading} />
            <HeatmapCard heatmap={data.heatmap} loading={loading} />
            <SessionsCard sessions={data.sessions} loading={loading} />
            <AdminChangelogCard changelog={data.changelog} loading={loading} />
            <TrackingStartDisclaimer date={data.trackingStartDate} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ErrorBanner() {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5 text-[11.5px] text-warning">
      <strong>Não foi possível carregar.</strong> Dados podem estar desatualizados ou o tracking ainda não está disponível pra essa campanha.
    </div>
  );
}

/** Bloco shimmering reusável — bg sutil com animate-pulse. */
function SkelBox({ className }) {
  return <div className={cn("rounded-md bg-fg-subtle/10 animate-pulse", className)} />;
}

// ─── Header ────────────────────────────────────────────────────────────
function Header({ campaign, range, onRangeChange }) {
  return (
    <div className="px-6 md:px-8 pt-6 pb-5 border-b border-border bg-surface-2/60 relative">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at top right, var(--color-signature-glow) 0%, transparent 70%)",
        }}
      />
      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-block w-6 h-0.5 rounded-full bg-signature" aria-hidden />
            <Dialog.Title asChild>
              <span className="text-[10.5px] font-bold uppercase tracking-[1.5px] text-signature">
                Analytics de acessos
              </span>
            </Dialog.Title>
          </div>
          <h2 className="text-xl md:text-2xl font-bold text-fg leading-tight tracking-[-0.4px] line-clamp-2">
            {campaign.client_name}
          </h2>
          <Dialog.Description asChild>
            <div className="mt-1.5 text-[12.5px] text-fg-muted flex items-center gap-2 flex-wrap">
              <span>{campaign.campaign_name}</span>
              <span className="text-fg-subtle">·</span>
              <span className="font-mono">{campaign.short_token}</span>
            </div>
          </Dialog.Description>
          <div className="mt-3.5 flex items-center gap-3 flex-wrap">
            <RangeToggle value={range} onChange={onRangeChange} />
          </div>
        </div>
        <Dialog.Close
          aria-label="Fechar"
          className={cn(
            "shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-md",
            "text-fg-muted hover:text-fg hover:bg-surface",
            "transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
          )}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </Dialog.Close>
      </div>
    </div>
  );
}

function RangeToggle({ value, onChange }) {
  const opts = [
    { v: 7,  label: "7d" },
    { v: 30, label: "30d" },
    { v: 90, label: "90d" },
  ];
  return (
    <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-surface border border-border">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            "px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer",
            value === o.v
              ? "bg-signature text-white"
              : "text-fg-muted hover:text-fg hover:bg-surface-strong",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── KPIs ──────────────────────────────────────────────────────────────
function KpiRow({ kpis, loading }) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-surface px-4 py-3.5">
            <SkelBox className="h-2.5 w-20" />
            <SkelBox className="h-7 w-24 mt-2" />
            <SkelBox className="h-2.5 w-32 mt-2" />
          </div>
        ))}
      </div>
    );
  }
  return _KpiRowImpl({ kpis });
}

function _KpiRowImpl({ kpis }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Kpi
        label="Acessos totais"
        value={kpis.totalAccesses.toLocaleString("pt-BR")}
        delta={kpis.totalAccessesDelta}
      />
      <Kpi
        label="Sessões únicas"
        value={kpis.uniqueSessions.toLocaleString("pt-BR")}
        delta={kpis.uniqueSessionsDelta}
      />
      <Kpi
        label="Tempo médio"
        value={fmtDuration(kpis.avgDurationSec)}
        delta={kpis.avgDurationDelta}
      />
      <Kpi
        label="Último acesso"
        value={fmtRelative(kpis.lastAccessMinutesAgo)}
        valueIsRelative
      />
    </div>
  );
}

function Kpi({ label, value, delta, valueIsRelative }) {
  const deltaStr = fmtDelta(delta);
  const positive = delta != null && delta >= 0;
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
        {label}
      </div>
      <div className={cn(
        "mt-1 font-bold tracking-tight text-fg tabular-nums",
        valueIsRelative ? "text-base" : "text-2xl",
      )}>
        {value}
      </div>
      {deltaStr && (
        <div className={cn(
          "mt-1 text-[11px] font-semibold tabular-nums inline-flex items-center gap-1",
          positive ? "text-success" : "text-danger",
        )}>
          {deltaStr}
          <span className="text-fg-subtle font-normal">vs período anterior</span>
        </div>
      )}
    </div>
  );
}

// ─── Timeline ──────────────────────────────────────────────────────────
// Quantos ticks de data mostrar no eixo X, escolhido por range pra evitar
// poluição (90d com 30 labels viraria papagaio). 7d → diário (8 labels),
// 30d → cada ~6 dias (6 labels), 90d → cada ~18 dias (6 labels).
const X_TICKS_BY_RANGE = { 7: 8, 30: 6, 90: 6 };

function fmtDayMonth(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

// Largura do gutter à esquerda que reserva espaço pros labels do eixo Y.
// 36px cabe valores até 4 dígitos (9999) na fonte mono [10px] com folga.
// Pra séries com pico maior, aumentar — mas pra access tracking típico
// (dezenas a centenas de pageviews/dia) está OK.
const Y_AXIS_GUTTER_PX = 36;

// Altura fixa da área do gráfico em px. Bate com h-[120px] aplicado
// abaixo. Usado também pra calcular a posição vertical do dot do tooltip.
const CHART_HEIGHT_PX = 120;

// Padding vertical interno do SparklineV2 (deixa a linha não tocar a
// borda do viewBox). Replicado aqui pra posicionar o dot do tooltip
// exatamente sobre a linha do sparkline — sem isso, dot e linha ficam
// 2px misalinhados nos extremos. Se mudar em SparklineV2.jsx, mudar aqui.
const SPARKLINE_PAD_Y_PX = 2;
const SPARKLINE_USABLE_H_PX = CHART_HEIGHT_PX - SPARKLINE_PAD_Y_PX * 2;

// Raio do dot do tooltip (w-2 h-2 = 8px → raio 4px).
const TOOLTIP_DOT_RADIUS_PX = 4;

function TimelineCard({ series, annotations, range, loading }) {
  // hoverIdx = índice do dia sob o mouse, ou null. Hook precisa rodar em
  // toda render pra não violar regra dos hooks, então fica antes do
  // early-return de loading.
  const [hoverIdx, setHoverIdx] = useState(null);

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-4">
        <SkelBox className="h-4 w-48 mb-2" />
        <SkelBox className="h-3 w-32" />
        <div className="relative mt-5">
          <div className="h-[24px] mb-1" />
          <SkelBox className="h-[120px] w-full" />
        </div>
        <div className="mt-2 flex justify-between">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkelBox key={i} className="h-2 w-8" />
          ))}
        </div>
      </div>
    );
  }

  const values = series.map((d) => d.accesses);
  const max = Math.max(...values);
  // Mid arredondado pro inteiro de cima (max=5 → 3) — leitura mais natural
  // que 2.5. Quando max=0, todos os labels viram 0 e o gráfico fica flat
  // sem quebrar.
  const midValue = Math.ceil(max / 2);

  // Gera os índices dos dias que ganham label no eixo X (evenly spaced).
  // Inclui sempre primeiro e último ponto pras pontas baterem com "há Xd"
  // e "hoje" — leitura mantém a referência temporal.
  const tickCount = X_TICKS_BY_RANGE[range] || 6;
  const xTicks = [];
  for (let i = 0; i < tickCount; i++) {
    const idx = Math.round((i / (tickCount - 1)) * (series.length - 1));
    xTicks.push(idx);
  }

  // Pluralização do tooltip. 1 acesso vs N acessos.
  const fmtAccesses = (n) => `${n} ${n === 1 ? "acesso" : "acessos"}`;

  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-4">
      <div className="flex items-baseline justify-between mb-1">
        <div>
          <h3 className="text-sm font-semibold text-fg">Acessos ao longo do tempo</h3>
          <p className="text-[11px] text-fg-subtle">Últimos {range} dias · pico de {max} acessos/dia</p>
        </div>
        <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
          Pageviews
        </div>
      </div>
      {/* Layout em duas bands verticais: faixa de anotações ACIMA do gráfico
          (espaço dedicado, não sobrepõe a linha) + área do chart. As linhas
          tracejadas verticais correm pela área do chart, ancoradas no mesmo
          X de cada label, mantendo a leitura "evento → spike".
          Padding-left abre o gutter pro eixo Y; chart e ticks do eixo X
          herdam o mesmo offset, mantendo alinhamento vertical. */}
      <div className="relative mt-3" style={{ paddingLeft: Y_AXIS_GUTTER_PX }}>
        {/* Eixo Y — 3 ticks (max / mid / 0), alinhados às bordas do chart.
            Posicionados absolutamente pra não disputar layout com o chart.
            top-[24px] desce pra baixo da band de anotações. */}
        <div
          aria-hidden
          className="absolute left-0 top-[25px] h-[120px] flex flex-col justify-between text-[10px] text-fg-subtle font-mono tabular-nums select-none"
          style={{ width: Y_AXIS_GUTTER_PX - 6 }}
        >
          <span className="text-right leading-none">{max}</span>
          <span className="text-right leading-none">{midValue}</span>
          <span className="text-right leading-none">0</span>
        </div>

        <div className="relative h-[24px] mb-1">
          <div className="absolute inset-0 flex">
            {series.map((d, i) => {
              const anno = annotations.find((a) => a.day === i);
              if (!anno) return <div key={i} className="flex-1" />;
              return (
                <div key={i} className="flex-1 relative">
                  <span className={cn(
                    "absolute bottom-0 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md px-1.5 py-0.5",
                    "text-[9.5px] font-semibold uppercase tracking-wider shadow-sm",
                    anno.tone === "signature" ? "bg-signature/15 text-signature" : "bg-success/15 text-success",
                  )}>
                    {anno.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div
          className="relative h-[120px]"
          onMouseLeave={() => setHoverIdx(null)}
        >
          <SparklineV2
            values={values}
            // Força baseline = 0 pra dot/label do tooltip pousar exatamente
            // na coordenada que o label "0" do eixo Y indica. Sem isso,
            // sparkline escala min(values)→max e a base do gráfico flutua.
            minValue={0}
            width={800}
            height={120}
            fillOpacity={0.22}
            strokeWidth={2}
            className="w-full h-full"
            ariaLabel="Timeline de acessos"
          />
          {/* Linhas tracejadas das anotações (não-interativas, por isso
              pointer-events-none — não roubam hover das hit zones abaixo). */}
          <div className="pointer-events-none absolute inset-0 flex">
            {series.map((d, i) => {
              const anno = annotations.find((a) => a.day === i);
              if (!anno) return <div key={i} className="flex-1" />;
              return (
                <div key={i} className="flex-1 relative">
                  <div className={cn(
                    "absolute top-0 bottom-0 left-1/2 w-px border-l border-dashed",
                    anno.tone === "signature" ? "border-signature/60" : "border-success/60",
                  )} />
                </div>
              );
            })}
          </div>
          {/* Hit zones: 1 cell por dia, captura hover. Renderiza guia
              vertical, dot na posição do valor e tooltip flutuante.
              Mesma estrutura flex das anotações pra alinhar com pontos
              do sparkline (que também distribui i/(N-1) ao longo do width).
              `bottom: (v/max)*100%` casa com a fórmula da SparklineV2
              quando minValue=0 — ambos usam mesma escala 0→max. */}
          <div className="absolute inset-0 flex">
            {series.map((d, i) => {
              const isHover = hoverIdx === i;
              // Posição vertical do dot em px, replicando o cálculo interno
              // do SparklineV2 (usableH centrado entre padY top/bottom).
              // bottom-px do CENTRO da linha = padY + (v/max) * usableH;
              // do BOTTOM-edge do dot = centro - raio.
              const linePxFromBottom = max > 0
                ? SPARKLINE_PAD_Y_PX + (d.accesses / max) * SPARKLINE_USABLE_H_PX
                : SPARKLINE_PAD_Y_PX;
              const dotBottomPx = linePxFromBottom - TOOLTIP_DOT_RADIUS_PX;
              const isLastDay = i === series.length - 1;
              const isFirstDay = i === 0;
              return (
                <div
                  key={i}
                  className="flex-1 relative cursor-default"
                  onMouseEnter={() => setHoverIdx(i)}
                >
                  {isHover && (
                    <>
                      <div className="pointer-events-none absolute top-0 bottom-0 left-1/2 w-px bg-fg-subtle/35" />
                      <div
                        className="pointer-events-none absolute left-1/2 w-2 h-2 rounded-full bg-signature ring-2 ring-canvas-elevated"
                        style={{
                          bottom: `${dotBottomPx}px`,
                          transform: "translateX(-50%)",
                        }}
                      />
                      <div
                        className={cn(
                          "pointer-events-none absolute -top-7 whitespace-nowrap rounded-md bg-fg text-canvas-elevated",
                          "px-2 py-1 text-[10.5px] font-medium tabular-nums shadow-md",
                          // Próximo das bordas, ancora pela borda pra não cortar.
                          isFirstDay ? "left-0"
                          : isLastDay ? "right-0"
                          : "left-1/2 -translate-x-1/2",
                        )}
                      >
                        <span className="font-mono">{isLastDay ? "hoje" : fmtDayMonth(series.length - 1 - i)}</span>
                        <span className="opacity-50 mx-1">·</span>
                        <span>{fmtAccesses(d.accesses)}</span>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {/* Eixo X — ticks de data evenly spaced. Cada cell usa flex-1 igual
          às cells do chart, então labels alinham exatamente com os pontos
          do gráfico acima. Primeiro/último label encostam nas bordas
          (text-left / text-right) pra não cortar. Herda o mesmo
          padding-left do wrapper pra alinhar com o chart. */}
      <div
        className="mt-2 flex text-[10px] text-fg-subtle font-mono tabular-nums"
        style={{ paddingLeft: Y_AXIS_GUTTER_PX }}
      >
        {series.map((_, i) => {
          const isTick = xTicks.includes(i);
          if (!isTick) return <div key={i} className="flex-1" />;
          const isFirst = i === xTicks[0];
          const isLast  = i === xTicks[xTicks.length - 1];
          return (
            <div
              key={i}
              className={cn(
                "flex-1 relative",
                isFirst ? "text-left" : isLast ? "text-right" : "text-center",
              )}
            >
              <span
                className={cn(
                  "whitespace-nowrap",
                  // Pontas: ancora direto na cell; centro: absolute centralizado
                  // pra não duplicar largura quando a label é mais larga que a cell.
                  !isFirst && !isLast && "absolute left-1/2 -translate-x-1/2",
                )}
              >
                {isLast ? "hoje" : fmtDayMonth(series.length - 1 - i)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Abas mais vistas ──────────────────────────────────────────────────
function TabsCard({ tabs, loading }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-4 h-full">
        <SkelBox className="h-4 w-40 mb-4" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="mb-3 last:mb-0">
            <div className="flex justify-between mb-1">
              <SkelBox className="h-3 w-24" />
              <SkelBox className="h-3 w-6" />
            </div>
            <SkelBox className="h-1.5 w-full" />
          </div>
        ))}
      </div>
    );
  }
  // Math.max([]) = -Infinity → divisão dá -0 mas vira string "0%" OK.
  // Empty state explícito é mais honesto pro admin que vê o card vazio.
  if (!tabs || tabs.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-4 h-full">
        <h3 className="text-sm font-semibold text-fg mb-2">Abas mais acessadas</h3>
        <p className="text-[12px] text-fg-subtle italic py-1">
          Sem dados de navegação no período.
        </p>
      </div>
    );
  }
  const max = Math.max(...tabs.map((t) => t.views), 1);
  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-4 h-full">
      <h3 className="text-sm font-semibold text-fg mb-3">Abas mais acessadas</h3>
      <div className="space-y-2.5">
        {tabs.map((t) => {
          const pct = (t.views / max) * 100;
          return (
            <div key={t.name}>
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[12px] text-fg">{t.name}</span>
                <span className="text-[11px] font-semibold text-fg-muted tabular-nums">{t.views}</span>
              </div>
              <div className="h-1.5 rounded-full bg-canvas-deeper overflow-hidden">
                <div
                  className="h-full rounded-full bg-signature/80"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── CTAs clicados ────────────────────────────────────────────────────
// Card "Cliques em ações" — ranking de cliques em botões trackáveis do
// report (Abrir Sheets, Download CSV, etc). Mesma estrutura visual do
// TabsCard pra consistência. Skeleton enquanto loading; empty state
// explícito quando não houve cliques no período.
function CtasCard({ ctas, loading }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-4">
        <SkelBox className="h-4 w-40 mb-4" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="mb-3 last:mb-0">
            <div className="flex justify-between mb-1">
              <SkelBox className="h-3 w-32" />
              <SkelBox className="h-3 w-6" />
            </div>
            <SkelBox className="h-1.5 w-full" />
          </div>
        ))}
      </div>
    );
  }
  if (!ctas || ctas.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-4">
        <h3 className="text-sm font-semibold text-fg mb-2">Cliques em ações</h3>
        <p className="text-[12px] text-fg-subtle italic py-1">
          Nenhum CTA clicado no período.
        </p>
      </div>
    );
  }
  const max = Math.max(...ctas.map((c) => c.clicks), 1);
  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-4">
      <h3 className="text-sm font-semibold text-fg mb-3">Cliques em ações</h3>
      <div className="space-y-2.5">
        {ctas.map((c) => {
          const pct = (c.clicks / max) * 100;
          return (
            <div key={c.id}>
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[12px] text-fg">{c.label}</span>
                <span className="text-[11px] font-semibold text-fg-muted tabular-nums">{c.clicks}</span>
              </div>
              <div className="h-1.5 rounded-full bg-canvas-deeper overflow-hidden">
                <div
                  className="h-full rounded-full bg-success/80"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Device breakdown ──────────────────────────────────────────────────
function DeviceCard({ devices, loading }) {
  const TONE = {
    Desktop: "bg-signature",
    Mobile:  "bg-success",
    Tablet:  "bg-warning",
  };
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-4 h-full">
        <SkelBox className="h-4 w-32 mb-4" />
        <SkelBox className="h-2 w-full mb-3" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2.5 mb-2 last:mb-0">
            <SkelBox className="w-2 h-2 rounded-sm" />
            <SkelBox className="h-3 w-20 flex-1" />
            <SkelBox className="h-3 w-10" />
          </div>
        ))}
      </div>
    );
  }
  if (!devices || devices.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-4 h-full">
        <h3 className="text-sm font-semibold text-fg mb-2">Dispositivos</h3>
        <p className="text-[12px] text-fg-subtle italic py-1">
          Sem dados de dispositivo no período.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-4 h-full">
      <h3 className="text-sm font-semibold text-fg mb-3">Dispositivos</h3>
      <div className="flex h-2 rounded-full overflow-hidden mb-3 bg-canvas-deeper">
        {devices.map((d) => (
          <div
            key={d.name}
            className={TONE[d.name] || "bg-fg-subtle"}
            style={{ width: `${d.share * 100}%` }}
          />
        ))}
      </div>
      <div className="space-y-2">
        {devices.map((d) => (
          <div key={d.name} className="flex items-center gap-2.5 text-[12px]">
            <span className={cn("w-2 h-2 rounded-sm", TONE[d.name] || "bg-fg-subtle")} />
            <span className="text-fg flex-1">{d.name}</span>
            <span className="font-semibold text-fg-muted tabular-nums">
              {(d.share * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Heatmap dia × hora ────────────────────────────────────────────────
function HeatmapCard({ heatmap, loading }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-4">
        <div className="flex justify-between mb-3">
          <SkelBox className="h-4 w-36" />
          <SkelBox className="h-3 w-32" />
        </div>
        <div className="grid grid-cols-[32px_repeat(24,minmax(0,1fr))] gap-0.5">
          {Array.from({ length: 7 * 25 }).map((_, i) => (
            i % 25 === 0
              ? <SkelBox key={i} className="h-3 w-6" />
              : <SkelBox key={i} className="aspect-square" />
          ))}
        </div>
      </div>
    );
  }
  return _HeatmapCardImpl({ heatmap });
}

function _HeatmapCardImpl({ heatmap }) {
  const DAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
  const TONE = [
    "bg-canvas-deeper",
    "bg-signature/25",
    "bg-signature/55",
    "bg-signature",
  ];
  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-fg">Horários de pico</h3>
        <p className="text-[11px] text-fg-subtle">Dia × hora · últimos 30d</p>
      </div>
      <div className="overflow-x-auto">
        <div className="inline-block min-w-full">
          {/* Cabeçalho de horas */}
          <div className="grid grid-cols-[32px_repeat(24,minmax(0,1fr))] gap-0.5 mb-1">
            <div />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="text-[9px] text-fg-subtle text-center tabular-nums">
                {h % 6 === 0 ? `${h}h` : ""}
              </div>
            ))}
          </div>
          {heatmap.map((row, d) => (
            <div key={d} className="grid grid-cols-[32px_repeat(24,minmax(0,1fr))] gap-0.5 mb-0.5">
              <div className="text-[10px] text-fg-subtle font-semibold flex items-center">
                {DAYS[d]}
              </div>
              {row.map((v, h) => (
                <div
                  key={h}
                  className={cn("aspect-square rounded-sm", TONE[v])}
                  title={`${DAYS[d]} ${h}h — ${v === 0 ? "sem acessos" : v === 1 ? "baixo" : v === 2 ? "médio" : "alto"}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 text-[10px] text-fg-subtle">
        <span>Menos</span>
        {TONE.map((t, i) => (
          <span key={i} className={cn("w-3 h-3 rounded-sm", t)} />
        ))}
        <span>Mais</span>
      </div>
    </div>
  );
}

// ─── Sessões recentes ──────────────────────────────────────────────────
function SessionsCard({ sessions, loading }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-4">
        <div className="flex justify-between mb-3">
          <SkelBox className="h-4 w-32" />
          <SkelBox className="h-3 w-24" />
        </div>
        <div className="divide-y divide-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="py-2.5 flex items-center gap-3">
              <SkelBox className="h-3 w-16" />
              <SkelBox className="h-3 w-20" />
              <SkelBox className="h-3 w-14" />
              <div className="flex gap-1 flex-1">
                <SkelBox className="h-4 w-16" />
                <SkelBox className="h-4 w-14" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (!sessions || sessions.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-4">
        <h3 className="text-sm font-semibold text-fg mb-2">Sessões recentes</h3>
        <p className="text-[12px] text-fg-subtle italic py-1">
          Sem sessões registradas no período.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-fg">Sessões recentes</h3>
        <p className="text-[11px] text-fg-subtle">Últimas {sessions.length} visitas</p>
      </div>
      <div className="divide-y divide-border">
        {sessions.map((s) => (
          <div key={s.id} className="py-2.5 flex items-center gap-3 text-[12px]">
            <span className="text-fg-subtle font-mono tabular-nums w-[72px]">
              {fmtRelative(s.minutesAgo)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <DeviceIcon device={s.device} />
              <span className="text-fg-muted">{s.device}</span>
            </span>
            <span className="text-fg-muted tabular-nums w-[70px]">
              {fmtDuration(s.durationSec)}
            </span>
            <div className="flex-1 min-w-0 flex items-center gap-1 flex-wrap">
              {s.tabs.slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="rounded-md bg-surface-strong border border-border px-1.5 py-0.5 text-[10.5px] text-fg-muted"
                >
                  {t}
                </span>
              ))}
              {s.tabs.length > 3 && (
                <span className="text-[10.5px] text-fg-subtle">
                  +{s.tabs.length - 3}
                </span>
              )}
            </div>
            {s.internal && (
              <span className="shrink-0 rounded-md bg-warning-soft border border-warning/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warning">
                Interno
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Log de mudanças do admin ──────────────────────────────────────────
// Lista de ações que o admin executou no report (anexar Loom, trocar
// owner, reenviar link, etc.). Pareado com a timeline acima: dois eventos
// (link_resent, creative_added) batem com os spikes — admin escaneia o
// gráfico, desce até aqui e fecha o loop "fiz X → cliente acessou Y vezes".
const CHANGELOG_TONE = {
  link_resent:     "signature",
  creative_added:  "success",
  loom_added:      "signature",
  loom_replaced:   "signature",
  owner_changed:   "default",
  survey_created:  "signature",
  survey_updated:  "default",
  logo_changed:    "default",
  merge_linked:    "signature",
  abs_toggled:     "default",
  pacing_note:     "default",
  rmnd_uploaded:   "default",
  pdooh_uploaded:  "default",
};

const CHANGELOG_ICONS = {
  link_resent: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  ),
  creative_added: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  ),
  loom_added: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  ),
  loom_replaced: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  ),
  owner_changed: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </svg>
  ),
  survey_created: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 12h6M9 8h6M9 16h6" />
    </svg>
  ),
  survey_updated: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 12h6M9 8h6M9 16h6" />
    </svg>
  ),
  logo_changed: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  ),
  merge_linked: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6"  cy="6"  r="3" />
      <circle cx="6"  cy="18" r="3" />
      <circle cx="18" cy="12" r="3" />
      <path d="M9 6c4 0 6 2 6 6M9 18c4 0 6-2 6-6" />
    </svg>
  ),
  abs_toggled: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  pacing_note: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
  rmnd_uploaded: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
    </svg>
  ),
  pdooh_uploaded: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="14" rx="2" />
      <path d="M2 9h20" />
    </svg>
  ),
};

const fmtDaysAgo = (d) => {
  if (d == null) return "—";
  if (d === 0) return "hoje";
  if (d === 1) return "ontem";
  return `há ${d}d`;
};

// Limite inicial — mostra os N mais recentes; "Ver mais" expande inline.
// Evita scroll aninhado dentro do modal (modal já tem o seu próprio scroll
// e dois scrolls competindo deixa a navegação confusa). Progressive
// disclosure mantém o card compacto por default e dá controle ao admin.
const CHANGELOG_DEFAULT_LIMIT = 6;

function AdminChangelogCard({ changelog, loading }) {
  const [expanded, setExpanded] = useState(false);
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-4">
        <div className="flex justify-between mb-3">
          <SkelBox className="h-4 w-40" />
          <SkelBox className="h-3 w-28" />
        </div>
        <div className="relative">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="relative pl-6 py-2 flex items-start gap-3">
              <SkelBox className="absolute left-0 top-3 w-[11px] h-[11px] rounded-full" />
              <SkelBox className="h-3 w-12" />
              <SkelBox className="h-3 w-3" />
              <SkelBox className="h-3 flex-1 max-w-[280px]" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  const hasMore = changelog.length > CHANGELOG_DEFAULT_LIMIT;
  const visible = expanded ? changelog : changelog.slice(0, CHANGELOG_DEFAULT_LIMIT);
  const hiddenCount = changelog.length - CHANGELOG_DEFAULT_LIMIT;

  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-fg">Log de mudanças (admin)</h3>
        <p className="text-[11px] text-fg-subtle">{changelog.length} eventos · últimos 30d</p>
      </div>
      {changelog.length === 0 ? (
        <p className="text-[12px] text-fg-subtle italic py-2">Sem eventos no período.</p>
      ) : (
        <>
          <ol className="relative">
            <span aria-hidden className="absolute left-[5px] top-2 bottom-2 w-px bg-border" />
            {visible.map((ev) => {
              const tone = CHANGELOG_TONE[ev.type] || "default";
              const dotClass =
                tone === "signature" ? "bg-signature"
                : tone === "success"  ? "bg-success"
                : "bg-fg-subtle";
              const iconClass =
                tone === "signature" ? "text-signature"
                : tone === "success"  ? "text-success"
                : "text-fg-muted";
              return (
                <li key={ev.id} className="relative pl-6 py-2 flex items-start gap-3 text-[12px]">
                  <span
                    aria-hidden
                    className={cn(
                      "absolute left-0 top-3 w-[11px] h-[11px] rounded-full border-2 border-canvas-elevated",
                      dotClass,
                    )}
                  />
                  <span className="text-fg-subtle font-mono tabular-nums w-[58px] shrink-0 pt-0.5">
                    {fmtDaysAgo(ev.daysAgo)}
                  </span>
                  <span className={cn("shrink-0 mt-0.5", iconClass)}>
                    {CHANGELOG_ICONS[ev.type] || CHANGELOG_ICONS.pacing_note}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-fg leading-snug">
                      <span className="font-semibold">{ev.author}</span>{" "}
                      <span className="text-fg-muted">{ev.msg}</span>
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
          {hasMore && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={cn(
                "mt-2 w-full text-[11.5px] font-semibold py-2 rounded-md cursor-pointer",
                "text-signature hover:bg-signature/8 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature/40",
              )}
            >
              {expanded ? "Mostrar menos" : `Ver mais ${hiddenCount} ${hiddenCount === 1 ? "evento" : "eventos"}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function DeviceIcon({ device }) {
  if (device === "Mobile") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-subtle">
        <rect x="7" y="3" width="10" height="18" rx="2" />
        <path d="M11 18h2" />
      </svg>
    );
  }
  if (device === "Tablet") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-subtle">
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M11 18h2" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-subtle">
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

// ─── Disclaimer "Tracking iniciado em DD/MM" ──────────────────────────
//
// Aparece somente nos primeiros 90 dias após o launch do tracking — depois
// disso, a base é grande o suficiente pra falar por si. Sem data
// (tracking ainda zero events globalmente), mostra mensagem simples.
function TrackingStartDisclaimer({ date }) {
  // Calcula dias desde o launch a partir do MIN(created_at) do backend.
  // Se a base ainda não tem eventos (deploy day 0 sem nenhum acesso),
  // date é null — mostramos texto neutro explicando que pode demorar.
  if (!date) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-canvas-deeper/40 px-3 py-2.5 text-[11px] text-fg-subtle flex items-start gap-2">
        <InfoIcon />
        <p>
          <strong className="text-fg-muted">Tracking habilitado.</strong> Os primeiros acessos podem levar até 24h pra aparecer aqui — o rollup diário processa o dado da véspera de manhã.
        </p>
      </div>
    );
  }

  const startDate = new Date(date);
  const daysSinceLaunch = Math.floor((Date.now() - startDate.getTime()) / 86_400_000);
  if (daysSinceLaunch > 90) return null;

  const dd = String(startDate.getDate()).padStart(2, "0");
  const mm = String(startDate.getMonth() + 1).padStart(2, "0");
  const yyyy = startDate.getFullYear();

  return (
    <div className="rounded-lg border border-dashed border-border bg-canvas-deeper/40 px-3 py-2.5 text-[11px] text-fg-subtle flex items-start gap-2">
      <InfoIcon />
      <p>
        <strong className="text-fg-muted">Tracking iniciado em {dd}/{mm}/{yyyy}.</strong>{" "}
        Acessos anteriores não foram registrados — a base completa de comparação aparece a partir de {daysSinceLaunch >= 30 ? "30d do início" : "30 dias do início"}.
      </p>
    </div>
  );
}

function InfoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}
