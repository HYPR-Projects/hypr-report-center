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
