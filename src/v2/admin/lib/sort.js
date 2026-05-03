// src/v2/admin/lib/sort.js
//
// Opções de ordenação + comparadores pro menu admin.
//
// Modelo: campo + direção (asc/desc) separados
// ─────────────────────────────────────────────
// Antes existiam combinações pré-bakeadas tipo "ecpm_desc" / "pacing_asc".
// Limitava: user que queria "menor CTR" ou "pacing decrescente" não tinha
// como. Agora cada campo aceita as duas direções, controladas por um
// botão de toggle ao lado do dropdown (padrão GitHub/Linear/Notion).
//
// Defaults por campo
// ──────────────────
// Quando o user troca de campo (ex: pula de "Início" pra "ECPM"), aplica a
// direção mais útil pra aquele campo:
//   - Início:           desc (mais recente primeiro)
//   - A-Z:              asc (alfabético)
//   - ECPM/CTR/VTR:     desc (maior primeiro = melhor performance)
//   - Pacing:           asc (menor primeiro = pior pacing, mais acionável)
// Depois o user pode flipar pra direção oposta sem perder o campo escolhido.
//
// Convenções
// ──────────
// - Métricas null vão pro fim (nullsLast), independente da direção —
//   dado faltante não deve poluir o topo nem do "Maior X" nem do "Menor X".
// - "Pior pacing" = menor valor (underdelivery). Sort asc faz isso.

// ─── Comparator helper ───────────────────────────────────────────────────────

function byMetric(getValue, dir) {
  const sign = dir === "desc" ? -1 : 1;
  return (a, b) => {
    const va = getValue(a);
    const vb = getValue(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return sign * (Number(va) - Number(vb));
  };
}

function byString(getValue, dir) {
  const sign = dir === "desc" ? -1 : 1;
  return (a, b) => sign * (getValue(a) || "").localeCompare(getValue(b) || "");
}

// Pacing "pior" = menor valor (underdelivery). Pega o min entre display e
// video pra ranking conservador.
function campaignPacingMin(c) {
  const dp = c.display_pacing;
  const vp = c.video_pacing;
  if (dp == null && vp == null) return null;
  if (dp == null) return Number(vp);
  if (vp == null) return Number(dp);
  return Math.min(Number(dp), Number(vp));
}

// ─── Direção default por campo ───────────────────────────────────────────────
// Aplicada quando o user troca de campo. Não força — só sugere ao mudar.

const FIELD_DEFAULT_DIR = {
  // Campaigns
  start_date: "desc",
  alpha:      "asc",
  ecpm:       "desc",
  ctr:        "desc",
  vtr:        "desc",
  pacing:     "asc",
  // Clients
  active:     "desc",
  ctr_avg:    "desc",
  vtr_avg:    "desc",
  pacing_avg: "asc",
};

export function getDefaultDirection(field) {
  return FIELD_DEFAULT_DIR[field] || "desc";
}

// ─── Campaign sorts (layout=month e layout=list) ─────────────────────────────

export const CAMPAIGN_SORT_OPTIONS = [
  { value: "start_date", label: "Início",  group: "Por data" },
  { value: "alpha",      label: "A-Z",     group: "Por data" },
  { value: "ecpm",       label: "ECPM",    group: "Por performance" },
  { value: "ctr",        label: "CTR",     group: "Por performance" },
  { value: "vtr",        label: "VTR",     group: "Por performance" },
  { value: "pacing",     label: "Pacing",  group: "Por performance" },
];

export const CAMPAIGN_SORT_DEFAULT = "start_date";
export const CAMPAIGN_SORT_FIELDS = new Set(CAMPAIGN_SORT_OPTIONS.map((o) => o.value));

export function compareCampaigns(field, dir) {
  switch (field) {
    case "alpha":      return byString((c) => c.client_name, dir);
    case "ecpm":       return byMetric((c) => c.admin_ecpm, dir);
    case "ctr":        return byMetric((c) => c.display_ctr, dir);
    case "vtr":        return byMetric((c) => c.video_vtr, dir);
    case "pacing":     return byMetric(campaignPacingMin, dir);
    case "start_date":
    default:           return byString((c) => c.start_date, dir);
  }
}

// ─── Client sorts (layout=client) ────────────────────────────────────────────

export const CLIENT_SORT_OPTIONS = [
  { value: "active",     label: "Campanhas ativas", group: "Por volume" },
  { value: "alpha",      label: "A-Z",              group: "Por volume" },
  { value: "ctr_avg",    label: "CTR médio",        group: "Por performance" },
  { value: "vtr_avg",    label: "VTR médio",        group: "Por performance" },
  { value: "pacing_avg", label: "Pacing médio",     group: "Por performance" },
];

export const CLIENT_SORT_DEFAULT = "active";
export const CLIENT_SORT_FIELDS = new Set(CLIENT_SORT_OPTIONS.map((o) => o.value));

export function compareClients(field, dir) {
  switch (field) {
    case "alpha":      return byString((c) => c.display_name, dir);
    case "ctr_avg":    return byMetric((c) => c.avg_ctr, dir);
    case "vtr_avg":    return byMetric((c) => c.avg_vtr, dir);
    case "pacing_avg": return byMetric((c) => c.avg_pacing, dir);
    case "active":
    default:
      // Mantém o tiebreaker do aggregateClients (ativas → total → nome).
      // Direção asc inverte só o critério principal; o resto continua estável.
      return dir === "asc"
        ? (a, b) =>
            (a.active_campaigns - b.active_campaigns) ||
            (a.total_campaigns  - b.total_campaigns)  ||
            (a.display_name || "").localeCompare(b.display_name || "")
        : (a, b) =>
            (b.active_campaigns - a.active_campaigns) ||
            (b.total_campaigns  - a.total_campaigns)  ||
            (a.display_name || "").localeCompare(b.display_name || "");
  }
}
