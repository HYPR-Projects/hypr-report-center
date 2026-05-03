/**
 * Cache persistido em localStorage com versionamento de schema.
 *
 * Por que existe
 * --------------
 * Hoje o menu admin gate-eia a UI atrás de Promise.all([listCampaigns,
 * listClients, listTeamMembers]). Em qualquer falha silenciosa (JWT
 * expirado, blip de rede, response truncada), os helpers de api.js
 * retornam [] no catch — o user vê "0 campanhas" indistinguível de
 * "lista realmente vazia". Hard refresh é a única saída.
 *
 * Esta camada permite renderizar o último payload bom **imediatamente**
 * (instantâneo na 2ª+ visita) enquanto o refetch roda em background.
 * Se o refetch falhar, o cache mantém a UI funcional e um indicador
 * sutil avisa que os dados estão desatualizados.
 *
 * Convenções
 * ----------
 * - Chaves prefixadas com `hypr.cache.` pra não colidir com outros
 *   itens do localStorage (`hypr.session`, `hypr_theme`, etc).
 * - Schema versionado (`v` field) — bump em mudança incompatível
 *   invalida todo cache antigo silenciosamente (read retorna null).
 * - Falha no localStorage (quota, modo privado, disabled) é silenciosa:
 *   read retorna null, write é no-op. App degrada pra fetch direto.
 */

const PREFIX = "hypr.cache.";
const VERSION = 1;

/**
 * Lê um item do cache. Retorna `{ data, ts }` ou `null` se ausente,
 * inválido (JSON quebrado) ou de versão antiga.
 */
export function readCache(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj?.v !== VERSION) return null;
    if (typeof obj.ts !== "number") return null;
    return { data: obj.data, ts: obj.ts };
  } catch {
    return null;
  }
}

/**
 * Persiste um item. Erros (quota exceeded, localStorage desabilitado)
 * são silenciosos — cache é otimização, não pode quebrar o app.
 */
export function writeCache(key, data) {
  try {
    localStorage.setItem(
      PREFIX + key,
      JSON.stringify({ v: VERSION, ts: Date.now(), data })
    );
  } catch {
    /* ignore */
  }
}

export function clearCache(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}
