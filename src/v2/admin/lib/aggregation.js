// src/v2/admin/lib/aggregation.js
//
// Espelho client-side da agregação do backend (backend/clients.py).
//
// Usado APENAS como fallback quando o endpoint `?action=list_clients` não
// está disponível (deploy do backend ainda não rolou). Quando o backend
// está disponível, esse módulo nem é importado — a função listClients()
// usa lazy `await import()`.
//
// Mantém paridade SEMÂNTICA com clients.py mas sem sparkline/trend (que
// exigem query temporal só backend faz). Cliente vê o mesmo card visual,
// só sem a linha do sparkline.
//
// Quando o backend for atualizado, o frontend automaticamente passa a
// usar a versão dele (que tem sparkline + trend) sem precisar de
// mudança aqui. Esse fallback fica como segurança de produção.

const TODAY = () => new Date().toISOString().slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────
// Normalização (idêntica a backend/clients.py:normalize_client_slug)
// ─────────────────────────────────────────────────────────────────────────────
export function normalizeSlug(name) {
  if (!name) return "";
  return String(name)
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")     // remove combining marks
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Display name por frequência, com tie-break = end_date mais recente
// ─────────────────────────────────────────────────────────────────────────────
function chooseDisplayName(variants) {
  if (!variants.length) return "";
  const counter = new Map();
  for (const [name] of variants) {
    if (name) counter.set(name, (counter.get(name) || 0) + 1);
  }
  if (counter.size === 0) return "";
  let maxFreq = 0;
  for (const v of counter.values()) if (v > maxFreq) maxFreq = v;
  const top = [...counter.entries()].filter(([, n]) => n === maxFreq).map(([k]) => k);
  if (top.length === 1) return top[0];
  // Tie-break por end_date
  const candidates = variants
    .filter(([n]) => top.includes(n))
    .filter(([, d]) => d)
    .sort((a, b) => (a[1] < b[1] ? 1 : -1));
  if (candidates.length) return candidates[0][0];
  return [...top].sort()[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Health classification (espelho de _classify_pacing_health)
//
// Régua nova (4 bandas):
//   < 90        → critical   (vermelho)
//   90–99.99    → attention  (amarelo)
//   100–124.99  → healthy    (verde)
//   ≥ 125       → over       (azul/signature; ainda saudável)
// ─────────────────────────────────────────────────────────────────────────────
function classifyPacing(p) {
  if (p == null) return null;
  if (p < 90)  return "critical";
  if (p < 100) return "attention";
  if (p < 125) return "healthy";
  return "over";
}

function aggregateHealth(arr) {
  if (!arr.length) return null;
  if (arr.includes("critical"))  return "critical";
  if (arr.includes("attention")) return "attention";
  if (arr.includes("healthy"))   return "healthy";
  if (arr.includes("over"))      return "over";
  return null;
}

const PACING_TIER_RANK = { critical: 0, attention: 1, healthy: 2, over: 3 };

function worstPacing(dp, vp) {
  // Pega o pacing que cai na pior banda (rank crítico=0 < ... < over=3).
  // Antes usávamos distância de 100 — incompatível com over=saudável.
  const candidates = [];
  if (dp != null) candidates.push(Number(dp));
  if (vp != null) candidates.push(Number(vp));
  if (!candidates.length) return null;
  return candidates.reduce((a, b) =>
    PACING_TIER_RANK[classifyPacing(a)] <= PACING_TIER_RANK[classifyPacing(b)] ? a : b
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Agregação principal
// ─────────────────────────────────────────────────────────────────────────────
export function aggregateClients(campaigns) {
  const today = TODAY();
  const groups = new Map();

  for (const c of campaigns || []) {
    const slug = normalizeSlug(c.client_name);
    if (!slug) continue;
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push(c);
  }

  const out = [];
  for (const [slug, group] of groups.entries()) {
    const variants = group.map((c) => [c.client_name || "", c.end_date || ""]);
    const displayName = chooseDisplayName(variants);

    const active = group.filter((c) => c.end_date && c.end_date.slice(0, 10) >= today);

    // CTR/VTR/Pacing agregados via Σnumerador / Σdenominador. Espelha
    // backend/clients.py#aggregate_clients_from_campaigns. Fallback é só
    // usado quando o endpoint do backend não responde — paridade total.
    const m = aggregateMetrics(active);
    const dsp = m.dsp_pacing;
    const vid = m.vid_pacing;
    const pacingParts = [dsp, vid].filter((v) => v != null);
    const avgPacing = pacingParts.length
      ? Math.round((pacingParts.reduce((a, b) => a + b, 0) / pacingParts.length) * 10) / 10
      : null;
    const avgCtr = m.ctr != null ? Math.round(m.ctr * 100) / 100 : null;
    const avgVtr = m.vtr != null ? Math.round(m.vtr * 100) / 100 : null;

    // Top owners por frequência
    const topByEmail = (key, n) => {
      const counter = new Map();
      for (const c of group) {
        const email = c[key];
        if (email) counter.set(email, (counter.get(email) || 0) + 1);
      }
      return [...counter.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([email, count]) => ({ email, count }));
    };

    const lastUpdated = group.map((c) => c.updated_at || "").filter(Boolean).sort().pop() || null;

    const activeHealths = active
      .map((c) => classifyPacing(worstPacing(c.display_pacing, c.video_pacing)))
      .filter(Boolean);
    const health = aggregateHealth(activeHealths);

    const activeTokens = active.map((c) => c.short_token).filter(Boolean);

    out.push({
      slug,
      display_name: displayName,
      total_campaigns: group.length,
      active_campaigns: active.length,
      avg_pacing: avgPacing,
      avg_dsp_pacing: dsp != null ? Math.round(dsp * 10) / 10 : null,
      avg_vid_pacing: vid != null ? Math.round(vid * 10) / 10 : null,
      avg_ctr: avgCtr,
      avg_vtr: avgVtr,
      top_cp_owners: topByEmail("cp_email", 2),
      top_cs_owners: topByEmail("cs_email", 2),
      last_updated: lastUpdated,
      health,
      active_short_tokens: activeTokens,
      // sparkline + trend ausentes — backend é quem provê.
    });
  }

  out.sort(
    (a, b) =>
      b.active_campaigns - a.active_campaigns ||
      b.total_campaigns  - a.total_campaigns  ||
      a.display_name.localeCompare(b.display_name)
  );
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Métricas globais — KPIs no topo do menu admin
//
// Toda razão (CTR, VTR, Pacing, eCPM) é agregada via Σnumerador / Σdenominador.
// Média de razões infla VTR > 100% e dá peso desproporcional a campanhas
// pequenas com sorte. Os campos brutos vêm do backend (display_clicks,
// video_viewable_completions, etc.) quando admin; sem brutos, retorna null.
//
// `ecpm_prev` compara cohort: campanhas que ENCERRARAM nos últimos 30
// dias. Comparação honesta porque o eCPM lifetime delas é final
// (impressões/custo já não mudam mais), enquanto o eCPM das ativas é
// running. O delta indica como a nova safra se compara à que saiu.
// ─────────────────────────────────────────────────────────────────────────────
function sumField(set, field) {
  let acc = 0;
  for (const c of set) {
    const v = c[field];
    if (v != null) acc += Number(v) || 0;
  }
  return acc;
}

function meanOfField(set, field) {
  const xs = [];
  for (const c of set) {
    const v = c[field];
    if (v != null && Number.isFinite(Number(v))) xs.push(Number(v));
  }
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// Σnumerador / Σdenominador é o jeito correto de agregar razões.
// Backend admin agora manda os brutos (display_clicks, video_impressions,
// etc.). ENQUANTO o backend não estiver redeployado, os brutos podem estar
// ausentes — neste caso caímos pra média simples das %-já-calculadas.
// Não é correto matematicamente, mas evita "—" na UI durante a transição.
// Quando todos os clientes do payload tiverem brutos, a fallback nunca dispara.
function aggregateMetrics(set) {
  const dClicks    = sumField(set, "display_clicks");
  const dImpr      = sumField(set, "display_impressions");
  const dViewable  = sumField(set, "display_viewable_impressions");
  const dExpected  = sumField(set, "display_expected_impressions");
  const vCompl     = sumField(set, "video_viewable_completions");
  const vImpr      = sumField(set, "video_impressions");
  const vExpected  = sumField(set, "video_expected_completions");
  const cost       = sumField(set, "admin_total_cost");
  const impr       = sumField(set, "admin_impressions");

  return {
    ctr:        dImpr     > 0 ? (dClicks   / dImpr)     * 100  : meanOfField(set, "display_ctr"),
    vtr:        vImpr     > 0 ? (vCompl    / vImpr)     * 100  : meanOfField(set, "video_vtr"),
    dsp_pacing: dExpected > 0 ? (dViewable / dExpected) * 100  : meanOfField(set, "display_pacing"),
    vid_pacing: vExpected > 0 ? (vCompl    / vExpected) * 100  : meanOfField(set, "video_pacing"),
    ecpm:       impr      > 0 ? (cost      / impr)      * 1000 : null,
  };
}

export function computeMetricsSummary(campaigns) {
  const today = TODAY();
  const prev30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const active = (campaigns || []).filter(
    (c) => c.end_date && c.end_date.slice(0, 10) >= today
  );
  const recentlyEnded = (campaigns || []).filter((c) => {
    const end = c.end_date?.slice(0, 10);
    return end && end >= prev30 && end < today;
  });

  const cur  = aggregateMetrics(active);
  const prev = aggregateMetrics(recentlyEnded);

  return {
    active_count: active.length,
    dsp_pacing:   cur.dsp_pacing,
    vid_pacing:   cur.vid_pacing,
    ctr:          cur.ctr,
    vtr:          cur.vtr,
    ecpm:         cur.ecpm,
    ecpm_prev:    prev.ecpm,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top Performers — ranking de CS/CP por performance das campanhas ativas
//
// Score por campanha (0–100):
//   eCPM < R$ 0,70           → 35 pts (mais importante)
//   Pacing avg em [100, 125] → 30 pts (range ideal). Decai linear fora:
//                                90→100 e 125→150 dão crédito parcial.
//   CTR > 0,25%              → 25 pts
//   VTR > 80%                → 10 pts
//
// Score do owner = média do score das campanhas, ponderada por
// admin_impressions (campanha grande pesa mais — evita distorção
// por campanha pequenina com sorte). Sem impressões cai pra média simples.
//
// Retorna array ordenado desc por score. Caller resolve email → name.
// ─────────────────────────────────────────────────────────────────────────────
function pacingAvg(c) {
  const dp = c.display_pacing != null ? Number(c.display_pacing) : null;
  const vp = c.video_pacing   != null ? Number(c.video_pacing)   : null;
  if (dp != null && vp != null) return (dp + vp) / 2;
  if (dp != null) return dp;
  if (vp != null) return vp;
  return null;
}

function pacingScore(p) {
  if (p == null) return 0;
  if (p >= 100 && p <= 125) return 30;
  if (p >= 90  && p <  100) return 30 * ((p - 90) / 10);
  if (p >  125 && p <= 150) return 30 * ((150 - p) / 25);
  return 0;
}

function scoreCampaign(c) {
  let s = 0;
  if (c.admin_ecpm != null && Number(c.admin_ecpm) < 0.70) s += 35;
  s += pacingScore(pacingAvg(c));
  if (c.display_ctr != null && Number(c.display_ctr) > 0.25) s += 25;
  if (c.video_vtr   != null && Number(c.video_vtr)   > 80)   s += 10;
  return s;
}

export function computeTopPerformers(campaigns, ownerKey = "cs_email") {
  const today = TODAY();
  const active = (campaigns || []).filter(
    (c) => c.end_date && c.end_date.slice(0, 10) >= today
  );

  const byOwner = new Map();
  for (const c of active) {
    const email = c[ownerKey];
    if (!email) continue;
    if (!byOwner.has(email)) byOwner.set(email, []);
    byOwner.get(email).push(c);
  }

  const out = [];
  for (const [email, list] of byOwner.entries()) {
    let scoreSum = 0;
    let weightSum = 0;
    let idealPacing = 0;

    for (const c of list) {
      const s = scoreCampaign(c);
      const w = c.admin_impressions ? Number(c.admin_impressions) : 1;
      scoreSum  += s * w;
      weightSum += w;

      const p = pacingAvg(c);
      if (p != null && p >= 100 && p <= 125) idealPacing++;
    }

    // Métricas exibidas: agregação correta via Σnumerador / Σdenominador
    // sobre as campanhas do owner (ver aggregateMetrics).
    const m = aggregateMetrics(list);
    const score = weightSum > 0 ? scoreSum / weightSum : 0;

    out.push({
      email,
      score: Math.round(score * 10) / 10,
      campaign_count: list.length,
      ideal_pacing_count: idealPacing,
      ecpm_avg:   m.ecpm,
      dsp_pacing: m.dsp_pacing,
      vid_pacing: m.vid_pacing,
      ctr:        m.ctr,
      vtr:        m.vtr,
    });
  }

  out.sort(
    (a, b) =>
      b.score - a.score ||
      b.campaign_count - a.campaign_count ||
      a.email.localeCompare(b.email)
  );
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worklist (espelho de compute_worklist)
// ─────────────────────────────────────────────────────────────────────────────
export function computeWorklist(campaigns) {
  const today = new Date();
  const inSevenDays = new Date(today.getTime() + 7 * 86400000);
  const todayStr = today.toISOString().slice(0, 10);
  const horizonStr = inSevenDays.toISOString().slice(0, 10);

  const pacing_critical = [];
  const no_owner = [];
  const ending_soon = [];

  for (const c of campaigns || []) {
    if (!c.short_token) continue;
    const endStr = (c.end_date || "").slice(0, 10);
    if (!endStr || endStr < todayStr) continue; // só ativas

    const worst = worstPacing(c.display_pacing, c.video_pacing);
    // Critical = pacing < 90% em qualquer das frentes. Over delivery (≥125%)
    // saiu do bucket: é saudável pela régua atual.
    if (classifyPacing(worst) === "critical") pacing_critical.push(c.short_token);
    if (!c.cp_email || !c.cs_email) no_owner.push(c.short_token);
    if (endStr <= horizonStr) ending_soon.push(c.short_token);
  }

  return {
    pacing_critical:    { count: pacing_critical.length, tokens: pacing_critical },
    no_owner:           { count: no_owner.length,        tokens: no_owner        },
    ending_soon:        { count: ending_soon.length,     tokens: ending_soon     },
    reports_not_viewed: { count: 0, tokens: [] }, // placeholder (sem telemetria ainda)
  };
}
