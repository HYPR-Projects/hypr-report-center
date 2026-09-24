// src/v2/admin/components/MetricStrip.jsx
//
// Faixa de KPIs no topo do menu admin — cards de performance por cohort
// mensal (campanhas que iniciaram no mês selecionado). Default = mês
// corrente. Cliclar nos chips "Mai 26 / Abr 26 / ..." troca o cohort e a
// strip reage.
//
// Layout: grid responsivo 2/3/6+ colunas, cards bordados leves pra dar
// estrutura sem peso. Deltas (CTR/VTR/eCPM/Tech Cost) comparam contra o
// cohort do mês anterior calendário — mesma régua, janelas iguais. Verde
// = melhor que mês passado, vermelho = pior.
//
// Tech Cost mostra projeção (setinha ↗/↘) APENAS no mês corrente; em mês
// fechado já é tudo realizado, projetar não faz sentido.
//
// Alertas operacionais (críticas, sem owner, encerram em 7d) descem pra
// uma linha discreta de pills via SecondaryAlerts — preserva a função
// de filtro do worklist sem competir com os números.

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../../../ui/cn";
import { formatBRL, formatPct as formatPctBR } from "../lib/format";
import * as Popover from "@radix-ui/react-popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../ui/Tooltip";

// BRL compacto sem centavos pro tooltip de breakdown do Tech Cost. Numbers
// na casa de centena de milhar ficam mais legíveis sem ",00" no fim.
const _BRL_COMPACT_STRIP = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
function formatBrlCompact(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return _BRL_COMPACT_STRIP.format(Number(value));
}

/**
 * Anima um valor numérico do anterior pro novo via requestAnimationFrame
 * com easing ease-out-cubic. Usado nos KPIs do topo pra dar sensação de
 * "atualizou" quando o refetch traz números novos — antes o valor pulava
 * sem aviso (admin não sabia que houve refresh).
 *
 * - Primeiro render: sem animação (prev === target inicial, retorna direto)
 * - target/prev null: sem animação (não dá pra animar de/para "—")
 * - Mesmo valor: sem animação (early return)
 */
function useAnimatedNumber(target, duration = 600) {
  const [value, setValue] = useState(target);
  const prevTarget = useRef(target);

  useEffect(() => {
    if (target === prevTarget.current) return;
    if (target == null || prevTarget.current == null) {
      setValue(target);
      prevTarget.current = target;
      return;
    }
    const start = prevTarget.current;
    const startTime = performance.now();
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out-cubic
      setValue(start + (target - start) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    prevTarget.current = target;
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}

/**
 * Wrapper que aplica useAnimatedNumber + passa o valor interpolado pro
 * formatter. Renderiza string formatada — MetricCard espera ReactNode.
 */
function AnimatedValue({ value, format }) {
  const animated = useAnimatedNumber(value);
  return format(animated);
}

function formatPct(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatPctBR(Math.round(value), 0);
}

function formatPctTwo(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatPctBR(value, 2);
}

function tonePacing(value) {
  if (value == null) return "muted";
  if (value < 90)  return "danger";
  if (value < 100) return "warning";
  if (value < 125) return "success";
  return "signature";
}

// Régua sem-ABS (≥0.70 verde) porque é agregado de várias campanhas —
// mistura usa o threshold mais rigoroso. Alinhado com ctrColorClass do
// format.js. Per-campanha usa ABS-aware (ver CampaignCardV2).
function toneCtr(value) {
  if (value == null)  return "muted";
  if (value >= 0.70)  return "success";
  if (value >= 0.50)  return "warning";
  return "danger";
}

function toneVtr(value) {
  if (value == null) return "muted";
  return value >= 80 ? "success" : "danger";
}

// Tech Cost agregado: usa a régua sem-ABS como referência geral (campanhas
// HYPR são majoritariamente sem ABS). Quando o mix de ABS aumentar, os
// thresholds individuais por campanha continuam mais permissivos.
function toneTechCost(value) {
  if (value == null) return "muted";
  if (value <= 8)  return "success";
  if (value <= 10) return "warning";
  return "danger";
}

const TONE_CLASS = {
  muted:     "text-fg-subtle",
  danger:    "text-danger",
  warning:   "text-warning",
  success:   "text-success",
  signature: "text-signature",
  fg:        "text-fg",
};

function MetricCard({ label, value, tone = "fg", aside, footer, compact = false, className }) {
  // Padding e tipografia mobile-first: cards em 2 colunas a 375px ficam
  // ~165px de largura — `text-2xl` (24px) ainda cabe pra valores curtos.
  //
  // `aside` é um slot INLINE à direita do value (mesmo baseline), usado
  // hoje só pelo Tech Cost pra mostrar projeção de forma minimalista. Não
  // aumenta a altura do card.
  return (
    // justify-between + rodapé SEMPRE presente: os cards de Pacing não têm
    // comparativo, então antes o valor colava no topo e sobrava um vazio
    // embaixo enquanto os vizinhos tinham três andares — a faixa de oito
    // cards não formava uma linha. Agora todos têm as mesmas três âncoras
    // verticais (rótulo no topo, valor no meio, rodapé na base).
    // Célula, não card: o board já é a moldura. O fundo é `canvas-elevated`
    // (o mesmo do board) e o que separa as células é o `gap-px` da grade
    // deixando o `bg-border` do container aparecer como filete.
    // `compact`: com nove células (box "Fora do BR" presente) a linha única
    // dá ~150px por célula — o Tech Cost com projeção não cabe em text-2xl.
    <div className={cn(
      "bg-canvas-elevated py-3 flex flex-col justify-between gap-1.5 min-w-0",
      compact ? "px-3" : "px-3.5",
      className,
    )}>
      <span className="lbl-section whitespace-nowrap">
        {label}
      </span>
      <div className={cn("flex items-baseline min-w-0", compact ? "gap-1.5" : "gap-2")}>
        <span className={cn(
          "font-bold tracking-tight tabular-nums leading-none whitespace-nowrap",
          compact ? "text-xl" : "text-xl sm:text-2xl",
          TONE_CLASS[tone] || TONE_CLASS.fg
        )}>
          {value}
        </span>
        {aside && (
          <span className="text-[11px] leading-none whitespace-nowrap">
            {aside}
          </span>
        )}
      </div>
      {/* Sem footer, reserva a linha com um espaço não-quebrável — mantém a
          base alinhada com os cards que têm comparativo, sem inventar um
          texto que não existe. */}
      <div className="text-[11px] text-fg-subtle leading-snug md:leading-none md:whitespace-nowrap">
        {footer || " "}
      </div>
    </div>
  );
}

// Projeção inline minimalista — apenas seta + valor, sem labels. Tooltip
// no hover explica o que é. Tom: down=good pro Tech Cost (alta = piora).
function ProjectionInline({ current, projected, format, goodDirection = "down" }) {
  if (current == null || projected == null) return null;
  const delta = projected - current;
  const isFlat = Math.abs(delta) < 0.05;
  const isUp = delta > 0;
  const isGood = isFlat ? false : (goodDirection === "down" ? !isUp : isUp);
  const tone = isFlat ? "text-fg-subtle" : isGood ? "text-success" : "text-danger";
  const arrow = isFlat ? "→" : isUp ? "↗" : "↘";
  return (
    <span
      className={cn("inline-flex items-baseline gap-0.5 font-semibold", tone)}
      title={`Projeção ao fim mantendo o ritmo atual: ${format(projected)}`}
    >
      <span className="text-[9px] leading-none">{arrow}</span>
      <span className="tabular-nums">{format(projected)}</span>
    </span>
  );
}

// Delta vs cohort do mês anterior calendário. Quando o mês selecionado é
// Mai, previous = cohort de Abr (mesma régra de start_date).
//   goodDirection="down": queda é bom (eCPM/tech cost — mais eficiente)
//   goodDirection="up":   alta é bom (CTR/VTR — performance maior)
function MetricDelta({ current, previous, goodDirection = "up" }) {
  if (current == null || previous == null || previous <= 0) {
    return (
      <span className="text-[11px] text-fg-subtle whitespace-nowrap">
        sem comparativo
      </span>
    );
  }
  const deltaPct = ((current - previous) / previous) * 100;
  const rounded = Math.round(deltaPct * 10) / 10;

  const isFlat = Math.abs(rounded) < 0.1;
  const isDown = rounded < 0;
  const isGood = isFlat ? false : goodDirection === "down" ? isDown : !isDown;
  const colorClass = isFlat
    ? "text-fg-subtle"
    : isGood
    ? "text-success"
    : "text-danger";
  const arrow = isFlat ? "•" : isDown ? "▼" : "▲";

  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", colorClass)}>
      <span className="text-[10px] leading-none">{arrow}</span>
      <span className="tabular-nums">{formatPctBR(Math.abs(rounded), 1)}</span>
      <span className="text-fg-subtle font-normal">vs mês anterior</span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fora do BR — entrega do DV360 em país que a line não prevê.
//
// Dado: action=out_of_country (backend/out_of_country.py). "Previsto" é o
// país escrito por extenso no nome da line (Elux _CHILE_/_PERU_/_COLOMBIA_):
// esse volume aparece no hover mas não entra na taxa.
//
// Vermelho é reservado pro ALERTA (salto dia a dia, global ou de campanha):
// célula e número. Fora do alerta o número é verde (≤ 1%) ou amarelo — um
// mês alto e estável não pode ter a mesma cara de um incidente, senão o
// vermelho vira paisagem e ninguém olha quando é de verdade.
// ─────────────────────────────────────────────────────────────────────────────

function toneOutOfCountry(value) {
  if (value == null) return "muted";
  return value <= 1 ? "success" : "warning";
}

function dataWarningText(w) {
  if (w.kind === "unknown_country") {
    return `${formatPctBR(w.share, 1)} das impressões sem país identificado — a taxa pode estar subestimada.`;
  }
  if (w.kind === "untracked_lines") {
    return `${formatPctBR(w.share, 1)} do volume em lines sem campanha vinculada — ranking e alerta por campanha incompletos.`;
  }
  return null;
}

const _IMPS_COMPACT = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
function formatImps(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return _IMPS_COMPACT.format(Number(value));
}

let _regionNames = null;
function countryName(code) {
  try {
    _regionNames = _regionNames || new Intl.DisplayNames(["pt-BR"], { type: "region" });
    return _regionNames.of(code) || code;
  } catch {
    return code;
  }
}

function formatDayMonth(iso) {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function alertReasonText(r) {
  const pct = (v) => formatPctTwo(v);
  if (r.kind === "global_jump") {
    return `Taxa do dia ${formatDayMonth(r.date)} saltou de ${pct(r.previous_rate)} para ${pct(r.rate)}`;
  }
  if (r.kind === "global_baseline") {
    return `Taxa do dia ${formatDayMonth(r.date)} (${pct(r.rate)}) bem acima da média de ${r.baseline_days} dias (${pct(r.baseline_rate)})`;
  }
  if (r.kind === "campaign_jump") {
    const who = [r.client_name, r.campaign_name].filter(Boolean).join(" · ") || r.short_token;
    return `${who}: ${pct(r.previous_rate)} → ${pct(r.rate)} fora do BR em ${formatDayMonth(r.date)} (${formatImps(r.unexpected_impressions)} imps)`;
  }
  return null;
}

// ── Tendência diária no hover ───────────────────────────────────────────────
// Taxa fora (UNEXPECTED / total) dos últimos 7 dias com dado, vindo de
// `daily` do payload. Responde "está melhorando ou piorando?" sem abrir o
// DV360: linha + área, dot por dia, valor só no ponto em foco (último dia por
// padrão; hover/toque troca). A linha verde é a régua de 1% do box.
//
// SVG medido (ResizeObserver) em vez de viewBox esticado: o popover vai de
// 560px a ~350px no celular, e esticar deformaria dots e texto.
const TREND_DAYS = 7;
const TREND_H = 92;
const TREND_PAD = { top: 20, bottom: 18, x: 18 };
const TREND_FLAT_PP = 0.5;

function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// Último dia vs taxa ponderada dos dias anteriores da janela. Comparar só com
// o primeiro dia seria refém de um dia atípico; a média dos anteriores é a
// mesma lógica do alerta de base no backend.
function trendSummary(points) {
  const last = points[points.length - 1];
  const before = points.slice(0, -1);
  const tot = before.reduce((s, p) => s + (p.impressions || 0), 0);
  const unx = before.reduce((s, p) => s + (p.unexpected_impressions || 0), 0);
  if (!tot || last.rate == null) return null;
  const baseRate = (unx / tot) * 100;
  const delta = last.rate - baseRate;
  const dir = Math.abs(delta) < TREND_FLAT_PP ? "flat" : delta > 0 ? "up" : "down";
  return { delta, dir, baseRate, from: before[0].date, to: before[before.length - 1].date, last };
}

function TrendBadge({ summary }) {
  if (!summary) return null;
  const { delta, dir, baseRate, from, to, last } = summary;
  const cfg = {
    up:   { arrow: "▲", text: "piorando",   cls: "text-danger" },
    down: { arrow: "▼", text: "melhorando", cls: "text-success" },
    flat: { arrow: "•", text: "estável",    cls: "text-fg-subtle" },
  }[dir];
  const pp = `${formatPctBR(Math.abs(delta), 1).replace("%", "")} pp`;
  return (
    <span
      className={cn("inline-flex items-center gap-1 font-semibold whitespace-nowrap", cfg.cls)}
      title={`${formatDayMonth(last.date)}: ${formatPctTwo(last.rate)} vs ${formatPctTwo(baseRate)} de ${formatDayMonth(from)} a ${formatDayMonth(to)}`}
    >
      <span aria-hidden="true" className="text-[9px] leading-none">{cfg.arrow}</span>
      {dir !== "flat" && <span className="tabular-nums">{pp}</span>}
      <span className="font-normal text-fg-subtle">{dir === "flat" ? "" : "· "}{cfg.text}</span>
    </span>
  );
}

function OutOfCountryTrend({ daily, alert }) {
  const points = (daily || []).filter((d) => d.rate != null).slice(-TREND_DAYS);
  const [ref, width] = useElementWidth();
  const [active, setActive] = useState(null);
  const gradId = `ooc-trend-${useId().replace(/:/g, "")}`;

  if (points.length < 2) return null;

  const n = points.length;
  const lastIdx = n - 1;
  const focus = active ?? lastIdx;
  const summary = trendSummary(points);

  const W = Math.max(width, 0);
  const plotH = TREND_H - TREND_PAD.top - TREND_PAD.bottom;
  const baseY = TREND_PAD.top + plotH;
  // Teto com folga e nunca abaixo de 1,5%: com a semana toda em 0,2% a linha
  // não pode ocupar a altura inteira e parecer um incêndio.
  const yMax = Math.max(1.5, ...points.map((p) => p.rate)) * 1.15;
  const x = (i) => TREND_PAD.x + (i / (n - 1)) * (W - TREND_PAD.x * 2);
  const y = (v) => TREND_PAD.top + plotH * (1 - v / yMax);

  const xy = points.map((p, i) => [x(i), y(p.rate)]);
  const line = xy.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = `M${xy[0][0].toFixed(1)},${baseY} ${xy.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join(" ")} L${xy[lastIdx][0].toFixed(1)},${baseY} Z`;
  const refY = y(1);

  const onMove = (e) => {
    if (!W) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left - TREND_PAD.x) / (W - TREND_PAD.x * 2);
    setActive(Math.min(lastIdx, Math.max(0, Math.round(rel * (n - 1)))));
  };

  const fp = points[focus];
  const [fx, fy] = xy[focus];
  // Rótulo do ponto em foco preso às bordas: no primeiro/último dia ele
  // alinha pela ponta em vez de centralizar e sair do SVG.
  const labelAnchor = fx < 36 ? "start" : fx > W - 36 ? "end" : "middle";
  const labelX = labelAnchor === "start" ? fx - 6 : labelAnchor === "end" ? fx + 6 : fx;
  const alertDot = alert && focus === lastIdx;

  return (
    <div className="px-3.5 pt-2.5 pb-2 border-b border-border/60">
      <div className="flex items-baseline justify-between gap-3 text-[11px]">
        <span className="text-fg-subtle">Taxa fora por dia · últimos {n} dias</span>
        <TrendBadge summary={summary} />
      </div>

      <div ref={ref} className="mt-1 w-full" style={{ height: TREND_H }}>
        {W > 0 && (
          <svg
            width={W}
            height={TREND_H}
            className="block touch-none select-none overflow-visible"
            role="img"
            aria-label={`Taxa fora do Brasil por dia: ${points.map((p) => `${formatDayMonth(p.date)} ${formatPctTwo(p.rate)}`).join(", ")}`}
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setActive(null)}
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-signature)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--color-signature)" stopOpacity={0} />
              </linearGradient>
            </defs>

            <line x1={0} x2={W} y1={baseY} y2={baseY} stroke="var(--color-border)" strokeWidth={1} />

            {/* Régua de 1%: abaixo dela o box fica verde. O rótulo mora na
                margem esquerda, antes do primeiro dot, pra nunca brigar com o
                crosshair nem com o valor do ponto em foco. */}
            <line x1={13} x2={W} y1={refY} y2={refY} stroke="var(--color-success)" strokeOpacity={0.45} strokeWidth={1} />
            <text x={0} y={refY} dominantBaseline="middle" className="fill-fg-subtle" style={{ fontSize: 9 }}>1%</text>

            <path d={area} fill={`url(#${gradId})`} />
            <path d={line} fill="none" stroke="var(--color-signature)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

            <line x1={fx} x2={fx} y1={TREND_PAD.top - 4} y2={baseY} stroke="var(--color-border-strong)" strokeWidth={1} />

            {xy.map(([px, py], i) => (
              <circle
                key={points[i].date}
                cx={px}
                cy={py}
                r={i === focus ? 4.5 : 3}
                fill={i === focus && alertDot ? "var(--color-danger)" : "var(--color-signature)"}
                stroke="var(--color-canvas-elevated)"
                strokeWidth={2}
                style={{ transition: "r 120ms ease-out" }}
              />
            ))}

            <text
              x={labelX}
              y={Math.max(fy - 9, 10)}
              textAnchor={labelAnchor}
              className={cn("font-bold tabular-nums", alertDot ? "fill-danger" : "fill-fg")}
              style={{ fontSize: 11 }}
            >
              {formatPctTwo(fp.rate)}
            </text>

            {points.map((p, i) => (
              <text
                key={p.date}
                x={x(i)}
                y={TREND_H - 3}
                textAnchor="middle"
                className={cn("tabular-nums", i === focus ? "fill-fg font-semibold" : "fill-fg-subtle")}
                style={{ fontSize: 10 }}
              >
                {formatDayMonth(p.date)}
              </text>
            ))}
          </svg>
        )}
      </div>

      <div className="text-[10px] text-fg-subtle tabular-nums text-right">
        {formatDayMonth(fp.date)}: {formatImps(fp.unexpected_impressions)} fora de {formatImps(fp.impressions)} imps
      </div>
    </div>
  );
}

// Classes de span quando a strip tem nove células: fecha a última linha da
// grade de 2 colunas (9 = 4×2 + 1) e da de 5 (9 = 5 + 4), sem buraco cinza.
const OOC_SPAN_NINE = "col-span-2 @min-[520px]:col-span-1 @min-[840px]:col-span-2 @min-[1340px]:col-span-1";

// Popover que abre no hover (mouse) e no clique/toque/Enter. Não é Tooltip de
// propósito: o conteúdo é uma tabela clicável, e o Tooltip do Radix (1) copia
// o conteúdo inteiro num nó oculto de leitor de tela — a tabela seria lida
// como "dica" do box — e (2) não abre com toque, então no celular o ranking
// ficaria inacessível. O atraso de fechar dá tempo de atravessar o vão entre
// o box e o painel sem ele sumir.
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 180;

function useHoverOpen() {
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const schedule = (next, ms) => {
    clear();
    timer.current = setTimeout(() => { timer.current = null; setOpen(next); }, ms);
  };
  useEffect(() => clear, []);
  const onPointerEnter = (e) => { if (e.pointerType === "mouse") schedule(true, open ? 0 : HOVER_OPEN_MS); };
  const onPointerLeave = (e) => { if (e.pointerType === "mouse") schedule(false, HOVER_CLOSE_MS); };
  const onOpenChange = (next) => { clear(); setOpen(next); };
  return { open, onOpenChange, hoverProps: { onPointerEnter, onPointerLeave } };
}

function OutOfCountryCard({ data, compact, onOpenReport }) {
  const { open, onOpenChange, hoverProps } = useHoverOpen();
  const {
    rate, alert, alert_reasons = [], campaigns = [],
    impressions, unexpected_impressions, expected_impressions, expected_rate,
    unknown_impressions, unknown_rate, expected_countries = [], top_countries = [],
    reference_date, day_rate, campaigns_with_unexpected, data_warnings = [], daily = [],
  } = data;
  const suspect = data_warnings.length > 0;

  const footer = alert ? (
    <span className="inline-flex items-center gap-1 font-semibold text-danger whitespace-nowrap">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-danger shadow-glow-danger animate-pulse" />
      fora do normal
    </span>
  ) : suspect ? (
    <span className="inline-flex items-center gap-1 font-semibold text-warning whitespace-nowrap">
      <span aria-hidden="true">⚠</span> checar dado
    </span>
  ) : reference_date ? (
    <span className="whitespace-nowrap">
      {formatDayMonth(reference_date)}: <span className="tabular-nums">{formatPctTwo(day_rate)}</span> · DV360
    </span>
  ) : (
    <span className="whitespace-nowrap">DV360</span>
  );

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        {/* Fundo opaco no wrapper: o danger-soft da célula é translúcido e,
            sem isso, o bg-border da grade (os filetes) vazaria por baixo.
            div + role=button (e não <button>) porque a célula tem blocos
            dentro; Enter/Espaço são tratados à mão. */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Entrega fora do Brasil: ver campanhas"
          {...hoverProps}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenChange(!open); }
          }}
          className={cn(
            "cursor-pointer bg-canvas-elevated focus-visible:outline-none",
            "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-signature",
            compact && OOC_SPAN_NINE,
          )}
        >
          <MetricCard
            compact={compact}
            label="Fora do BR"
            value={<AnimatedValue value={rate} format={formatPctTwo} />}
            tone={alert ? "danger" : suspect ? "muted" : toneOutOfCountry(rate)}
            footer={footer}
            className={cn("h-full", alert && "bg-danger-soft shadow-[inset_0_0_0_1px_var(--color-danger)]")}
          />
        </div>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          // Abrir por hover não pode roubar o foco da página.
          onOpenAutoFocus={(e) => e.preventDefault()}
          {...hoverProps}
          className={cn(
            "z-50 w-[min(560px,calc(100vw-24px))] max-h-[70vh] overflow-y-auto",
            "rounded-md border border-border bg-canvas-elevated text-xs text-fg shadow-md",
            "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out focus-visible:outline-none",
          )}
        >
          <div className="px-3.5 pt-3 pb-2 flex items-baseline justify-between gap-3 border-b border-border/60">
            <span className="lbl-section">Entrega fora do Brasil · DV360</span>
            {reference_date && (
              <span className="text-[11px] text-fg-subtle whitespace-nowrap">dado até {formatDayMonth(reference_date)}</span>
            )}
          </div>

          {suspect && (
            <div className="mx-3.5 mt-2.5 rounded-md border border-warning/40 bg-warning-soft px-3 py-2">
              <div className="text-[11px] font-bold text-warning mb-1">Dado suspeito</div>
              <ul className="flex flex-col gap-0.5 text-[11px] text-fg">
                {data_warnings.map((w, i) => {
                  const text = dataWarningText(w);
                  return text ? <li key={i}>{text}</li> : null;
                })}
              </ul>
            </div>
          )}

          {alert && alert_reasons.length > 0 && (
            <div className="mx-3.5 mt-2.5 rounded-md border border-danger/40 bg-danger-soft px-3 py-2">
              <div className="text-[11px] font-bold text-danger mb-1">Fora do normal</div>
              <ul className="flex flex-col gap-0.5 text-[11px] text-fg">
                {alert_reasons.map((r, i) => {
                  const text = alertReasonText(r);
                  return text ? <li key={i}>{text}</li> : null;
                })}
              </ul>
            </div>
          )}

          <OutOfCountryTrend daily={daily} alert={alert} />

          <div className="px-3.5 py-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <span className="text-fg-subtle">Fora sem previsão na line</span>
            <span className="text-right tabular-nums">
              <span className={cn("font-bold", TONE_CLASS[toneOutOfCountry(rate)])}>{formatPctTwo(rate)}</span>
              <span className="text-fg-subtle"> · {formatImps(unexpected_impressions)} imps</span>
            </span>
            {top_countries.length > 0 && (
              <>
                <span className="text-fg-subtle">Principais países</span>
                <span className="text-right truncate" title={top_countries.map((c) => countryName(c.country)).join(", ")}>
                  {top_countries.slice(0, 4).map((c) => `${c.country} ${formatImps(c.impressions)}`).join(" · ")}
                </span>
              </>
            )}
            <span className="text-fg-subtle">Previsto na line</span>
            <span className="text-right tabular-nums">
              {formatPctTwo(expected_rate)}
              {expected_countries.length > 0 && (
                <span className="text-fg-subtle"> · {expected_countries.map((c) => c.country).join(", ")}</span>
              )}
              <span className="text-fg-subtle"> · {formatImps(expected_impressions)}</span>
            </span>
            <span className="text-fg-subtle">País não identificado</span>
            <span className="text-right tabular-nums">
              {formatPctTwo(unknown_rate)}<span className="text-fg-subtle"> · {formatImps(unknown_impressions)}</span>
            </span>
            <span className="text-fg-subtle">Total DV360 no mês</span>
            <span className="text-right tabular-nums font-semibold">{formatImps(impressions)} imps</span>
          </div>

          <div className="border-t border-border/60">
            {campaigns.length === 0 ? (
              <div className="px-3.5 py-3 text-[11px] text-fg-subtle">
                Nenhuma campanha com entrega fora do Brasil sem previsão na line.
              </div>
            ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-fg-subtle">
                    <th className="text-left font-semibold px-3.5 py-1.5">Campanha</th>
                    <th className="text-right font-semibold px-2 py-1.5">Fora</th>
                    <th className="text-right font-semibold px-2 py-1.5">Imps fora</th>
                    <th className="text-left font-semibold pl-2 pr-3.5 py-1.5">Países</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => {
                    const clickable = !!onOpenReport;
                    const name = [c.client_name, c.campaign_name].filter(Boolean).join(" · ") || c.short_token;
                    return (
                      <tr
                        key={c.short_token}
                        onClick={clickable ? () => onOpenReport(c.short_token) : undefined}
                        tabIndex={clickable ? 0 : undefined}
                        onKeyDown={clickable ? (e) => { if (e.key === "Enter") onOpenReport(c.short_token); } : undefined}
                        className={cn(
                          "border-t border-border/40",
                          clickable && "cursor-pointer hover:bg-surface focus-visible:outline-none focus-visible:bg-surface",
                          c.alert && "bg-danger-soft",
                        )}
                      >
                        <td className="px-3.5 py-1.5 max-w-[220px]">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {c.alert && <span aria-label="alerta" className="size-1.5 shrink-0 rounded-full bg-danger" />}
                            <span className="truncate font-medium text-fg" title={name}>{name}</span>
                          </div>
                          <div className="text-[10px] text-fg-subtle tabular-nums">
                            {c.short_token}
                            {c.expected_countries?.length > 0 && ` · previsto ${c.expected_countries.join(", ")}`}
                          </div>
                        </td>
                        <td className={cn("px-2 py-1.5 text-right tabular-nums font-bold", TONE_CLASS[toneOutOfCountry(c.rate)])}>
                          {formatPctTwo(c.rate)}
                          {c.day_rate != null && (
                            <div className="text-[10px] font-normal text-fg-subtle">dia {formatPctTwo(c.day_rate)}</div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatImps(c.unexpected_impressions)}</td>
                        <td
                          className="pl-2 pr-3.5 py-1.5 text-fg-muted whitespace-nowrap"
                          title={(c.top_countries || []).map((t) => countryName(t.country)).join(", ")}
                        >
                          {(c.top_countries || []).map((t) => t.country).join(", ") || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="px-3.5 py-2 border-t border-border/60 text-[10px] text-fg-subtle leading-snug">
            {campaigns_with_unexpected > campaigns.length
              ? `Top ${campaigns.length} de ${campaigns_with_unexpected} campanhas com entrega fora. `
              : ""}
            Só DV360. País no nome da line ou da campanha (ex.: CHILE, CH) conta como previsto e fica fora da taxa. Pra liberar outro país, use "Entrega fora do Brasil" no drawer da campanha.
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function MetricStrip({ summary, outOfCountry, onOpenReport, className }) {
  if (!summary) return null;

  const {
    active_count,
    cohort_size,
    is_current_month,
    dsp_pacing,
    vid_pacing,
    ctr,
    ctr_prev,
    vtr,
    vtr_prev,
    ecpm,
    ecpm_prev,
    ecpm_display,
    ecpm_display_prev,
    ecpm_video,
    ecpm_video_prev,
    tech_cost,
    tech_cost_prev,
    tech_cost_projected,
    tech_cost_cost,
    tech_cost_budget,
  } = summary;

  // Fallback pra eCPM combinado quando o backend ainda não envia os splits
  // por mídia (d_admin_total_cost / v_admin_total_cost). Mantém o card único
  // de eCPM até o redeploy.
  const hasSplit = ecpm_display != null || ecpm_video != null;
  // Tech cost só aparece se backend tiver enviado d_client_budget/v_client_budget.
  const hasTechCost = tech_cost != null;
  // Box de entrega fora do BR: vem de endpoint próprio (tabela de regiões do
  // DV360) e só entra quando o payload chegou.
  // `alert` também segura o box: no dia 1º o mês ainda não tem entrega, mas
  // um salto no último dia do mês anterior continua valendo aviso.
  const hasOutOfCountry = outOfCountry != null && (outOfCountry.impressions > 0 || outOfCountry.alert);
  // Grid: 5 (sem split) + eCPM card(s) + opcionalmente Tech Cost e Fora do BR.
  const totalCols = 5 + (hasSplit ? 2 : 1) + (hasTechCost ? 1 : 0) + (hasOutOfCountry ? 1 : 0);
  const compact = totalCols >= 9;

  return (
    <div
      className={cn(
        // Limiares por largura do BOARD (ver KpiBoard). Cada célula precisa
        // de ~135px pra caber rótulo em versalete + valor + delta sem quebrar.
        // `gap-px` sobre `bg-border` desenha os filetes entre as células.
        "grid grid-cols-2 @min-[520px]:grid-cols-3 gap-px bg-border",
        // Nove células só cabem numa linha a partir de ~1340px (rodapé "vs mês
        // anterior" + projeção do Tech Cost). Abaixo disso, 5 colunas: a
        // segunda linha fecha com o Fora do BR ocupando duas (ver OutOfCountryCard).
        totalCols === 9 && "@min-[840px]:grid-cols-5 @min-[1340px]:grid-cols-9",
        totalCols === 8 && "@min-[1120px]:grid-cols-8",
        totalCols === 7 && "@min-[980px]:grid-cols-7",
        totalCols === 6 && "@min-[840px]:grid-cols-6",
        className
      )}
      role="region"
      aria-label="Performance do cohort do mês"
    >
      <MetricCard
        compact={compact}
        label="Ativas"
        value={<AnimatedValue value={active_count} format={(n) => n == null ? "—" : Math.round(n)} />}
        footer={
          cohort_size != null
            ? <span className="whitespace-nowrap">de {cohort_size} no mês</span>
            : null
        }
      />
      <MetricCard
        compact={compact}
        label="Pacing DSP"
        value={<AnimatedValue value={dsp_pacing} format={formatPct} />}
        tone={tonePacing(dsp_pacing)}
      />
      <MetricCard
        compact={compact}
        label="Pacing VID"
        value={<AnimatedValue value={vid_pacing} format={formatPct} />}
        tone={tonePacing(vid_pacing)}
      />
      <MetricCard
        compact={compact}
        label="CTR"
        value={<AnimatedValue value={ctr} format={formatPctTwo} />}
        tone={toneCtr(ctr)}
        footer={<MetricDelta current={ctr} previous={ctr_prev} goodDirection="up" />}
      />
      <MetricCard
        compact={compact}
        label="VTR"
        value={<AnimatedValue value={vtr} format={formatPctTwo} />}
        tone={toneVtr(vtr)}
        footer={<MetricDelta current={vtr} previous={vtr_prev} goodDirection="up" />}
      />
      {hasSplit ? (
        <>
          <MetricCard
            compact={compact}
            label="eCPM Display"
            value={<AnimatedValue value={ecpm_display} format={formatBRL} />}
            footer={<MetricDelta current={ecpm_display} previous={ecpm_display_prev} goodDirection="down" />}
          />
          <MetricCard
            compact={compact}
            label="eCPM Video"
            value={<AnimatedValue value={ecpm_video} format={formatBRL} />}
            footer={<MetricDelta current={ecpm_video} previous={ecpm_video_prev} goodDirection="down" />}
          />
        </>
      ) : (
        <MetricCard
          compact={compact}
          label="eCPM"
          value={<AnimatedValue value={ecpm} format={formatBRL} />}
          footer={<MetricDelta current={ecpm} previous={ecpm_prev} goodDirection="down" />}
        />
      )}
      {hasTechCost && (
        <Tooltip delayDuration={150}>
          <TooltipTrigger asChild>
            {/* Wrapper inline pra Radix conseguir aplicar ref/eventos no
                card. tabindex=0 deixa o tooltip acessível por teclado. */}
            <div className="cursor-help" tabIndex={0}>
              <MetricCard
                compact={compact}
                label="Tech Cost"
                value={<AnimatedValue value={tech_cost} format={formatPctTwo} />}
                tone={toneTechCost(tech_cost)}
                aside={
                  // Projeção só faz sentido no mês corrente — em mês fechado a
                  // tech_cost_projected vem null e o componente já fica oculto.
                  is_current_month ? (
                    <ProjectionInline
                      current={tech_cost}
                      projected={tech_cost_projected}
                      format={formatPctTwo}
                      goodDirection="down"
                    />
                  ) : null
                }
                footer={<MetricDelta current={tech_cost} previous={tech_cost_prev} goodDirection="down" />}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={8} className="px-3.5 py-2.5 min-w-[200px]">
            {/* Breakdown da conta — Custo / Investimento → Tech Cost.
                Minimalista: 2 linhas com label esquerda + valor direita,
                divisor sutil, resultado em destaque na cor do tom. */}
            <div className="flex flex-col gap-1.5 text-[11px]">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-fg-subtle">Custo</span>
                <span className="font-semibold tabular-nums">{formatBrlCompact(tech_cost_cost)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-fg-subtle">Investimento</span>
                <span className="font-semibold tabular-nums">{formatBrlCompact(tech_cost_budget)}</span>
              </div>
              <div className="border-t border-border/60 my-0.5" />
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-fg-subtle">Tech Cost</span>
                <span className={cn("font-bold tabular-nums", TONE_CLASS[toneTechCost(tech_cost)])}>
                  {formatPctTwo(tech_cost)}
                </span>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      )}
      {hasOutOfCountry && (
        <OutOfCountryCard data={outOfCountry} compact={compact} onOpenReport={onOpenReport} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WorklistChips — os recortes operacionais do worklist (críticas, sem owner,
// encerram em 7d) como CHIPS, dentro do KpiBoard.
//
// O que eram antes: `SecondaryAlerts`, uma fileira de pílulas sem caixa
// logo abaixo da grade de KPIs, separadas por pontinhos. Pareciam legenda
// dos números acima — mas são filtros clicáveis. E quando você clicava num,
// aparecia um TERCEIRO elemento (o `ActiveWorklistBanner`): uma faixa cheia
// em `signature-soft`, largura total, só pra dizer "filtrado por pacing
// crítico · 14 campanhas". Três linguagens visuais pra uma interação: ver a
// contagem, filtrar, saber que está filtrado.
//
// Agora são chips com `aria-pressed`, na mesma família visual dos chips da
// FilterBar — porque é isso que eles são. O estado "filtrado" aparece no
// chip (tintado) e na linha de filtros ativos da barra, que é onde todo
// filtro ativo do app mora. O banner morreu.
// ─────────────────────────────────────────────────────────────────────────────
const WORKLIST_CHIPS = [
  { key: "pacing_critical", label: "críticas",       dotClass: "bg-danger",  glow: "shadow-glow-danger"  },
  { key: "no_owner",        label: "sem owner",      dotClass: "bg-warning", glow: "shadow-glow-warning" },
  { key: "ending_soon",     label: "encerram em 7d", dotClass: "bg-success", glow: "shadow-glow-success" },
];

// Os rótulos dos buckets (`WORKLIST_LABELS`) vivem em ../lib/filterLabels.js
// — junto dos outros rótulos de chip, e fora de um arquivo de componente.

export function WorklistChips({ worklist, activeKey, onSelect, className }) {
  if (!worklist) return null;
  const items = WORKLIST_CHIPS
    .map((s) => ({ ...s, count: worklist[s.key]?.count || 0 }))
    .filter((s) => s.count > 0);
  if (!items.length) return null;

  return (
    <div className={cn("flex items-center flex-wrap gap-1.5", className)}>
      {items.map((s) => {
        const isActive = activeKey === s.key;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onSelect?.(isActive ? null : s.key)}
            aria-pressed={isActive}
            title={isActive ? `Mostrando só ${s.label} — clique pra limpar` : `Filtrar por ${s.label}`}
            className={cn(
              "inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full cursor-pointer",
              "text-[11px] font-semibold transition-colors border",
              isActive
                ? "bg-signature-soft border-signature text-fg"
                : "bg-canvas-elevated border-border text-fg-muted hover:text-fg hover:border-border-strong",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
              "focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
            )}
          >
            <span aria-hidden="true" className={cn("size-1.5 rounded-full shrink-0", s.dotClass, s.glow)} />
            <span className="tabular-nums font-extrabold text-fg">{s.count}</span>
            <span>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
