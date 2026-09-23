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

import { useEffect, useRef, useState } from "react";
import { cn } from "../../../ui/cn";
import { formatBRL, formatPct as formatPctBR } from "../lib/format";
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
// O vermelho da CÉLULA é reservado pro alerta (salto dia a dia, global ou de
// campanha). A cor do NÚMERO segue a régua de nível, pra um mês alto e
// estável não parecer incidente todo dia.
// ─────────────────────────────────────────────────────────────────────────────

function toneOutOfCountry(value) {
  if (value == null) return "muted";
  if (value <= 1) return "success";
  if (value <= 3) return "warning";
  return "danger";
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

// Classes de span quando a strip tem nove células: fecha a última linha da
// grade de 2 colunas (9 = 4×2 + 1) e da de 5 (9 = 5 + 4), sem buraco cinza.
const OOC_SPAN_NINE = "col-span-2 @min-[520px]:col-span-1 @min-[840px]:col-span-2 @min-[1340px]:col-span-1";

function OutOfCountryCard({ data, compact, onOpenReport }) {
  const {
    rate, alert, alert_reasons = [], campaigns = [],
    impressions, unexpected_impressions, expected_impressions, expected_rate,
    unknown_impressions, unknown_rate, expected_countries = [], top_countries = [],
    reference_date, day_rate, campaigns_with_unexpected,
  } = data;

  const footer = alert ? (
    <span className="inline-flex items-center gap-1 font-semibold text-danger whitespace-nowrap">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-danger shadow-glow-danger animate-pulse" />
      fora do normal
    </span>
  ) : reference_date ? (
    <span className="whitespace-nowrap">
      {formatDayMonth(reference_date)}: <span className="tabular-nums">{formatPctTwo(day_rate)}</span> · DV360
    </span>
  ) : (
    <span className="whitespace-nowrap">DV360</span>
  );

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        {/* Fundo opaco no wrapper: o danger-soft da célula é translúcido e,
            sem isso, o bg-border da grade (os filetes) vazaria por baixo. */}
        <div className={cn("cursor-help bg-canvas-elevated", compact && OOC_SPAN_NINE)} tabIndex={0} aria-label="Entrega fora do Brasil — passe o mouse para ver as campanhas">
          <MetricCard
            compact={compact}
            label="Fora do BR"
            value={<AnimatedValue value={rate} format={formatPctTwo} />}
            tone={alert ? "danger" : toneOutOfCountry(rate)}
            footer={footer}
            className={cn("h-full", alert && "bg-danger-soft shadow-[inset_0_0_0_1px_var(--color-danger)]")}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="max-w-none w-[min(560px,calc(100vw-24px))] p-0 max-h-[70vh] overflow-y-auto"
      >
        <div className="px-3.5 pt-3 pb-2 flex items-baseline justify-between gap-3 border-b border-border/60">
          <span className="lbl-section">Entrega fora do Brasil · DV360</span>
          {reference_date && (
            <span className="text-[11px] text-fg-subtle whitespace-nowrap">dado até {formatDayMonth(reference_date)}</span>
          )}
        </div>

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
                      className={cn(
                        "border-t border-border/40",
                        clickable && "cursor-pointer hover:bg-surface",
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
          Só DV360. País escrito por extenso no nome da line (ex.: _CHILE_) conta como previsto e fica fora da taxa.
        </div>
      </TooltipContent>
    </Tooltip>
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
  const hasOutOfCountry = outOfCountry != null && outOfCountry.impressions > 0;
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
