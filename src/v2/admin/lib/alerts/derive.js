// src/v2/admin/lib/alerts/derive.js
//
// Enriquece cada campanha com métricas derivadas pras regras de alerta:
//
//   • elapsed_days / days_remaining / total_days
//   • daily_rate por mídia
//   • d1_rate por mídia (D-1)
//   • velocity_ratio = d1_rate / daily_rate (detecta aceleração/desaceleração)
//   • negotiated reconstruído (mesma matemática do diagnostico.js)
//   • projected_final + projected_pacing (ritmo constante)
//   • catch_up_multiplier (quanto a mais por dia precisa pra fechar)
//   • projected_real_cost + projected_tech_cost_pct (Tech Cost futuro)
//   • overspend_brl (prejuízo direto em super_over)
//   • viewability (cap em 100%, igual ao diagnostico)
//
// Tudo per-media (display + video separados). Campanha mista vira 2 entries
// no array de enriched_media, pra regras avaliarem cada mídia
// independentemente — espelha o que o buildDiagnosticoRows já faz.

import { MAX_OK_PACING_RATIO, TARGET_PACING_PCT } from "./constants";

const MS_PER_DAY = 86_400_000;

function parseDateUTC(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}

function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/**
 * Constrói as projeções pra uma campanha+mídia. Retorna null quando faltar
 * dado mínimo (sem delivered ou sem datas válidas).
 */
function deriveMediaProjections({
  pacing,
  delivered,
  expectedToDate,
  startDate,
  endDate,
  lastDayDelivered,
  realCost,            // custo COM survey (admin_total_cost_full) — base do tech cost
  realCostNoSurvey,    // custo SEM survey (admin_total_cost) — pra disclaimer da Atenção
  clientBudget,
  ecpmReal,
  impressionsGross,
}) {
  if (!delivered && !pacing && !expectedToDate) return null;

  const s = parseDateUTC(startDate);
  const e = parseDateUTC(endDate);
  if (!s || !e) return null;

  const today = todayUTC();
  const total_days   = daysBetween(s, e) + 1;
  const elapsed_days = Math.max(0, Math.min(total_days, daysBetween(s, today) + 1));
  if (total_days <= 0 || elapsed_days <= 0) return null;

  const days_remaining = Math.max(0, total_days - elapsed_days + 1);
  const elapsed_ratio  = elapsed_days / total_days;

  // Reconstrói negotiated (volume contratado) a partir de expected_to_date,
  // que o backend já manda pro-rata calendar. Fallback: usa pacing+delivered.
  let negotiated = null;
  if (expectedToDate && expectedToDate > 0) {
    negotiated = expectedToDate / elapsed_ratio;
  } else if (pacing && delivered && pacing > 0) {
    const expected = delivered / (pacing / 100);
    negotiated = expected / elapsed_ratio;
  }

  // Ritmo médio realizado (constante implícito no `pacing`).
  const daily_rate = delivered && delivered > 0 && elapsed_days > 0
    ? delivered / elapsed_days
    : null;

  // Ritmo de ontem (D-1). Quando ausente, vira null — algumas regras só
  // disparam se temos D-1 (parou, desaceleração, burst).
  const d1_rate = lastDayDelivered != null && Number.isFinite(lastDayDelivered)
    ? lastDayDelivered
    : null;

  // Razão D-1 / média. null se faltar D-1 ou média.
  const velocity_ratio = (d1_rate != null && daily_rate != null && daily_rate > 0)
    ? d1_rate / daily_rate
    : null;

  // Projeção forward-looking (ritmo constante = média histórica).
  const projected_final = (daily_rate != null && days_remaining > 0)
    ? delivered + daily_rate * days_remaining
    : delivered;
  const projected_pacing = (negotiated != null && negotiated > 0 && projected_final != null)
    ? (projected_final / negotiated) * 100
    : null;

  // Catch-up multiplier: ritmo necessário pra fechar / ritmo atual.
  // > 1 = precisa acelerar; >> 1 = quase impossível; < 1 = vai estourar.
  let catch_up_multiplier = null;
  if (negotiated != null && delivered != null && daily_rate != null && daily_rate > 0 && days_remaining > 0) {
    const remaining_needed = Math.max(0, negotiated - delivered);
    const required_rate    = remaining_needed / days_remaining;
    catch_up_multiplier    = required_rate / daily_rate;
  }

  // Projeção de custo real: escala linear com o delivery.
  let projected_real_cost = null;
  let projected_tech_cost_pct = null;
  if (realCost != null && delivered != null && delivered > 0 && projected_final != null) {
    projected_real_cost = realCost * (projected_final / delivered);
    if (clientBudget != null && clientBudget > 0) {
      projected_tech_cost_pct = (projected_real_cost / clientBudget) * 100;
    }
  }

  // Over delivery não faturado — volume entregue ACIMA do limite saudável
  // (125% do contratado) × CPM real. O teto de 125% espelha a classificação
  // do diagnostico: até 125% é gordura aceitável (zona OK); acima disso vira
  // "over" e o excesso não tem contrapartida de faturamento (PI é cap fixo).
  //
  // Usa import dinâmico do constants pra evitar ciclo — `MAX_OK_PACING_RATIO`
  // está em constants.js que importa zero deste arquivo.
  let excess_brl = null;
  if (
    projected_final != null && negotiated != null &&
    ecpmReal != null && ecpmReal > 0
  ) {
    const acceptableMax = negotiated * MAX_OK_PACING_RATIO;
    if (projected_final > acceptableMax) {
      excess_brl = (projected_final - acceptableMax) * ecpmReal / 1000;
    }
  }

  // Viewability cap 100% (mesmo cuidado do diagnostico.js).
  let viewability = (impressionsGross != null && impressionsGross > 0 && delivered != null && delivered > 0)
    ? (delivered / impressionsGross) * 100
    : null;
  if (viewability != null && viewability > 100) viewability = 100;

  // Tech cost atual (snapshot). Usa realCost que JÁ é com survey (vem
  // de admin_total_cost_full no caller).
  const tech_cost_pct = (realCost != null && clientBudget != null && clientBudget > 0)
    ? (realCost / clientBudget) * 100
    : null;

  // Tech cost SEM survey + contribuição do survey — usado pelo disclaimer
  // da Atenção. Quando survey representa parcela significativa do custo
  // (>25%), o alerta mostra "↳ R$ X vem de survey, sem survey: Y%".
  // Permite admin distinguir "tech cost alto operacional" de "tech cost
  // alto por causa de survey grande".
  const survey_cost_brl = (realCost != null && realCostNoSurvey != null)
    ? Math.max(0, realCost - realCostNoSurvey)
    : 0;
  const tech_cost_pct_no_survey = (realCostNoSurvey != null && clientBudget != null && clientBudget > 0)
    ? (realCostNoSurvey / clientBudget) * 100
    : null;
  // Share do survey no custo total. Se for >0.25 (25%), alertas tech cost
  // adicionam disclaimer. Calculado aqui pra centralizar e evitar duplicar
  // a régua nas 3 regras (C1/C2/C3).
  const survey_share = (realCost != null && realCost > 0)
    ? survey_cost_brl / realCost
    : 0;

  // ── Análise de custo: alocado vs ideal ─────────────────────────────
  // Pra cada momento, computa quanto deveria ter sido alocado pra fechar
  // em `TARGET_PACING_PCT`. A premissa é que `ecpm_real` se mantém
  // constante até o fim — boa aproximação porque o inventário do DSP é
  // o mesmo. Se ecpm_real ausente (admin_cost zero), análise vira null.
  let target_cost_to_date     = null;
  let target_total_cost       = null;
  let excess_so_far_brl       = null;
  let projected_total_cost    = null;
  let excess_projected_brl    = null;
  let current_daily_cost      = null;
  let ideal_daily_remaining   = null;
  let adjustment_pct          = null;
  if (
    realCost != null && realCost > 0 &&
    delivered != null && delivered > 0 &&
    negotiated != null && negotiated > 0 &&
    ecpmReal != null && ecpmReal > 0
  ) {
    const targetRatio = TARGET_PACING_PCT / 100;
    // Custo "ideal" = volume_alvo × ecpm / 1000.
    const targetDeliveredToDate = (negotiated * elapsed_ratio) * targetRatio;
    target_cost_to_date  = (targetDeliveredToDate * ecpmReal) / 1000;
    target_total_cost    = (negotiated * targetRatio * ecpmReal) / 1000;
    excess_so_far_brl    = realCost - target_cost_to_date;

    projected_total_cost = realCost * (projected_final / delivered);
    excess_projected_brl = projected_total_cost - target_total_cost;

    current_daily_cost = realCost / elapsed_days;
    if (days_remaining > 0) {
      const remainingBudget = target_total_cost - realCost;
      // Se já gastamos mais que o alvo total, o ideal é parar (0).
      ideal_daily_remaining = Math.max(0, remainingBudget / days_remaining);
      // % de ajuste no ritmo: (ideal - atual) / atual × 100.
      // Negativo = reduzir; positivo = aumentar. null se atual=0.
      if (current_daily_cost > 0) {
        adjustment_pct = ((ideal_daily_remaining - current_daily_cost) / current_daily_cost) * 100;
      }
    }
  }

  return {
    total_days,
    elapsed_days,
    days_remaining,
    delivered: delivered ?? null,
    negotiated,
    daily_rate,
    d1_rate,
    velocity_ratio,
    projected_final,
    projected_pacing,
    catch_up_multiplier,
    real_cost: realCost ?? null,
    real_cost_no_survey: realCostNoSurvey ?? null,
    survey_cost_brl,
    survey_share,
    projected_real_cost,
    tech_cost_pct,
    tech_cost_pct_no_survey,
    projected_tech_cost_pct,
    excess_brl,
    viewability,
    ecpm_real: ecpmReal ?? null,
    client_budget: clientBudget ?? null,
    // Análise de custo (sheet de deep-dive — todos null se faltar ecpm/delivered)
    target_cost_to_date,
    target_total_cost,
    excess_so_far_brl,
    projected_total_cost,
    excess_projected_brl,
    current_daily_cost,
    ideal_daily_remaining,
    adjustment_pct,
  };
}

/**
 * Enriquece uma campanha com seus 2 lados (display, video) caso aplicável.
 * Retorna [{ media: "display", ... }, { media: "video", ... }] com null pra
 * mídias inexistentes.
 */
export function enrichCampaign(c, statusFn) {
  const camp_status = statusFn(c.end_date, c.closed_at, c.paused_at, c.early_end_date);

  // realCost = COM survey (`_full`) — alinha com a régua do KPI strip e da
  // tabela do diagnostico. Fallback pro sem-survey enquanto backend não tem
  // o campo `_full` (deploy gracioso).
  // realCostNoSurvey = SEM survey (campo legado) — usado pelo disclaimer
  // das regras C1/C2/C3 quando survey é >25% do custo total.
  const display = deriveMediaProjections({
    pacing:           c.display_pacing,
    delivered:        c.display_viewable_impressions,
    expectedToDate:   c.display_expected_impressions,
    startDate:        c.start_date,
    endDate:          c.end_date,
    lastDayDelivered: c.display_yesterday_viewable,
    realCost:         c.d_admin_total_cost_full ?? c.d_admin_total_cost,
    realCostNoSurvey: c.d_admin_total_cost,
    clientBudget:     c.d_client_budget,
    ecpmReal:         c.display_ecpm,
    impressionsGross: c.d_admin_impressions,
  });

  const video = deriveMediaProjections({
    pacing:           c.video_pacing,
    delivered:        c.video_viewable_completions,
    expectedToDate:   c.video_expected_completions,
    startDate:        c.start_date,
    endDate:          c.end_date,
    lastDayDelivered: c.video_yesterday_completions,
    realCost:         c.v_admin_total_cost_full ?? c.v_admin_total_cost,
    realCostNoSurvey: c.v_admin_total_cost,
    clientBudget:     c.v_client_budget,
    ecpmReal:         c.video_ecpm,
    impressionsGross: c.v_admin_impressions,
  });

  return {
    raw: c,
    camp_status,
    display,
    video,
  };
}

/**
 * Idade do `updated_at` em horas. Null se campo ausente/inválido.
 */
export function staleHours(updated_at) {
  if (!updated_at) return null;
  const t = new Date(updated_at);
  if (isNaN(t.getTime())) return null;
  return (Date.now() - t.getTime()) / (1000 * 60 * 60);
}
