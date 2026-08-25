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
 * Remove entradas de cache que a leitura JÁ IGNORA: de outra versão de
 * schema ou de outro build. Devolve quantas saíram.
 *
 * POR QUE ISSO PRECISA EXISTIR
 * ────────────────────────────────────────────────────────────────────────
 * `readCache` descarta entrada com `bid` diferente (todo deploy gera um
 * BUILD_ID novo), mas nada nunca a APAGAVA. Resultado: cada deploy deixava
 * no navegador de cada pessoa mais uma cópia da lista de campanhas — e a
 * lista tem centenas de campanhas. Depois de alguns deploys o localStorage
 * do domínio chega no teto de ~5MB entupido de cache que ninguém mais lê.
 *
 * O sintoma não aparece no cache (ele degrada em silêncio, é otimização),
 * aparece em QUEM PRECISA GRAVAR DEPOIS: gravar `hypr.session` passa a
 * estourar quota. Escrever POR CIMA de uma chave do mesmo tamanho ainda
 * funciona, o que é exatamente por que isso ficou invisível por tanto
 * tempo — e explodiu no dia em que a sessão cresceu alguns bytes.
 */
export function evictStaleCache() {
  let removed = 0;
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      try {
        const obj = JSON.parse(localStorage.getItem(key));
        if (obj?.v !== VERSION || obj?.bid !== BUILD_ID) doomed.push(key);
      } catch {
        doomed.push(key); // JSON quebrado nunca vai ser lido de novo
      }
    }
    for (const key of doomed) {
      try { localStorage.removeItem(key); removed++; } catch { /* ignore */ }
    }
  } catch {
    /* localStorage inacessível — nada a fazer */
  }
  return removed;
}

/**
 * Apaga TODO o cache persistido. Último recurso pra abrir espaço: cache é
 * reconstruível com um fetch, sessão não é. Devolve quantas chaves saíram.
 */
export function evictAllCache() {
  let removed = 0;
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX)) doomed.push(key);
    }
    for (const key of doomed) {
      try { localStorage.removeItem(key); removed++; } catch { /* ignore */ }
    }
  } catch {
    /* ignore */
  }
  return removed;
}

/**
 * Persiste um item. Erros (quota exceeded, localStorage desabilitado)
 * são silenciosos — cache é otimização, não pode quebrar o app.
 *
 * Em falha de quota, limpa as entradas obsoletas e tenta uma vez mais:
 * sem isso o cache entope o localStorage do domínio e quebra quem grava
 * depois dele (ver evictStaleCache).
 */
export function writeCache(key, data) {
  const payload = JSON.stringify({ v: VERSION, bid: BUILD_ID, ts: Date.now(), data });
  try {
    localStorage.setItem(PREFIX + key, payload);
  } catch {
    if (evictStaleCache() > 0) {
      try { localStorage.setItem(PREFIX + key, payload); } catch { /* desiste */ }
    }
  }
}

export function clearCache(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}
