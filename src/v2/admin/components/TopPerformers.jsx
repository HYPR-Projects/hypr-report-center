// src/v2/admin/components/TopPerformers.jsx
//
// Layout dedicado de leaderboard — usado pelo LayoutToggle quando
// `layout === "performers"`. Mostra ranking de CS ou CP (toggle interno)
// com métricas agregadas completas em cada linha.
//
// Score vem de aggregation.js#computeTopPerformers. Só Display contribui
// pra eCPM/CTR; Video é avaliado apenas via Pacing + VTR. ABS torna os
// thresholds Display mais permissivos (inventário com pre-bid é mais caro):
//   eCPM    Display < R$ 0,70 / R$ 1,50 ABS  (30 pts × peso Display)
//   CTR     Display > 0,7% / 0,5% ABS        (25 pts × peso Display)
//   VTR     Video   > 80%                    (10 pts × peso Video)
//   Pacing  100–125% gradiente               (35 pts, ponderado entre mídias)
// Max teórico: 100% Display = 90 pts | 100% Video = 45 pts | 50/50 = 67.5.
// Score normalizado pelo max_total da composição, frame "X / max" justo.
//
// Cada linha exibe:
//   - rank · avatar (iniciais) · nome
//   - 4 micro-metrics: Pacing DSP / Pacing VID / CTR / VTR / eCPM
//   - score numérico + barra de progresso colorida por banda
//
// O componente recebe `campaigns` e o `teamMap` e calcula internamente
// os rankings de CS e CP — assim o caller só precisa passar dados crus.

import { useState, useMemo, useEffect, useRef } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import { ptBR } from "date-fns/locale";
import { format } from "date-fns";
import "react-day-picker/style.css";
import "../../components/DateRangeFilterV2.css";
import { cn } from "../../../ui/cn";
import { formatBRL } from "../lib/format";
import { computeTopPerformers } from "../lib/aggregation";
import { saveDailySnapshot, getPreviousScore, loadSnapshots } from "../lib/scoreSnapshots";
import { PERIOD_PRESETS, resolvePeriod, formatPeriodLabel } from "../lib/period";
import { ymd, parseYmd } from "../../../shared/dateFilter";
import { listPerformersForPeriod } from "../../../lib/api";
import { PerformerDrawer } from "./PerformerDrawer";

function localPartFromEmail(email) {
  if (!email) return "";
  return email.split("@")[0].replace(/[._-]+/g, " ").trim();
}

function initialsFor(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function scoreTone(score) {
  if (score >= 80) return "success";
  if (score >= 60) return "signature";
  if (score >= 40) return "warning";
  return "danger";
}

function tonePacing(value) {
  if (value == null) return "muted";
  if (value < 90)  return "danger";
  if (value < 100) return "warning";
  if (value < 125) return "success";
  return "signature";
}

function toneEcpm(value) {
  if (value == null) return "muted";
  if (value < 0.70) return "success";
  if (value < 0.80) return "warning";
  return "danger";
}

function toneCtr(value) {
  if (value == null)  return "muted";
  if (value >= 0.6)   return "success";
  if (value >= 0.5)   return "warning";
  return "danger";
}

function toneVtr(value) {
  if (value == null) return "muted";
  return value >= 80 ? "success" : "danger";
}

const BAR_BG = {
  success:   "bg-success",
  signature: "bg-signature",
  warning:   "bg-warning",
  danger:    "bg-danger",
};

const TEXT_TONE = {
  muted:     "text-fg-subtle",
  success:   "text-success",
  signature: "text-signature",
  warning:   "text-warning",
  danger:    "text-danger",
  fg:        "text-fg",
};

function formatPctInt(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}
function formatPctTwo(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(Math.round(value * 100) / 100).toFixed(2)}%`;
}

function MicroMetric({ label, value, tone = "fg" }) {
  // Divisor vertical só aparece quando a row vira layout horizontal (lg+),
  // onde as 6 micro-métricas ficam lado-a-lado entre identidade e score.
  // Em telas menores, a row quebra em stack e o divisor seria ruído.
  return (
    <div className="flex flex-col gap-1 min-w-0 lg:pl-3 lg:border-l lg:border-border/40 lg:first:border-l-0 lg:first:pl-0">
      <span className="text-[9px] uppercase tracking-widest font-bold text-fg-subtle whitespace-nowrap leading-none">
        {label}
      </span>
      <span className={cn(
        "text-sm font-semibold tabular-nums whitespace-nowrap leading-none",
        TEXT_TONE[tone] || TEXT_TONE.fg
      )}>
        {value}
      </span>
    </div>
  );
}

function ScoreDelta({ current, previous }) {
  if (current == null || !previous) return null;
  const delta = current - previous.score;
  const rounded = Math.round(delta * 10) / 10;
  // Label adapta ao gap: "vs ontem" se daysAgo=1, "vs Xd" se maior.
  const label = previous.daysAgo === 1 ? "vs ontem" : `vs ${previous.daysAgo}d`;
  if (Math.abs(rounded) < 0.1) {
    return (
      <span className="text-[10px] text-fg-subtle font-medium tabular-nums whitespace-nowrap">
        ▬ {label}
      </span>
    );
  }
  const isUp = rounded > 0;
  return (
    <span className={cn(
      "text-[10px] font-semibold tabular-nums whitespace-nowrap",
      isUp ? "text-success" : "text-danger"
    )}>
      {isUp ? "▲" : "▼"} {Math.abs(rounded).toFixed(1)} <span className="text-fg-subtle font-normal">{label}</span>
    </span>
  );
}

function PerformerRow({ rank, performer, displayName, scorePrev, onClick }) {
  const {
    email, score, breakdown: bd, campaign_count, ideal_pacing_count,
    dsp_pacing, vid_pacing, ctr, vtr, ecpm_display, ecpm_video, ecpm_avg,
  } = performer;
  // Fallback: payload antigo (sem split por mídia) cai no ecpm_avg como
  // se fosse Display — VideoecPM fica null e renderiza "—" sem cor.
  const ecpmDisplay = ecpm_display ?? ecpm_avg;
  const ecpmVideo   = ecpm_video ?? null;
  const name = displayName || localPartFromEmail(email);
  // max_total dinâmico: campanhas só-video têm max ~45, só-display ~90.
  // Score do CS é a média ponderada — então o max também é ponderado.
  // scoreTone consome % (0-100) pra manter thresholds absolutos.
  const maxTotal = bd ? (bd.max_pacing + bd.max_ecpm + bd.max_ctr + bd.max_vtr) : 100;
  const scorePct = maxTotal > 0 ? (score / maxTotal) * 100 : 0;
  const tone = scoreTone(scorePct);
  const initials = initialsFor(name);

  // Layout responsivo:
  //   • Mobile (<lg): empilha em duas linhas — identidade+score na 1ª, grid
  //     de micro-métricas (3 colunas) na 2ª. Larguras fixas das colunas
  //     desktop (w-[220px]/w-[200px]) eram a causa do overlap no mobile;
  //     em flex-row sem gap suficiente, os 3 blocos brigavam pelo mesmo
  //     espaço e o do meio era esmagado.
  //   • Desktop (lg+): row única horizontal com identidade · 6 métricas · score.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(); } }}
      className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4 px-3 lg:px-4 py-3 lg:py-4 rounded-lg hover:bg-canvas-deeper transition-colors border-t border-border/40 first:border-t-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1"
    >
      {/* Linha 1 mobile (rank + identidade + score). Em desktop tudo
          continua inline — o flex container pai vira lg:flex-row. */}
      <div className="flex items-center gap-3 lg:contents">
        <span className="text-[11px] font-bold text-fg-subtle tabular-nums w-5 text-center flex-shrink-0">
          {rank}
        </span>

        {/* Identidade — mobile flex-1 (ocupa o espaço entre rank e score),
            desktop largura fixa pra alinhar colunas entre rows. */}
        <div className="flex items-center gap-3 min-w-0 flex-1 lg:flex-none lg:w-[220px] lg:flex-shrink-0">
          <span className="w-9 h-9 rounded-full bg-signature-soft text-signature font-bold text-xs flex items-center justify-center flex-shrink-0">
            {initials}
          </span>
          <div className="min-w-0 flex flex-col">
            <span className="text-sm font-semibold text-fg truncate capitalize">
              {name}
            </span>
            <span className="text-[11px] text-fg-subtle tabular-nums">
              {campaign_count} ativa{campaign_count === 1 ? "" : "s"}
              {ideal_pacing_count > 0 && (
                <> · {ideal_pacing_count}/{campaign_count} ideal</>
              )}
            </span>
          </div>
        </div>

        {/* Score mobile-compact (só número + delta, sem barra) à direita.
            Em desktop, este bloco fica escondido — a versão completa com
            barra renderiza depois das métricas (ver abaixo). */}
        <div className="flex flex-col items-end gap-0.5 flex-shrink-0 lg:hidden">
          <span className={cn(
            "text-lg font-bold tabular-nums leading-none",
            TEXT_TONE[tone]
          )}>
            {Math.round(score)}
            <span className="text-fg-subtle text-[10px] font-normal">/{Math.round(maxTotal)}</span>
          </span>
          <ScoreDelta current={score} previous={scorePrev} />
        </div>
      </div>

      {/* Barra de score full-width no mobile (entre identidade e métricas).
          Some no desktop — lá a barra fica junto do número (col score). */}
      <div className="lg:hidden h-1.5 rounded-full bg-surface-strong overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-300", BAR_BG[tone])}
          style={{ width: `${Math.max(2, scorePct)}%` }}
        />
      </div>

      {/* Métricas agregadas. Mobile: grid 3 cols (cabe Pacing DSP/VID/CTR
          em uma linha, VTR/eCPM Disp/Vid na outra). Desktop: 6 cols
          inline com divisor vertical (border-l no MicroMetric). */}
      <div className="grid grid-cols-3 lg:flex-1 lg:grid-cols-6 gap-x-3 gap-y-2 min-w-0 pl-8 lg:pl-0">
        <MicroMetric label="Pacing DSP" value={formatPctInt(dsp_pacing)} tone={tonePacing(dsp_pacing)} />
        <MicroMetric label="Pacing VID" value={formatPctInt(vid_pacing)} tone={tonePacing(vid_pacing)} />
        <MicroMetric label="CTR"        value={formatPctTwo(ctr)}        tone={toneCtr(ctr)} />
        <MicroMetric label="VTR"        value={formatPctTwo(vtr)}        tone={toneVtr(vtr)} />
        <MicroMetric label="eCPM Disp"  value={formatBRL(ecpmDisplay)}   tone={toneEcpm(ecpmDisplay)} />
        <MicroMetric label="eCPM Vid"   value={formatBRL(ecpmVideo)}     tone="fg" />
      </div>

      {/* Score desktop (barra + número juntos, à direita). Some no mobile
          — versão compacta renderiza no header da row (ver acima). */}
      <div className="hidden lg:flex items-center gap-3 w-[200px] flex-shrink-0">
        <div className="flex-1 h-1.5 rounded-full bg-surface-strong overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-300", BAR_BG[tone])}
            style={{ width: `${Math.max(2, scorePct)}%` }}
          />
        </div>
        <div className="flex flex-col items-end gap-0.5 w-14">
          <span className={cn(
            "text-lg font-bold tabular-nums leading-none",
            TEXT_TONE[tone]
          )}>
            {Math.round(score)}
            <span className="text-fg-subtle text-[10px] font-normal">/{Math.round(maxTotal)}</span>
          </span>
          <ScoreDelta current={score} previous={scorePrev} />
        </div>
      </div>
    </div>
  );
}

export function PerformersLayout({ campaigns, teamMap = {}, onOpenReport }) {
  const [role, setRole] = useState("cs");
  const [snapshots, setSnapshots] = useState(() => loadSnapshots());
  const [selected, setSelected] = useState(null); // performer email selecionado

  // Filtro de período. preset="now" (default) usa props.campaigns sem fetch
  // — comportamento original mantido. Qualquer outro preset dispara fetch ao
  // backend e re-agrega métricas dentro da janela.
  const [preset, setPreset] = useState("now");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [periodCampaigns, setPeriodCampaigns] = useState(null); // null = não fetcheado ainda
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  // Trigger pra forçar refetch manual sem mudar preset (botão "Tentar de novo").
  // Mudar este state re-dispara o useEffect mesmo quando o resto das deps é
  // idêntico — alternativa a tentar reusar o setPreset, que o React bail-out
  // ignora quando o valor é o mesmo.
  const [refetchKey, setRefetchKey] = useState(0);
  // SeqRef pra evitar race condition quando user troca de preset rápido —
  // resposta de fetch lento de um preset anterior não pode sobrescrever a do
  // preset atual.
  const fetchSeqRef = useRef(0);

  const isHistorical = preset !== "now";
  const { from, to } = useMemo(() => resolvePeriod(preset, custom), [preset, custom]);

  // Dispara fetch quando entra em modo histórico OU muda janela OU refetchKey
  // muda (botão de retry). Em modo "now" limpa o cache local — voltar a
  // "Agora" deve ser instantâneo (props.campaigns continua sendo a fonte).
  //
  // periodCampaigns(null) no início do fetch força o skeleton a aparecer
  // durante a transição entre presets — sem isso, a UI mostrava o subtitle do
  // novo período mas a lista do anterior (com opacity reduzida), criando
  // mismatch entre o que o cabeçalho prometia e o que a lista entregava.
  useEffect(() => {
    if (!isHistorical) {
      setPeriodCampaigns(null);
      setLoading(false);
      setFetchError(null);
      return;
    }
    if (!from || !to) return; // custom ainda incompleto
    const seq = ++fetchSeqRef.current;
    setPeriodCampaigns(null);
    setLoading(true);
    setFetchError(null);
    listPerformersForPeriod({ from, to })
      .then((data) => {
        if (seq !== fetchSeqRef.current) return; // resposta obsoleta
        setPeriodCampaigns(data);
        setLoading(false);
      })
      .catch((err) => {
        if (seq !== fetchSeqRef.current) return;
        setFetchError(err.message || "Erro ao carregar período");
        setLoading(false);
      });
  }, [isHistorical, from, to, refetchKey]);

  // Fonte ativa: props.campaigns no modo Agora, periodCampaigns no histórico.
  const sourceCampaigns = isHistorical ? periodCampaigns : campaigns;

  const performers = useMemo(() => {
    if (!sourceCampaigns) return [];
    return computeTopPerformers(
      sourceCampaigns,
      role === "cs" ? "cs_email" : "cp_email",
      { requireCurrentlyActive: !isHistorical },
    );
  }, [sourceCampaigns, role, isHistorical]);

  const selectedPerformer = useMemo(
    () => (selected ? performers.find((p) => p.email === selected) : null),
    [selected, performers]
  );

  // Snapshot diário só faz sentido em modo "Agora" — em modo histórico, o
  // score reflete uma janela passada e não deve poluir a série de deltas
  // (que assume "score do dia atual").
  useEffect(() => {
    if (isHistorical || !performers.length) return;
    const next = saveDailySnapshot(role, performers);
    setSnapshots(next);
  }, [role, performers, isHistorical]);

  if (!campaigns || !campaigns.length) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <p className="text-sm text-fg-muted">Nenhuma campanha pra ranquear.</p>
      </div>
    );
  }

  const periodLabel = isHistorical ? formatPeriodLabel(preset, from, to) : null;
  const subtitleSuffix = isHistorical
    ? `com entrega no período (${periodLabel})`
    : "com campanhas ativas";

  return (
    <div className="space-y-4">
      {/* Header com toggle CS/CP + descrição */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-fg">
            Top Performers — {role === "cs" ? "CS" : "CP"}
            {loading && (
              <span className="ml-2 text-[11px] font-medium text-fg-subtle">
                carregando…
              </span>
            )}
          </h2>
          <p className="text-[11px] text-fg-subtle mt-0.5">
            Ranking entre {performers.length}{" "}
            {role === "cs" ? "Customer Success" : "Customer Planner"}{" "}
            {subtitleSuffix}
          </p>
        </div>
        <RoleToggle value={role} onChange={setRole} />
      </div>

      {/* Filtro de período */}
      <PeriodPicker
        preset={preset}
        onPresetChange={setPreset}
        custom={custom}
        onCustomChange={setCustom}
      />

      {/* Lista */}
      {fetchError ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center">
          <p className="text-sm text-danger">Erro ao carregar período: {fetchError}</p>
          <button
            type="button"
            onClick={() => setRefetchKey((k) => k + 1)}
            className="mt-2 text-xs text-signature hover:underline"
          >
            Tentar de novo
          </button>
        </div>
      ) : loading && !performers.length ? (
        <PerformerSkeleton />
      ) : performers.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center">
          <p className="text-sm text-fg-muted">
            {isHistorical
              ? `Nenhum ${role === "cs" ? "CS" : "CP"} teve entrega no período (${periodLabel}).`
              : `Nenhum ${role === "cs" ? "CS" : "CP"} com campanhas ativas no momento.`}
          </p>
        </div>
      ) : (
        <div className={cn(
          "rounded-xl border border-border bg-surface overflow-hidden",
          loading && "opacity-60 transition-opacity"
        )}>
          {performers.map((p, i) => (
            <PerformerRow
              key={p.email}
              rank={i + 1}
              performer={p}
              displayName={teamMap[p.email]}
              // Delta vs ontem só faz sentido em modo "Agora" — em histórico,
              // os snapshots locais não pareiam com a janela escolhida.
              scorePrev={isHistorical ? null : getPreviousScore(snapshots, role, p.email)}
              onClick={() => setSelected(p.email)}
            />
          ))}
        </div>
      )}

      <PerformerDrawer
        performer={selectedPerformer}
        displayName={selectedPerformer ? teamMap[selectedPerformer.email] : null}
        onOpenReport={onOpenReport}
        onClose={() => setSelected(null)}
      />

      {/* Legenda */}
      <p className="text-[11px] text-fg-subtle px-1 leading-relaxed">
        Pacing 100–125% (35 pts, ponderado entre mídias) · eCPM Display
        &lt; R$ 0,70 (ABS R$ 1,50) (30 pts × peso Display) · CTR Display
        &gt; 0,7% (ABS 0,5%) (25 pts × peso Display) · VTR Video &gt; 80%
        (10 pts × peso Video). Quando a campanha tem brand safety pre-bid
        (ABS) ativo — DoubleVerify no DV360, DV/IAS no Xandr ou marcado
        manualmente — os thresholds eCPM/CTR de Display ficam mais
        permissivos. Video só contribui via Pacing e VTR — eCPM/CTR de
        Video não pontuam. Max teórico varia por composição (100% Display
        = 90 · 100% Video = 45 · 50/50 = 67.5); score é normalizado pelo
        max da campanha. Score do CS é a média ponderada por impressões
        das campanhas ativas. Métricas exibidas (Pacing/CTR/VTR/eCPM) são
        agregadas via Σnumerador / Σdenominador sobre as campanhas
        {isHistorical ? " com entrega no período" : " ativas"} do owner.
        {isHistorical && (
          <>
            {" "}
            <span className="text-warning">No modo histórico</span>, pacing
            = entregue na janela ÷ (contrato/dia × dias da janela que
            sobrepõem o contrato) — assume distribuição linear da entrega.
            Campanhas com entrega muito concentrada (front-loaded ou
            back-loaded) podem ter pacing distorcido na janela.
          </>
        )}
      </p>
    </div>
  );
}

function PeriodPicker({ preset, onPresetChange, custom, onCustomChange }) {
  // Popover do calendário custom. Fica controlado aqui pra:
  //   (a) auto-abrir quando o user clica no pill "Custom" sem range ainda
  //   (b) re-abrir clicando novamente quando já existe range (edita)
  //   (c) fechar ao aplicar via footer
  const [popoverOpen, setPopoverOpen] = useState(false);
  // Draft do range enquanto o popover está aberto — só aplica quando user
  // clica Aplicar. Sincronizado com `custom` ao abrir (callback determinístico,
  // mesma técnica do DateRangeFilterV2).
  const [draftRange, setDraftRange] = useState(() => customToRange(custom));

  const handleOpenChange = (open) => {
    if (open) setDraftRange(customToRange(custom));
    setPopoverOpen(open);
  };

  const handleCustomClick = () => {
    onPresetChange("custom");
    // Se já tem custom range aplicado, abre direto pra edição.
    // Se está virando custom agora, também abre — UX rápida.
    setDraftRange(customToRange(custom));
    setPopoverOpen(true);
  };

  const applyCustom = () => {
    if (draftRange?.from && draftRange?.to) {
      onCustomChange({ from: ymd(draftRange.from), to: ymd(draftRange.to) });
      setPopoverOpen(false);
    }
  };

  const cancelCustom = () => {
    setDraftRange(customToRange(custom));
    setPopoverOpen(false);
  };

  // Limita seleção: não permite datas no futuro. Não tem `min` — admin pode
  // querer comparar trimestres antigos.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const draftCount =
    draftRange?.from && draftRange?.to
      ? Math.round((draftRange.to - draftRange.from) / 86400000) + 1
      : 0;

  return (
    <div
      role="tablist"
      aria-label="Período do ranking"
      className="inline-flex flex-wrap gap-0.5 p-0.5 rounded-lg bg-canvas-deeper border border-border w-fit"
    >
      {PERIOD_PRESETS.map((opt) => {
        const active = preset === opt.id;
        if (opt.id === "custom") {
          // Pill "Custom" é o trigger do Popover. Quando ativo, mostra o
          // range escolhido (ex.: "15 abr → 30 abr") em vez do label "Custom".
          const customLabel =
            active && custom.from && custom.to
              ? formatRangeCompact(custom.from, custom.to)
              : opt.shortLabel;
          return (
            <Popover.Root key={opt.id} open={popoverOpen} onOpenChange={handleOpenChange}>
              <Popover.Trigger asChild>
                <button
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={handleCustomClick}
                  className={cn(
                    "inline-flex items-center gap-1 px-3 h-7 rounded-md cursor-pointer",
                    "text-xs font-medium",
                    "transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
                    active
                      ? "bg-canvas-elevated text-fg shadow-sm"
                      : "text-fg-muted hover:text-fg hover:bg-surface-strong",
                  )}
                >
                  {customLabel}
                  <ChevronDownPico
                    className={cn(
                      "size-2.5 text-fg-subtle transition-transform duration-200",
                      popoverOpen && "rotate-180",
                    )}
                  />
                </button>
              </Popover.Trigger>

              <Popover.Portal>
                <Popover.Content
                  align="end"
                  sideOffset={8}
                  collisionPadding={8}
                  // Animações: o Radix expõe data-[state=open|closed] e
                  // data-[side=...] pra Tailwind animar entrada/saída. fade +
                  // zoom suave + slide-from-top dá o "drop" natural do popover.
                  className={cn(
                    "z-50 rounded-xl overflow-hidden border border-border bg-surface-2 shadow-2xl",
                    "max-w-[calc(100vw-1rem)] sm:max-w-none",
                    "data-[state=open]:animate-in data-[state=closed]:animate-out",
                    "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                    "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
                    "data-[side=bottom]:slide-in-from-top-2",
                    "data-[side=top]:slide-in-from-bottom-2",
                  )}
                >
                  {/* DayPicker em modo range — clique 1 = from, clique 2 = to.
                      `defaultMonth` sincroniza com o from selecionado: se o
                      user já escolheu uma data em abril, ao reabrir cai em
                      abril direto. Sem from ainda, abre no mês atual.
                      `numberOfMonths={2}` mostra 2 meses lado a lado: range
                      cross-month fica visível sem precisar navegar. */}
                  <div className="p-3 rdp-hypr">
                    <DayPicker
                      mode="range"
                      locale={ptBR}
                      numberOfMonths={2}
                      pagedNavigation
                      selected={draftRange}
                      onSelect={setDraftRange}
                      disabled={{ after: today }}
                      defaultMonth={
                        draftRange?.from
                          ? draftRange.from
                          : new Date(today.getFullYear(), today.getMonth() - 1, 1)
                      }
                      weekStartsOn={0}
                    />
                  </div>

                  {/* Footer com contagem de dias + Aplicar/Cancelar */}
                  <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border bg-surface-2">
                    <div className="text-xs tabular-nums min-w-0">
                      {draftRange?.from && draftRange?.to ? (
                        <span className="text-fg-muted">
                          <span className="text-fg font-semibold">
                            {formatRangeCompact(ymd(draftRange.from), ymd(draftRange.to))}
                          </span>
                          <span className="ml-2">
                            · {draftCount} dia{draftCount !== 1 ? "s" : ""}
                          </span>
                        </span>
                      ) : draftRange?.from ? (
                        <span className="text-fg-subtle italic">
                          Selecione a data final
                        </span>
                      ) : (
                        <span className="text-fg-subtle italic">
                          Selecione um intervalo
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2 ml-auto">
                      <button
                        type="button"
                        onClick={cancelCustom}
                        className="px-3 h-7 rounded-md text-xs font-medium text-fg-muted hover:bg-surface-strong cursor-pointer transition-colors"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        onClick={applyCustom}
                        disabled={!draftRange?.from || !draftRange?.to}
                        className={cn(
                          "px-3 h-7 rounded-md text-xs font-semibold cursor-pointer transition-colors",
                          "bg-signature text-white hover:bg-signature/90",
                          "disabled:bg-surface-strong disabled:text-fg-subtle disabled:cursor-not-allowed",
                        )}
                      >
                        Aplicar
                      </button>
                    </div>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          );
        }
        return (
          <button
            key={opt.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onPresetChange(opt.id)}
            className={cn(
              "inline-flex items-center px-3 h-7 rounded-md cursor-pointer",
              "text-xs font-medium",
              "transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
              active
                ? "bg-canvas-elevated text-fg shadow-sm"
                : "text-fg-muted hover:text-fg hover:bg-surface-strong",
            )}
          >
            {opt.shortLabel}
          </button>
        );
      })}
    </div>
  );
}

// Custom helpers — `custom` (ISO strings) ↔ DayPicker range (Date objects).
// parseYmd cuida do parsing local-safe que `new Date("YYYY-MM-DD")` quebra
// em fusos negativos (vira midnight UTC = dia anterior em BRT).
function customToRange(custom) {
  if (!custom?.from || !custom?.to) return undefined;
  try {
    return { from: parseYmd(custom.from), to: parseYmd(custom.to) };
  } catch {
    return undefined;
  }
}

function formatRangeCompact(fromIso, toIso) {
  if (!fromIso || !toIso) return "";
  try {
    const f = parseYmd(fromIso);
    const t = parseYmd(toIso);
    const fmt = (d) => format(d, "dd MMM", { locale: ptBR });
    if (fromIso === toIso) return fmt(f);
    return `${fmt(f)} → ${fmt(t)}`;
  } catch {
    return `${fromIso} → ${toIso}`;
  }
}

function ChevronDownPico({ className }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}

// Skeleton enquanto o fetch da janela acontece. 6 rows com bloquinhos
// pulsantes — mesmo padrão visual do PerformerRow pra não dar shift de
// layout quando a lista real renderizar.
function PerformerSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      {[...Array(6)].map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-4 border-t border-border/40 first:border-t-0 animate-pulse"
        >
          <div className="w-5 h-3 bg-surface-strong rounded" />
          <div className="flex items-center gap-3 w-[220px]">
            <div className="w-9 h-9 rounded-full bg-surface-strong" />
            <div className="flex flex-col gap-1.5 flex-1">
              <div className="h-3 w-24 bg-surface-strong rounded" />
              <div className="h-2 w-16 bg-surface-strong rounded" />
            </div>
          </div>
          <div className="flex-1 grid grid-cols-6 gap-3">
            {[...Array(6)].map((__, j) => (
              <div key={j} className="h-4 bg-surface-strong rounded" />
            ))}
          </div>
          <div className="w-[200px] flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-surface-strong rounded-full" />
            <div className="w-12 h-4 bg-surface-strong rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RoleToggle({ value, onChange }) {
  return (
    <div
      role="tablist"
      aria-label="Tipo de owner"
      className="inline-flex gap-0.5 p-0.5 rounded-lg bg-canvas-deeper border border-border"
    >
      {[
        { value: "cs", label: "CS" },
        { value: "cp", label: "CP" },
      ].map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center px-3 h-7 rounded-md cursor-pointer",
              "text-xs font-medium",
              "transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
              active
                ? "bg-canvas-elevated text-fg shadow-sm"
                : "text-fg-muted hover:text-fg hover:bg-surface-strong"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
