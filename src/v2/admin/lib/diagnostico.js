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
};

// Ordem canônica pra exibição/tabs. Coloca o que exige ação primeiro.
export const STATUS_ORDER = [
  STATUS.SUPER_OVER,
  STATUS.OVER,
  STATUS.UNDER,
  STATUS.OK,
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
};

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
  const totalDays   = daysBetween(s, e) + 1;
  const elapsedDays = Math.max(0, Math.min(totalDays, daysBetween(s, today) + 1));
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
  const totalEntreguePct = (pacing != null && Number.isFinite(pacing))
    ? pacing * elapsedRatio
    : null;

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
    // status
    status: classifyStatus(pacing),
    pacing: pacing ?? null,
    // colunas da tabela
    totalEntreguePct,
    projetadaPct: pacing ?? null,
    deliveredD1: lastDayDelivered ?? null,    // backend novo (undefined até deploy)
    minDiariaContratada,
    mediaDiariaAtual,
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
      displayRows.push({ ...identity, ...displayMetrics, media: "display" });
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
      videoRows.push({ ...identity, ...videoMetrics, media: "video" });
    }
  }

  return { displayRows, videoRows };
}

// ────────────────────────────────────────────────────────────────────────
// Contagens por status (alimenta os pills de filtro)
// ────────────────────────────────────────────────────────────────────────
export function countByStatus(rows) {
  const counts = {
    [STATUS.SUPER_OVER]: 0,
    [STATUS.OVER]:       0,
    [STATUS.UNDER]:      0,
    [STATUS.OK]:         0,
  };
  for (const r of rows || []) {
    if (counts[r.status] != null) counts[r.status]++;
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
 * Compara dois valores pra ordenação. null/undefined sempre vão pro fim.
 */
export function compareNullableNumbers(a, b, dir = "desc") {
  if (a == null && b == null) return 0;
  if (a == null) return 1;       // a no fim
  if (b == null) return -1;      // b no fim
  return dir === "asc" ? a - b : b - a;
}
