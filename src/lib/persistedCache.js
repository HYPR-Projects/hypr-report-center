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
const VERSION = 2;

// Build ID injetado pelo Vite (vide vite.config.js). Toda mudança de
// bundle (= todo deploy) gera um BUILD_ID novo, e o cache antigo passa
// a ser ignorado — sem isso, a UI pintava com dados gerados por uma
// lógica de scoring/alertas antiga e atualizava 4s depois.
// `typeof` guard pra que o módulo não exploda caso seja importado fora
// do Vite build (testes Node, scripts standalone, etc).
const BUILD_ID =
  typeof __APP_BUILD_ID__ !== "undefined" ? __APP_BUILD_ID__ : "unknown";

// TTL — depois disso o cache é tratado como miss. Cobre o caso "abri o
// menu ontem às 17h, abro hoje às 8h": o backend roda refresh diário às
// 6h, então cache de >30min pode ter divergido. Sub-30min de revisita
// (caso dominante: trocar de aba, abrir drawer, voltar) permanece
// instantâneo.
const TTL_MS = 30 * 60 * 1000;

/**
 * Lê um item do cache. Retorna `{ data, ts }` ou `null` se ausente,
 * inválido (JSON quebrado), de versão antiga, de outro bundle, ou
 * mais velho que TTL.
 *
 * `ttlMs` opcional sobrepõe o TTL default de 30 min — o payload do report
 * (stale-while-revalidate no ClientDashboardV2) usa 24h: a base só muda
 * 1x/dia (~06h) e o dado stale é pintado na hora ENQUANTO o refetch roda,
 * nunca no lugar dele.
 */
export function readCache(key, ttlMs = TTL_MS) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj?.v !== VERSION) return null;
    if (obj?.bid !== BUILD_ID) return null;
    if (typeof obj.ts !== "number") return null;
    if (Date.now() - obj.ts > ttlMs) return null;
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
      JSON.stringify({ v: VERSION, bid: BUILD_ID, ts: Date.now(), data })
    );
  } catch {
    /* ignore */
  }
}

export function clearCache(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}
