// src/v2/admin/lib/alerts/engine.js
//
// Engine de alertas — recebe lista crua de campanhas + status fn, retorna
// `Alert[]` ordenado por relevância:
//
//   1. Enriquece cada campanha com `enrichCampaign` (derive.js)
//   2. Filtra só `in_flight` (paused/awaiting/ended saem do escopo)
//   3. Roda 14 regras por mídia/campanha (rules.js · RULES_PER_MEDIA)
//   4. Roda 3 regras macro (agregados por owner/cliente)
//   5. Ordena por score = severity_weight × log10(1 + impactBrl)
//   6. Aplica caps anti-fatigue
//
// Saída — Alert shape:
//   {
//     id: string,                    // único: ruleId + token + media
//     ruleId: string,                // "A1", "C1", "H2", etc
//     category: string,              // CATEGORY.*
//     severity: string,              // SEVERITY.*
//     campaign: { short_token, client_name, campaign_name } | null,
//     owner: { type: "cs"|"cp", email, name } | null,
//     media: "display" | "video" | null,
//     message: string,
//     detail: string,
//     impactBrl: number,
//     score: number,
//   }

import { enrichCampaign } from "./derive";
import { RULES_PER_MEDIA, MACRO_RULES } from "./rules";
import {
  CATEGORY,
  SEVERITY,
  SEVERITY_WEIGHT,
  MAX_ALERTS_TOTAL,
  MAX_ALERTS_PER_CAMPAIGN,
  MACRO_OWNER_CRITICAL_MIN,
  MACRO_CLIENT_SUPER_OVER,
  MACRO_CLIENT_TECH_CRIT,
  TECH_COST,
  MIN_BUDGET_FOR_TECH_ALERT,
} from "./constants";

const fmtBrl = (n) => n.toLocaleString("pt-BR", {
  style: "currency", currency: "BRL", minimumFractionDigits: 0, maximumFractionDigits: 0,
});

function computeScore(severity, impactBrl) {
  const w = SEVERITY_WEIGHT[severity] || 0;
  const impact = Math.max(0, impactBrl || 0);
  return w * Math.log10(1 + impact);
}

/**
 * Gera todos os alertas. `campaigns` é o array cru de listCampaigns,
 * `statusFn` é o `getCampaignStatus` do format.js, `teamMap` é { email → name }
 * pra renderizar nome de owner nas regras macro.
 */
export function generateAlerts(campaigns, statusFn, teamMap = {}) {
  if (!Array.isArray(campaigns) || campaigns.length === 0) return [];

  // ── 1. Enriquece + filtra in_flight ─────────────────────────────────
  const enriched = campaigns
    .map((c) => enrichCampaign(c, statusFn))
    .filter((e) => e.camp_status === "in_flight");

  // ── 2. Regras per-media (loop) ──────────────────────────────────────
  const alerts = [];
  for (const e of enriched) {
    const raw = e.raw;
    const hasAbsDisplay = !!raw.display_has_abs;
    const hasAbsVideo   = !!raw.video_has_abs;

    for (const rule of RULES_PER_MEDIA) {
      // Regras campaign-level (A2 — pipeline travado) só rodam uma vez.
      if (rule.isCampaignLevel) {
        const result = rule.evaluate({ enriched: e, rawCampaign: raw });
        if (result) {
          alerts.push(buildAlert(rule, raw, null, result));
        }
        continue;
      }
      // Demais regras: rodam pra cada mídia presente
      for (const media of ["display", "video"]) {
        if (!e[media]) continue;
        const hasAbs = media === "display" ? hasAbsDisplay : hasAbsVideo;
        const result = rule.evaluate({
          enriched: e,
          media,
          hasAbs,
          rawCampaign: raw,
        });
        if (result) {
          alerts.push(buildAlert(rule, raw, media, result));
        }
      }
    }
  }

  // ── 3. Regras macro (agregados) ─────────────────────────────────────
  alerts.push(...computeMacroAlerts(alerts, enriched, teamMap));

  // ── 4. Dedup: cap N alertas por campanha (manter os de maior score) ─
  const byCampaign = new Map();
  for (const a of alerts) {
    if (!a.campaign) continue; // macros sem campanha não entram no cap
    const key = a.campaign.short_token;
    if (!byCampaign.has(key)) byCampaign.set(key, []);
    byCampaign.get(key).push(a);
  }
  const capped = [];
  for (const a of alerts) {
    if (!a.campaign) { capped.push(a); continue; }
    const list = byCampaign.get(a.campaign.short_token);
    // Pega top N por score; se este alerta está entre eles, mantém
    list.sort((x, y) => y.score - x.score);
    const top = new Set(list.slice(0, MAX_ALERTS_PER_CAMPAIGN).map((x) => x.id));
    if (top.has(a.id)) capped.push(a);
  }
  // Remove duplicados (campanha em múltiplos arrays foram processadas — dedup por id)
  const seen = new Set();
  const deduped = capped.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  // ── 5. Ordena por score desc + cap global ───────────────────────────
  deduped.sort((a, b) => b.score - a.score);
  return deduped.slice(0, MAX_ALERTS_TOTAL);
}

function buildAlert(rule, raw, media, result) {
  const impactBrl = Math.max(0, result.impactBrl || 0);
  return {
    id: `${rule.id}:${raw.short_token}${media ? ":" + media : ""}`,
    ruleId:    rule.id,
    category:  rule.category,
    severity:  rule.severity,
    campaign:  { short_token: raw.short_token, client_name: raw.client_name, campaign_name: raw.campaign_name },
    owner:     null,
    media:     media || null,
    // csEmail/cpEmail expostos pra alimentar o filtro rápido de owner no
    // popover do sino. Null em campanhas sem owner — esses ficam visíveis
    // quando o filtro está em "Todos CS".
    csEmail:   raw.cs_email || null,
    cpEmail:   raw.cp_email || null,
    message:   result.message,
    detail:    result.detail,
    impactBrl,
    score:     computeScore(rule.severity, impactBrl),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Regras macro
// ────────────────────────────────────────────────────────────────────────
function computeMacroAlerts(individualAlerts, enriched, teamMap) {
  const out = [];

  // H1 — Owner com 5+ alertas críticos
  const criticalByCs = new Map();
  for (const a of individualAlerts) {
    if (a.severity !== SEVERITY.CRITICAL) continue;
    if (!a.campaign) continue;
    // Resolve cs_email via campanha bruta (precisamos do enriched)
    const e = enriched.find((x) => x.raw.short_token === a.campaign.short_token);
    const cs = e?.raw?.cs_email;
    if (!cs) continue;
    if (!criticalByCs.has(cs)) criticalByCs.set(cs, []);
    criticalByCs.get(cs).push(a);
  }
  for (const [cs, list] of criticalByCs) {
    if (list.length < MACRO_OWNER_CRITICAL_MIN) continue;
    const name = teamMap[cs] || cs.split("@")[0];
    const totalImpact = list.reduce((s, a) => s + (a.impactBrl || 0), 0);
    out.push({
      id: `H1:${cs}`,
      ruleId: "H1",
      category: CATEGORY.MACRO,
      severity: SEVERITY.CRITICAL,
      campaign: null,
      owner: { type: "cs", email: cs, name },
      media: null,
      message: `${name} tem ${list.length} alertas críticos hoje`,
      detail:  `${fmtBrl(totalImpact)} acumulado em risco · sobrecarga`,
      impactBrl: totalImpact,
      score: computeScore(SEVERITY.CRITICAL, totalImpact) * 1.2, // peso macro
    });
  }

  // H2 — Cliente com 3+ campanhas atualmente em super_over
  const superOverByClient = new Map();
  for (const e of enriched) {
    const isSuperOver =
      (e.display?.projected_pacing != null && e.display.projected_pacing > 150) ||
      (e.video?.projected_pacing != null && e.video.projected_pacing > 150);
    if (!isSuperOver) continue;
    const client = e.raw.client_name;
    if (!client) continue;
    if (!superOverByClient.has(client)) superOverByClient.set(client, []);
    superOverByClient.get(client).push(e);
  }
  for (const [client, list] of superOverByClient) {
    if (list.length < MACRO_CLIENT_SUPER_OVER) continue;
    // Soma o over delivery acima do teto saudável (125%) das duas mídias.
    // Pega o maior dos dois pra evitar dupla-contagem em campanhas mistas.
    const totalExcess = list.reduce((s, e) => {
      return s + Math.max(e.display?.excess_brl || 0, e.video?.excess_brl || 0);
    }, 0);
    out.push({
      id: `H2:${client}`,
      ruleId: "H2",
      category: CATEGORY.MACRO,
      severity: SEVERITY.CRITICAL,
      campaign: null,
      owner: null,
      media: null,
      message: `${client} com ${list.length} campanhas em super over`,
      detail:  `${fmtBrl(totalExcess)} de over delivery acima do necessário · revisar planejamento`,
      impactBrl: totalExcess,
      score: computeScore(SEVERITY.CRITICAL, totalExcess) * 1.2,
    });
  }

  // H3 — Cliente com 3+ campanhas com Tech Cost crítico
  const techCritByClient = new Map();
  for (const e of enriched) {
    const checkMedia = (m, hasAbs) => {
      if (!m || m.tech_cost_pct == null) return false;
      if (m.client_budget < MIN_BUDGET_FOR_TECH_ALERT) return false;
      const tiers = hasAbs ? TECH_COST.abs : TECH_COST.noAbs;
      return m.tech_cost_pct > tiers.warning;
    };
    const isTechCrit =
      checkMedia(e.display, !!e.raw.display_has_abs) ||
      checkMedia(e.video, !!e.raw.video_has_abs);
    if (!isTechCrit) continue;
    const client = e.raw.client_name;
    if (!client) continue;
    if (!techCritByClient.has(client)) techCritByClient.set(client, []);
    techCritByClient.get(client).push(e);
  }
  for (const [client, list] of techCritByClient) {
    if (list.length < MACRO_CLIENT_TECH_CRIT) continue;
    out.push({
      id: `H3:${client}`,
      ruleId: "H3",
      category: CATEGORY.MACRO,
      severity: SEVERITY.CRITICAL,
      campaign: null,
      owner: null,
      media: null,
      message: `${client} com ${list.length} campanhas em Tech Cost crítico`,
      detail:  `Margem em risco recorrente · revisar pricing`,
      impactBrl: 0,
      score: computeScore(SEVERITY.CRITICAL, 1) * 1.2,
    });
  }

  return out;
}

/**
 * Contagem agrupada por severidade. Útil pro badge do sino.
 */
export function countBySeverity(alerts) {
  const out = { critical: 0, warning: 0, info: 0, positive: 0 };
  for (const a of alerts) {
    if (out[a.severity] != null) out[a.severity]++;
  }
  return out;
}

/**
 * Agrupa por categoria pras abas do popover.
 */
export function groupByCategory(alerts) {
  const out = {
    [CATEGORY.OPERATIONAL]:  [],
    [CATEGORY.FINANCIAL]:    [],
    [CATEGORY.CROSS_SIGNAL]: [],
    [CATEGORY.MACRO]:        [],
  };
  for (const a of alerts) {
    if (out[a.category]) out[a.category].push(a);
  }
  return out;
}
