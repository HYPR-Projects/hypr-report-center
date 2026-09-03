// src/v2/admin/lib/pmpFilters.js
//
// Filtros transversais do PMP Deals (busca + cliente + bid + status + fonte)
// como FUNÇÃO PURA, fora do componente.
//
// Por que existe: a regra vivia dentro de um closure no PmpDealsPage
// (`applyFilters`), então cada view decidia por conta própria se aplicava ou
// não — e a aba Analytics simplesmente não aplicava: recebia `lines` cru.
// Filtrar "Fonte · PubMatic" mudava a lista, os KPIs do topo e o Histórico,
// mas o Analytics continuava somando Xandr + PubMatic. Com a regra num módulo
// só, toda view (e os testes) leem o MESMO recorte.

/** Sentinela de "sem recorte" dos filtros de valor único (bid, fonte). */
export const FILTER_ALL = "__ALL__";

/** Fonte de curadoria da line. Backend antigo não carimbava `source` — line
 *  sem fonte é Xandr por definição (era a única quando o campo nasceu). */
export function lineSource(line) {
  return line?.source || "xandr";
}

/** Texto onde a busca livre procura: ids, nomes, e-mails e token. */
export function lineSearchHaystack(line) {
  // Com N checklists por line, TODOS os tokens (e as campanhas de cada um)
  // entram na busca — o operador procura pelo token da 2ª campanha e tem que
  // achar o deal que a carrega.
  const extraTokens = Array.isArray(line?.linked_tokens) && line.linked_tokens.length
    ? line.linked_tokens
    : (line?.extra_short_tokens || []);
  const linkedCampaigns = Array.isArray(line?.linked_checklists)
    ? line.linked_checklists.map((c) => c?.campaign_name)
    : [];
  return [
    line?.line_id, line?.line_name, line?.customer, line?.campaign_name,
    line?.agency, line?.short_token, ...extraTokens, ...linkedCampaigns,
    line?.io_name, line?.cp_email, line?.cs_email,
  ].filter(Boolean).join(" ").toLowerCase();
}

/**
 * Uma line passa nos filtros transversais?
 *
 * @param {object} line
 * @param {object} criteria
 * @param {string}   [criteria.search]     busca livre (case-insensitive)
 * @param {string[]} [criteria.customers]  multi-select; vazio = todos
 * @param {string[]} [criteria.statuses]   multi-select (status EFETIVO); vazio = todos
 * @param {string}   [criteria.bidType]    FILTER_ALL = todos
 * @param {string}   [criteria.source]     FILTER_ALL = todas as fontes
 * @param {(line:object)=>string} criteria.statusOf  resolvedor de status efetivo
 */
export function matchesPmpFilters(line, criteria = {}) {
  const {
    search = "", customers = [], statuses = [],
    bidType = FILTER_ALL, source = FILTER_ALL,
    statusOf,
  } = criteria;

  if (customers.length > 0 && !customers.includes(line?.customer)) return false;
  if (bidType !== FILTER_ALL && (line?.bid_type || "—") !== bidType) return false;
  if (source !== FILTER_ALL && lineSource(line) !== source) return false;
  if (statuses.length > 0) {
    const st = statusOf ? statusOf(line) : line?.status;
    if (!statuses.includes(st)) return false;
  }
  const term = String(search || "").trim().toLowerCase();
  if (term && !lineSearchHaystack(line).includes(term)) return false;
  return true;
}

/** `matchesPmpFilters` sobre uma lista. */
export function filterPmpLines(lines = [], criteria = {}) {
  return lines.filter((l) => matchesPmpFilters(l, criteria));
}
