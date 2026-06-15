// src/v2/admin/lib/alerts/rules.js
//
// Catálogo de 18 regras de alerta. Cada regra é um objeto puro com:
//
//   id, category, severity, label, evaluate(ctx) → null | { message, detail, impactBrl }
//
// `ctx` tem:
//   { campaign: enrichedCampaign, media: "display" | "video", clientBudget, ... }
//
// `evaluate` retorna null quando a regra NÃO se aplica (sem dado / fora da
// condição). Retornando objeto = alerta dispara.
//
// `impactBrl` quando undefined vira 0 (entra no score sem peso financeiro).
//
// Não importa nenhum estado nem efeito colateral aqui — engine.js compõe.

import { CATEGORY, SEVERITY } from "./constants";
import {
  STALE_UPDATED_AT_HOURS,
  VELOCITY_DECEL_RATIO,
  VELOCITY_ACCEL_RATIO,
  MIN_DAYS_FOR_VELOCITY,
  MIN_DAYS_FOR_STOPPED,
  TECH_COST,
  MIN_BUDGET_FOR_TECH_ALERT,
  EXCESS_BRL_THRESHOLD,
  MAX_OK_PACING_RATIO,
  VIEWABILITY_LOW_PCT,
  FRAUD_CTR_PCT,
  FRAUD_CPM_BRL,
} from "./constants";
import { staleHours } from "./derive";
import { buildFrenteSubBars } from "../../../../shared/aggregations";

const fmtBrl = (n) => (n == null || !Number.isFinite(n))
  ? "—"
  : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtInt = (n) => (n == null || !Number.isFinite(n)) ? "—" : Math.round(n).toLocaleString("pt-BR");
const fmtPct = (n, d = 1) => (n == null || !Number.isFinite(n)) ? "—" : `${n.toFixed(d)}%`;

const mediaLabel = (m) => m === "video" ? "Video" : "Display";

// ────────────────────────────────────────────────────────────────────────
// Helpers de threshold
// ────────────────────────────────────────────────────────────────────────
const techTier = (hasAbs) => hasAbs ? TECH_COST.abs : TECH_COST.noAbs;

// Threshold pra mostrar disclaimer de survey nos alertas de tech cost.
// 25% = survey representa pelo menos 1/4 do custo total. Abaixo disso a
// "contaminação" é pequena e o alerta com survey já é o tech cost real
// que o admin deve agir. Acima, vale mostrar a quebra pra admin distinguir
// "tech cost alto operacional" de "survey inflando margem".
const SURVEY_SHARE_DISCLAIMER_THRESHOLD = 0.25;

/**
 * Concatena disclaimer de survey ao detail do alerta quando survey é
 * parcela significativa do custo. Devolve detail original se não atinge
 * o threshold ou se faltam dados.
 *
 * Ex: detail original = "Display · ~R$ 1.700 de margem comida"
 *     com disclaimer  = "Display · ~R$ 1.700 de margem comida\n
 *                        ↳ R$ 2.436 vem de SURVEY (87% do custo) — sem survey: 9.4%"
 */
function appendSurveyDisclaimer(detail, m) {
  if (!m || !m.survey_share || m.survey_share < SURVEY_SHARE_DISCLAIMER_THRESHOLD) return detail;
  if (!m.survey_cost_brl || m.tech_cost_pct_no_survey == null) return detail;
  const sharePct = Math.round(m.survey_share * 100);
  return `${detail}\n↳ ${fmtBrl(m.survey_cost_brl)} vem de SURVEY (${sharePct}% do custo) — sem survey: ${fmtPct(m.tech_cost_pct_no_survey, 1)}`;
}

// ────────────────────────────────────────────────────────────────────────
// Cada rule.evaluate recebe { enriched, media, hasAbs, rawCampaign }
// e retorna null OU { message, detail, impactBrl }
// ────────────────────────────────────────────────────────────────────────

const RULES_PER_MEDIA = [
  // ── A · OPERACIONAL ─────────────────────────────────────────────────
  {
    id: "A1",
    category: CATEGORY.OPERATIONAL,
    severity: SEVERITY.CRITICAL,
    label: "Parou de entregar ontem",
    evaluate: ({ enriched, media, rawCampaign }) => {
      const m = enriched[media];
      if (!m) return null;
      // Só campanha que já rodou alguns dias — se começou anteontem e ontem
      // não entregou, pode ser ramp-up natural, não vale alarmar.
      if (m.elapsed_days < MIN_DAYS_FOR_STOPPED) return null;
      // D-1 ausente = backend não entregou o yesterday_delivery. Pode ser
      // que rollou às 6h e ainda tá processando — então diferenciamos: se
      // delivered > 0 (já tem histórico) e D-1 == 0 confirmado pelo daily_rate,
      // assumimos parou. Sem D-1 disponível, regra não dispara.
      if (m.d1_rate == null) return null;
      if (m.d1_rate > 0) return null;
      if (m.delivered == null || m.delivered <= 0) return null;

      const lostBrl = m.daily_rate != null && m.ecpm_real
        ? (m.daily_rate * m.ecpm_real / 1000)
        : 0;
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} parou de entregar ontem`,
        detail:  `${mediaLabel(media)} · ritmo médio diário ${fmtInt(m.daily_rate)} · ~${fmtBrl(lostBrl)}/dia em risco`,
        impactBrl: lostBrl * (m.days_remaining || 1),
      };
    },
  },
  {
    id: "A2",
    category: CATEGORY.OPERATIONAL,
    severity: SEVERITY.CRITICAL,
    label: "Pipeline travado",
    isCampaignLevel: true,  // não depende da mídia — uma vez por campanha
    evaluate: ({ enriched, rawCampaign }) => {
      const hours = staleHours(rawCampaign.updated_at);
      if (hours == null) return null;
      if (hours <= STALE_UPDATED_AT_HOURS) return null;
      // Volume "em jogo" = budget cliente total da campanha.
      const totalBudget = (enriched.display?.client_budget || 0) + (enriched.video?.client_budget || 0);
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} sem dado novo há ${Math.round(hours)}h`,
        detail:  `Pipeline pode ter travado · ${fmtBrl(totalBudget)} no contrato`,
        impactBrl: totalBudget,
      };
    },
  },
  {
    id: "A3",
    category: CATEGORY.OPERATIONAL,
    severity: SEVERITY.WARNING,
    label: "Desacelerou ontem",
    evaluate: ({ enriched, media, rawCampaign }) => {
      const m = enriched[media];
      if (!m) return null;
      if (m.elapsed_days < MIN_DAYS_FOR_VELOCITY) return null;
      if (m.velocity_ratio == null) return null;
      if (m.velocity_ratio >= VELOCITY_DECEL_RATIO) return null;
      if (m.velocity_ratio <= 0) return null; // 0 cai na regra A1 (parou)
      const deficitBrl = m.client_budget && m.projected_pacing
        ? Math.max(0, (1 - m.projected_pacing / 100) * m.client_budget)
        : 0;
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} desacelerou ontem`,
        detail:  `${mediaLabel(media)} · D-1 ${fmtInt(m.d1_rate)} vs média ${fmtInt(m.daily_rate)} (${fmtPct(m.velocity_ratio * 100, 0)})`,
        impactBrl: deficitBrl,
      };
    },
  },
  {
    id: "A4",
    category: CATEGORY.OPERATIONAL,
    severity: SEVERITY.WARNING,
    label: "Burst anômalo ontem",
    evaluate: ({ enriched, media, rawCampaign }) => {
      const m = enriched[media];
      if (!m) return null;
      if (m.elapsed_days < MIN_DAYS_FOR_VELOCITY) return null;
      if (m.velocity_ratio == null) return null;
      if (m.velocity_ratio <= VELOCITY_ACCEL_RATIO) return null;
      const overspendBrl = m.daily_rate && m.ecpm_real
        ? (m.d1_rate - m.daily_rate) * m.ecpm_real / 1000
        : 0;
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} entregou ${m.velocity_ratio.toFixed(1)}x a média ontem`,
        detail:  `${mediaLabel(media)} · D-1 ${fmtInt(m.d1_rate)} vs média ${fmtInt(m.daily_rate)} · ~${fmtBrl(overspendBrl)} de gasto extra`,
        impactBrl: overspendBrl,
      };
    },
  },
  {
    id: "A5",
    category: CATEGORY.OPERATIONAL,
    severity: SEVERITY.CRITICAL,
    label: "Inconsistência: pacing OK mas D-1 = 0",
    evaluate: ({ enriched, media, rawCampaign }) => {
      const m = enriched[media];
      if (!m) return null;
      const pacing = m.projected_pacing;
      if (pacing == null || pacing < 95 || pacing > 130) return null; // só pacing "saudável"
      if (m.d1_rate == null || m.d1_rate > 0) return null;
      if (m.elapsed_days < MIN_DAYS_FOR_STOPPED) return null;
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} reporta OK mas D-1 = 0`,
        detail:  `${mediaLabel(media)} · pacing ${fmtPct(pacing, 0)} · investigar inconsistência`,
        impactBrl: m.client_budget || 0,
      };
    },
  },
  {
    // A6 — Frente desbalanceada (O2O vs OOH escondida pela média).
    //
    // Caso operacional típico: Display O2O 128% + Display OOH 92% → média
    // 110% verde. CS olha a média e segue em frente; OOH continua under,
    // não cumpre o contrato com o meio, e ninguém pega o problema. A
    // regra protege contra exatamente esse "blindspot" da média agregada.
    //
    // Severidade é função do quão under a pior frente está:
    //   - frente <90% e média ≥100%   → CRITICAL (deep red escondido)
    //   - frente 90-100% e média ≥100% → WARNING (zona de atenção)
    //
    // Precisa do `detail` (per-token endpoint) pra ler tactic_type das rows;
    // o list endpoint não devolve esse split. Quando detail ainda não chegou
    // (bulk prefetch em background), a regra não dispara — vira gracioso.
    id: "A6",
    category: CATEGORY.OPERATIONAL,
    severity: SEVERITY.CRITICAL,
    label: "Frente desbalanceada (O2O/OOH/Groundflow)",
    evaluate: ({ enriched, media, rawCampaign, detail }) => {
      if (!detail?.campaign) return null;
      const m = enriched[media];
      if (!m) return null;
      // Média projetada (forward-looking, mesma régua das outras A*).
      // Só dispara quando o agregado dá conforto pro CS — abaixo de 100%
      // outras regras (A1/A3/A4/E2) já cobrem o cenário.
      if (m.projected_pacing == null || m.projected_pacing < 100) return null;

      const mediaType = media === "video" ? "VIDEO" : "DISPLAY";
      const subBars = buildFrenteSubBars(detail, mediaType);
      if (!subBars || subBars.length < 2) return null;

      // Pega a frente mais under. Se nenhuma está under (<100%), ignora.
      const under = subBars
        .filter((s) => s.pacing != null && s.pacing < 100)
        .sort((a, b) => a.pacing - b.pacing)[0];
      if (!under) return null;

      const isDeepUnder = under.pacing < 90;
      // impactBrl estimado: gap até 100% × budget × share-of-spend da
      // frente (~50% como aproximação — backend não devolve breakdown
      // de budget por tactic). Pacing 92% → gap 8% × budget × 0.5.
      const gap = Math.max(0, 100 - under.pacing) / 100;
      const impactBrl = (m.client_budget || 0) * gap * 0.5;

      return {
        // Override de severity dentro do result não é suportado pelo
        // engine — então mapeio via duas regras-irmãs (A6 critical, A6w
        // warning) NÃO. Solução: deixo o severity fixo no objeto-regra
        // como CRITICAL e o caller (engine.buildAlert) lê do rule. Pra
        // diferenciar warning vs critical aqui, anexo `_severity` no
        // result que o engine respeita (ver buildAlert override abaixo).
        _severity: isDeepUnder ? SEVERITY.CRITICAL : SEVERITY.WARNING,
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} com ${under.label} em ${fmtPct(under.pacing, 0)} escondido pela média`,
        detail:  `${mediaLabel(media)} · média ${fmtPct(m.projected_pacing, 0)} esconde ${under.label} ${fmtPct(under.pacing, 0)} · risco de não cumprir contrato com a frente`,
        impactBrl,
      };
    },
  },

  // ── C · TECH COST ────────────────────────────────────────────────────
  {
    id: "C1",
    category: CATEGORY.FINANCIAL,
    severity: SEVERITY.CRITICAL,
    label: "Tech Cost vermelho",
    evaluate: ({ enriched, media, hasAbs, rawCampaign }) => {
      const m = enriched[media];
      if (!m || m.tech_cost_pct == null) return null;
      if (m.client_budget < MIN_BUDGET_FOR_TECH_ALERT) return null;
      const tiers = techTier(hasAbs);
      if (m.tech_cost_pct <= tiers.warning) return null;
      // Margem comida = excesso acima do threshold healthy × budget.
      const excessPct  = m.tech_cost_pct - tiers.healthy;
      const marginEaten = (excessPct / 100) * m.client_budget;
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} com Tech Cost crítico (${fmtPct(m.tech_cost_pct, 1)})`,
        detail:  appendSurveyDisclaimer(
          `${mediaLabel(media)}${hasAbs ? " · ABS" : ""} · ~${fmtBrl(marginEaten)} de margem comida`,
          m
        ),
        impactBrl: marginEaten,
      };
    },
  },
  {
    id: "C2",
    category: CATEGORY.FINANCIAL,
    severity: SEVERITY.WARNING,
    label: "Tech Cost no amarelo",
    evaluate: ({ enriched, media, hasAbs, rawCampaign }) => {
      const m = enriched[media];
      if (!m || m.tech_cost_pct == null) return null;
      if (m.client_budget < MIN_BUDGET_FOR_TECH_ALERT) return null;
      const tiers = techTier(hasAbs);
      if (m.tech_cost_pct <= tiers.healthy) return null;
      if (m.tech_cost_pct > tiers.warning) return null;
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} Tech Cost no amarelo (${fmtPct(m.tech_cost_pct, 1)})`,
        detail:  appendSurveyDisclaimer(
          `${mediaLabel(media)}${hasAbs ? " · ABS" : ""} · monitorar`,
          m
        ),
        impactBrl: m.client_budget * 0.02, // ~2% de "atenção"
      };
    },
  },
  {
    id: "C3",
    category: CATEGORY.FINANCIAL,
    severity: SEVERITY.WARNING,
    label: "Tech Cost vai virar vermelho",
    evaluate: ({ enriched, media, hasAbs, rawCampaign }) => {
      const m = enriched[media];
      if (!m || m.tech_cost_pct == null || m.projected_tech_cost_pct == null) return null;
      if (m.client_budget < MIN_BUDGET_FOR_TECH_ALERT) return null;
      const tiers = techTier(hasAbs);
      // Hoje no amarelo ou abaixo, projetando passar do warning.
      if (m.tech_cost_pct > tiers.warning) return null;
      if (m.projected_tech_cost_pct <= tiers.warning) return null;
      const projectedMarginEaten = ((m.projected_tech_cost_pct - tiers.healthy) / 100) * m.client_budget;
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} Tech Cost vai cruzar vermelho`,
        detail:  appendSurveyDisclaimer(
          `${mediaLabel(media)} · hoje ${fmtPct(m.tech_cost_pct, 1)} → projetado ${fmtPct(m.projected_tech_cost_pct, 1)}`,
          m
        ),
        impactBrl: projectedMarginEaten,
      };
    },
  },
  {
    id: "C4",
    category: CATEGORY.FINANCIAL,
    severity: SEVERITY.CRITICAL,
    label: "Over delivery acima do limite saudável",
    evaluate: ({ enriched, media, rawCampaign }) => {
      const m = enriched[media];
      if (!m || m.excess_brl == null) return null;
      if (m.excess_brl < EXCESS_BRL_THRESHOLD) return null;
      // Excesso de volume acima do teto saudável (125% do contrato).
      // Espelha a régua do diagnostico: até 125% é gordura aceitável.
      const acceptableMax = m.negotiated * MAX_OK_PACING_RATIO;
      const excessVol = m.projected_final - acceptableMax;
      const unit = media === "video" ? "completions" : "imps";
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} vai entregar ${fmtBrl(m.excess_brl)} acima do necessário`,
        detail:  `${mediaLabel(media)} · ${fmtInt(excessVol)} ${unit} acima do limite saudável (125% do contrato)`,
        impactBrl: m.excess_brl,
      };
    },
  },

  // ── E · CRUZADOS ─────────────────────────────────────────────────────
  {
    id: "E1",
    category: CATEGORY.CROSS_SIGNAL,
    severity: SEVERITY.CRITICAL,
    label: "Rodando OK mas comendo margem",
    evaluate: ({ enriched, media, hasAbs, rawCampaign }) => {
      const m = enriched[media];
      if (!m || m.tech_cost_pct == null || m.projected_pacing == null) return null;
      if (m.client_budget < MIN_BUDGET_FOR_TECH_ALERT) return null;
      const tiers = techTier(hasAbs);
      // Tech Cost no vermelho + pacing entre 95% e 130% (zona "OK")
      if (m.tech_cost_pct <= tiers.warning) return null;
      if (m.projected_pacing < 95 || m.projected_pacing > 130) return null;
      const marginEaten = ((m.tech_cost_pct - tiers.healthy) / 100) * m.client_budget;
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} rodando OK mas comendo margem`,
        detail:  `${mediaLabel(media)} · pacing ${fmtPct(m.projected_pacing, 0)} + Tech Cost ${fmtPct(m.tech_cost_pct, 1)}`,
        impactBrl: marginEaten,
      };
    },
  },
  {
    id: "E2",
    category: CATEGORY.CROSS_SIGNAL,
    severity: SEVERITY.POSITIVE,
    label: "Oportunidade de escalar",
    evaluate: ({ enriched, media, hasAbs, rawCampaign }) => {
      const m = enriched[media];
      if (!m || m.tech_cost_pct == null || m.projected_pacing == null) return null;
      if (m.client_budget < MIN_BUDGET_FOR_TECH_ALERT) return null;
      const tiers = techTier(hasAbs);
      // Tech Cost folgado + pacing under com tempo pra ajustar
      if (m.tech_cost_pct > tiers.healthy) return null;
      if (m.projected_pacing >= 95) return null;
      if (m.days_remaining < 5) return null;
      const opportunityBrl = m.client_budget * Math.max(0, (95 - m.projected_pacing) / 100);
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} dá pra escalar (Tech Cost folgado)`,
        detail:  `${mediaLabel(media)} · pacing ${fmtPct(m.projected_pacing, 0)} + Tech Cost ${fmtPct(m.tech_cost_pct, 1)}`,
        impactBrl: opportunityBrl,
      };
    },
  },
  {
    id: "E3",
    category: CATEGORY.CROSS_SIGNAL,
    severity: SEVERITY.CRITICAL,
    label: "Caro e com baixa qualidade",
    evaluate: ({ enriched, media, hasAbs, rawCampaign }) => {
      const m = enriched[media];
      if (!m || m.ecpm_real == null || m.viewability == null) return null;
      // CPM no tier vermelho da régua do diagnostico
      // (display 0.80+, displayAbs 1.80+, video 3.50+)
      let cpmThreshold;
      if (media === "video") cpmThreshold = 3.5;
      else cpmThreshold = hasAbs ? 1.8 : 0.8;
      if (m.ecpm_real < cpmThreshold) return null;
      if (m.viewability >= VIEWABILITY_LOW_PCT) return null;
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} caro e com baixa qualidade`,
        detail:  `${mediaLabel(media)} · CPM ${fmtBrl(m.ecpm_real)} · Viewability ${fmtPct(m.viewability, 0)}`,
        impactBrl: (m.real_cost || 0) * 0.3, // estimativa de "desperdício"
      };
    },
  },
  {
    id: "E4",
    category: CATEGORY.CROSS_SIGNAL,
    severity: SEVERITY.CRITICAL,
    label: "Padrão suspeito de fraud",
    evaluate: ({ enriched, media, rawCampaign }) => {
      if (media !== "display") return null; // CTR de vídeo é raro, regra só faz sentido em display
      const m = enriched.display;
      if (!m || m.ecpm_real == null) return null;
      const ctr = rawCampaign.display_ctr;
      if (ctr == null) return null;
      // CPM anormalmente barato + CTR muito alto = padrão de bot
      if (m.ecpm_real > FRAUD_CPM_BRL) return null;
      if (ctr < FRAUD_CTR_PCT) return null;
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} padrão suspeito de tráfego`,
        detail:  `Display · CPM ${fmtBrl(m.ecpm_real)} + CTR ${fmtPct(ctr, 2)} (típico de bot)`,
        impactBrl: m.real_cost || 0,
      };
    },
  },
  {
    id: "E5",
    category: CATEGORY.CROSS_SIGNAL,
    severity: SEVERITY.WARNING,
    label: "ABS marcado mas CPM no tier sem-ABS",
    evaluate: ({ enriched, media, hasAbs, rawCampaign }) => {
      if (media !== "display") return null; // ABS só muda régua em display
      if (!hasAbs) return null;
      const m = enriched.display;
      if (!m || m.ecpm_real == null) return null;
      // Tier display sem-ABS: warning 0.80. Se ABS marcado mas CPM abaixo
      // desse threshold, suspeita-se que ABS não está ativo.
      if (m.ecpm_real >= 0.8) return null;
      return {
        message: `${rawCampaign.client_name}/${rawCampaign.campaign_name} ABS marcado mas CPM baixo`,
        detail:  `Display · CPM ${fmtBrl(m.ecpm_real)} (tier sem-ABS) — verificar ativação`,
        impactBrl: 0,
      };
    },
  },
];

// ────────────────────────────────────────────────────────────────────────
// Regras macro — agregam alertas individuais por owner/cliente. Avaliadas
// no engine após os alertas individuais, recebendo a lista bruta.
// ────────────────────────────────────────────────────────────────────────
export const MACRO_RULES = [
  {
    id: "H1",
    category: CATEGORY.MACRO,
    severity: SEVERITY.CRITICAL,
    label: "Owner sobrecarregado",
  },
  {
    id: "H2",
    category: CATEGORY.MACRO,
    severity: SEVERITY.CRITICAL,
    label: "Conta com múltiplos super over",
  },
  {
    id: "H3",
    category: CATEGORY.MACRO,
    severity: SEVERITY.CRITICAL,
    label: "Conta com Tech Cost crítico recorrente",
  },
];

export { RULES_PER_MEDIA };
