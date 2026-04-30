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
// ─────────────────────────────────────────────────────────────────────────────
function classifyPacing(p) {
  if (p == null) return null;
  if (p > 140 || p < 75) return "critical";
  if (p > 115 || p < 85) return "attention";
  return "healthy";
}

function aggregateHealth(arr) {
  if (!arr.length) return null;
  if (arr.includes("critical")) return "critical";
  if (arr.includes("attention")) return "attention";
  if (arr.includes("healthy")) return "healthy";
  return null;
}

function worstPacing(dp, vp) {
  const candidates = [];
  if (dp != null) candidates.push(Number(dp));
  if (vp != null) candidates.push(Number(vp));
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (Math.abs(a - 100) > Math.abs(b - 100) ? a : b));
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

    // Pacing médio (display + video, ativas só)
    const pacingValues = [];
    for (const c of active) {
      if (c.display_pacing != null) pacingValues.push(Number(c.display_pacing));
      if (c.video_pacing   != null) pacingValues.push(Number(c.video_pacing));
    }
    const avgPacing = pacingValues.length
      ? Math.round((pacingValues.reduce((a, b) => a + b, 0) / pacingValues.length) * 10) / 10
      : null;

    const ctrValues = active.map((c) => c.display_ctr).filter((v) => v != null).map(Number);
    const vtrValues = active.map((c) => c.video_vtr  ).filter((v) => v != null).map(Number);
    const avgCtr = ctrValues.length
      ? Math.round((ctrValues.reduce((a, b) => a + b, 0) / ctrValues.length) * 100) / 100
      : null;
    const avgVtr = vtrValues.length
      ? Math.round((vtrValues.reduce((a, b) => a + b, 0) / vtrValues.length) * 100) / 100
      : null;

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
    if (worst != null && (worst > 140 || worst < 75)) pacing_critical.push(c.short_token);
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
