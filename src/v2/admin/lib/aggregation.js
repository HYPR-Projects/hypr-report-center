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

  return {
    ctr:        dImpr     > 0 ? (dClicks   / dImpr)     * 100  : meanOfField(set, "display_ctr"),
    vtr:        vViewable > 0 ? (vCompl    / vViewable) * 100  : meanOfField(set, "video_vtr"),
    dsp_pacing: dExpected > 0 ? (dViewable / dExpected) * 100  : meanOfField(set, "display_pacing"),
    vid_pacing: vExpected > 0 ? (vCompl    / vExpected) * 100  : meanOfField(set, "video_pacing"),
    ecpm:         impr      > 0 ? (cost  / impr)     * 1000 : null,
    ecpm_display: dCostImpr > 0 ? (dCost / dCostImpr) * 1000 : null,
    ecpm_video:   vCostImpr > 0 ? (vCost / vCostImpr) * 1000 : null,
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
    ctr_prev:     prev.ctr,
    vtr:          cur.vtr,
    vtr_prev:     prev.vtr,
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
// Score "raw" do owner = média do score das campanhas, ponderada por
// admin_impressions (campanha grande pesa mais que pequena).
//
// Score "regredido" do owner = aplica Empirical Bayes shrinkage em cima
// do raw — corrige viés de amostra pequena (ex: 1 campanha perfeita
// derrotando alguém com 15 boas). Os parâmetros de regressão são
// CALCULADOS DOS PRÓPRIOS DADOS (parameter-free):
//
//   k = σ²_within / σ²_between
//   score_final = (n × raw + k × média_do_time) / (n + k)
//
// Onde σ²_within = variância média entre campanhas DENTRO de cada CS
// e σ²_between = variância dos scores raw ENTRE os CSs. Quando o time
// tem alta variância de skill (sinal forte), k fica pequeno e o raw
// domina. Quando os CSs parecem indistinguíveis (ruído alto), k cresce
// e tudo regride pra média. É matematicamente ótimo (MMSE).
//
// Retorna array ordenado desc por score regredido. raw_score fica
// disponível pra debug/tooltip.
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
function scoreCampaignDetailed(c) {
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
  const dPacingPts = c.display_pacing != null ? pacingScore(Number(c.display_pacing)) : null;
  const vPacingPts = c.video_pacing   != null ? pacingScore(Number(c.video_pacing))   : null;
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
    if (c.display_pacing != null && wDsp > 0) {
      const dp = Number(c.display_pacing);
      if (dp < 90)       reasons.push(`Display ${dp.toFixed(0)}% (under)`);
      else if (dp > 150) reasons.push(`Display ${dp.toFixed(0)}% (over)`);
      else if (dp < 100) reasons.push(`Display ${dp.toFixed(0)}% (sub-ideal)`);
      else if (dp > 125) reasons.push(`Display ${dp.toFixed(0)}% (acima do ideal)`);
    }
    if (c.video_pacing != null && wVid > 0) {
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


// Variância amostral (n-1). Retorna 0 se < 2 elementos.
function variance(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((a, x) => a + (x - m) ** 2, 0) / (arr.length - 1);
}

// Empirical Bayes shrinkage parameter k = σ²_within / σ²_between, estimado
// dos dados via método dos momentos. Edge cases:
//   - 1 owner só: sem amostra pra estimar between → k = 0 (sem regressão)
//   - within = 0 (sem ruído): k = 0 (raw é confiável)
//   - between ≈ 0 (todos iguais): k grande, força regressão à média
// Cap em k=50 evita explodir em casos patológicos.
//
// Piso K_FLOOR=5: garante regressão mínima mesmo quando o estimator dá
// k baixo. Razão: com poucos owners (~6), o estimator é instável e
// frequentemente devolve k≈1–2, deixando CSs com 1–2 campanhas escaparem
// da regressão e dominarem o topo do ranking só por amostra pequena. O
// piso é estatística boa: incerteza maior em n pequeno justifica puxar
// pra média do time. Calibrado pra time de 5–10 owners; revisar se
// crescer muito.
const K_FLOOR = 5;

function computeEBParams(ownersData) {
  if (!ownersData || ownersData.length < 2) {
    const teamMean = ownersData?.[0]?.rawScore ?? 0;
    return { k: 0, teamMean };
  }
  const withinVars = ownersData
    .map((o) => variance(o.campaignScores))
    .filter((v) => v > 0);
  const sigma2 = withinVars.length
    ? withinVars.reduce((a, b) => a + b, 0) / withinVars.length
    : 0;
  const ownerMeans = ownersData.map((o) => o.rawScore);
  const tau2 = variance(ownerMeans);
  const teamMean = ownerMeans.reduce((a, b) => a + b, 0) / ownerMeans.length;

  let k;
  if (sigma2 <= 0) k = K_FLOOR;       // sem ruído entre campanhas, mas piso ainda aplica
  else if (tau2 <= 0.01) k = 50;      // CSs indistinguíveis — força regressão máxima
  else k = Math.max(K_FLOOR, Math.min(50, sigma2 / tau2));

  return { k, teamMean };
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

  const ownersData = []; // pra estimar params do shrinkage depois
  const out = [];
  for (const [email, list] of byOwner.entries()) {
    let scoreSum = 0;
    let weightSum = 0;
    let idealPacing = 0;
    const campaignScores = [];
    const campaignDetails = []; // {campaign, breakdown, weight, potential}

    // Acumuladores ponderados por categoria pro breakdown agregado do CS.
    let pacingPtsSum = 0, ecpmPtsSum = 0, ctrPtsSum = 0, vtrPtsSum = 0;
    let maxPacingSum = 0, maxEcpmSum = 0, maxCtrSum = 0, maxVtrSum = 0;

    for (const c of list) {
      const detailed = scoreCampaignDetailed(c);
      campaignScores.push(detailed.total);
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

    ownersData.push({ email, rawScore, campaignScores });
    out.push({
      email,
      raw_score: Math.round(rawScore * 10) / 10,
      score: 0, // preenchido depois com o score regredido
      campaign_count: list.length,
      ideal_pacing_count: idealPacing,
      ecpm_avg:     m.ecpm,
      ecpm_display: m.ecpm_display,
      ecpm_video:   m.ecpm_video,
      dsp_pacing:   m.dsp_pacing,
      vid_pacing:   m.vid_pacing,
      ctr:          m.ctr,
      vtr:          m.vtr,
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

  // Empirical Bayes: regride scores pra média do time, com força inversamente
  // proporcional ao volume de campanhas. CS com poucas campanhas converge
  // pra média; com muitas, raw domina.
  const { k, teamMean } = computeEBParams(ownersData);
  for (let i = 0; i < out.length; i++) {
    const o = out[i];
    const raw = ownersData[i].rawScore;
    const n = o.campaign_count;
    const smoothed = (n + k) > 0 ? (n * raw + k * teamMean) / (n + k) : raw;
    o.score = Math.round(smoothed * 10) / 10;
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
