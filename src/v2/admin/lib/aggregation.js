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

import { computeMediaPacing } from "../../../shared/aggregations";

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
export function classifyPacing(p) {
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

export function worstPacing(dp, vp) {
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

/**
 * Distribuição de saúde — conta campanhas ativas por tier de pacing.
 * Retorna { healthy, attention, critical, over } sempre (zeros pra
 * tiers vazios), pra que o caller não precise checar undefined.
 *
 * Usado pelo HealthDistribution no ClientCard pra mostrar o mix de
 * status do cliente (ex: 1 saudável + 1 crítica em vez de só "crítica"
 * que era o que o `health` (worst-tier) comunicava antes).
 */
export function computeHealthDistribution(activeCampaigns) {
  const out = { healthy: 0, attention: 0, critical: 0, over: 0 };
  for (const c of activeCampaigns || []) {
    const tier = classifyPacing(worstPacing(c.display_pacing, c.video_pacing));
    if (tier && out[tier] != null) out[tier] += 1;
  }
  return out;
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
    const healthDistribution = computeHealthDistribution(active);

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
      health_distribution: healthDistribution,
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
  // VTR usa viewable/viewable (não total). Antes usávamos video_impressions
  // (total) como denominador, o que dava VTR > 100% por descasamento de
  // fontes no backend (numerador vinha de unified, denom de agg/dedup).
  const vViewable  = sumField(set, "video_viewable_impressions");
  const vExpected  = sumField(set, "video_expected_completions");
  const cost       = sumField(set, "admin_total_cost");
  const impr       = sumField(set, "admin_impressions");
  // Splits por mídia pra eCPM separado — Display vai pro score, Video é
  // exibido sem cor condicional (não pontua mais, mas serve de referência).
  const dCost      = sumField(set, "d_admin_total_cost");
  const dCostImpr  = sumField(set, "d_admin_impressions");
  const vCost      = sumField(set, "v_admin_total_cost");
  const vCostImpr  = sumField(set, "v_admin_impressions");
  // Custo COM survey — usado SÓ pro tech cost (não pro eCPM, que precisa
  // de cost e impressions ambos sem survey pra ratio fazer sentido).
  // Fallback pro admin_total_cost sem survey enquanto backend não tem o
  // campo `_full` (pre-deploy ou cache antigo).
  const costFull = sumField(set, "admin_total_cost_full") || cost;
  // Tech Cost agregado = Σ custo cru DSP (com survey) / Σ valor PI cliente × 100.
  // Backend emite d_client_budget/v_client_budget só pra campanhas com
  // CPM/CPCV e contratado > 0 — então campanhas 100% bonificadas ou sem
  // checklist somam 0 no denominador e ficam fora do agregado naturalmente.
  // Mesma lógica que o tier do diagnostico — mas global em vez de por
  // campanha. Survey entra no numerador (sai da carteira HYPR) mas não
  // no denominador (PI cliente não fatura survey).
  const clientBudget = sumField(set, "d_client_budget") + sumField(set, "v_client_budget");

  return {
    ctr:        dImpr     > 0 ? (dClicks   / dImpr)     * 100  : meanOfField(set, "display_ctr"),
    vtr:        vViewable > 0 ? (vCompl    / vViewable) * 100  : meanOfField(set, "video_vtr"),
    dsp_pacing: dExpected > 0 ? (dViewable / dExpected) * 100  : meanOfField(set, "display_pacing"),
    vid_pacing: vExpected > 0 ? (vCompl    / vExpected) * 100  : meanOfField(set, "video_pacing"),
    ecpm:         impr      > 0 ? (cost  / impr)     * 1000 : null,
    ecpm_display: dCostImpr > 0 ? (dCost / dCostImpr) * 1000 : null,
    ecpm_video:   vCostImpr > 0 ? (vCost / vCostImpr) * 1000 : null,
    tech_cost:    clientBudget > 0 ? (costFull / clientBudget) * 100 : null,
  };
}

// Projeção forward-looking de Tech Cost no fim da campanha, agregada
// pelas ativas. Método: pra cada campanha multiplica o real_cost atual
// por (total_days / elapsed_days) — extrapolação calendar-constante, a
// mesma matemática que usamos por campanha individual em derive.js.
// Soma os projected_real_cost e divide pela soma de client_budget — sem
// média de razões (que distorceria com campanha pequena).
//
// Campanhas sem dado suficiente (sem datas, sem cost, sem budget) saem
// do agregado naturalmente. Sem cap nem gating exotic — projeção honesta
// que reflete onde a operação tá indo se mantiver o ritmo atual.
function aggregateProjectedTechCost(set) {
  // Today às 12:00 UTC pra evitar oscilação na borda do dia em comparações
  // com start_date/end_date que vêm como YYYY-MM-DD (00:00 UTC).
  const todayIso = TODAY();
  const todayMs = Date.parse(todayIso + "T12:00:00Z");
  let sumProjectedRealCost = 0;
  let sumClientBudget = 0;

  for (const c of set) {
    const dBudget = Number(c.d_client_budget) || 0;
    const vBudget = Number(c.v_client_budget) || 0;
    const budget  = dBudget + vBudget;
    // Custo com survey (mesma régua do tech cost agregado). Fallback pro
    // admin_total_cost sem survey enquanto backend não tem `_full`.
    const realCost = Number(c.admin_total_cost_full) || Number(c.admin_total_cost) || 0;
    if (budget <= 0 || realCost <= 0) continue;
    if (!c.start_date || !c.end_date) continue;

    const startMs = Date.parse(c.start_date);
    const endMs   = Date.parse(c.end_date);
    if (isNaN(startMs) || isNaN(endMs)) continue;

    const totalDays = Math.max(1, Math.floor((endMs - startMs) / 86400000) + 1);
    let elapsedDays = Math.floor((todayMs - startMs) / 86400000) + 1;
    elapsedDays = Math.min(totalDays, Math.max(1, elapsedDays));

    const multiplier = totalDays / elapsedDays;
    sumProjectedRealCost += realCost * multiplier;
    sumClientBudget      += budget;
  }

  return sumClientBudget > 0
    ? (sumProjectedRealCost / sumClientBudget) * 100
    : null;
}

// "YYYY-MM" do mês corrente, derivado de TODAY().
function currentMonthKey() {
  return TODAY().slice(0, 7);
}

// "2026-05" → "2026-04". "2026-01" → "2025-12".
function previousMonthKey(monthKey) {
  if (!monthKey) return null;
  const [yStr, mStr] = monthKey.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, "0")}`;
}

// Dias no mês — 28/29/30/31 automatico. Day 0 do mês seguinte = ultimo dia.
function daysInMonth(monthKey) {
  if (!monthKey) return 0;
  const [y, m] = monthKey.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return 0;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Dias elapsed dentro do mês até hoje. Mês corrente: dia de hoje. Mês
// passado: total de dias. Mês futuro: 0 (não começou).
function daysElapsedInMonth(monthKey) {
  if (!monthKey) return 0;
  const today = TODAY();
  const todayMonth = today.slice(0, 7);
  if (monthKey === todayMonth) return Number(today.slice(8, 10));
  return monthKey < todayMonth ? daysInMonth(monthKey) : 0;
}

// Tech cost da Big Metric — REGRA ASSIMETRICA:
//   Numerador   = Σ custo gasto DENTRO de M por TODAS campanhas que tocaram M
//                 (vem do campo monthly_cost_full do backend, com survey)
//   Denominador = Σ budget SO de campanhas com start_date em M
//
// Por que assimetrico:
//   - Custo é "real" — todo dinheiro de DSP que saiu da carteira HYPR em M,
//     independente de qual mês a PI foi vendida.
//   - Budget é "contractual" — só conta budget de PIs realmente vendidas
//     pra M. Não pega budget de PI vendida em Abril que cruzou pra Maio
//     (essa fica em Abril).
//
// Cross-month edge case (Neutrogena 27/04→31/05): custo de Abr fica em
// Abr, custo de Mai vai pra Mai. Budget cheio em Abr (sold em Abr).
//
// Fallback: se backend ainda não tem `monthly_cost_full`, retorna null
// e o caller decide o que fazer (provavelmente cai pra calculo antigo).
function aggregateMonthlyTechCost(campaigns, monthKey) {
  if (!monthKey || !Array.isArray(campaigns) || campaigns.length === 0) return null;
  let cost = 0;
  let budget = 0;
  let hasMonthlyData = false;
  for (const c of campaigns) {
    const m = c.monthly_cost_full;
    if (m && typeof m === "object") {
      hasMonthlyData = true;
      const mc = Number(m[monthKey]);
      if (Number.isFinite(mc) && mc > 0) cost += mc;
    }
    if (c.start_date && c.start_date.slice(0, 7) === monthKey) {
      const b = (Number(c.d_client_budget) || 0) + (Number(c.v_client_budget) || 0);
      if (b > 0) budget += b;
    }
  }
  if (!hasMonthlyData) return null;  // backend sem o campo — caller cai pro legado
  // Retorna objeto com pct + brutos pro tooltip do card mostrar a conta.
  // Caller que só quer o pct usa .pct.
  return {
    pct:    budget > 0 ? (cost / budget) * 100 : null,
    cost,
    budget,
  };
}

// Projeção da Big Metric — APENAS mês corrente.
//   projected_cost = MTD_cost × (days_in_month / days_elapsed_in_month)
//   projected_tech_cost = projected_cost / budget × 100
//
// Lógica: assume que o ritmo diário de gasto do mês até agora se mantém
// até o fim do mês. Linear, sem cap. Mês fechado → null (já é realizado).
function aggregateMonthlyProjectedTechCost(campaigns, monthKey) {
  if (!monthKey || !Array.isArray(campaigns) || campaigns.length === 0) return null;
  const todayMonth = currentMonthKey();
  if (monthKey !== todayMonth) return null;  // só projeta mês vigente

  const totalDays = daysInMonth(monthKey);
  const elapsed   = daysElapsedInMonth(monthKey);
  if (totalDays <= 0 || elapsed <= 0) return null;

  let mtdCost = 0;
  let budget = 0;
  let hasMonthlyData = false;
  for (const c of campaigns) {
    const m = c.monthly_cost_full;
    if (m && typeof m === "object") {
      hasMonthlyData = true;
      const mc = Number(m[monthKey]);
      if (Number.isFinite(mc) && mc > 0) mtdCost += mc;
    }
    if (c.start_date && c.start_date.slice(0, 7) === monthKey) {
      const b = (Number(c.d_client_budget) || 0) + (Number(c.v_client_budget) || 0);
      if (b > 0) budget += b;
    }
  }
  if (!hasMonthlyData || budget <= 0) return null;

  const projectedCost = mtdCost * (totalDays / elapsed);
  return (projectedCost / budget) * 100;
}

// Cohort por start_date — "campanhas que iniciaram no mês X". Mesma regra
// que o MonthFilterPills usa pra agrupar (slice(0,7) === monthKey), então
// strip de KPIs e chips de filtro ficam sempre coerentes.
function filterByStartMonth(campaigns, monthKey) {
  if (!monthKey) return [];
  return (campaigns || []).filter(
    (c) => c.start_date && c.start_date.slice(0, 7) === monthKey
  );
}

// Resumo de KPIs por cohort de mês (campanhas que iniciaram no mês
// selecionado). Default = mês corrente.
//
// Por que cohort-by-start em vez de "ativas globais":
//   - Time olha tech cost em ciclo mensal de fechamento de PI.
//   - Permite comparar mês-vs-mês (delta vs cohort do mês anterior).
//   - Filtro de chips no rodapé já usa essa mesma regra.
//
// Trade-off: "CTR de Mai" = CTR lifetime das campanhas que começaram em
// maio (inclui dados de jun/jul se elas se estenderam). Não é "CTR
// observado dentro do mês de maio" — esse não é computável sem dados
// temporais por campanha.
//
// Projeção: só roda no mês corrente. Mês fechado já é realizado, projetar
// não faz sentido — strip mostra só a barra atual sem a setinha.
export function computeMetricsSummary(campaigns, options = {}) {
  const monthKey   = options.monthKey || currentMonthKey();
  const prevMonth  = previousMonthKey(monthKey);
  const today      = TODAY();
  const isCurrent  = monthKey === currentMonthKey();

  const cohort     = filterByStartMonth(campaigns, monthKey);
  const prevCohort = filterByStartMonth(campaigns, prevMonth);

  const cur  = aggregateMetrics(cohort);
  const prev = aggregateMetrics(prevCohort);

  // ── Tech Cost: regra ASSIMETRICA (diferente das outras métricas) ───
  // CTR/VTR/eCPM continuam por cohort (start_date em M). Tech cost usa
  // monthly_cost_full do backend pra capturar cost real gasto no mês,
  // independente de quando a campanha começou. Budget continua só do
  // cohort (PI vendida pra M). Ver aggregateMonthlyTechCost pra racional.
  //
  // Fallback: backend sem campo monthly_cost_full → cai pro lifetime
  // tech_cost do cohort (régua antiga). Não quebra durante deploy.
  const techCostMonthly = aggregateMonthlyTechCost(campaigns, monthKey);
  const techCostPrev    = aggregateMonthlyTechCost(campaigns, prevMonth);
  const techCost        = techCostMonthly != null ? techCostMonthly.pct : cur.tech_cost;
  const techCostPrevVal = techCostPrev    != null ? techCostPrev.pct    : prev.tech_cost;
  // Brutos pro tooltip do card (Custo / Investimento). Quando estamos no
  // fallback legado (sem monthly_cost_full do backend), expõe os valores
  // do cohort lifetime — ainda assim útil pro tooltip explicar a conta.
  const techCostCost   = techCostMonthly != null ? techCostMonthly.cost   : null;
  const techCostBudget = techCostMonthly != null ? techCostMonthly.budget : null;

  // Projeção mensal: MTD extrapolado pelo ritmo diário até fim do mês.
  // Só pro mês corrente. Mês fechado já é tech cost final. Fallback pro
  // método antigo (lifetime extrapolado) se monthly_cost_full ausente.
  const techCostProjectedMonthly = isCurrent
    ? aggregateMonthlyProjectedTechCost(campaigns, monthKey)
    : null;
  const techCostProjected = techCostProjectedMonthly != null
    ? techCostProjectedMonthly
    : (isCurrent ? aggregateProjectedTechCost(cohort) : null);

  // "Ativas" do cohort = subset que ainda tá rodando hoje. Pra mês corrente
  // a maioria do cohort ainda tá in flight; pra mês passado, mostra quantas
  // PIs daquela safra escaparam pro presente.
  const activeInCohort = cohort.filter(
    (c) => c.end_date && c.end_date.slice(0, 10) >= today
  ).length;

  return {
    month_key:       monthKey,
    is_current_month: isCurrent,
    cohort_size:     cohort.length,
    active_count:    activeInCohort,
    dsp_pacing:      cur.dsp_pacing,
    vid_pacing:      cur.vid_pacing,
    ctr:             cur.ctr,
    ctr_prev:        prev.ctr,
    vtr:             cur.vtr,
    vtr_prev:        prev.vtr,
    ecpm:            cur.ecpm,
    ecpm_prev:       prev.ecpm,
    ecpm_display:      cur.ecpm_display,
    ecpm_display_prev: prev.ecpm_display,
    ecpm_video:        cur.ecpm_video,
    ecpm_video_prev:   prev.ecpm_video,
    tech_cost:           techCost,
    tech_cost_prev:      techCostPrevVal,
    tech_cost_projected: techCostProjected,
    tech_cost_cost:      techCostCost,
    tech_cost_budget:    techCostBudget,
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
// admin_impressions (campanha grande pesa mais que pequena).
//
// Retorna array ordenado desc por score.
// ─────────────────────────────────────────────────────────────────────────────
// Pacing "médio simples" (DSP+VID)/2. Usado APENAS pra contar campanhas
// com pacing ideal no card (ideal_pacing_count) — não entra no score.
// O score usa pacing por mídia ponderado por impressões em scoreCampaign.
function pacingAvg(c) {
  const dp = c.display_pacing != null ? Number(c.display_pacing) : null;
  const vp = c.video_pacing   != null ? Number(c.video_pacing)   : null;
  if (dp != null && vp != null) return (dp + vp) / 2;
  if (dp != null) return dp;
  if (vp != null) return vp;
  return null;
}

// Score de pacing — gradiente linear, ramp 90→100 e 125→150.
// Recebe pacing % (0–∞), retorna pontos 0–35.
function pacingScore(p) {
  if (p == null) return 0;
  if (p >= 100 && p <= 125) return 35;
  if (p >= 90  && p <  100) return 35 * ((p - 90) / 10);
  if (p >  125 && p <= 150) return 35 * ((150 - p) / 25);
  return 0;
}

// Thresholds. Só Display contribui pra eCPM/CTR no score — Video é avaliado
// apenas via Pacing (ponderado) + VTR. Decisão de produto: benchmarks de eCPM
// e CTR pra Video são instáveis (mix de inventário muito heterogêneo, do
// instream short ao CTV), então removemos Video dessas duas métricas pra
// não contaminar o score. ABS só altera os thresholds de Display.
//
// Detecção via flags `display_has_abs` / `video_has_abs` do payload. Cobre
// DV360 (DoubleVerify ABS), Xandr (DV ou IAS via data_provider_name) e
// override manual via campaign_abs_overrides.
const ECPM_THRESHOLD_DISPLAY     = 0.70;
const ECPM_THRESHOLD_DISPLAY_ABS = 1.50;
const CTR_THRESHOLD_DISPLAY      = 0.7;
const CTR_THRESHOLD_DISPLAY_ABS  = 0.5;
const VTR_THRESHOLD              = 80;

// Mínimo de share contratado pra uma frente entrar na conta de pacing.
// Frente com <5% do contrato é tipicamente OOH residual em campanha O2O-heavy
// (ou vice-versa) — penalizar isso seria injusto, e o ruído contamina o sinal
// da frente principal. Frente única (single-tactic) também não passa por aqui:
// o caller cai no fallback de pacing agregado abaixo.
const MIN_FRENTE_CONTRACTED_SHARE = 0.05;

/**
 * Score de pacing por frente (O2O/OOH) pra uma mídia, ponderado pelo SHARE
 * CONTRATADO de cada frente (não pelo entregue — peso entregue criaria
 * incentivo perverso onde frente under entrega menos e pesa menos).
 *
 * Returns:
 *   { pts, max, frenteReasons }
 *   - pts: pontos somados das duas frentes, ponderados.
 *   - max: 35 (ou proporcional se share total < 100%).
 *   - frenteReasons: array de { tactic, pacing, share, lost } pra diagnostics.
 *
 * Retorna null quando:
 *   - Detail não disponível ou sem totals
 *   - Mídia não tem frente válida (single tactic — caller usa fallback)
 *   - Ambas frentes têm contracted=0 (100% bonificada — sem régua de pacing)
 */
function pacingScorePerFrente(detail, mediaType) {
  if (!detail?.totals || !Array.isArray(detail.totals)) return null;
  const camp = detail.campaign;
  if (!camp) return null;

  const isVideo = mediaType === "VIDEO";
  const o2oRows = detail.totals.filter((r) => r.media_type === mediaType && r.tactic_type === "O2O");
  const oohRows = detail.totals.filter((r) => r.media_type === mediaType && r.tactic_type === "OOH");

  // Contracted (sem bônus) por frente — bonificada parcial entra com peso
  // proporcional ao contratado dela. Se TODA a mídia é bonificada (sem
  // contracted_*), não há régua → retorna null e caller usa fallback.
  const r0 = (o2oRows[0] || oohRows[0] || {});
  const contractedO2O = isVideo
    ? Number(r0.contracted_o2o_video_completions   || 0)
    : Number(r0.contracted_o2o_display_impressions || 0);
  const contractedOOH = isVideo
    ? Number(r0.contracted_ooh_video_completions   || 0)
    : Number(r0.contracted_ooh_display_impressions || 0);
  const contractedTotal = contractedO2O + contractedOOH;
  if (contractedTotal <= 0) return null;

  const shareO2O = contractedO2O / contractedTotal;
  const shareOOH = contractedOOH / contractedTotal;

  // Frente única (uma das duas é 0 ou está abaixo do mínimo) → null pra cair
  // no fallback de pacing agregado. Não dá pra ter "frente desbalanceada"
  // com uma só.
  const validO2O = o2oRows.length > 0 && shareO2O >= MIN_FRENTE_CONTRACTED_SHARE;
  const validOOH = oohRows.length > 0 && shareOOH >= MIN_FRENTE_CONTRACTED_SHARE;
  if (!validO2O || !validOOH) return null;

  const pacingO2O = computeMediaPacing(o2oRows, camp, mediaType, "O2O");
  const pacingOOH = computeMediaPacing(oohRows, camp, mediaType, "OOH");

  const ptsO2O = pacingScore(pacingO2O);
  const ptsOOH = pacingScore(pacingOOH);

  const pts = ptsO2O * shareO2O + ptsOOH * shareOOH;
  const frenteReasons = [
    { tactic: "O2O", pacing: pacingO2O, share: shareO2O, lost: (35 - ptsO2O) * shareO2O },
    { tactic: "OOH", pacing: pacingOOH, share: shareOOH, lost: (35 - ptsOOH) * shareOOH },
  ];
  return { pts, max: 35, frenteReasons };
}

// Breakdown completo do score de uma campanha. Retorna pts atuais e máximos
// por categoria, pesos por mídia, e diagnósticos textuais ordenados por
// impacto (perda em pts). Usado pelo PerformerDrawer pra explicar onde
// cada CS está perdendo pontos.
//
// Pesos (wDsp/wVid) = share de viewable_impressions em cada mídia.
// Campanha 80% Display + 20% Video tem wDsp=0,8 e wVid=0,2.
//
// Distribuição de pontos:
//   - Pacing  (35) ponderado por mídia (Display + Video contam).
//     Quando `detail` está disponível e a mídia tem ambas frentes (O2O+OOH)
//     com contrato ≥5% cada, o pacing dessa mídia é calculado POR FRENTE
//     (ponderado por share contratado), não pela média agregada. Isso evita
//     o blindspot "média 110% esconde OOH 92%".
//   - eCPM    (30 × wDsp) APENAS Display. Threshold ABS-aware.
//   - CTR     (25 × wDsp) APENAS Display. Threshold ABS-aware.
//   - VTR     (10 × wVid) APENAS Video.
//
// Max teórico varia por composição da campanha:
//   - 100% Display: 35 + 30 + 25 = 90 pts
//   - 100% Video:   35 + 0 + 0 + 10 = 45 pts
//   - 50/50:        35 + 15 + 12.5 + 5 = 67.5 pts
// Score é normalizado pelo max_total dinâmico — frame "X / max" justo entre
// composições diferentes.
//
// ABS: thresholds eCPM/CTR de Display ficam mais permissivos quando
// `c.display_has_abs` é true (DV360, Xandr DV/IAS, ou override manual).
function scoreCampaignDetailed(c, detail = null) {
  const dImpr = Number(c.display_impressions || 0);
  const vImpr = Number(c.video_impressions   || 0);
  const totalImpr = dImpr + vImpr;

  const empty = {
    total: 0,
    pacing: 0, ecpm: 0, ctr: 0, vtr: 0,
    max_total: 0, max_pacing: 0, max_ecpm: 0, max_ctr: 0, max_vtr: 0,
    weights: { dsp: 0, vid: 0 },
    diagnostics: [],
  };
  if (totalImpr === 0) return empty;

  const wDsp = dImpr / totalImpr;
  const wVid = vImpr / totalImpr;

  // ── Pacing (35 pts) ──────────────────────────────────────────
  // Quando detail está disponível e a mídia tem ambas as frentes válidas
  // (O2O+OOH com ≥5% contratado cada), substituímos o pacingScore(media)
  // pelo pacingScorePerFrente. Caso contrário, cai no comportamento legado
  // (média agregada do list endpoint).
  const dFrente = pacingScorePerFrente(detail, "DISPLAY");
  const vFrente = pacingScorePerFrente(detail, "VIDEO");
  const dPacingPts = dFrente
    ? dFrente.pts
    : (c.display_pacing != null ? pacingScore(Number(c.display_pacing)) : null);
  const vPacingPts = vFrente
    ? vFrente.pts
    : (c.video_pacing != null ? pacingScore(Number(c.video_pacing)) : null);
  let pacingPts = 0;
  let maxPacing = 35;
  if (dPacingPts != null && vPacingPts != null) {
    pacingPts = dPacingPts * wDsp + vPacingPts * wVid;
  } else if (dPacingPts != null) {
    pacingPts = dPacingPts;
  } else if (vPacingPts != null) {
    pacingPts = vPacingPts;
  } else {
    maxPacing = 0;
  }

  // Thresholds Display dinâmicos baseados em ABS. Video não tem threshold
  // porque eCPM/CTR de Video deixaram de pontuar — mas mantemos `vHasAbs`
  // pro retorno (`breakdown.abs.video`), que o PerformerDrawer usa pra
  // renderizar o badge "ABS·V" quando o sinal automático marca só Video.
  const dHasAbs = !!c.display_has_abs;
  const vHasAbs = !!c.video_has_abs;
  const dEcpmTh = dHasAbs ? ECPM_THRESHOLD_DISPLAY_ABS : ECPM_THRESHOLD_DISPLAY;
  const dCtrTh  = dHasAbs ? CTR_THRESHOLD_DISPLAY_ABS  : CTR_THRESHOLD_DISPLAY;

  // ── eCPM (30 pts × wDsp) — só Display ──────────────────────
  const dEcpm = c.display_ecpm != null ? Number(c.display_ecpm) : null;
  let ecpmPts = 0;
  let maxEcpm = 0;
  if (dEcpm != null && wDsp > 0) {
    ecpmPts = (dEcpm < dEcpmTh ? 30 : 0) * wDsp;
    maxEcpm = 30 * wDsp;
  } else if (c.admin_ecpm != null && wDsp > 0) {
    // Fallback antigo: sem split por mídia. Trata como Display.
    const ecpm = Number(c.admin_ecpm);
    ecpmPts = ecpm < dEcpmTh ? 30 * wDsp : 0;
    maxEcpm = 30 * wDsp;
  }

  // ── CTR (25 pts × wDsp) — só Display ───────────────────────
  const dCtr = c.display_ctr != null ? Number(c.display_ctr) : null;
  let ctrPts = 0;
  let maxCtr = 0;
  if (dCtr != null && wDsp > 0) {
    ctrPts = (dCtr > dCtrTh ? 25 : 0) * wDsp;
    maxCtr = 25 * wDsp;
  }

  // ── VTR (10 pts × wVid) — só Video ──────────────────────────
  const vtrHasData = c.video_vtr != null;
  const vtrPts = vtrHasData && Number(c.video_vtr) > VTR_THRESHOLD ? 10 * wVid : 0;
  const maxVtr = vtrHasData ? 10 * wVid : 0;

  // ── Diagnostics: razões da perda, ordenadas por impacto ─────
  const diagnostics = [];
  if (maxPacing > 0 && pacingPts < maxPacing - 0.5) {
    const reasons = [];
    // Quando há frente desbalanceada, mostra cada frente individualmente
    // (mais útil que a média — admin precisa saber QUAL frente puxou).
    // Ordena por lost desc pra a frente que mais penalizou aparecer primeiro.
    const frenteReasonsList = [];
    if (dFrente && wDsp > 0) {
      for (const f of dFrente.frenteReasons) frenteReasonsList.push({ media: "Display", ...f });
    }
    if (vFrente && wVid > 0) {
      for (const f of vFrente.frenteReasons) frenteReasonsList.push({ media: "Video", ...f });
    }
    frenteReasonsList.sort((a, b) => b.lost - a.lost);
    const FRENTE_PACING_LABEL = {
      critical:  "under",
      attention: "sub-ideal",
      over:      "acima do ideal",
    };
    for (const f of frenteReasonsList) {
      // Só lista frentes que efetivamente penalizaram (lost > 0.3pts ponderado).
      if (f.lost < 0.3) continue;
      const tag = classifyPacing(f.pacing);
      const label = FRENTE_PACING_LABEL[tag];
      if (!label) continue; // healthy não vira diagnóstico
      reasons.push(`${f.media} ${f.tactic} ${f.pacing.toFixed(0)}% (${label})`);
    }
    // Fallback pra mídia sem detail (single-frente ou detail ainda não chegou)
    // — comportamento legado, baseado na média agregada do list endpoint.
    if (!dFrente && c.display_pacing != null && wDsp > 0) {
      const dp = Number(c.display_pacing);
      if (dp < 90)       reasons.push(`Display ${dp.toFixed(0)}% (under)`);
      else if (dp > 150) reasons.push(`Display ${dp.toFixed(0)}% (over)`);
      else if (dp < 100) reasons.push(`Display ${dp.toFixed(0)}% (sub-ideal)`);
      else if (dp > 125) reasons.push(`Display ${dp.toFixed(0)}% (acima do ideal)`);
    }
    if (!vFrente && c.video_pacing != null && wVid > 0) {
      const vp = Number(c.video_pacing);
      if (vp < 90)       reasons.push(`Video ${vp.toFixed(0)}% (under)`);
      else if (vp > 150) reasons.push(`Video ${vp.toFixed(0)}% (over)`);
      else if (vp < 100) reasons.push(`Video ${vp.toFixed(0)}% (sub-ideal)`);
      else if (vp > 125) reasons.push(`Video ${vp.toFixed(0)}% (acima do ideal)`);
    }
    if (reasons.length) {
      diagnostics.push({ category: "pacing", lost: maxPacing - pacingPts, reason: reasons.join(" · ") });
    }
  }
  if (maxEcpm > 0 && ecpmPts < maxEcpm - 0.5) {
    const reasons = [];
    if (dEcpm != null && dEcpm >= dEcpmTh) {
      reasons.push(`Display eCPM R$ ${dEcpm.toFixed(2)} (≥ R$ ${dEcpmTh.toFixed(2)}${dHasAbs ? " ABS" : ""})`);
    } else if (dEcpm == null && c.admin_ecpm != null) {
      const ecpm = Number(c.admin_ecpm);
      if (ecpm >= dEcpmTh) reasons.push(`eCPM R$ ${ecpm.toFixed(2)} (≥ R$ ${dEcpmTh.toFixed(2)}${dHasAbs ? " ABS" : ""})`);
    }
    if (reasons.length) {
      diagnostics.push({ category: "ecpm", lost: maxEcpm - ecpmPts, reason: reasons.join(" · ") });
    }
  }
  if (maxCtr > 0 && ctrPts < maxCtr - 0.5) {
    if (dCtr != null && dCtr <= dCtrTh) {
      diagnostics.push({
        category: "ctr",
        lost: maxCtr - ctrPts,
        reason: `Display CTR ${dCtr.toFixed(2)}% (≤ ${dCtrTh.toFixed(1)}%${dHasAbs ? " ABS" : ""})`,
      });
    }
  }
  if (maxVtr > 0.5 && vtrPts < maxVtr - 0.5 && vtrHasData) {
    const vtr = Number(c.video_vtr);
    if (vtr <= VTR_THRESHOLD) {
      diagnostics.push({ category: "vtr", lost: maxVtr - vtrPts, reason: `VTR ${vtr.toFixed(1)}% (≤ ${VTR_THRESHOLD}%)` });
    }
  }
  diagnostics.sort((a, b) => b.lost - a.lost);

  return {
    total: pacingPts + ecpmPts + ctrPts + vtrPts,
    pacing: pacingPts, ecpm: ecpmPts, ctr: ctrPts, vtr: vtrPts,
    max_total: maxPacing + maxEcpm + maxCtr + maxVtr,
    max_pacing: maxPacing, max_ecpm: maxEcpm, max_ctr: maxCtr, max_vtr: maxVtr,
    weights: { dsp: wDsp, vid: wVid },
    abs: { display: dHasAbs, video: vHasAbs },
    diagnostics,
  };
}


export function computeTopPerformers(campaigns, ownerKey = "cs_email", options = {}, detailMap = {}) {
  const { requireCurrentlyActive = true, periodFrom = null, periodTo = null } = options;
  // Período histórico (Mês passado / 7d / 30d / 90d / Custom) passa
  // periodFrom/periodTo. Sem eles = modo "Agora" → usa mês corrente.
  const hasPeriod = Boolean(periodFrom && periodTo);
  const today = TODAY();
  // Modo "Agora": campanha entra no ranking quando está EM VÔO (end_date >= hoje
  // + não pausada). Paused (paused_at != null) tem performance congelada no
  // momento da pausa — entrar no score premia/penaliza algo que não está sob
  // ação ativa. Quando a campanha despausar, volta automaticamente ao cálculo.
  //
  // Modo histórico (requireCurrentlyActive=false): a janela já foi aplicada
  // pelo backend (só vêm campanhas com delivery no período), e o status atual
  // não importa — campanha encerrada que rodou na janela deve pontuar.
  const active = requireCurrentlyActive
    ? (campaigns || []).filter(
        (c) => c.end_date && c.end_date.slice(0, 10) >= today && !c.paused_at
      )
    : (campaigns || []);

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
    const campaignDetails = []; // {campaign, breakdown, weight, potential}

    // Acumuladores ponderados por categoria pro breakdown agregado do CS.
    let pacingPtsSum = 0, ecpmPtsSum = 0, ctrPtsSum = 0, vtrPtsSum = 0;
    let maxPacingSum = 0, maxEcpmSum = 0, maxCtrSum = 0, maxVtrSum = 0;

    for (const c of list) {
      const detailed = scoreCampaignDetailed(c, detailMap[c.short_token] || null);
      const w = c.admin_impressions ? Number(c.admin_impressions) : 1;
      scoreSum  += detailed.total * w;
      weightSum += w;

      pacingPtsSum += detailed.pacing * w;
      ecpmPtsSum   += detailed.ecpm   * w;
      ctrPtsSum    += detailed.ctr    * w;
      vtrPtsSum    += detailed.vtr    * w;
      maxPacingSum += detailed.max_pacing * w;
      maxEcpmSum   += detailed.max_ecpm   * w;
      maxCtrSum    += detailed.max_ctr    * w;
      maxVtrSum    += detailed.max_vtr    * w;

      campaignDetails.push({ campaign: c, breakdown: detailed, weight: w });

      const p = pacingAvg(c);
      if (p != null && p >= 100 && p <= 125) idealPacing++;
    }

    // Potential: pontos não-ganhos × share de impressões da campanha no
    // total do owner. Campanha grande com gap grande tem maior alavancagem.
    // Ordena desc — primeiras são "onde vale mais a pena focar".
    for (const cd of campaignDetails) {
      const gap = cd.breakdown.max_total - cd.breakdown.total;
      cd.potential = weightSum > 0 ? gap * (cd.weight / weightSum) : 0;
    }
    campaignDetails.sort((a, b) => b.potential - a.potential);

    // Métricas exibidas: agregação correta via Σnumerador / Σdenominador
    // sobre as campanhas do owner (ver aggregateMetrics).
    const m = aggregateMetrics(list);
    const rawScore = weightSum > 0 ? scoreSum / weightSum : 0;

    // Totais do período atribuídos ao CS — exibidos no PerformerDrawer
    // como "Investido no mês" / "Custo no mês".
    //
    // Modo "Agora" (sem período):
    //   Custo       = Σ monthly_cost_full[mês_corrente] das campanhas do CS
    //   Investimento = Σ client_budget das PIs do CS com start no mês corrente
    //
    // Modo histórico (com periodFrom/periodTo):
    //   Custo       = Σ admin_total_cost_full (já windowed pelo backend
    //                 — query_performers_for_period filtra date no período)
    //   Investimento = Σ client_budget das PIs do CS com start_date dentro
    //                  do período (cohort do período)
    //
    // Régua assimétrica preservada: custo pega tudo que rolou no período,
    // budget só PIs que iniciaram no período. Fallback pra null quando
    // backend não tem os campos — drawer esconde a seção.
    let monthCost = 0;
    let monthBudget = 0;
    let hasMonthlyData = false;
    // Breakdown por campanha das duas somas — alimenta o popover de auditoria
    // no PerformerDrawer (clicar em Investido/Custo no mês mostra de onde vem
    // cada R$). Montado AQUI, no mesmo loop da soma, pra bater EXATAMENTE com
    // month_budget/month_cost — uma fonte só, sem recálculo no front que
    // pudesse divergir do total exibido.
    const budgetBreakdown = [];
    const costBreakdown = [];
    const mkEntry = (c, value) => ({
      token: c.short_token,
      client: c.client_name,
      campaign: c.campaign_name,
      value,
    });
    if (hasPeriod) {
      // Modo histórico — backend já filtrou cost pelo período.
      for (const c of list) {
        const cf = Number(c.admin_total_cost_full);
        if (Number.isFinite(cf) && cf > 0) {
          hasMonthlyData = true;
          monthCost += cf;
          costBreakdown.push(mkEntry(c, cf));
        }
        if (c.start_date) {
          const sd = c.start_date.slice(0, 10);
          if (sd >= periodFrom && sd <= periodTo) {
            const b = (Number(c.d_client_budget) || 0) + (Number(c.v_client_budget) || 0);
            if (b > 0) { monthBudget += b; budgetBreakdown.push(mkEntry(c, b)); }
          }
        }
      }
    } else {
      // Modo "Agora" — usa monthly_cost_full do mês corrente.
      const mk = currentMonthKey();
      for (const c of list) {
        const mcMap = c.monthly_cost_full;
        if (mcMap && typeof mcMap === "object") {
          hasMonthlyData = true;
          const mc = Number(mcMap[mk]);
          if (Number.isFinite(mc) && mc > 0) { monthCost += mc; costBreakdown.push(mkEntry(c, mc)); }
        }
        if (c.start_date && c.start_date.slice(0, 7) === mk) {
          const b = (Number(c.d_client_budget) || 0) + (Number(c.v_client_budget) || 0);
          if (b > 0) { monthBudget += b; budgetBreakdown.push(mkEntry(c, b)); }
        }
      }
    }
    // Maior contribuição primeiro — popover lista do que mais pesa pro menos.
    budgetBreakdown.sort((a, b) => b.value - a.value);
    costBreakdown.sort((a, b) => b.value - a.value);

    // Tech cost da COLUNA = MESMA régua assimétrica do KPI strip
    // (aggregateMonthlyTechCost) e do drawer: custo realizado no período ÷
    // budget das PIs que iniciaram no período. Reusa month_cost/month_budget
    // já computados acima — assim coluna, drawer e Big Metric mostram SEMPRE
    // o mesmo número (uma só fonte de verdade). Antes a coluna usava
    // m.tech_cost (Σ admin_total_cost_full / Σ client_budget de contrato
    // cheio), que divergia: numerador janelado no período mas denominador
    // = contrato lifetime de TODA campanha com entrega → tech cost
    // artificialmente baixo. Fallback pro ratio legado quando backend não
    // tem os campos _full (mesmo padrão: techCostMonthly ?? cur.tech_cost).
    const techCostAligned = (hasMonthlyData && monthBudget > 0)
      ? (monthCost / monthBudget) * 100
      : m.tech_cost;

    out.push({
      email,
      score: Math.round(rawScore * 10) / 10,
      campaign_count: list.length,
      ideal_pacing_count: idealPacing,
      month_cost:    hasMonthlyData ? monthCost   : null,
      month_budget:  monthBudget > 0 ? monthBudget : null,
      // Breakdown por campanha das somas acima (auditoria via popover no
      // drawer). null quando não há dados — esconde o affordance de clique.
      month_budget_breakdown: monthBudget > 0 ? budgetBreakdown : null,
      month_cost_breakdown:   hasMonthlyData ? costBreakdown : null,
      month_key:     hasPeriod ? null : currentMonthKey(),
      period_from:   periodFrom,
      period_to:     periodTo,
      ecpm_avg:     m.ecpm,
      ecpm_display: m.ecpm_display,
      ecpm_video:   m.ecpm_video,
      dsp_pacing:   m.dsp_pacing,
      vid_pacing:   m.vid_pacing,
      ctr:          m.ctr,
      vtr:          m.vtr,
      // Tech cost do CS — régua assimétrica (custo no período ÷ budget das
      // PIs iniciadas no período), alinhada ao drawer e à Big Metric. Inclui
      // survey no numerador (régua admin). Métrica cosmética — NÃO entra no
      // cálculo do score (que é só pacing/eCPM/CTR/VTR). Ver techCostAligned.
      tech_cost:    techCostAligned,
      // Breakdown agregado por categoria (pts médios ponderados / max realista).
      breakdown: weightSum > 0 ? {
        pacing_pts: pacingPtsSum / weightSum,
        ecpm_pts:   ecpmPtsSum   / weightSum,
        ctr_pts:    ctrPtsSum    / weightSum,
        vtr_pts:    vtrPtsSum    / weightSum,
        max_pacing: maxPacingSum / weightSum,
        max_ecpm:   maxEcpmSum   / weightSum,
        max_ctr:    maxCtrSum    / weightSum,
        max_vtr:    maxVtrSum    / weightSum,
      } : null,
      // Lista de campanhas ordenada por potencial de ganho desc.
      campaigns: campaignDetails,
    });
  }

  // Team avg por categoria: média dos breakdowns ponderados de cada CS.
  // Anexado em cada performer pra simplificar API (Drawer recebe o performer
  // e já tem tudo que precisa pra exibir o "vs time").
  const valid = out.filter((o) => o.breakdown);
  const teamAvg = valid.length > 0 ? {
    pacing_pts: valid.reduce((a, o) => a + o.breakdown.pacing_pts, 0) / valid.length,
    ecpm_pts:   valid.reduce((a, o) => a + o.breakdown.ecpm_pts,   0) / valid.length,
    ctr_pts:    valid.reduce((a, o) => a + o.breakdown.ctr_pts,    0) / valid.length,
    vtr_pts:    valid.reduce((a, o) => a + o.breakdown.vtr_pts,    0) / valid.length,
  } : null;
  for (const o of out) o.team_avg = teamAvg;

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
