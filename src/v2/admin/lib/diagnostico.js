// src/v2/admin/lib/diagnostico.js
//
// Lógica pura de diagnóstico de pacing — usada pela aba "Diagnóstico" do
// CampaignMenuV2. Recebe uma campanha crua do payload de listCampaigns e
// devolve as métricas derivadas + classificação de status.
//
// Status (4 bandas, baseadas na projeção = display_pacing/video_pacing,
// que o backend já calcula como "delivered / expected_to_date × 100" —
// matematicamente equivale a "% que vai bater no fim mantendo o ritmo"):
//
//   • Verificar Under    → projeção <  100%   (ritmo atual não bate o contrato)
//   • Ok                 → projeção entre 100% e 125%  (até 25% over)
//   • Over               → projeção entre 125% e 150%  (25–50% over)
//   • Possível Super Over → projeção >  150%   (>50% over)
//
// NOTA sobre Viewable D-1:
//   "D-1" = soma das viewable_impressions (Display) ou views 100%
//   (Video) do dia anterior em BRT (America/Sao_Paulo). Vem do backend
//   nos campos `display_yesterday_viewable` / `video_yesterday_completions`
//   (CTE `yesterday_delivery` no main.py).
//
//   Quando o campo vier undefined (rollup das 6h BRT ainda não rodou OU
//   a campanha não entregou ontem), a coluna renderiza "—".

const TODAY = () => new Date();

// ────────────────────────────────────────────────────────────────────────
// Status enum + metadados visuais
// ────────────────────────────────────────────────────────────────────────
export const STATUS = {
  UNDER:      "under",
  OK:         "ok",
  OVER:       "over",
  SUPER_OVER: "super_over",
  // Status de Tech Cost — ORTOGONAIS aos status de pacing. Uma campanha
  // pode ser Super Over (pacing) E Tech High (financeiro) ao mesmo tempo.
  // O filtro pill faz OR: selecionar "Super Over" + "Tech Alto" mostra
  // a união dos dois sets.
  TECH_HIGH:    "tech_high",     // atual > tier.warning (10% sem ABS / 12% com)
  TECH_AT_RISK: "tech_at_risk",  // atual em zona amarela OU projetando estourar
};

// Ordem canônica pra exibição/tabs. Pacing primeiro (operacional), depois
// tech cost (financeiro).
export const STATUS_ORDER = [
  STATUS.SUPER_OVER,
  STATUS.OVER,
  STATUS.UNDER,
  STATUS.OK,
  STATUS.TECH_HIGH,
  STATUS.TECH_AT_RISK,
];

export const STATUS_META = {
  [STATUS.SUPER_OVER]: {
    label:     "Possível Super Over",
    shortLabel: "Super Over",
    description: "Projeção acima de 150% — risco alto de super entrega",
    // Tokens do tema HYPR (theme.css). signature = azul HYPR.
    tone:      "signature",
    textClass: "text-signature",
    bgClass:   "bg-signature-soft",
    borderClass: "border-signature/40",
    dotClass:  "bg-signature",
  },
  [STATUS.OVER]: {
    label:     "Over",
    shortLabel: "Over",
    description: "Projeção entre 125% e 150% — over delivery moderado",
    tone:      "warning",
    textClass: "text-warning",
    bgClass:   "bg-warning/12",
    borderClass: "border-warning/40",
    dotClass:  "bg-warning",
  },
  [STATUS.UNDER]: {
    label:     "Verificar Under",
    shortLabel: "Under",
    description: "Ritmo diário atual não supre o volume contratado",
    tone:      "danger",
    textClass: "text-danger",
    bgClass:   "bg-danger/8",
    borderClass: "border-danger/40",
    dotClass:  "bg-danger",
  },
  [STATUS.OK]: {
    label:     "Ok",
    shortLabel: "Ok",
    description: "Projeção entre 100% e 125% — saudável",
    tone:      "success",
    textClass: "text-success",
    bgClass:   "bg-success/8",
    borderClass: "border-success/40",
    dotClass:  "bg-success",
  },
  [STATUS.TECH_HIGH]: {
    label:     "Tech Cost Alto",
    shortLabel: "Tech Alto",
    description: "Custo real DSP acima do tier vs PI cliente — margem em risco direto",
    tone:      "danger",
    textClass: "text-danger",
    bgClass:   "bg-danger/8",
    borderClass: "border-danger/40",
    dotClass:  "bg-danger",
  },
  [STATUS.TECH_AT_RISK]: {
    label:     "Possível Tech Alto",
    shortLabel: "Pos. Tech",
    description: "Tech cost em zona amarela ou projetando estourar o tier no fim",
    tone:      "warning",
    textClass: "text-warning",
    bgClass:   "bg-warning/12",
    borderClass: "border-warning/40",
    dotClass:  "bg-warning",
  },
};

// ────────────────────────────────────────────────────────────────────────
// Classificação Tech Cost (ortogonal ao pacing — pode coexistir)
// ────────────────────────────────────────────────────────────────────────
/**
 * Classifica o tech cost de uma mídia em:
 *   • TECH_HIGH:    atual já passou o tier warning (vermelho)
 *   • TECH_AT_RISK: atual em zona amarela OU projetado passa o warning
 *   • null:         dentro do tier saudável
 *
 * `projectedPct` opcional — se fornecido, o "AT_RISK" cobre também
 * campanhas saudáveis hoje mas projetando estourar. Critério mesma régua
 * do techCostToneClass.
 */
const TECH_COST_TIERS_CLASSIFY = {
  noAbs: { healthy: 8,  warning: 10 },
  abs:   { healthy: 10, warning: 12 },
};

export function classifyTechCostStatus(pct, hasAbs, projectedPct = null) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const tiers = hasAbs ? TECH_COST_TIERS_CLASSIFY.abs : TECH_COST_TIERS_CLASSIFY.noAbs;
  if (pct > tiers.warning) return STATUS.TECH_HIGH;
  if (pct > tiers.healthy) return STATUS.TECH_AT_RISK;
  if (projectedPct != null && projectedPct > tiers.warning) return STATUS.TECH_AT_RISK;
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Classificação a partir do pacing (= projeção %)
// ────────────────────────────────────────────────────────────────────────
/**
 * Classifica um valor de pacing em um dos 4 status.
 * Retorna null se input inválido (sem mídia, valor ausente).
 *
 * Thresholds (alinhados com a régua operacional definida):
 *   < 100      → under
 *   100–124.99 → ok
 *   125–149.99 → over
 *   ≥ 150      → super_over
 */
export function classifyStatus(pacing) {
  if (pacing == null || !Number.isFinite(pacing)) return null;
  if (pacing < 100) return STATUS.UNDER;
  if (pacing < 125) return STATUS.OK;
  if (pacing < 150) return STATUS.OVER;
  return STATUS.SUPER_OVER;
}

// ────────────────────────────────────────────────────────────────────────
// Date helpers (alinhados com format.js — UTC midnight comparison)
// ────────────────────────────────────────────────────────────────────────
function parseDateUTC(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}

function todayUTC() {
  const now = TODAY();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function daysBetween(fromUTC, toUTC) {
  return Math.floor((toUTC.getTime() - fromUTC.getTime()) / 86400000);
}

// Multiplier calendar-constante pra projeção: total_days / elapsed_days.
// Aplica ao tech_cost_pct atual pra estimar o tech cost ao final mantendo
// ritmo atual. Null se datas inválidas ou campanha acabando hoje.
function dayProjMultiplier(startISO, endISO) {
  const s = parseDateUTC(startISO);
  const e = parseDateUTC(endISO);
  if (!s || !e) return null;
  const t = todayUTC();
  const totalDays = daysBetween(s, e) + 1;
  const elapsedDays = Math.max(1, Math.min(totalDays, daysBetween(s, t) + 1));
  if (totalDays <= 0) return null;
  return totalDays / elapsedDays;
}

// ────────────────────────────────────────────────────────────────────────
// Cálculo das métricas derivadas
// ────────────────────────────────────────────────────────────────────────
/**
 * Dado um pacing % (= projeção) e a janela calendar da campanha, retorna:
 *   - totalEntregue: % do contrato TOTAL entregue até hoje
 *   - projetada: o próprio pacing (% que vai bater no fim mantendo ritmo)
 *   - minDiariaContratada: ritmo diário necessário pra bater 100% até o fim
 *   - mediaDiariaAtual: ritmo médio real (delivered / dias_elapsed)
 *
 * Matematicamente:
 *   pacing = delivered / expected_to_date
 *          = delivered / (negotiated × elapsed/total)
 *          = (delivered/elapsed) / (negotiated/total)
 *          = ritmoAtual / ritmoNecessario
 *
 *   totalEntregue% = delivered / negotiated × 100
 *                  = pacing × (elapsed/total)
 *
 *   negotiated = delivered / (pacing/100) × (total/elapsed)
 *              = expected_to_date × (total/elapsed)
 *
 * Tudo derivado SEM precisar do `negotiated` cru — pacing + datas + delivered
 * já permitem reconstruir todos os números operacionais.
 */
export function deriveMediaMetrics({
  pacing,            // display_pacing OU video_pacing
  delivered,         // display_viewable_impressions OU video_viewable_completions
  expectedToDate,    // display_expected_impressions OU video_expected_completions
  startDate,         // start_date ISO
  endDate,           // end_date ISO (NÃO usar early_end_date — pacing é vs contrato original)
  impressions,       // display_impressions OU video_impressions (denom. da viewability)
  lastDayDelivered,  // display_last_day_viewable OU video_last_day_completions (opcional, futuro)
}) {
  // Sem mídia? retorna sentinel "vazio".
  if (pacing == null && !delivered && !expectedToDate) return null;

  const s = parseDateUTC(startDate);
  const e = parseDateUTC(endDate);
  if (!s || !e) return null;

  const today = todayUTC();
  // Janela calendar — EXATAMENTE igual ao backend (main.py linha 5141-5148
  // `pacing_expected_to_date`) e ao frontend canônico (shared/aggregations.js
  // linha 342-343 `computeMediaPacing`):
  //
  //   total_days   = (end - start) + 1            ← inclui o end_date
  //   elapsed_days = (today - start)              ← SEM +1 (não inclui hoje)
  //
  // Esse alinhamento é crítico — se elapsedRatio aqui diferir do que o
  // backend usou pra calcular `expected_to_date`, a reconstrução do
  // negotiated (= expected/elapsedRatio) fica errada, e por consequência
  // o % entregue (= delivered/negotiated) também. Bug visível: dava
  // 154% aqui vs 139% no report cliente.
  const totalDays   = daysBetween(s, e) + 1;
  const elapsedDaysRaw = daysBetween(s, today);
  const elapsedDays = today > e ? totalDays : Math.max(0, elapsedDaysRaw);
  if (totalDays <= 0 || elapsedDays <= 0) return null;

  const elapsedRatio = elapsedDays / totalDays;

  // Contrato total — reconstruído a partir do expected_to_date (que é
  // pro-rata calendar). Fallback: usa pacing/delivered se expected ausente.
  let negotiated = null;
  if (expectedToDate && expectedToDate > 0) {
    negotiated = expectedToDate / elapsedRatio;
  } else if (pacing && delivered && pacing > 0) {
    // pacing = delivered / expected → expected = delivered / (pacing/100)
    // negotiated = expected / elapsedRatio
    const expected = delivered / (pacing / 100);
    negotiated = expected / elapsedRatio;
  }

  // % do contrato total entregue até agora.
  //
  // IMPORTANTE: calculamos como `delivered / negotiated × 100` direto, NÃO
  // como `pacing × elapsedRatio` (atalho matemático que assumia equivalência
  // — só vale se elapsedRatio do frontend == ratio implícito no pacing do
  // backend). Na prática, eles divergem quando há campanhas com dias sem
  // delivery, pausas, ou início atrasado, porque o backend calcula
  // `expected_to_date` baseado em dias com entrega real, não dias de
  // calendário. Resultado: o valor exibido aqui passa a bater exatamente
  // com a divisão "viewable acumulado / impressions contratadas" que o
  // operador faz na mão olhando o report da campanha.
  const totalEntreguePct = (negotiated != null && negotiated > 0 && delivered != null && delivered >= 0)
    ? (delivered / negotiated) * 100
    : null;

  // ── Projeção D-1 ────────────────────────────────────────────────────────
  // "Se o ritmo de ontem (D-1) se mantiver até o fim, quanto vai entregar?"
  //
  // Fórmula:
  //   projeção_total = delivered_acumulado + (entrega_D1 × dias_restantes)
  //   % projetada    = projeção_total / negotiated × 100
  //
  // dias_restantes inclui HOJE (porque a campanha ainda pode entregar hoje).
  //
  // Fallback: quando D-1 vier null/zero (rollup ainda não rodou ou campanha
  // não entregou ontem), cai pro pacing histórico do backend. Decisão
  // operacional: "se não tenho dado fresco, melhor mostrar a média histórica
  // do que esconder informação". O fallback é transparente — usuário vê o
  // número que esperava ver, sem indicação visual que foi fallback (sinal
  // de "sem D-1" já aparece na coluna "Viewable Imps. D-1" mostrando "—"
  // na mesma linha).
  //
  // Sem cap: deixa passar de 999% intencionalmente. Quando D-1 é muito alto
  // (spike), o número grande É o sinal operacional importante — capar
  // mascararia exatamente o que o CS precisa ver.
  const daysRemainingProj = Math.max(0, totalDays - elapsedDays);
  let projetadaPct = null;
  if (lastDayDelivered != null && lastDayDelivered > 0
      && negotiated != null && negotiated > 0
      && delivered != null) {
    // Caminho feliz: projetar pelo ritmo de ontem
    const projecaoTotal = delivered + (lastDayDelivered * daysRemainingProj);
    projetadaPct = (projecaoTotal / negotiated) * 100;
  } else if (pacing != null && Number.isFinite(pacing)) {
    // Fallback: pacing histórico do backend (mesmo número que aparecia antes
    // do D-1 ser implementado). Usado quando lastDayDelivered ausente/zero.
    projetadaPct = pacing;
  }

  // ── Mínima diária RESTANTE ──────────────────────────────────────────────
  // "Quanto ainda preciso entregar por dia daqui pra frente pra fechar 100%."
  //
  // Lógica:
  //   • Já bateu 100% (delivered >= negotiated)        → null → renderiza "—"
  //     (não precisa de mínima, já entregou tudo que precisava)
  //   • Sem dias restantes (campanha já acabou hoje)   → null → renderiza "—"
  //     (não dá pra entregar mais, end_date é hoje ou já passou)
  //   • Caso normal: (negotiated - delivered) / dias_restantes
  //     onde dias_restantes inclui hoje (campanha ainda pode entregar hoje)
  //
  // Por que NÃO usar `negotiated / totalDays` (lógica antiga):
  //   Aquilo era a "mínima estática" do plano original — útil só no dia 1.
  //   Conforme a campanha evolui (over, under), o ritmo necessário pra fechar
  //   muda. Mostrar a mínima ESTÁTICA pra campanha 170% entregue confunde
  //   ("preciso entregar 12.801/dia?" — não, você já tem 70% de gordura).
  const daysRemaining = Math.max(0, totalDays - elapsedDays + 1);
  let minDiariaContratada = null;
  if (negotiated != null && negotiated > 0 && delivered != null) {
    const remaining = negotiated - delivered;
    if (remaining > 0 && daysRemaining > 0) {
      minDiariaContratada = remaining / daysRemaining;
    }
    // Quando remaining <= 0 (já bateu 100%) ou daysRemaining = 0 (acabou),
    // deixa null pra UI mostrar "—". Operacionalmente: "não precisa mais
    // se preocupar com mínima diária".
  }

  // Ritmo médio realizado (delivered / dias decorridos).
  const mediaDiariaAtual = delivered && delivered > 0 && elapsedDays > 0
    ? delivered / elapsedDays
    : null;

  // Ritmo médio IDEAL pra bater 100% — plano original "linear", do
  // primeiro ao último dia. Diferente de minDiariaContratada que é o ritmo
  // RESTANTE (ajustado pelo que já entregou); aqui é o baseline pra
  // comparar com mediaDiariaAtual e ver "tô em cima ou abaixo do plano?".
  const idealDiaria = negotiated != null && negotiated > 0 && totalDays > 0
    ? negotiated / totalDays
    : null;

  // Viewability = viewable / impressions × 100.
  // delivered já é viewable (campo `*_viewable_impressions` no payload),
  // então: viewability = delivered / impressions × 100.
  //
  // Cap em 100% como defesa em profundidade. Matematicamente impossível
  // ter viewable > impressions (viewable é subconjunto), mas se o backend
  // tiver descasamento de fonte residual (numerador e denominador vindo
  // de tabelas/janelas ligeiramente diferentes), preferimos exibir 100%
  // a um número absurdo tipo 104% que dá impressão de bug visível.
  let viewability = impressions && impressions > 0 && delivered > 0
    ? (delivered / impressions) * 100
    : null;
  if (viewability != null && viewability > 100) viewability = 100;

  return {
    // status — classifica baseado na PROJEÇÃO D-1 (que reflete o ritmo
    // recente com fallback pro pacing histórico). Mantém consistência
    // entre Status e a coluna Projetada: se Projetada diz 333%, Status
    // diz "Super Over" — não uma classificação baseada num pacing
    // histórico que pode estar desatualizado.
    status: classifyStatus(projetadaPct),
    pacing: pacing ?? null,                   // pacing histórico (cru) — não usado na UI, fica pra debug
    // colunas da tabela
    totalEntreguePct,
    projetadaPct,                             // projeção D-1 (com fallback) — exibida na UI
    deliveredD1: lastDayDelivered ?? null,    // entrega de ontem (BRT) — vai pro XLSX
    minDiariaContratada,                      // mínima RESTANTE — vai pro XLSX
    mediaDiariaAtual,                         // média real (entregue/elapsed) — coluna UI
    idealDiaria,                              // ritmo ideal linear (negotiated/total) — coluna UI
    viewability,
    // brutos pra debugging/tooltip
    negotiated,
    delivered: delivered ?? null,
    totalDays,
    elapsedDays,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Status agregado da campanha (pior entre Display e Video)
// ────────────────────────────────────────────────────────────────────────
/**
 * Quando uma campanha tem Display E Video, queremos o status "pior" pra
 * que ela apareça nos filtros de problema (Super Over / Over / Under)
 * independente de em qual mídia tá o problema.
 *
 * Ordem de prioridade (do mais alarmante pro mais saudável):
 *   super_over > over > under > ok
 */
const STATUS_RANK = {
  [STATUS.SUPER_OVER]: 3,
  [STATUS.OVER]:       2,
  [STATUS.UNDER]:      1,
  [STATUS.OK]:         0,
};

export function worstStatus(...statuses) {
  let worst = null;
  for (const s of statuses) {
    if (!s) continue;
    if (worst == null || STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

// ────────────────────────────────────────────────────────────────────────
// Filtro principal: monta linhas de Display + Video pras tabelas
// ────────────────────────────────────────────────────────────────────────
/**
 * Recebe a lista crua de campanhas (do payload de listCampaigns) e devolve
 * dois arrays: { displayRows, videoRows }. Cada row contém:
 *   - identidade: short_token, client_name, campaign_name, cs_email/cp_email
 *   - métricas: todas vindas de deriveMediaMetrics()
 *
 * Filtra APENAS campanhas ativas (status === "in_flight"). Campanhas
 * paused/awaiting_closure/ended NÃO entram no diagnóstico — diagnóstico é
 * sobre operação corrente.
 *
 * Uma campanha só vai pra `displayRows` se tiver dado Display (pacing OU
 * delivered OU expected). Análogo pra Video. Campanha mista vai pras 2
 * tabelas em linhas separadas.
 */
export function buildDiagnosticoRows(campaigns, getCampaignStatusFn) {
  const displayRows = [];
  const videoRows   = [];

  for (const c of campaigns || []) {
    // Só campanhas in_flight. getCampaignStatusFn vem de format.js do caller
    // pra reusar a mesma lógica do resto do menu (closed_at, paused_at, etc).
    const campStatus = getCampaignStatusFn(
      c.end_date, c.closed_at, c.paused_at, c.early_end_date
    );
    if (campStatus !== "in_flight") continue;

    const identity = {
      short_token:   c.short_token,
      client_name:   c.client_name,
      campaign_name: c.campaign_name,
      cs_email:      c.cs_email,
      cp_email:      c.cp_email,
      start_date:    c.start_date,
      end_date:      c.end_date,
      merge_id:      c.merge_id,
    };

    // ── Display ──────────────────────────────────────────────────────
    // Viewability: usa `d_admin_impressions` (CTE unified do backend) como
    // denominador — MESMA FONTE do display_viewable_impressions. Usar
    // display_impressions (vem do CTE agg/dedup) causa descasamento entre
    // numerador e denominador (fontes diferentes no BQ), gerando
    // viewability > 100% que é matematicamente impossível.
    const displayMetrics = deriveMediaMetrics({
      pacing:           c.display_pacing,
      delivered:        c.display_viewable_impressions,
      expectedToDate:   c.display_expected_impressions,
      startDate:        c.start_date,
      endDate:          c.end_date,
      impressions:      c.d_admin_impressions,
      lastDayDelivered: c.display_yesterday_viewable,
    });
    if (displayMetrics && displayMetrics.status) {
      const displayFin = computeFinancials(c, "display");
      const multiplier = dayProjMultiplier(c.start_date, c.end_date);
      const displayProjTech = displayFin.techCostPct != null && multiplier
        ? displayFin.techCostPct * multiplier
        : null;
      displayRows.push({
        ...identity,
        ...displayMetrics,
        ...displayFin,
        has_abs: !!c.display_has_abs,
        media: "display",
        // Brutos pro CSV — totais, não viewable. delivered (viewable) já vai
        // separado via spread de displayMetrics.
        totalImpressions: c.display_impressions ?? null,
        clicks:           c.display_clicks      ?? null,
        tech_status: classifyTechCostStatus(displayFin.techCostPct, !!c.display_has_abs, displayProjTech),
      });
    }

    // ── Video ────────────────────────────────────────────────────────
    // Mesmo princípio: usa `v_admin_impressions` (CTE unified) como denom
    // de viewability ao invés de video_impressions (CTE agg/dedup).
    const videoMetrics = deriveMediaMetrics({
      pacing:           c.video_pacing,
      delivered:        c.video_viewable_completions,
      expectedToDate:   c.video_expected_completions,
      startDate:        c.start_date,
      endDate:          c.end_date,
      impressions:      c.v_admin_impressions,
      lastDayDelivered: c.video_yesterday_completions,
    });
    if (videoMetrics && videoMetrics.status) {
      const videoFin = computeFinancials(c, "video");
      const multiplier = dayProjMultiplier(c.start_date, c.end_date);
      const videoProjTech = videoFin.techCostPct != null && multiplier
        ? videoFin.techCostPct * multiplier
        : null;
      videoRows.push({
        ...identity,
        ...videoMetrics,
        ...videoFin,
        has_abs: !!c.video_has_abs,
        media: "video",
        // Brutos pro CSV. Video não tem "starts" no payload da list (só
        // aparece em report detail), então exporto impressões totais +
        // viewable + completions 100% (delivered já é v_viewable_comp).
        totalImpressions:    c.video_impressions            ?? null,
        viewableImpressions: c.video_viewable_impressions   ?? null,
        clicks:              c.video_clicks                 ?? null,
        tech_status: classifyTechCostStatus(videoFin.techCostPct, !!c.video_has_abs, videoProjTech),
      });
    }
  }

  return { displayRows, videoRows };
}

// ────────────────────────────────────────────────────────────────────────
// Financials por mídia (admin-only) — eCPM real, impressões totais, custo
// real e Tech Cost (% do PI cliente consumido em custo real HYPR).
// ────────────────────────────────────────────────────────────────────────
//
// Tech Cost
// ─────────
//   numerador   = custo real DSP HYPR (d_admin_total_cost / v_admin_total_cost)
//   denominador = valor PI cliente daquela mídia (d_client_budget / v_client_budget,
//                 calculado server-side como `contracted × CPM/CPCV` SEM bônus)
//
// Campanhas 100% bonificadas, single-media, ou sem CPM/CPCV preenchido na
// checklist saem do backend sem `*_client_budget` → Tech Cost = null → UI "—".
function computeFinancials(campaign, media) {
  const isDisplay = media === "display";

  const realEcpm      = isDisplay ? (campaign.display_ecpm       ?? null) : (campaign.video_ecpm        ?? null);
  const realTotalCost = isDisplay ? (campaign.d_admin_total_cost ?? null) : (campaign.v_admin_total_cost ?? null);
  const clientBudget  = isDisplay ? (campaign.d_client_budget    ?? null) : (campaign.v_client_budget    ?? null);

  const techCostPct = (realTotalCost != null && clientBudget != null && clientBudget > 0)
    ? (realTotalCost / clientBudget) * 100
    : null;

  return { realEcpm, realTotalCost, techCostPct };
}

// ────────────────────────────────────────────────────────────────────────
// Contagens por status (alimenta os pills de filtro)
// ────────────────────────────────────────────────────────────────────────
export function countByStatus(rows) {
  const counts = {
    [STATUS.SUPER_OVER]:   0,
    [STATUS.OVER]:         0,
    [STATUS.UNDER]:        0,
    [STATUS.OK]:           0,
    [STATUS.TECH_HIGH]:    0,
    [STATUS.TECH_AT_RISK]: 0,
  };
  for (const r of rows || []) {
    if (counts[r.status] != null) counts[r.status]++;
    // Tech status é ortogonal — uma row pode contribuir pra status pacing
    // E status tech ao mesmo tempo (campanha super_over + tech alto).
    if (r.tech_status && counts[r.tech_status] != null) counts[r.tech_status]++;
  }
  return counts;
}

// ────────────────────────────────────────────────────────────────────────
// Formatadores específicos da tabela
// ────────────────────────────────────────────────────────────────────────
export function formatPctRow(value, decimals = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(decimals)}%`;
}

export function formatIntRow(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  // toLocaleString com pt-BR usa ponto como separador de milhar.
  return Math.round(value).toLocaleString("pt-BR");
}

/**
 * Formata BRL. Default 2 casas (R$ 1.234,56); pra eCPM passa 2 e mantém
 * "R$ 0,85" estilo do MetricStrip. Null/NaN → "—".
 */
export function formatBrlRow(value, decimals = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// ────────────────────────────────────────────────────────────────────────
// Tech Cost — formatação condicional
// ────────────────────────────────────────────────────────────────────────
//
// Sem ABS: ≤ 8% verde · 8–10% amarelo · > 10% vermelho
// Com ABS: ≤ 10% verde · 10–12% amarelo · > 12% vermelho
//
// Inventário com ABS (pre-bid DV/IAS) é estruturalmente mais caro, então
// o "saudável" tolera ~2 pp a mais antes de virar alerta. Mesma lógica que
// já se aplica no eCPM (displayAbs tem tier mais permissivo que display).
const TECH_COST_TIERS = {
  noAbs: { healthy: 8,  warning: 10 },
  abs:   { healthy: 10, warning: 12 },
};

export function techCostToneClass(pct, hasAbs) {
  if (pct == null || !Number.isFinite(pct)) return "";
  const tiers = hasAbs ? TECH_COST_TIERS.abs : TECH_COST_TIERS.noAbs;
  if (pct <= tiers.healthy) return "text-success";
  if (pct <= tiers.warning) return "text-warning";
  return "text-danger";
}

// ────────────────────────────────────────────────────────────────────────
// Média Diária — tom baseado em proximidade ao Ideal
// ────────────────────────────────────────────────────────────────────────
//
// Régua de proximidade SIMÉTRICA — pinta vermelho tanto pra over delivery
// (média muito acima do ideal) quanto pra under delivery (muito abaixo).
// Quanto mais perto do ideal, mais saudável.
//
//   |delta| ≤ 15%  → verde   (bem próximo, dentro da margem de operação)
//   |delta| ≤ 30%  → amarelo (atenção — ritmo desviando do plano)
//   |delta| >  30% → vermelho (descolado — super over OU under)
//
// Espelha em escala mais sensível a régua do Status Pacing (que usa 25%/50%
// como thresholds de "ok/over/super over") — a coluna de ritmo é um sinal
// mais rápido que a projeção acumulada e aceita menos margem.
const MEDIA_DIARIA_TIERS = { healthy: 15, warning: 30 };

export function mediaDiariaToneClass(media, ideal) {
  if (media == null || ideal == null || !ideal) return "";
  if (!Number.isFinite(media) || !Number.isFinite(ideal)) return "";
  const deltaPct = Math.abs((media - ideal) / ideal) * 100;
  if (deltaPct <= MEDIA_DIARIA_TIERS.healthy) return "text-success";
  if (deltaPct <= MEDIA_DIARIA_TIERS.warning) return "text-warning";
  return "text-danger";
}

/**
 * Compara dois valores pra ordenação. null/undefined sempre vão pro fim.
 */
export function compareNullableNumbers(a, b, dir = "desc") {
  if (a == null && b == null) return 0;
  if (a == null) return 1;       // a no fim
  if (b == null) return -1;      // b no fim
  return dir === "asc" ? a - b : b - a;
}
