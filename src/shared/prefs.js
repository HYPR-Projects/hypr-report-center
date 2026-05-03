/**
 * UI preferences helpers (localStorage).
 *
 * Persistem preferências visuais do usuário entre sessões. Diferente do
 * auth, não têm TTL — o usuário escolheu, fica salvo até trocar.
 *
 * Nota: a preferência de tema vive em `src/v2/hooks/useTheme.js` (key
 * `hypr_theme`, lida também pelo script anti-FOUC em index.html).
 */

const LS_OWNER_FILTER_KEY = "hypr.ownerFilter";
const LS_SORT_BY_PREFIX   = "hypr.sortBy.";
const LS_SORT_DIR_PREFIX  = "hypr.sortDir.";

/**
 * Retorna a lista de emails de owners selecionados, ou [] se nenhum
 * filtro estiver ativo. Persistido como CSV pra simplicidade — array
 * vazio é representado como ausência da chave (não "").
 *
 * Compat backwards: filtro era single-select string ("a@hypr.mobi").
 * O parse atual aceita: split(",") da string. Como não há vírgula em
 * email, a leitura do formato antigo retorna [emailAntigo] sem mudança.
 */
export function getOwnerFilter() {
  try {
    const raw = localStorage.getItem(LS_OWNER_FILTER_KEY);
    if (!raw) return [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Persiste a lista de owners. Array vazio remove a chave (filtro inativo).
 */
export function setOwnerFilter(emails) {
  try {
    if (Array.isArray(emails) && emails.length > 0) {
      localStorage.setItem(LS_OWNER_FILTER_KEY, emails.join(","));
    } else {
      localStorage.removeItem(LS_OWNER_FILTER_KEY);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Sort por escopo — campanhas e clientes têm conjuntos distintos de opções,
 * então persistimos separados ("hypr.sortBy.campaigns", "hypr.sortBy.clients").
 * Caller passa o `defaultValue` pra cobrir localStorage vazio sem precisar
 * conhecer a key interna.
 */
export function getSortBy(scope, defaultValue) {
  try {
    return localStorage.getItem(LS_SORT_BY_PREFIX + scope) || defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setSortBy(scope, value) {
  try {
    if (value) localStorage.setItem(LS_SORT_BY_PREFIX + scope, value);
    else localStorage.removeItem(LS_SORT_BY_PREFIX + scope);
  } catch {
    /* ignore */
  }
}

/**
 * Direção do sort (asc/desc) por escopo. Separada do campo pra que
 * a inversão (botão de toggle) não dispare regravação de tudo.
 */
export function getSortDir(scope, defaultValue) {
  try {
    const v = localStorage.getItem(LS_SORT_DIR_PREFIX + scope);
    return v === "asc" || v === "desc" ? v : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setSortDir(scope, dir) {
  try {
    if (dir === "asc" || dir === "desc") {
      localStorage.setItem(LS_SORT_DIR_PREFIX + scope, dir);
    } else {
      localStorage.removeItem(LS_SORT_DIR_PREFIX + scope);
    }
  } catch {
    /* ignore */
  }
}
