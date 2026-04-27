/**
 * UI preferences helpers (localStorage).
 *
 * Persistem preferências visuais do usuário entre sessões. Diferente do
 * auth, não têm TTL — o usuário escolheu, fica salvo até trocar.
 */

const LS_THEME_KEY = "hypr.theme";
const LS_OWNER_FILTER_KEY = "hypr.ownerFilter";

/**
 * Retorna "dark" ou "light". Default: "dark".
 */
export function getTheme() {
  try {
    const v = localStorage.getItem(LS_THEME_KEY);
    return v === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Persiste a preferência de tema. Aceita "dark" ou "light".
 */
export function setTheme(theme) {
  try {
    localStorage.setItem(LS_THEME_KEY, theme === "light" ? "light" : "dark");
  } catch {
    /* ignore */
  }
}

/**
 * Retorna o email do owner selecionado pelo admin no menu, ou ""
 * se nenhum filtro estiver ativo.
 */
export function getOwnerFilter() {
  try {
    return localStorage.getItem(LS_OWNER_FILTER_KEY) || "";
  } catch {
    return "";
  }
}

/**
 * Persiste o owner selecionado. Passar "" remove o filtro.
 */
export function setOwnerFilter(email) {
  try {
    if (email) localStorage.setItem(LS_OWNER_FILTER_KEY, email);
    else localStorage.removeItem(LS_OWNER_FILTER_KEY);
  } catch {
    /* ignore */
  }
}
