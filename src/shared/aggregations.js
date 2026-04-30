/**
 * Funções puras de agregação consumidas pelos tabs do ClientDashboard.
 *
 * Por que existe
 * --------------
 * DisplayTab e VideoTab tinham as mesmas funções (`groupByDate`,
 * `groupBySize`, `groupByAudience`) duplicadas literalmente, com
 * diferenças apenas na métrica somada (clicks/CTR pra display,
 * video_view_100/VTR pra video). Centralizar elimina ~80 linhas
 * duplicadas e garante que ajustes futuros em "como agrega por
 * audiência" mudem nos dois tabs ao mesmo tempo.
 *
 * Tudo aqui é função pura: mesmo input → mesmo output, sem efeito
 * colateral. Pode ser testado isoladamente sem precisar de React.
 *
 * Nomes preservam os do código original (ctr, vtr, viewable_impressions,
 * video_view_100, etc.) pra os charts e tabelas continuarem funcionando
 * sem mudança.
 */

import { enrichDetailCosts } from "./enrichDetail";
import {
  inRange,
  daysInRange,
  daysBetween,
  formatRangeShort,
} from "./dateFilter";

/**
 * Extrai o segundo-último token de um line_name "_-separado".
 * Convenção HYPR: o segmento antes do final identifica a audiência.
 * Ex.: "campaign_O2O_Heineken_DISPLAY" → "Heineken"
 */
const extractAudience = (lineName) => {
  const parts = (lineName || "").split("_");
  return parts.length >= 2 ? parts[parts.length - 2] : "N/A";
};

/**
 * Agrega rows por data, somando duas métricas, e calcula uma taxa derivada.
 *
 * @param {Array} rows         Linhas com `date`, `numeratorKey`, `denomKey`.
 * @param {string} numeratorKey  Ex: "clicks" (display) ou "video_view_100" (video).
 *                               Pra video, faz fallback automático pra `completions`
 *                               quando `video_view_100` ausente — manteve compat com
 *                               código antigo.
 * @param {string} denomKey      Geralmente "viewable_impressions".
 * @param {string} rateKey       Nome da taxa derivada ("ctr" | "vtr").
 * @returns {Array} Objetos com `{date, [numeratorKey], [denomKey], [rateKey]}`,
 *                  ordenados ascendente por data.
 */
export const groupByDate = (rows, numeratorKey, denomKey, rateKey) => {
  const m = {};
  rows.forEach(r => {
    if (!r.date) return;
    if (!m[r.date]) m[r.date] = { date: r.date, [denomKey]: 0, [numeratorKey]: 0 };
    m[r.date][denomKey]      += Number(r[denomKey])      || 0;
    // Pra video, video_view_100 pode vir vazio em rows antigas — fallback pra completions
    const num = numeratorKey === "video_view_100"
      ? Number(r.video_view_100 || r.completions || 0)
      : Number(r[numeratorKey]) || 0;
    m[r.date][numeratorKey] += num;
  });
  return Object.values(m)
    .sort((a, b) => a.date > b.date ? 1 : -1)
    .map(r => ({
      ...r,
      [rateKey]: r[denomKey] > 0 ? r[numeratorKey] / r[denomKey] * 100 : 0,
    }));
};

/**
 * Agrega rows por `creative_size`, somando duas métricas, e calcula taxa.
 *
 * Observa: usa `r[k] || 0` (sem `Number()`) preservando o comportamento
 * exato do código original — viewable_impressions e clicks/views são
 * números no payload do backend, não strings.
 */
export const groupBySize = (rows, numeratorKey, denomKey, rateKey) =>
  Object.values(rows.reduce((acc, r) => {
    const k = r.creative_size || "N/A";
    if (!acc[k]) acc[k] = { size: k, [denomKey]: 0, [numeratorKey]: 0 };
    acc[k][denomKey]      += r[denomKey]      || 0;
    acc[k][numeratorKey]  += r[numeratorKey]  || 0;
    return acc;
  }, {})).map(r => ({
    ...r,
    [rateKey]: r[denomKey] > 0 ? r[numeratorKey] / r[denomKey] * 100 : 0,
  }));

/**
 * Agrega rows por audiência (extraída do line_name), ignorando lines de
 * survey e linhas sem padrão reconhecível ("N/A"). Sempre opera sobre o
 * conjunto total — não filtra por line, porque essa visão deve mostrar
 * todas as audiências independentemente do filtro do usuário.
 */
export const groupByAudience = (rows, numeratorKey, denomKey, rateKey) =>
  Object.values(rows.reduce((acc, r) => {
    const k = extractAudience(r.line_name);
    if (/survey/i.test(k) || k === "N/A") return acc;
    if (!acc[k]) acc[k] = { audience: k, [denomKey]: 0, [numeratorKey]: 0 };
    acc[k][denomKey]      += r[denomKey]      || 0;
    acc[k][numeratorKey]  += r[numeratorKey]  || 0;
    return acc;
  }, {})).map(r => ({
    ...r,
    [rateKey]: r[denomKey] > 0 ? r[numeratorKey] / r[denomKey] * 100 : 0,
  }));

/**
 * Lista de line_names únicos pra popular o MultiLineSelect, com "ALL"
 * no topo. Ordenação alfabética estável.
 */
export const buildLineOptions = (rows) =>
  ["ALL", ...[...new Set(rows.map(r => r.line_name).filter(Boolean))].sort()];

/**
 * Calcula KPIs do Display tab (CPM efetivo, pacing, rentabilidade, CPC,
 * CTR, etc.) a partir do conjunto filtrado pelo usuário e do total não
 * filtrado.
 *
 * Por que não usa o backend
 * -------------------------
 * O backend (`compute_metrics` em main.py) calcula sobre o total da
 * campanha — não conhece o filtro de line do usuário. Aqui precisamos
 * dos KPIs que **respeitam o filtro**, então recalculamos no front com
 * a mesma fórmula do backend (Math.min com cpmNeg pra travar overdelivery,
 * proporção de dias decorridos pra budgetProp, etc.).
 *
 * Decisão consciente: detail vs detailAll
 * - detail (filtrado): usado pra impressões/cliques/CTR exibidos
 * - detailAll (todo): usado pra CPM efetivo/pacing/rentab — pra o
 *   cliente não ver número rentab "absurdo" só porque filtrou um line
 *   pequeno. Coerente com o comportamento original.
 *
 * @param {object} input
 * @param {Array}  input.rows         totals filtrados por media=DISPLAY e tactic
 * @param {Array}  input.detail       detail0 filtrado por line do usuário
 * @param {Array}  input.detailAll    detail0 sem filtro de line (só por tactic)
 * @param {string} input.tactic       "O2O" | "OOH"
 * @param {object} input.camp         data.campaign (precisa de start_date/end_date)
 * @returns {object} KPIs computados — mantém os mesmos nomes que o código
 *                   antigo usava nas variáveis locais.
 */
export const computeDisplayKpis = ({ rows, detail, detailAll, tactic, camp }) => {
  const sumD    = k => detail.reduce((s, r) => s + (r[k] || 0), 0);
  const sumDAll = k => detailAll.reduce((s, r) => s + (r[k] || 0), 0);

  const cost = rows.reduce((s, r) => s + (r.effective_total_cost || 0), 0);
  const impr = sumD("impressions");
  const vi   = sumD("viewable_impressions");
  const clks = sumD("clicks");
  const ctr  = vi > 0 ? clks / vi * 100 : 0;

  const viAll  = sumDAll("viewable_impressions");
  const budget = rows.reduce((s, r) => s + (tactic === "O2O" ? (r.o2o_display_budget || 0) : (r.ooh_display_budget || 0)), 0);
  const cpmNeg = rows[0]?.deal_cpm_amount || 0;

  const [sy, sm, sd] = camp.start_date.split("-").map(Number);
  const [ey, em, ed] = camp.end_date.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end   = new Date(ey, em - 1, ed);
  const today = new Date();

  const contracted = tactic === "O2O" ? (rows[0]?.contracted_o2o_display_impressions || 0) : (rows[0]?.contracted_ooh_display_impressions || 0);
  const bonus      = tactic === "O2O" ? (rows[0]?.bonus_o2o_display_impressions || 0)      : (rows[0]?.bonus_ooh_display_impressions || 0);
  const totalNeg   = contracted + bonus;

  const tDays         = (end - start) / 864e5 + 1;
  const eDays         = today < start ? 0 : today > end ? tDays : Math.floor((today - start) / 864e5);
  const budgetProp    = today > end ? budget : budget / tDays * eDays;

  // CPM Efetivo trava no negociado pra não exibir CPM "negativo" em over.
  // Mesma lógica do backend (compute_metrics): se entregou MENOS que esperado,
  // CPM fica no negociado e rentab=0; se entregou MAIS, CPM cai e rentab>0.
  const cpmEf  = cpmNeg > 0 ? Math.min(viAll > 0 ? budgetProp / viAll * 1000 : 0, cpmNeg) : 0;
  const cpc    = clks > 0 ? cpmEf / 1000 * (viAll / clks) : 0;
  const rentab = cpmNeg > 0 ? (cpmNeg - cpmEf) / cpmNeg * 100 : 0;

  const expected = totalNeg * (eDays / tDays);
  const pac      = totalNeg > 0
    ? (today > end ? viAll / totalNeg * 100 : expected > 0 ? viAll / expected * 100 : 0)
    : 0;
  const pacBase  = Math.min(pac, 100);
  const pacOver  = Math.max(0, pac - 100);

  return {
    cost, impr, vi, clks, ctr,
    viAll, budget, cpmNeg, contracted, bonus,
    cpmEf, cpc, rentab,
    pac, pacBase, pacOver,
  };
};

/**
 * Calcula KPIs do Video tab. Diferente do Display, aqui pacing/CPCV
 * efetivo/rentabilidade vêm direto do `rows[0]` (backend já calculou
 * com fórmula de days_with_delivery por frente, mais precisa que dá
 * pra fazer no front).
 *
 * KPIs que respeitam o filtro de line continuam calculados no front
 * (vi, views100, starts, vtr).
 */
export const computeVideoKpis = ({ rows, detail, tactic }) => {
  const cost     = rows.reduce((s, r) => s + (r.effective_total_cost || 0), 0);
  const vi       = detail.reduce((s, r) => s + (r.viewable_impressions || 0), 0);
  const views100 = detail.reduce((s, r) => s + (r.video_view_100 || 0), 0);
  const starts   = detail.reduce((s, r) => s + (r.video_starts || 0), 0);
  const vtr      = vi > 0 ? views100 / vi * 100 : 0;

  const budget  = rows.reduce((s, r) => s + (tactic === "O2O" ? (r.o2o_video_budget || 0) : (r.ooh_video_budget || 0)), 0);
  const cpcvNeg = rows[0]?.deal_cpcv_amount    || 0;
  const cpcvEf  = rows[0]?.effective_cpcv_amount || 0;
  const rentab  = rows[0]?.rentabilidade       || 0;
  const pac     = rows[0]?.pacing              || 0;
  const pacBase = Math.min(pac, 100);
  const pacOver = Math.max(0, pac - 100);

  return {
    cost, vi, views100, starts, vtr,
    budget, cpcvNeg, cpcvEf, rentab,
    pac, pacBase, pacOver,
  };
};

/**
 * ─────────────────────────────────────────────────────────────────────
 * computeMediaPacing — pacing canônico da Visão Geral
 * ─────────────────────────────────────────────────────────────────────
 *
 * Definição (alinhada com o que a HYPR reporta pro cliente):
 *   "Baseado na média diária de entrega até agora, qual % do contrato
 *    a campanha vai entregar até o final?"
 *
 * Equivale matematicamente a:
 *     pacing = delivered / (negotiated × elapsed_calendar / total_days) × 100
 *
 * Após o end_date a fórmula naturalmente convergiria pra delivered/neg
 * (porque elapsed = total), mas pra evitar divisões esquisitas com
 * elapsed > total quando today já passou de end, capamos elapsed em
 * total. Resultado idêntico ao "short-circuit" do legacy, sem o salto
 * não-monotônico que disparava no LAST day.
 *
 * Bug latente corrigido (PRINCIPAL):
 *   `contracted_*` e `bonus_*` são DENORMALIZADOS no backend — todas as
 *   linhas de uma mesma campanha carregam os mesmos valores (cada row
 *   tem o2o E ooh contratado da campanha inteira, não só o do tactic
 *   daquela linha). O legacy `computeDisplayPacing` somava esses campos
 *   across rows e DOBRAVA o contrato em campanhas com 2 tactics
 *   (O2O+OOH), fazendo o pacing aparecer como METADE do real.
 *   Ex.: Diageo Johnnie Walker mostrava 12.8% quando o pacing real era
 *   ~28%. Pegamos de `rows[0]` apenas (mesma estratégia que
 *   `computeDisplayKpis` já usa).
 *
 * @param {Array} rows         totals filtrados por media_type
 * @param {object} camp        data.campaign (start_date, end_date)
 * @param {"DISPLAY"|"VIDEO"} mediaType
 * @returns {number} pacing em % (ex.: 87.4 = 87.4%)
 */
export function computeMediaPacing(rows, camp, mediaType) {
  if (!rows?.length || !camp?.start_date || !camp?.end_date) return 0;

  const r0 = rows[0];
  const isVideo = mediaType === "VIDEO";

  const totalNeg = isVideo
    ? (r0.contracted_o2o_video_completions || 0)
      + (r0.contracted_ooh_video_completions || 0)
      + (r0.bonus_o2o_video_completions      || 0)
      + (r0.bonus_ooh_video_completions      || 0)
    : (r0.contracted_o2o_display_impressions || 0)
      + (r0.contracted_ooh_display_impressions || 0)
      + (r0.bonus_o2o_display_impressions      || 0)
      + (r0.bonus_ooh_display_impressions      || 0);
  if (!totalNeg) return 0;

  const delivered = isVideo
    ? rows.reduce((s, r) => s + (r.viewable_video_view_100_complete || r.completions || 0), 0)
    : rows.reduce((s, r) => s + (r.viewable_impressions || 0), 0);

  const [sy, sm, sd] = camp.start_date.split("-").map(Number);
  const [ey, em, ed] = camp.end_date.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end   = new Date(ey, em - 1, ed);
  const now   = new Date();

  // total_days inclui ambos os limites (start E end), por isso o +1.
  // elapsed é capado em total — após o end_date, expected = negotiated
  // e pacing = delivered/negotiated naturalmente.
  const total   = (end - start) / 864e5 + 1;
  const rawElapsed = now < start ? 0 : Math.floor((now - start) / 864e5);
  const elapsed = Math.min(rawElapsed, total);
  const expected = totalNeg * (elapsed / total);
  return expected > 0 ? (delivered / expected) * 100 : 0;
}


/**
 * ─────────────────────────────────────────────────────────────────────
 * computeAggregates — agregação master consumida pelo ClientDashboard
 *                     Legacy e pelo ClientDashboardV2.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Função pura — recebe (data, mainRange) e retorna o objeto agregado.
 * Sem side-effects, sem dependência de React.
 *
 * Histórico
 * ---------
 * Esta lógica vivia inline dentro de pages/ClientDashboard.jsx (~150
 * linhas dentro de um useMemo). Foi extraída na PR-06 (Fase 2) para que
 * o V2 (src/v2/dashboards/ClientDashboardV2.jsx) possa consumir o MESMO
 * cálculo, sem duplicação. Bug fix futuro acontece num lugar só.
 *
 * O comportamento é idêntico ao código original — extração foi puro
 * recortar e colar com `data` e `mainRange` como parâmetros explícitos
 * em vez de variáveis fechadas pelo escopo do componente.
 *
 * Contrato
 * --------
 * Input:
 *   - data: payload completo da campanha (saída de getCampaign).
 *           Precisa de data.campaign, data.totals, data.daily, data.detail.
 *   - mainRange: { from: Date, to: Date } | null. Quando null → sem filtro.
 *
 * Output: objeto aggregates com:
 *   - totals, daily0, detail0, detail
 *   - chartDisplay, chartVideo (séries diárias enriquecidas com CTR/VTR)
 *   - display, video (totals filtrados por media_type, enriquecidos com
 *     CTR, VCR, pacing, rentabilidade, custo_efetivo)
 *   - totalImpressions, totalCusto, totalCustoOver
 *   - isFiltered, range, rangeLabel, filterDays, campaignDays
 *   - budgetTotal, budgetProRata
 *   - availableDates (datas com entrega real, pro DateRangeFilter)
 *
 * Retorna null se data não estiver pronto (preserva guard original).
 *
 * Regra de custo (importante)
 * ---------------------------
 * O backend retorna `effective_total_cost` com SUM em query_totals
 * (correto, soma real), mas com MAX em query_daily e query_detail porque
 * a coluna é cumulativa na tabela base. Somar os valores diários/detail
 * no front infla o custo (somaria cumulativos).
 *
 * Solução: pra qualquer recálculo de custo filtrado, aplicar PROPORÇÃO
 * sobre o custo total de totalsRaw (que é correto) baseado em delivery
 * do detail filtrado — exatamente o que enrichDetailCosts já faz.
 */
export function computeAggregates(data, mainRange) {
  if (!data || !data.campaign) return null;

  const noSurvey = (r) => !/survey/i.test(r.line_name || "");
  const totalsRaw = (data.totals || []).filter(noSurvey);
  const dailyRaw  = (data.daily  || []).filter(noSurvey);
  const detailRaw = (data.detail || []).filter(noSurvey);

  const isFiltered = !!mainRange;
  const daily0  = isFiltered ? dailyRaw.filter(r => inRange(r.date, mainRange))   : dailyRaw;
  const detail0 = isFiltered ? detailRaw.filter(r => inRange(r.date, mainRange))  : detailRaw;

  // Quando filtrado, reconstroi `totals` agregando delivery do `detail0`
  // (campos SUM no backend — somar é correto) e aplicando proporção sobre
  // o custo total de `totalsRaw` (que vem com SUM correto do backend).
  let totals = totalsRaw;
  if (isFiltered) {
    // 1) Soma delivery do detail filtrado por (media_type, tactic_type)
    const byKey = {};
    detail0.forEach(r => {
      const k = `${r.media_type}|${r.tactic_type}`;
      if (!byKey[k]) {
        byKey[k] = {
          media_type: r.media_type,
          tactic_type: r.tactic_type,
          impressions: 0,
          viewable_impressions: 0,
          clicks: 0,
          video_view_100: 0,
          video_view_25: 0, video_view_50: 0, video_view_75: 0,
          video_starts: 0,
          completions: 0,
          line_name: "TOTAL",
        };
      }
      const g = byKey[k];
      g.impressions          += r.impressions          || 0;
      g.viewable_impressions += r.viewable_impressions || 0;
      g.clicks               += r.clicks               || 0;
      g.video_view_100       += r.video_view_100       || 0;
      g.video_view_25        += r.video_view_25        || 0;
      g.video_view_50        += r.video_view_50        || 0;
      g.video_view_75        += r.video_view_75        || 0;
      g.video_starts         += r.video_starts         || 0;
      g.completions          += r.video_view_100       || 0;
    });

    // 2) Pra cada (media_type, tactic_type), aplica proporção sobre o
    //    custo total CORRETO de totalsRaw. Display usa viewable_impressions
    //    como denominador, Video usa completions (consistente com CPM/CPCV).
    totals = totalsRaw.map(orig => {
      const k = `${orig.media_type}|${orig.tactic_type}`;
      const g = byKey[k] || {
        media_type: orig.media_type,
        tactic_type: orig.tactic_type,
        impressions: 0, viewable_impressions: 0, clicks: 0,
        video_view_100: 0, video_view_25: 0, video_view_50: 0, video_view_75: 0,
        video_starts: 0, completions: 0,
        line_name: "TOTAL",
      };
      const isVideo = orig.media_type === "VIDEO";
      const denom_filtered = isVideo ? (g.completions || 0)            : (g.viewable_impressions || 0);
      const denom_total    = isVideo ? (orig.completions || 0)         : (orig.viewable_impressions || 0);
      const proportion     = denom_total > 0 ? denom_filtered / denom_total : 0;

      const cost_filtered      = (orig.effective_total_cost      || 0) * proportion;
      const cost_over_filtered = (orig.effective_cost_with_over  || 0) * proportion;

      // CPM/CPCV efetivo derivado dos novos valores
      const eff_cpm  = g.viewable_impressions > 0 ? (cost_filtered / g.viewable_impressions) * 1000 : 0;
      const eff_cpcv = g.completions          > 0 ? (cost_filtered / g.completions)                : 0;

      return {
        ...g,
        deal_cpm_amount:           orig.deal_cpm_amount  || 0,
        deal_cpcv_amount:          orig.deal_cpcv_amount || 0,
        effective_total_cost:      Math.round(cost_filtered      * 100) / 100,
        effective_cost_with_over:  Math.round(cost_over_filtered * 100) / 100,
        effective_cpm_amount:      Math.round(eff_cpm  * 100) / 100,
        effective_cpcv_amount:     Math.round(eff_cpcv * 100) / 100,
        // Preserva campos de contratação (usados em pacing display)
        contracted_o2o_display_impressions: orig.contracted_o2o_display_impressions,
        contracted_ooh_display_impressions: orig.contracted_ooh_display_impressions,
        contracted_o2o_video_completions:   orig.contracted_o2o_video_completions,
        contracted_ooh_video_completions:   orig.contracted_ooh_video_completions,
        bonus_o2o_display_impressions:      orig.bonus_o2o_display_impressions,
        bonus_ooh_display_impressions:      orig.bonus_ooh_display_impressions,
        bonus_o2o_video_completions:        orig.bonus_o2o_video_completions,
        bonus_ooh_video_completions:        orig.bonus_ooh_video_completions,
        // pacing não faz sentido em janela parcial — null pra UI esconder
        pacing: null,
      };
    });
  }

  const daily  = daily0;
  const detail = enrichDetailCosts(detail0, totals);

  // ─── Agregação por data pros charts diários ────────────────────────────
  // O backend (`query_daily`) agrupa por (date, media_type, tactic_type),
  // então um mesmo (date, media_type) pode ter até 2 linhas (uma O2O, uma
  // OOH). Pros charts da Visão Geral, queremos UMA barra por data —
  // somando tactics. Sem essa agregação, o chart mostra barras duplicadas
  // no mesmo dia (e a tooltip do recharts se confunde com x-values
  // duplicados, parecendo "travada").
  //
  // O DisplayV2/VideoV2 (tabs específicas) usam `groupByDate` aplicado em
  // detail (não daily), então não tinham esse bug.
  const aggregateDailyByDate = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!r.date) continue;
      const e = m.get(r.date) || {
        date: r.date,
        media_type: r.media_type,
        impressions: 0,
        viewable_impressions: 0,
        clicks: 0,
        video_starts: 0,
        video_view_100: 0,
      };
      e.impressions          += Number(r.impressions          || 0);
      e.viewable_impressions += Number(r.viewable_impressions || 0);
      e.clicks               += Number(r.clicks               || 0);
      e.video_starts         += Number(r.video_starts         || 0);
      e.video_view_100       += Number(r.video_view_100 || r.completions || r.viewable_video_view_100_complete || 0);
      m.set(r.date, e);
    }
    return Array.from(m.values()).sort((a, b) => a.date.localeCompare(b.date));
  };

  const chartDisplay = aggregateDailyByDate(daily.filter(r => r.media_type === "DISPLAY"))
    .map(r => ({
      ...r,
      ctr: r.viewable_impressions > 0 ? (r.clicks / r.viewable_impressions) * 100 : 0,
    }));
  const chartVideo = aggregateDailyByDate(daily.filter(r => r.media_type === "VIDEO"))
    .map(r => ({
      ...r,
      completions: r.video_view_100,
      vtr: r.viewable_impressions > 0 ? (r.video_view_100 / r.viewable_impressions) * 100 : 0,
    }));

  const enrich = (rows) => rows.map(r=>({
    ...r,
    ctr: r.impressions>0?(r.clicks/r.impressions)*100:null,
    vcr: r.impressions>0?((r.viewable_video_view_100_complete||r.video_view_100||0)/r.impressions)*100:null,
    // Usar pacing do backend diretamente — já calculado com datas reais por frente.
    // Quando filtrado, pacing fica null (escondido na UI).
    pacing: r.pacing ?? null,
    rentabilidade: r.deal_cpm_amount>0?((r.deal_cpm_amount-(r.effective_cpm_amount||0))/r.deal_cpm_amount)*100
      :r.deal_cpcv_amount>0?((r.deal_cpcv_amount-(r.effective_cpcv_amount||0))/r.deal_cpcv_amount)*100:null,
    custo_efetivo: r.effective_total_cost,
    custo_efetivo_over: r.effective_cost_with_over,
    completions: r.viewable_video_view_100_complete ?? r.completions ?? r.video_view_100,
  }));

  const display = enrich(totals.filter(t=>t.media_type==="DISPLAY"));
  const video   = enrich(totals.filter(t=>t.media_type==="VIDEO"));

  const totalImpressions=totals.reduce((s,t)=>s+(t.viewable_impressions||0),0);
  const totalCusto=totals.reduce((s,t)=>s+(t.effective_total_cost||0),0);
  const totalCustoOver=totals.reduce((s,t)=>s+(t.effective_cost_with_over||0),0);

  // Budget proporcional ao período filtrado: budget_total * (dias_filtro / dias_campanha).
  // Aproximação linear — assume distribuição uniforme. É o mesmo cálculo
  // usado no pacing.
  const camp = data.campaign;
  const budgetTotal = camp?.budget_contracted || 0;
  const campaignDays = daysBetween(camp?.start_date, camp?.end_date) || 1;
  const filterDays = isFiltered ? daysInRange(mainRange) : campaignDays;
  const budgetProRata = isFiltered
    ? Math.round(budgetTotal * (filterDays / campaignDays) * 100) / 100
    : budgetTotal;

  // Datas com entrega real (extraídas do daily bruto, antes do filtro).
  // Usado pro DateRangeFilter desabilitar dias sem dado.
  const availableDates = Array.from(
    new Set(dailyRaw.map(r => r.date).filter(Boolean))
  ).sort();

  return {
    totals, daily0, detail0, detail,
    chartDisplay, chartVideo,
    display, video,
    totalImpressions, totalCusto, totalCustoOver,
    isFiltered,
    range: mainRange,
    rangeLabel: isFiltered ? formatRangeShort(mainRange) : null,
    filterDays,
    campaignDays,
    budgetTotal,
    budgetProRata,
    availableDates,
  };
}
