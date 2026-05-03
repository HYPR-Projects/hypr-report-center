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

const HOVER_DELAY_MS = 100;
const PREFETCH_TTL_MS = 50_000;

const pendingHovers = new Map(); // token -> setTimeout id
const prefetchedAt  = new Map(); // token -> ms timestamp

function fireFetch(token) {
  // Atualiza timestamp ANTES do fetch — se duas chamadas concorrentes
  // chegam aqui (improvável dado o debounce), só uma vai disparar.
  prefetchedAt.set(token, Date.now());
  fetch(`${API_URL}?token=${encodeURIComponent(token)}`).catch(() => {
    // Reseta pra próximo hover poder retentar.
    prefetchedAt.delete(token);
  });
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
}
