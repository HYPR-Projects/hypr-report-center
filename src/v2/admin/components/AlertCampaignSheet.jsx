// src/v2/admin/components/AlertCampaignSheet.jsx
//
// Sheet lateral que abre ao clicar num alerta no AlertsBell. Não é o
// CampaignDrawer (que é pra ações admin como Loom/Survey/Owner) — esse
// aqui é puramente analítico:
//
//   1. Resumo inteligente: 1 sentença narrativa baseada nos alertas
//      que dispararam (não só lista de regras, mas o "diagnóstico").
//   2. Lista de alertas agrupados por severidade.
//   3. Snapshot de métricas por mídia (Display + Video) com cores
//      condicionais alinhadas à régua do Diagnóstico.
//   4. Footer com 2 ações: abrir report e abrir drawer admin completo.
//
// Reusa o Drawer base de ui/Drawer.jsx (Radix Dialog + animação slide).

import { useMemo, useState, useEffect } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerBody,
  DrawerFooter,
} from "../../../ui/Drawer";
import { Button } from "../../../ui/Button";
import { cn } from "../../../ui/cn";
import { getCampaignStatus, ecpmToneClass, localPartFromEmail } from "../lib/format";
import { STATUS_META, techCostToneClass, formatBrlRow, formatPctRow, formatIntRow } from "../lib/diagnostico";
import { enrichCampaign } from "../lib/alerts/derive";
import { SEVERITY, TARGET_PACING_PCT } from "../lib/alerts/constants";
import { getCampaignLines } from "../../../lib/api";

// ────────────────────────────────────────────────────────────────────────
// Tokens de cor por severidade
// ────────────────────────────────────────────────────────────────────────
const SEVERITY_TONE = {
  [SEVERITY.CRITICAL]: { dot: "bg-danger",   text: "text-danger",   label: "Crítico",   ring: "border-danger/30   bg-danger/5" },
  [SEVERITY.WARNING]:  { dot: "bg-warning",  text: "text-warning",  label: "Atenção",   ring: "border-warning/30  bg-warning/5" },
  [SEVERITY.INFO]:     { dot: "bg-fg-muted", text: "text-fg-muted", label: "Info",      ring: "border-border      bg-surface" },
  [SEVERITY.POSITIVE]: { dot: "bg-success",  text: "text-success",  label: "Oportunidade", ring: "border-success/30 bg-success/5" },
};
const SEVERITY_ORDER = [SEVERITY.CRITICAL, SEVERITY.WARNING, SEVERITY.POSITIVE, SEVERITY.INFO];

// ────────────────────────────────────────────────────────────────────────
// Narrativa inteligente — 1 sentença que sintetiza o estado da campanha
// baseado nas combinações de regras que dispararam. Ordem importa: a
// primeira regra que bater vence.
// ────────────────────────────────────────────────────────────────────────
function buildNarrative(alerts) {
  const has = (id) => alerts.some((a) => a.ruleId === id);
  const criticals = alerts.filter((a) => a.severity === SEVERITY.CRITICAL).length;

  if (has("A1")) return {
    headline: "Campanha parou de entregar ontem",
    body: "Verificar se foi pausa não documentada, pacing zerado no DSP, ou problema de tracking.",
  };
  if (has("A2")) return {
    headline: "Dado parado há mais de 48h",
    body: "Pipeline pode estar travado — investigar antes de tomar qualquer decisão operacional.",
  };
  if (has("E1")) return {
    headline: "Rodando dentro do contrato mas comendo margem",
    body: "Pacing está saudável, mas o Tech Cost está crítico — preço por impressão está errado pra esse PI.",
  };
  if (has("C4") && (has("C1") || has("E3"))) return {
    headline: "Estourando contrato com problemas financeiros",
    body: "Sobreposição de over delivery + Tech Cost ou qualidade ruim — prioridade máxima de ajuste.",
  };
  if (has("C4")) return {
    headline: "Vai entregar acima do limite saudável",
    body: "Projetando passar de 125% do contrato — considerar redução de orçamento ou pausa.",
  };
  if (has("C1")) return {
    headline: "Tech Cost crítico",
    body: "Custo real do DSP acima do tier aceitável vs PI cliente — margem em risco direto.",
  };
  if (has("E3")) return {
    headline: "Inventário caro e com baixa qualidade",
    body: "CPM alto + viewability ruim — vale investigar se a campanha está em inventário adequado.",
  };
  if (has("E4")) return {
    headline: "Padrão suspeito de tráfego",
    body: "CPM anormalmente baixo + CTR alto sugere bot traffic. Validar fontes de impressão.",
  };
  if (has("E5")) return {
    headline: "ABS marcado mas CPM no tier sem-ABS",
    body: "Pre-bid pode não estar ativo — verificar configuração de Brand Safety no setup.",
  };
  if (has("A3")) return {
    headline: "Desacelerou ontem",
    body: "Entrega caiu vs média histórica — verificar se foi cap de budget, pausa parcial, ou inventário escasso.",
  };
  if (has("A4")) return {
    headline: "Burst anômalo ontem",
    body: "Entrega muito acima da média — verificar se foi liberação de budget acumulado ou bug.",
  };
  if (criticals > 0) return {
    headline: `${criticals} ${criticals === 1 ? "alerta crítico" : "alertas críticos"} ativo${criticals === 1 ? "" : "s"}`,
    body: "Múltiplas frentes de risco — revisar item a item.",
  };
  if (alerts.length > 0) return {
    headline: `${alerts.length} ${alerts.length === 1 ? "ponto" : "pontos"} de atenção`,
    body: "Monitorar sem ação imediata, mas marcar como visto após confirmar.",
  };
  // Sem alertas — útil quando clicado por uma row "Ok" do Diagnóstico.
  return {
    headline: "Campanha rodando saudável",
    body: "Sem alertas no momento — métricas dentro dos limites operacionais.",
  };
}

// ────────────────────────────────────────────────────────────────────────
// Status badge — mesma régua do diagnostico
// ────────────────────────────────────────────────────────────────────────
function StatusBadge({ pacing }) {
  if (pacing == null || !Number.isFinite(pacing)) return null;
  let status;
  if (pacing < 100) status = "under";
  else if (pacing < 125) status = "ok";
  else if (pacing < 150) status = "over";
  else status = "super_over";
  const meta = STATUS_META[status];
  if (!meta) return null;
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border",
      "text-[10.5px] font-bold uppercase tracking-wide whitespace-nowrap",
      meta.bgClass, meta.borderClass, meta.textClass,
    )}>
      <span className={cn("size-1.5 rounded-full", meta.dotClass)} />
      {meta.shortLabel}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Card de métrica única (label + valor + cor opcional)
// ────────────────────────────────────────────────────────────────────────
function MetricTile({ label, value, tone, title }) {
  return (
    <div className="px-3 py-2.5 rounded-lg bg-surface border border-border" title={title}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
        {label}
      </p>
      <p className={cn("mt-1 text-sm font-bold tabular-nums leading-none", tone)}>
        {value}
      </p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Grid de métricas por mídia
// ────────────────────────────────────────────────────────────────────────
function MediaMetricsGrid({ mediaName, m, hasAbs }) {
  if (!m) return null;
  const ecpmKind = mediaName === "Video"
    ? "video"
    : (hasAbs ? "displayAbs" : "display");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">
          {mediaName}
        </h4>
        <StatusBadge pacing={m.projected_pacing} />
        {hasAbs && (
          <span className="text-[10px] font-bold uppercase tracking-wide text-fg-subtle px-1.5 py-0.5 rounded bg-surface-strong border border-border">
            ABS
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <MetricTile
          label="Pacing atual"
          value={formatPctRow(m.projected_pacing, 1)}
          title="Pacing = delivered ÷ expected_to_date × 100"
        />
        <MetricTile
          label="CPM Real"
          value={formatBrlRow(m.ecpm_real, 2)}
          tone={ecpmToneClass(m.ecpm_real, ecpmKind)}
          title="eCPM real HYPR (custo cru DSP / 1k imps)"
        />
        <MetricTile
          label="Custo Real"
          value={formatBrlRow(m.real_cost, 0)}
          title="Total já pago ao DSP"
        />
        <MetricTile
          label="Tech Cost"
          value={formatPctRow(m.tech_cost_pct, 1)}
          tone={techCostToneClass(m.tech_cost_pct, hasAbs)}
          title="Custo real ÷ PI cliente × 100"
        />
        <MetricTile
          label="Viewability"
          value={formatPctRow(m.viewability, 1)}
          title="Viewable / total impressions"
        />
        <MetricTile
          label="Dias restantes"
          value={m.days_remaining != null ? `${m.days_remaining}d` : "—"}
          title="Dias até end_date (inclusive)"
        />
        {m.excess_brl != null && m.excess_brl > 0 && (
          <MetricTile
            label="Excesso projetado"
            value={formatBrlRow(m.excess_brl, 0)}
            tone="text-danger"
            title="Volume projetado acima de 125% do contrato × CPM real"
          />
        )}
        {m.catch_up_multiplier != null && m.catch_up_multiplier > 1 && (
          <MetricTile
            label="Catch-up"
            value={`${m.catch_up_multiplier.toFixed(1)}x`}
            tone={m.catch_up_multiplier > 3 ? "text-danger" : m.catch_up_multiplier > 1.5 ? "text-warning" : "text-fg"}
            title="Ritmo necessário pra fechar 100% ÷ ritmo atual"
          />
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Análise de custo: alocado vs ideal pra fechar em TARGET_PACING_PCT%
// ────────────────────────────────────────────────────────────────────────
function CostAnalysisCard({ mediaName, m }) {
  if (!m || m.target_total_cost == null || m.excess_projected_brl == null) {
    return null; // sem ecpm/delivered → análise vazia
  }
  const excessSoFar     = m.excess_so_far_brl;
  const excessProjected = m.excess_projected_brl;
  const overSpending    = excessSoFar > 0;
  const willOverSpend   = excessProjected > 0;
  // Tom geral baseado no excesso projetado (futuro pesa mais que passado).
  const tone = willOverSpend
    ? (excessProjected > m.target_total_cost * 0.30 ? "text-danger" : "text-warning")
    : (excessProjected < -m.target_total_cost * 0.20 ? "text-warning" : "text-success");

  // Recomendação acionável — sempre uma ação de ajuste de budget. Pausar
  // não é opção (mantém compromisso de entrega), então quando o gasto já
  // passou do ideal total, sugerimos redução agressiva ao mínimo operacional
  // (~15% do ritmo atual) pra minimizar over delivery adicional.
  let recommendation = null;
  if (m.days_remaining > 0 && m.current_daily_cost != null && m.current_daily_cost > 0) {
    if (m.ideal_daily_remaining === 0) {
      // Já estourou o budget total ideal — qualquer gasto adicional só
      // piora. Recomenda mínimo operacional: ~15% do ritmo atual.
      const minimalDaily = m.current_daily_cost * 0.15;
      recommendation = {
        verb: "Reduzir agressivamente",
        body: `Gasto total já passou do ideal — reduzir budget pro mínimo operacional, de ${formatBrlRow(m.current_daily_cost, 0)}/dia → ~${formatBrlRow(minimalDaily, 0)}/dia (-85%) nos próximos ${m.days_remaining}d. Cada real adicional aumenta o over delivery.`,
        tone: "text-danger",
      };
    } else if (m.adjustment_pct != null) {
      const absAdj = Math.abs(m.adjustment_pct);
      if (absAdj < 5) {
        recommendation = {
          verb: "Manter",
          body: `Ritmo atual (${formatBrlRow(m.current_daily_cost, 0)}/dia) está dentro de ±5% do ideal — manter como está.`,
          tone: "text-success",
        };
      } else if (m.adjustment_pct < 0) {
        recommendation = {
          verb: "Reduzir",
          body: `Reduzir budget em ${absAdj.toFixed(0)}% — de ${formatBrlRow(m.current_daily_cost, 0)}/dia → ${formatBrlRow(m.ideal_daily_remaining, 0)}/dia nos próximos ${m.days_remaining}d pra fechar em ${TARGET_PACING_PCT}%.`,
          tone: "text-warning",
        };
      } else {
        recommendation = {
          verb: "Aumentar",
          body: `Aumentar budget em ${absAdj.toFixed(0)}% — de ${formatBrlRow(m.current_daily_cost, 0)}/dia → ${formatBrlRow(m.ideal_daily_remaining, 0)}/dia nos próximos ${m.days_remaining}d pra fechar em ${TARGET_PACING_PCT}%.`,
          tone: "text-warning",
        };
      }
    }
  }

  return (
    <div className="space-y-2">
      <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">
        {mediaName}
      </h4>
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        {/* Linha 1 — situação atual */}
        <div className="grid grid-cols-2 divide-x divide-border/60">
          <div className="px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
              Alocado até hoje
            </p>
            <p className="mt-1 text-sm font-bold tabular-nums">
              {formatBrlRow(m.real_cost, 0)}
            </p>
          </div>
          <div className="px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
              Ideal até hoje ({TARGET_PACING_PCT}%)
            </p>
            <p className="mt-1 text-sm font-bold tabular-nums text-fg-muted">
              {formatBrlRow(m.target_cost_to_date, 0)}
            </p>
          </div>
        </div>
        {/* Linha 2 — diferença */}
        <div className="px-3 py-2 border-t border-border/60 bg-canvas-deeper">
          <p className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
            {overSpending ? "Acima do ideal" : "Abaixo do ideal"}
          </p>
          <p className={cn("mt-0.5 text-sm font-bold tabular-nums", overSpending ? "text-danger" : "text-success")}>
            {overSpending ? "+" : ""}{formatBrlRow(excessSoFar, 0)}
          </p>
        </div>
        {/* Linha 3 — projeção */}
        <div className="grid grid-cols-2 divide-x divide-border/60 border-t border-border/60">
          <div className="px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
              Projetado ao final
            </p>
            <p className={cn("mt-1 text-sm font-bold tabular-nums", tone)}>
              {formatBrlRow(m.projected_total_cost, 0)}
            </p>
          </div>
          <div className="px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
              Excesso projetado
            </p>
            <p className={cn("mt-1 text-sm font-bold tabular-nums", willOverSpend ? "text-danger" : "text-success")}>
              {willOverSpend ? "+" : ""}{formatBrlRow(excessProjected, 0)}
            </p>
          </div>
        </div>
        {/* Linha 4 — recomendação */}
        {recommendation && (
          <div className="px-3 py-2.5 border-t border-border/60 bg-surface-strong">
            <div className="flex items-baseline gap-2">
              <span className={cn("text-[10px] font-bold uppercase tracking-wider", recommendation.tone)}>
                {recommendation.verb}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                · ação recomendada
              </span>
            </div>
            <p className="mt-1 text-[11.5px] text-fg leading-relaxed">
              {recommendation.body}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Thresholds de qualidade por line — alinhados ao que a HYPR olha de fato
// ────────────────────────────────────────────────────────────────────────
//
// Régua revisada:
//   • CPM alto (acima do tier por mídia × ABS): warning/critical
//   • Viewability < 60%: warning, < 40% critical
//   • VTR < 60% (era 70): warning, < 40% critical
//   • Cliques zerados (clicks=0 em line com ≥ MIN imps): critical em qualquer
//     mídia — sinaliza erro de contabilização ou setup quebrado.
//   • CTR baixo APENAS no Display (HYPR não se importa com CTR baixo em
//     video, exceto se zerado — já coberto acima).
const LINE_TH = {
  ecpmDisplay:    0.80,
  ecpmDisplayABS: 1.80,
  ecpmVideo:      3.50,
  ecpmVideoABS:   5.00,
  viewability:    60,
  ctrDisplay:     0.30,   // só Display — video low CTR não é sinal
  vtr:            60,     // era 70, mudou pra 60 (ajuste régua HYPR)
};
const MIN_IMPS_FOR_CRITICAL = 5_000; // ignora lines sem volume significativo

function evaluateLineIssues(line, hasAbs) {
  const cost   = Number(line.admin_total_cost ?? line.total_cost) || 0;
  const imps   = Number(line.impressions) || 0;
  if (cost === 0 || imps < MIN_IMPS_FOR_CRITICAL) return null;

  const view   = Number(line.viewable_impressions) || 0;
  const clicks = Number(line.clicks) || 0;
  const starts = Number(line.video_starts) || 0;
  const v100   = Number(line.video_view_100) || 0;
  const isVideo = line.media_type === "VIDEO";

  const ecpm    = imps > 0 ? (cost / imps) * 1000 : null;
  const viewPct = imps > 0 ? (view / imps) * 100  : null;
  const ctr     = view > 0 ? (clicks / view) * 100 : null;
  const vtr     = isVideo && starts > 0 ? (v100 / starts) * 100 : null;

  const ecpmTh = isVideo
    ? (hasAbs ? LINE_TH.ecpmVideoABS : LINE_TH.ecpmVideo)
    : (hasAbs ? LINE_TH.ecpmDisplayABS : LINE_TH.ecpmDisplay);

  const issues = [];

  // CPM alto
  if (ecpm != null && ecpm > ecpmTh) {
    const ratio = ecpm / ecpmTh;
    issues.push({
      key: "cpm",
      label: "CPM alto",
      value: formatBrlRow(ecpm, 2),
      detail: `acima do tier de ${formatBrlRow(ecpmTh, 2)}`,
      severity: ratio > 1.5 ? "critical" : "warning",
    });
  }

  // Viewability baixa (< 60%)
  if (viewPct != null && viewPct < LINE_TH.viewability) {
    issues.push({
      key: "vw",
      label: "Viewability baixa",
      value: `${viewPct.toFixed(0)}%`,
      detail: `abaixo de ${LINE_TH.viewability}%`,
      severity: viewPct < 40 ? "critical" : "warning",
    });
  }

  // VTR baixo — só video. Threshold 60 (era 70).
  if (vtr != null && vtr < LINE_TH.vtr) {
    issues.push({
      key: "vtr",
      label: "VTR baixo",
      value: `${vtr.toFixed(0)}%`,
      detail: `abaixo de ${LINE_TH.vtr}%`,
      severity: vtr < 40 ? "critical" : "warning",
    });
  }

  // Cliques zerados — line com volume mas zero cliques registrados. Em video,
  // é o ÚNICO sinal de CTR que a HYPR olha (CTR baixo não é relevante; zero
  // pode indicar erro de contabilização). Em display, complementa o CTR
  // baixo abaixo (zero é mais grave que baixo).
  if (clicks === 0 && imps >= MIN_IMPS_FOR_CRITICAL) {
    issues.push({
      key: "zeroClicks",
      label: "Cliques zerados",
      value: `0 / ${formatIntRow(imps)} imps`,
      detail: "possível erro de contabilização ou setup",
      severity: "critical",
    });
  } else if (!isVideo && ctr != null && ctr < LINE_TH.ctrDisplay) {
    // CTR Display baixo (não-zero) — só pra display. Video CTR baixo
    // HYPR não monitora; zero já foi capturado acima.
    issues.push({
      key: "ctr",
      label: "CTR baixo",
      value: `${ctr.toFixed(2)}%`,
      detail: `abaixo de ${LINE_TH.ctrDisplay.toFixed(2)}%`,
      severity: ctr < LINE_TH.ctrDisplay * 0.5 ? "critical" : "warning",
    });
  }

  return { cost, imps, isVideo, issues };
}

// ────────────────────────────────────────────────────────────────────────
// Pílula de problema (badge inline)
// ────────────────────────────────────────────────────────────────────────
function IssuePill({ issue }) {
  const tone = issue.severity === "critical"
    ? "border-danger/40 bg-danger/8 text-danger"
    : "border-warning/40 bg-warning/8 text-warning";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md border",
        "text-[10.5px] font-medium whitespace-nowrap",
        tone,
      )}
      title={`${issue.label}: ${issue.value} (${issue.detail})`}
    >
      {issue.label}
      <span className="font-bold tabular-nums">{issue.value}</span>
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Critical lines — substitui o antigo "Top spending lines". Mostra só
// lines com problemas concretos, ranqueadas por gasto × severidade.
// ────────────────────────────────────────────────────────────────────────
// Acha o maior prefixo comum entre os nomes — usado pra esconder o prefixo
// redundante "ID-{token}_HYPR_{client}_..." que aparece em todas as lines
// da mesma campanha. Mantém pelo menos os 4 últimos caracteres do prefixo
// pra preservar contexto (ex: "...AON_RANGE_ROVER_O2O" em vez de "O2O").
function longestCommonPrefix(strings) {
  if (!strings || strings.length === 0) return "";
  if (strings.length === 1) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (strings[i].indexOf(prefix) !== 0) {
      prefix = prefix.substring(0, prefix.length - 1);
      if (prefix === "") return "";
    }
  }
  // Só strip se o prefixo é grande o bastante pra valer a pena (≥ 8 chars).
  return prefix.length >= 8 ? prefix : "";
}

function CriticalLines({ shortToken, hasAbsDisplay, hasAbsVideo }) {
  const [state, setState] = useState({ loading: true, lines: [], error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, lines: [], error: null });
    getCampaignLines({ short_token: shortToken })
      .then((lines) => {
        if (cancelled) return;
        setState({ loading: false, lines: lines || [], error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ loading: false, lines: [], error: err.message || String(err) });
      });
    return () => { cancelled = true; };
  }, [shortToken]);

  // Avalia cada line e mantém só as que têm pelo menos 1 problema.
  // Score = soma das severidades (critical=2, warning=1) × log10(1 + cost).
  // Lines com problemas amplificadas pelo volume de gasto.
  const critical = useMemo(() => {
    const out = [];
    for (const l of state.lines) {
      const hasAbs = l.media_type === "VIDEO" ? hasAbsVideo : hasAbsDisplay;
      const evaluated = evaluateLineIssues(l, hasAbs);
      if (!evaluated || evaluated.issues.length === 0) continue;
      const severityScore = evaluated.issues.reduce(
        (s, i) => s + (i.severity === "critical" ? 2 : 1), 0
      );
      const score = severityScore * Math.log10(1 + evaluated.cost);
      out.push({ ...l, ...evaluated, score });
    }
    out.sort((a, b) => b.score - a.score || b.cost - a.cost);
    return out.slice(0, 5);
  }, [state.lines, hasAbsDisplay, hasAbsVideo]);

  // Strip de prefixo comum pra deixar os nomes legíveis.
  const commonPrefix = useMemo(
    () => longestCommonPrefix(critical.map((l) => l.line_name || "")),
    [critical]
  );
  const cleanName = (name) => {
    if (!name) return "—";
    if (!commonPrefix) return name;
    return name.startsWith(commonPrefix) ? name.slice(commonPrefix.length) : name;
  };

  if (state.loading) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-4 text-center">
        <p className="text-[11px] text-fg-muted italic">Analisando lines…</p>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-4">
        <p className="text-[11px] text-danger">Erro ao buscar lines: {state.error}</p>
      </div>
    );
  }
  if (critical.length === 0) {
    return (
      <div className="rounded-lg border border-success/30 bg-success/5 px-3 py-3 text-center">
        <p className="text-[11px] text-success">
          Todas as lines estão dentro dos tiers ideais.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <ul className="divide-y divide-border/40">
        {critical.map((l, i) => (
          <li key={`${l.line_name}-${i}`} className="px-3 py-3 space-y-2">
            {/* Linha 1: nome + gasto */}
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-semibold text-fg truncate" title={l.line_name}>
                  {cleanName(l.line_name)}
                </p>
                <p className="mt-0.5 text-[10.5px] text-fg-muted">
                  {l.isVideo ? "Video" : "Display"}
                  {l.tactic_type ? ` · ${l.tactic_type}` : ""}
                  {` · ${formatIntRow(l.imps)} imps`}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p
                  className="text-[12px] font-bold tabular-nums text-fg"
                  title="Gasto cru HYPR pago ao DSP por essa line"
                >
                  {formatBrlRow(l.cost, 0)}
                </p>
                <p className="text-[9.5px] uppercase tracking-wide text-fg-subtle font-semibold">
                  gasto
                </p>
              </div>
            </div>
            {/* Linha 2: badges dos problemas */}
            <div className="flex flex-wrap gap-1.5">
              {l.issues.map((issue) => (
                <IssuePill key={issue.key} issue={issue} />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Survey lines acima da régua — operação HYPR teto R$ 1.000 por line
// ────────────────────────────────────────────────────────────────────────
//
// Survey nunca entra em "Lines Críticas" (que avalia CPM/CTR/VTR/viewability,
// e survey é excluído dessas métricas). Mas survey custa dinheiro real, sai
// da carteira HYPR e entra no tech cost — então precisa de visibilidade
// própria pra admin detectar quando tá inflando margem.
//
// Régua operacional: R$ 1.000 por line de survey por campanha. Acima disso
// flag pra revisão. Em campanha com várias lines de survey, é comum 1 ou 2
// passarem do teto — não necessariamente é erro, mas precisa decisão.
//
// Detecção espelha o filtro SQL do backend ([main.py:5021](unified CTE)):
//   line_name match SURVEY|_(CONTROLE|EXPOSTO)(_|$)  OU
//   creative_name contém SURVEY
const SURVEY_COST_THRESHOLD = 1000;

function isSurveyLine(line) {
  const lname = String(line.line_name || "").toUpperCase();
  if (/SURVEY/.test(lname)) return true;
  if (/_(?:CONTROLE|EXPOSTO)(?:_|$)/.test(lname)) return true;
  const cname = String(line.creative_name || "").toUpperCase();
  if (/SURVEY/.test(cname)) return true;
  return false;
}

function SurveyLines({ shortToken }) {
  const [state, setState] = useState({ loading: true, lines: [], error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, lines: [], error: null });
    getCampaignLines({ short_token: shortToken })
      .then((lines) => {
        if (cancelled) return;
        setState({ loading: false, lines: lines || [], error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ loading: false, lines: [], error: err.message || String(err) });
      });
    return () => { cancelled = true; };
  }, [shortToken]);

  // Filtra survey + ordena por gasto desc. Inclui TODAS as survey (acima e
  // abaixo do teto) pra dar contexto — admin precisa ver "as 3 surveys
  // gastaram R$ X total, sendo Y acima da régua".
  const surveyLines = useMemo(() => {
    const out = [];
    for (const l of state.lines) {
      if (!isSurveyLine(l)) continue;
      const cost = Number(l.admin_total_cost ?? l.total_cost) || 0;
      if (cost <= 0) continue;
      out.push({ ...l, cost });
    }
    out.sort((a, b) => b.cost - a.cost);
    return out;
  }, [state.lines]);

  const acimaTeto = useMemo(
    () => surveyLines.filter((l) => l.cost > SURVEY_COST_THRESHOLD),
    [surveyLines]
  );
  const totalSurveyCost = useMemo(
    () => surveyLines.reduce((s, l) => s + l.cost, 0),
    [surveyLines]
  );

  // Strip prefixo comum (mesma lógica de CriticalLines).
  const commonPrefix = useMemo(
    () => longestCommonPrefix(surveyLines.map((l) => l.line_name || "")),
    [surveyLines]
  );
  const cleanName = (name) => {
    if (!name) return "—";
    if (!commonPrefix) return name;
    return name.startsWith(commonPrefix) ? name.slice(commonPrefix.length) : name;
  };

  if (state.loading) return null; // já temos loading no CriticalLines acima
  if (state.error) return null;   // erro já mostrado no CriticalLines
  if (surveyLines.length === 0) return null; // sem survey, esconde a seção inteira

  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
          Survey acima da régua
        </h3>
        <p className="mt-1 text-[11px] text-fg-muted leading-snug">
          Régua HYPR: máx <strong>{formatBrlRow(SURVEY_COST_THRESHOLD, 0)}</strong> por
          line de survey. {surveyLines.length} survey{surveyLines.length > 1 ? "s" : ""} nessa
          campanha, total {formatBrlRow(totalSurveyCost, 0)}.
          {acimaTeto.length > 0 && (
            <> <span className="text-danger font-semibold">{acimaTeto.length} acima do teto.</span></>
          )}
        </p>
      </div>
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <ul className="divide-y divide-border/40">
          {surveyLines.map((l, i) => {
            const acima = l.cost > SURVEY_COST_THRESHOLD;
            return (
              <li key={`survey-${l.line_name}-${i}`} className="px-3 py-2.5 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-semibold text-fg truncate" title={l.line_name}>
                    {cleanName(l.line_name)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={cn(
                      "text-[12px] font-bold tabular-nums",
                      acima ? "text-danger" : "text-fg-muted"
                    )}
                    title={acima
                      ? `R$ ${(l.cost - SURVEY_COST_THRESHOLD).toFixed(0)} acima do teto`
                      : "Dentro da régua"}
                  >
                    {formatBrlRow(l.cost, 0)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Componente principal
// ────────────────────────────────────────────────────────────────────────
/**
 * Props:
 *   open, onOpenChange — controle do drawer
 *   campaign           — objeto cru da campanha (do listCampaigns)
 *   alerts             — alertas já filtrados pra essa campanha
 *   teamMap            — { email → nome } pra resolver owners
 *   onOpenReport       — (short_token) => void
 *   onOpenAdminDrawer  — opcional, abre o CampaignDrawer admin
 */
export function AlertCampaignSheet({
  open,
  onOpenChange,
  campaign,
  alerts = [],
  teamMap = {},
  onOpenReport,
  onOpenAdminDrawer,
}) {
  // Enriquece a campanha pra ter projeções nas métricas. Recomputa só
  // quando a campanha selecionada muda — não a cada render.
  const enriched = useMemo(
    () => campaign ? enrichCampaign(campaign, getCampaignStatus) : null,
    [campaign]
  );

  const narrative = useMemo(() => buildNarrative(alerts), [alerts]);

  // Agrupa alertas por severidade pra render organizado.
  const grouped = useMemo(() => {
    const out = { [SEVERITY.CRITICAL]: [], [SEVERITY.WARNING]: [], [SEVERITY.POSITIVE]: [], [SEVERITY.INFO]: [] };
    for (const a of alerts) {
      if (out[a.severity]) out[a.severity].push(a);
    }
    return out;
  }, [alerts]);

  if (!campaign) return null;

  const csName = campaign.cs_email
    ? (teamMap[campaign.cs_email] || localPartFromEmail(campaign.cs_email))
    : null;
  const cpName = campaign.cp_email
    ? (teamMap[campaign.cp_email] || localPartFromEmail(campaign.cp_email))
    : null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent widthClass="sm:w-[480px]">
        <DrawerHeader
          title={`${campaign.client_name} / ${campaign.campaign_name}`}
          subtitle={[campaign.short_token, csName && `CS ${csName}`, cpName && `CP ${cpName}`].filter(Boolean).join(" · ")}
          titleClassName="text-base leading-tight"
        />

        <DrawerBody className="space-y-6">
          {/* ── Narrativa ─────────────────────────────────────────── */}
          {narrative && (
            <div className={cn(
              "rounded-xl border px-4 py-3.5",
              alerts.some((a) => a.severity === SEVERITY.CRITICAL)
                ? "border-danger/30 bg-danger/5"
                : alerts.some((a) => a.severity === SEVERITY.WARNING)
                  ? "border-warning/30 bg-warning/5"
                  : "border-border bg-surface",
            )}>
              <p className="text-[13px] font-bold text-fg leading-snug">
                {narrative.headline}
              </p>
              <p className="mt-1 text-[12px] text-fg-muted leading-relaxed">
                {narrative.body}
              </p>
            </div>
          )}

          {/* ── Lista de alertas agrupados ────────────────────────── */}
          {alerts.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                Alertas ({alerts.length})
              </h3>
              {SEVERITY_ORDER.map((sev) => {
                const list = grouped[sev];
                if (!list || list.length === 0) return null;
                const tone = SEVERITY_TONE[sev];
                return (
                  <div key={sev} className="space-y-1.5">
                    <p className={cn("text-[10.5px] font-bold uppercase tracking-wider", tone.text)}>
                      {tone.label} · {list.length}
                    </p>
                    <ul className="space-y-1.5">
                      {list.map((a) => (
                        <li
                          key={a.id}
                          className={cn(
                            "flex items-start gap-2.5 px-3 py-2.5 rounded-lg border",
                            tone.ring,
                          )}
                        >
                          <span className={cn("shrink-0 mt-1 size-1.5 rounded-full", tone.dot)} />
                          <div className="min-w-0 flex-1">
                            <p className="text-[12.5px] font-semibold text-fg leading-snug">
                              {a.message.replace(`${campaign.client_name}/${campaign.campaign_name} `, "")}
                            </p>
                            <p className="mt-0.5 text-[11px] text-fg-muted leading-snug">
                              {a.detail}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>
          )}

          {/* ── Snapshot de métricas ─────────────────────────────── */}
          {enriched && (enriched.display || enriched.video) && (
            <section className="space-y-4">
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                Snapshot
              </h3>
              {enriched.display && (
                <MediaMetricsGrid
                  mediaName="Display"
                  m={enriched.display}
                  hasAbs={!!campaign.display_has_abs}
                />
              )}
              {enriched.video && (
                <MediaMetricsGrid
                  mediaName="Video"
                  m={enriched.video}
                  hasAbs={!!campaign.video_has_abs}
                />
              )}
            </section>
          )}

          {/* ── Análise de custo: alocado vs ideal pra fechar em 110% ── */}
          {enriched && (
            (enriched.display?.target_total_cost != null ||
             enriched.video?.target_total_cost != null) && (
              <section className="space-y-4">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                  Análise de custo (meta {TARGET_PACING_PCT}% pacing)
                </h3>
                {enriched.display?.target_total_cost != null && (
                  <CostAnalysisCard mediaName="Display" m={enriched.display} />
                )}
                {enriched.video?.target_total_cost != null && (
                  <CostAnalysisCard mediaName="Video" m={enriched.video} />
                )}
              </section>
            )
          )}

          {/* ── Lines críticas (lazy fetch via getCampaignLines) ─────── */}
          <section className="space-y-2">
            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                Lines críticas
              </h3>
              <p className="mt-1 text-[11px] text-fg-muted leading-snug">
                Lines que estão fora dos tiers ideais (CPM, viewability, CTR, VTR), priorizadas pelo gasto. Só aparecem aqui se têm problema concreto — não é ranking de "quem gastou mais".
              </p>
            </div>
            <CriticalLines
              shortToken={campaign.short_token}
              hasAbsDisplay={!!campaign.display_has_abs}
              hasAbsVideo={!!campaign.video_has_abs}
            />
          </section>

          {/* ── Survey acima da régua (R$ 1.000) ────────────────────────
              Renderiza condicional: se não há survey na campanha, o
              componente devolve null e a seção some inteira. */}
          <SurveyLines shortToken={campaign.short_token} />
        </DrawerBody>

        <DrawerFooter>
          {onOpenReport && (
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                onOpenReport(campaign.short_token);
                onOpenChange?.(false);
              }}
              className="flex-1"
            >
              Abrir report
            </Button>
          )}
          {onOpenAdminDrawer && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                onOpenAdminDrawer(campaign);
                onOpenChange?.(false);
              }}
              className="flex-1"
            >
              Ações admin
            </Button>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
