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

import { enrichDetailCosts, distributeLargestRemainder } from "./enrichDetail";
import {
  inRange,
  daysInRange,
  daysBetween,
  formatRangeShort,
  parseYmd,
  ymd,
} from "./dateFilter";

/**
 * `range` engloba inteiramente a janela [startStr, endStr]?
 *
 * Compara como string YYYY-MM-DD (lexicográfico equivale a cronológico
 * nesse formato). Usado pra detectar "filtro cobre 100% do membro/campanha"
 * — nesse caso o cálculo proporcional é descartado e o totals fechado é
 * usado direto, evitando divergência entre fontes (totals lê de
 * unified_daily_performance_metrics, detail lê de campaign_results, e o
 * delta entre essas tabelas vazava no resultado proporcional mesmo quando
 * a janela cobria o período inteiro).
 */
function rangeCoversWindow(range, startStr, endStr) {
  if (!range || !startStr || !endStr) return false;
  const fromYmd = ymd(range.from);
  const toYmd   = ymd(range.to);
  return fromYmd <= startStr && toYmd >= endStr;
}

/**
 * Extrai o segundo-último token de um line_name "_-separado".
 * Convenção HYPR: o segmento antes do final identifica a audiência.
 * Ex.: "campaign_O2O_Heineken_DISPLAY" → "Heineken"
 *
 * Exportada porque componentes que enriquecem rows por audiência
 * (ex.: FormatBreakdownTableV2 quando agrupa por audience) precisam
 * resolver a chave do mesmo jeito que `groupByAudience` faz aqui.
 */
export const extractAudience = (lineName) => {
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
 * Deriva o identificador da "linha criativa" a partir de `creative_name`,
 * removendo o token de `creative_size` da própria row. A intenção é que
 * variantes do mesmo criativo em formatos diferentes (ex: BLACK-320X50,
 * BLACK-300X600) colapsem em uma única linha criativa ("BLACK"), em vez
 * de espelhar a quebra "Por Formato". Usa lookarounds de dígito pra
 * evitar match dentro de números maiores (ex: "300x250" dentro de
 * "1300x250"). Se size não estiver presente no nome, devolve o nome cru
 * — comportamento idêntico ao agrupamento original, sem regressão.
 */
export const getCreativeLineKey = (row) => {
  const name = row.creative_name || "N/A";
  const size = row.creative_size;
  if (!size || name === "N/A") return name;
  const escaped = String(size).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<!\\d)${escaped}(?!\\d)`, "gi");
  const cleaned = name
    .replace(re, "")
    .replace(/[-_| ]{2,}/g, "_")
    .replace(/^[-_| ]+|[-_| ]+$/g, "");
  return cleaned || name;
};

/**
 * Agrega rows pela "linha criativa" (creative_name menos o creative_size
 * da própria row — ver `getCreativeLineKey`). Mesma forma de `groupBySize`
 * — soma numerador/denominador e calcula a taxa final. Usado na tabela
 * "Distribuição por Linha Criativa" das abas Display/Video.
 */
export const groupByCreativeName = (rows, numeratorKey, denomKey, rateKey) =>
  Object.values(rows.reduce((acc, r) => {
    const k = getCreativeLineKey(r);
    if (!acc[k]) acc[k] = { creative_name: k, [denomKey]: 0, [numeratorKey]: 0 };
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
 * computeMediaPacing — pacing por mídia da Visão Geral
 * ─────────────────────────────────────────────────────────────────────
 *
 * Definição (alinhada com o que a HYPR reporta pro cliente):
 *   "Baseado na média diária de entrega até agora, qual % do contrato
 *    a campanha vai entregar até o final?"
 *
 * Escopo: SOMENTE Visão Geral. As abas Display e Video continuam usando
 * cálculo per-frente (computeDisplayKpis / computeVideoKpis), que olha
 * cada tática (O2O/OOH) separadamente com sua própria janela de entrega.
 *
 * Fórmula (calendar-elapsed, runway = campanha inteira):
 *     expected = neg_total × elapsed_camp / total_camp
 *     pacing   = delivered_total / expected × 100
 *
 *   onde:
 *     neg_total      = Σ (contracted_<tactic>_<media> + bonus_<tactic>_<media>)
 *                      somando O2O+OOH (campos denormalizados — pega de rows[0])
 *     delivered_total = Σ entregue de cada row (O2O+OOH)
 *     elapsed_camp   = Math.floor((today - camp.start_date) / 1d), capado em total_camp
 *     total_camp     = (end - start) + 1
 *
 * Por que runway da campanha (e não actual_start por frente)?
 *   Quando uma frente atrasa (ex: Display começa 6 dias depois do start
 *   contratual), usar actual_start comprime o runway pela metade e
 *   superinflada o pacing — Display aparecia 313% quando o esperado
 *   linear era 150%. Na Visão Geral o cliente quer ler "estamos no
 *   ritmo do contrato?" — e a régua é a campanha como um todo.
 *
 * @param {Array} rows         totals filtrados por media_type
 * @param {object} camp        data.campaign (precisa de start_date e end_date)
 * @param {"DISPLAY"|"VIDEO"} mediaType
 * @param {"ALL"|"O2O"|"OOH"} tactic  Quando "O2O"/"OOH", restringe NEG e
 *   ENTREGUE só a essa frente. Crítico quando rows já foi filtrado por
 *   tactic — sem esse arg, neg seguiria usando contratado O2O+OOH (campos
 *   denormalizados em rows[0]) e pacing seria entregue_X / contrato_total,
 *   matematicamente errado.
 * @returns {number} pacing em % (ex.: 87.4 = 87.4%)
 */
export function computeMediaPacing(rows, camp, mediaType, tactic = "ALL") {
  if (!rows?.length || !camp?.start_date || !camp?.end_date) return 0;

  const isVideo = mediaType === "VIDEO";
  const [sy, sm, sd] = camp.start_date.split("-").map(Number);
  const [ey, em, ed] = camp.end_date.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end   = new Date(ey, em - 1, ed);
  const now   = new Date();

  const tDays = (end - start) / 864e5 + 1;
  const eDays = now < start ? 0 : now > end ? tDays : Math.floor((now - start) / 864e5);
  if (tDays <= 0 || eDays <= 0) return 0;

  // Negociado (contratado + bônus). Campos *_<tactic>_<media>_<unit> são
  // denormalizados — todas as rows carregam o mesmo valor da campanha,
  // basta ler de rows[0]. Quando tactic="ALL", soma O2O+OOH; quando é
  // "O2O" ou "OOH", lê só aquela frente — assim o numerador (delivered
  // já restrito pelo filtro do caller) bate com o denominador.
  const r0 = rows[0] || {};
  const includeO2O = tactic === "ALL" || tactic === "O2O";
  const includeOOH = tactic === "ALL" || tactic === "OOH";
  const negO2O = isVideo
    ? (r0.contracted_o2o_video_completions   || 0) + (r0.bonus_o2o_video_completions   || 0)
    : (r0.contracted_o2o_display_impressions || 0) + (r0.bonus_o2o_display_impressions || 0);
  const negOOH = isVideo
    ? (r0.contracted_ooh_video_completions   || 0) + (r0.bonus_ooh_video_completions   || 0)
    : (r0.contracted_ooh_display_impressions || 0) + (r0.bonus_ooh_display_impressions || 0);
  const negTotal = (includeO2O ? negO2O : 0) + (includeOOH ? negOOH : 0);

  const totalDelivered = rows.reduce((s, r) => s + (isVideo
    ? (r.viewable_video_view_100_complete || r.completions || 0)
    : (r.viewable_impressions || 0)), 0);

  const expected = negTotal * (eDays / tDays);
  return expected > 0 ? (totalDelivered / expected) * 100 : 0;
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
export function computeAggregates(data, mainRange, mainTactic = "ALL") {
  if (!data || !data.campaign) return null;

  const noSurvey = (r) => !/survey/i.test(r.line_name || "");
  // mainTactic = "O2O" | "OOH" | "ALL". Filtro do "core product" da Visão
  // Geral. Aplicado na entrada (totals/daily/detail) pra que toda a árvore
  // de cálculo abaixo (proporção por membro, charts, sumários) trabalhe
  // sobre o subset coerente. Sem branch novo no resto do código.
  const tacticOk = (r) => mainTactic === "ALL" || r.tactic_type === mainTactic;
  const totalsRaw = (data.totals || []).filter(noSurvey).filter(tacticOk);
  const dailyRaw  = (data.daily  || []).filter(noSurvey).filter(tacticOk);
  const detailRaw = (data.detail || []).filter(noSurvey).filter(tacticOk);

  const isFiltered = !!mainRange;
  const daily0  = isFiltered ? dailyRaw.filter(r => inRange(r.date, mainRange))   : dailyRaw;
  const detail0 = isFiltered ? detailRaw.filter(r => inRange(r.date, mainRange))  : detailRaw;

  // Visão agregada (merged) com filtro: a fórmula proporcional padrão
  // assumiria CPM uniforme entre os membros do grupo, o que faz o custo
  // efetivo agregado em janela curta divergir do drill-down do mesmo
  // membro com o mesmo filtro. Aqui calculamos cost por-membro (cada um
  // proporciona contra seu próprio totals) e somamos. Sem merge_meta ou
  // sem filtro, segue o caminho single-token original.
  const isMergedAgg = isFiltered
    && Array.isArray(data.merge_meta?.members)
    && data.merge_meta.members.length > 1
    && data.merge_meta.members.every(m => Array.isArray(m.totals));

  let totals = totalsRaw;
  if (isFiltered) {
    totals = isMergedAgg
      ? recomputeTotalsByMember(data.merge_meta.members, detail0, totalsRaw, mainRange)
      : recomputeTotalsProportional(detail0, totalsRaw, data.campaign, mainRange);
  }

  // ─── Alinhamento contratual dos totals ─────────────────────────────
  // Campanha encerrada com todas frentes >= 100% → Σ custo efetivo deve
  // ser exatamente o budget contratado (regra do contrato: cliente paga
  // o budget integral quando entrega ≥ 100%). Sem isso, Σ dos 4
  // budgets-por-frente (cada um = contracted × cpm_neg / 1000, derivação
  // com casas decimais) abre ±2 centavos contra `budget_contracted`.
  //
  // Aplicamos largest-remainder pra realocar os centavos entre as 4
  // frentes preservando proporção — assim KPI agregado, parciais
  // Display/Video, detalhamento diário e Google Sheets ficam todos
  // consistentes ao centavo. Guard de 1 real evita mascarar mismatch
  // real de checklist vs campaign_results.
  //
  // Skip quando filtrado: budget proporcional muda e a regra "entrega ≥
  // 100% = paga tudo" não se aplica ao recorte.
  const _camp = data.campaign;
  const _budgetTotal = _camp?.budget_contracted || 0;
  const _today = new Date();
  const _isCampaignEnded = _camp?.end_date ? new Date(_camp.end_date) < _today : false;
  const _allOverDelivered = totals.length > 0 && totals.every(t => (t.pacing || 0) >= 100);
  const _sumCost = totals.reduce((s, t) => s + (t.effective_total_cost || 0), 0);
  if (!isFiltered
      && _isCampaignEnded
      && _allOverDelivered
      && _budgetTotal > 0
      && Math.abs(_sumCost - _budgetTotal) < 1
      && _sumCost > 0) {
    // (a) Alinha effective_total_cost por linha → Σ == budget_contracted
    const weights = totals.map(t => t.effective_total_cost || 0);
    const alignedCost = distributeLargestRemainder(weights, _budgetTotal);

    // (b) Alinha os 4 budgets-por-frente (denormalizados em cada linha).
    // Sem isso, `pickBudget()` continua somando valores derivados de
    // contracted×cpm (Display 99.999,99 + Video 100.000,08 = 200.000,07).
    // Após alinhamento: Display + Video = budget_contracted exato, e o
    // Budget de cada barra de pacing parcial bate com o Investido alinhado.
    const _t0 = totals[0] || {};
    const _budgetWeights = [
      _t0.o2o_display_budget || 0,
      _t0.ooh_display_budget || 0,
      _t0.o2o_video_budget   || 0,
      _t0.ooh_video_budget   || 0,
    ];
    const _budgetSum = _budgetWeights.reduce((s, w) => s + w, 0);
    let alignedBudgets = _budgetWeights;
    if (_budgetSum > 0 && Math.abs(_budgetSum - _budgetTotal) < 1) {
      alignedBudgets = distributeLargestRemainder(_budgetWeights, _budgetTotal);
    }
    const [_o2oD, _oohD, _o2oV, _oohV] = alignedBudgets;

    // total_invested por linha == budget da frente daquela linha
    const _investedByKey = {
      "DISPLAY|O2O": _o2oD,
      "DISPLAY|OOH": _oohD,
      "VIDEO|O2O":   _o2oV,
      "VIDEO|OOH":   _oohV,
    };

    totals = totals.map((t, i) => ({
      ...t,
      effective_total_cost: alignedCost[i],
      o2o_display_budget:   _o2oD,
      ooh_display_budget:   _oohD,
      o2o_video_budget:     _o2oV,
      ooh_video_budget:     _oohV,
      total_invested:       _investedByKey[`${t.media_type}|${t.tactic_type}`] ?? (t.total_invested || 0),
    }));
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
  // `totals.effective_total_cost` já passou pelo alinhamento contratual
  // acima quando aplicável, então Σ aqui == budget_contracted exato em
  // campanhas encerradas com over. Demais casos: Σ raw dos totals.
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

// ─── Recompose totals quando filtrado ──────────────────────────────────
//
// Duas estratégias separadas, escolhidas em computeAggregates:
//
//   1. recomputeTotalsProportional — caminho single-token (e drill-down
//      de membro). Aplica proporção sobre o totals do próprio token.
//      Comportamento idêntico ao código original.
//
//   2. recomputeTotalsByMember — caminho merged agregado. Aplica a
//      proporção POR MEMBRO contra o totals individual de cada um, soma
//      tudo. Necessário porque somar custos entre membros antes de
//      proporcionar derruba o CPM real de cada um (vide bug onde
//      "Visão agregada · Este mês" mostrava custo diferente de
//      "Mai 26 · Este mês" para o mesmo range de datas).

function emptyDeliveryRow(media_type, tactic_type) {
  return {
    media_type,
    tactic_type,
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

function sumDeliveryFromDetail(detailRows) {
  const byKey = {};
  detailRows.forEach(r => {
    const k = `${r.media_type}|${r.tactic_type}`;
    if (!byKey[k]) byKey[k] = emptyDeliveryRow(r.media_type, r.tactic_type);
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
  return byKey;
}

// Preserva os campos do totals "original" (negociado, contratado, bonus,
// budget) — esses são metadados da campanha, não dependem do filtro.
// Sem isso, qualquer consumer que precise desses campos nos totals
// recomputados (ex: pickBudget no OverviewV2) recebe undefined.
function carryOverContractFields(orig) {
  return {
    deal_cpm_amount:                    orig.deal_cpm_amount  || 0,
    deal_cpcv_amount:                   orig.deal_cpcv_amount || 0,
    contracted_o2o_display_impressions: orig.contracted_o2o_display_impressions,
    contracted_ooh_display_impressions: orig.contracted_ooh_display_impressions,
    contracted_o2o_video_completions:   orig.contracted_o2o_video_completions,
    contracted_ooh_video_completions:   orig.contracted_ooh_video_completions,
    bonus_o2o_display_impressions:      orig.bonus_o2o_display_impressions,
    bonus_ooh_display_impressions:      orig.bonus_ooh_display_impressions,
    bonus_o2o_video_completions:        orig.bonus_o2o_video_completions,
    bonus_ooh_video_completions:        orig.bonus_ooh_video_completions,
    o2o_display_budget:                 orig.o2o_display_budget,
    ooh_display_budget:                 orig.ooh_display_budget,
    o2o_video_budget:                   orig.o2o_video_budget,
    ooh_video_budget:                   orig.ooh_video_budget,
  };
}

function recomputeTotalsProportional(detail0, totalsRaw, camp, mainRange) {
  // Filtro cobre 100% da campanha → totals raw direto, sem proporção.
  // O número fica idêntico ao "Todo o período" (que pula esse caminho via
  // mainRange=null), e elimina divergência decorrente de detail/totals
  // virem de tabelas diferentes no backend.
  if (camp && rangeCoversWindow(mainRange, camp.start_date, camp.end_date)) {
    return totalsRaw.map(orig => ({ ...orig, pacing: null }));
  }
  const byKey = sumDeliveryFromDetail(detail0);
  return totalsRaw.map(orig => {
    const k = `${orig.media_type}|${orig.tactic_type}`;
    const g = byKey[k] || emptyDeliveryRow(orig.media_type, orig.tactic_type);
    const isVideo = orig.media_type === "VIDEO";
    const denom_filtered = isVideo ? (g.completions       || 0) : (g.viewable_impressions    || 0);
    const denom_total    = isVideo ? (orig.completions    || 0) : (orig.viewable_impressions || 0);
    const proportion     = denom_total > 0 ? denom_filtered / denom_total : 0;

    const cost_filtered      = (orig.effective_total_cost     || 0) * proportion;
    const cost_over_filtered = (orig.effective_cost_with_over || 0) * proportion;

    const eff_cpm  = g.viewable_impressions > 0 ? (cost_filtered / g.viewable_impressions) * 1000 : 0;
    const eff_cpcv = g.completions          > 0 ? (cost_filtered / g.completions)                : 0;

    return {
      ...g,
      ...carryOverContractFields(orig),
      effective_total_cost:     Math.round(cost_filtered      * 100) / 100,
      effective_cost_with_over: Math.round(cost_over_filtered * 100) / 100,
      effective_cpm_amount:     Math.round(eff_cpm  * 100) / 100,
      effective_cpcv_amount:    Math.round(eff_cpcv * 100) / 100,
      pacing: null,
    };
  });
}

// Custo agregado em janela parcial = Σ (custo proporcional do membro M
// contra o detail de M dentro do range). Cada membro carrega o seu CPM
// real — o agregado deixa de ser "CPM médio × imp filtradas" e passa a
// ser soma honesta dos custos por membro.
//
// As contas dependem de:
//   • members[i].totals: totals single-token de cada membro (vem do backend
//     em merge_meta.members[i].totals — não somado, não compose).
//   • Janela de cada membro: [start_date, end_date] em members[i].
//     PIs sequenciais não sobrepõem (garantia do backend), então cada row
//     do detail filtrado pertence a no máximo 1 membro.
//
// Campos contratados/bonus ficam vindo do `totalsRaw` (que é a soma entre
// membros) — eles não dependem do filtro de tempo, são da campanha como
// um todo.
function recomputeTotalsByMember(members, detail0, totalsRaw, mainRange) {
  const noSurvey = (r) => !/survey/i.test(r.line_name || "");

  // Pré-classifica cada membro:
  //   • fullCoverage: filtro engloba toda a janela do membro → contribui
  //     com totals direto (sem proporção); funil de vídeo (25/50/75/starts)
  //     vem do detail porque totals não tem.
  //   • parcial:      janela do filtro intersecta com a do membro mas não
  //     a engloba → proporção via detail filtrado (lógica original).
  //   • fora:         filtro não toca o membro → contribui zero.
  const memberContext = members.map((m) => {
    const memberRange = (m.start_date && m.end_date)
      ? { from: parseYmd(m.start_date), to: parseYmd(m.end_date) }
      : null;
    const fullCoverage = !!memberRange
      && rangeCoversWindow(mainRange, m.start_date, m.end_date);
    const memberRows = memberRange
      ? detail0.filter(r => inRange(r.date, memberRange) && inRange(r.date, mainRange))
      : [];
    return {
      member: m,
      fullCoverage,
      memberDelivery: sumDeliveryFromDetail(memberRows),
    };
  });

  return totalsRaw.map(orig => {
    const isVideo = orig.media_type === "VIDEO";
    const k = `${orig.media_type}|${orig.tactic_type}`;
    let cost_filtered      = 0;
    let cost_over_filtered = 0;
    const counts = emptyDeliveryRow(orig.media_type, orig.tactic_type);

    memberContext.forEach(({ member, fullCoverage, memberDelivery }) => {
      const memberTotals = (member.totals || []).filter(noSurvey);
      const mt = memberTotals.find(t =>
        t.media_type === orig.media_type && t.tactic_type === orig.tactic_type
      );
      if (!mt) return;

      const g = memberDelivery[k];

      if (fullCoverage) {
        // Fonte canônica: totals do membro (cravado, igual "Todo o período"
        // do drill-down). Imune à divergência detail vs totals.
        cost_filtered      += (mt.effective_total_cost     || 0);
        cost_over_filtered += (mt.effective_cost_with_over || 0);
        counts.impressions          += (mt.impressions          || 0);
        counts.viewable_impressions += (mt.viewable_impressions || 0);
        counts.clicks               += (mt.clicks               || 0);
        counts.completions          += (mt.completions          || 0);
        counts.video_view_100       += (mt.video_view_100 || mt.completions || 0);
        if (g) {
          counts.video_view_25 += g.video_view_25 || 0;
          counts.video_view_50 += g.video_view_50 || 0;
          counts.video_view_75 += g.video_view_75 || 0;
          counts.video_starts  += g.video_starts  || 0;
        }
        return;
      }

      // Janela parcial: proporção via detail.
      if (!g) return;
      const denom_filtered = isVideo ? (g.completions    || 0) : (g.viewable_impressions  || 0);
      const denom_total    = isVideo ? (mt.completions   || 0) : (mt.viewable_impressions || 0);
      if (denom_total <= 0) return;

      const proportion = denom_filtered / denom_total;
      cost_filtered      += (mt.effective_total_cost     || 0) * proportion;
      cost_over_filtered += (mt.effective_cost_with_over || 0) * proportion;

      counts.impressions          += g.impressions;
      counts.viewable_impressions += g.viewable_impressions;
      counts.clicks               += g.clicks;
      counts.video_view_100       += g.video_view_100;
      counts.video_view_25        += g.video_view_25;
      counts.video_view_50        += g.video_view_50;
      counts.video_view_75        += g.video_view_75;
      counts.video_starts         += g.video_starts;
      counts.completions          += g.completions;
    });

    const eff_cpm  = counts.viewable_impressions > 0 ? (cost_filtered / counts.viewable_impressions) * 1000 : 0;
    const eff_cpcv = counts.completions          > 0 ? (cost_filtered / counts.completions)                : 0;

    return {
      ...counts,
      ...carryOverContractFields(orig),
      effective_total_cost:     Math.round(cost_filtered      * 100) / 100,
      effective_cost_with_over: Math.round(cost_over_filtered * 100) / 100,
      effective_cpm_amount:     Math.round(eff_cpm  * 100) / 100,
      effective_cpcv_amount:    Math.round(eff_cpcv * 100) / 100,
      pacing: null,
    };
  });
}

