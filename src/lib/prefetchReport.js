/**
 * Prefetch de report data via hover.
 *
 * Por que existe
 * --------------
 * Hoje, abrir um report (`/report/<token>`) dispara o fetch de dados
 * só *depois* do clique. Latência típica: ~800ms-2s (BQ frio) ou ~200ms
 * (cache backend hit). Pré-buscar no `onMouseEnter` do card aproveita
 * o gap natural entre hover e click (~200-400ms em média) pra esquentar
 * o cache HTTP do browser.
 *
 * Como funciona
 * -------------
 * - O backend devolve `Cache-Control: private, max-age=60` em
 *   `getCampaign`. O cache HTTP do browser é compartilhado entre
 *   tabs/windows do mesmo origin. Quando o user clica em "Ver Report"
 *   e abre uma tab nova, o `fetch(API_URL?token=X)` da nova tab é
 *   resolvido instantaneamente pelo cache.
 * - Debounce de 100ms evita disparar request em mouse-pass-by (passar
 *   rápido por cima sem intenção de clicar).
 * - Dedup por token + janela de TTL — se já prefetchado nos últimos
 *   50s, skip. (50s < 60s do max-age pra dar margem.)
 * - Falha silenciosa: prefetch é otimização, qualquer erro vira no-op
 *   e não bloqueia o fluxo. O cache do browser também não vai cachear
 *   responses 4xx/5xx de qualquer jeito.
 *
 * Uso
 * ---
 * ```jsx
 * <Card
 *   onMouseEnter={() => schedulePrefetch(token)}
 *   onMouseLeave={() => cancelPrefetch(token)}
 *   onFocus={() => schedulePrefetch(token)}   // teclado também
 * />
 * ```
 */

import { API_URL } from "../shared/config";
import { isDemoToken, buildDemoPayload } from "../shared/demoData";

const HOVER_DELAY_MS = 100;
const PREFETCH_TTL_MS = 50_000;

// Teto de prefetches SIMULTÂNEOS — o gargalo mais importante deste módulo.
//
// Contexto (incidente 04/08): o menu admin faz bulk-prefetch de toda campanha
// in_flight ao carregar. Com ~41 ativas e só 40ms de escalonamento, isso virava
// uma rajada de ~41 requests em 2s — cada uma um report COMPLETO no backend.
// A Cloud Function roda com concurrency=10, então o Cloud Run subia 10+
// instâncias frias de uma vez, todas martelando o BigQuery ao mesmo tempo. Foi
// essa rajada que expôs o deadlock do ThreadPool e matou uma instância por 16h.
//
// O escalonamento por tempo (40ms) não limita nada de verdade: se cada report
// leva 2s, 40ms de espaçamento ainda deixa ~50 em voo. O que limita é contar
// quantas estão ABERTAS. 4 é confortável: mantém o prefetch útil (os cards
// visíveis chegam rápido) sem nunca estourar a concorrência do backend.
//
// Fila global de propósito: hover, IntersectionObserver e bulk-prefetch passam
// todos por aqui, então o teto vale pra soma dos três — não por origem.
const MAX_CONCURRENT = 4;

const pendingHovers = new Map(); // token -> setTimeout id
const prefetchedAt  = new Map(); // token -> ms timestamp
const waiting       = [];        // tokens na fila aguardando slot
const queued        = new Set(); // dedup da fila (O(1))
let inFlight        = 0;

// Cache em memória do detalhe parseado. Hoje o prefetch só esquenta o cache
// HTTP do browser e descarta a Response; consumidores precisavam refetchar
// e re-parsear. Guardar o JSON aqui deixa o card admin calcular pacing
// per-frente (O2O/OOH) sync no render, sem ida ao backend nem flash de loading.
const detailCache = new Map(); // token -> parsed payload (saída de getCampaign)
const listeners   = new Set(); // fn() -> chamada quando detailCache muda

// Snapshot estável do cache pra useSyncExternalStore. Rebuild só acontece
// quando notifyListeners dispara — entre notifies, `cachedSnapshot` mantém
// a mesma referência, evitando loop infinito de re-render no React.
let cachedSnapshot = {};

function rebuildSnapshot() {
  const out = {};
  for (const [token, payload] of detailCache) {
    out[token] = payload;
  }
  cachedSnapshot = out;
}

function notifyListeners() {
  rebuildSnapshot();
  for (const fn of listeners) {
    try { fn(); } catch { /* listener isolado */ }
  }
}

/**
 * Enfileira o prefetch. O timestamp é marcado AQUI (não no disparo real) pra
 * que a dedupe por TTL valha também pro que está esperando slot — senão o
 * bulk-prefetch reenfileirava o mesmo token a cada re-render.
 */
function fireFetch(token) {
  prefetchedAt.set(token, Date.now());

  // Demo token não passa pelo backend — resolve na hora, sem ocupar slot.
  if (isDemoToken(token)) {
    detailCache.set(token, buildDemoPayload());
    notifyListeners();
    return;
  }

  if (queued.has(token)) return;
  queued.add(token);
  waiting.push(token);
  drainQueue();
}

function drainQueue() {
  while (inFlight < MAX_CONCURRENT && waiting.length > 0) {
    const token = waiting.shift();
    queued.delete(token);
    runFetch(token);
  }
}

function runFetch(token) {
  inFlight += 1;
  // Prefetch é otimização: se o backend está lento, desistir é melhor que
  // segurar um slot da fila (e uma conexão do browser, que tem teto de 6 por
  // origem) enquanto o usuário espera pela navegação de verdade.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);

  fetch(`${API_URL}?token=${encodeURIComponent(token)}`, { signal: ctrl.signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && data.campaign) {
        detailCache.set(token, data);
        notifyListeners();
      }
    })
    .catch(() => {
      // Reseta pra próximo hover poder retentar.
      prefetchedAt.delete(token);
    })
    .finally(() => {
      clearTimeout(timer);
      inFlight -= 1;
      drainQueue();
    });
}

/**
 * Retorna o detalhe prefetched de uma campanha, ou null se ainda não chegou.
 * Consulta sync — não dispara request. Use junto com subscribe() pra
 * re-renderizar quando o dado chegar.
 */
export function getPrefetchedDetail(token) {
  if (!token) return null;
  return detailCache.get(token) || null;
}

/**
 * Snapshot estável do cache (todos os tokens com detail carregado).
 * MESMA referência entre notifies — seguro pra useSyncExternalStore.
 *
 * Pareado com `subscribeDetail`: chamadores reativos re-leem após cada
 * notify pra incluir os novos tokens chegados. Reference equality muda
 * só quando o cache realmente mudou.
 */
export function getAllPrefetchedDetails() {
  return cachedSnapshot;
}

/**
 * Assina mudanças no cache de detalhes. Retorna função pra cancelar.
 * Usado por components que querem reagir ao detalhe chegar (ex: card
 * recalcular cor do pacing per-frente).
 */
export function subscribeDetail(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function schedulePrefetch(token) {
  if (!token) return;
  const last = prefetchedAt.get(token) || 0;
  if (Date.now() - last < PREFETCH_TTL_MS) return; // recentemente prefetchado

  // Cancela hover pendente (caso o user re-hoverou rápido)
  const existing = pendingHovers.get(token);
  if (existing) clearTimeout(existing);

  const id = setTimeout(() => {
    pendingHovers.delete(token);
    fireFetch(token);
  }, HOVER_DELAY_MS);
  pendingHovers.set(token, id);
}

export function cancelPrefetch(token) {
  if (!token) return;
  const id = pendingHovers.get(token);
  if (id) {
    clearTimeout(id);
    pendingHovers.delete(token);
  }
  // Sai da fila se ainda não começou. Mouse passou por cima e seguiu → não há
  // motivo pra ocupar um dos 4 slots. Request já em voo continua (cancelar
  // desperdiçaria o trabalho que o backend já fez).
  if (queued.has(token)) {
    queued.delete(token);
    const i = waiting.indexOf(token);
    if (i !== -1) waiting.splice(i, 1);
    prefetchedAt.delete(token);
  }
}
