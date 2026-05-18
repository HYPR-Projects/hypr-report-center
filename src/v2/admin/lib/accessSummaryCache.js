// src/v2/admin/lib/accessSummaryCache.js
//
// Cache em módulo de access summaries pra o badge dos cards. Fonte real:
// endpoint POST ?action=access_summary_batch (backend/access_tracking.py).
//
// Estratégia
// ----------
// 1. CampaignMenuV2 chama `prefetchAccessSummaries(tokens)` quando a
//    lista de campanhas carrega. Isso dispara 1 request batched pro
//    backend que devolve summary de todos de uma vez.
// 2. Cada AccessBadge lê via `getCachedSummary(token)` — sync, retorna
//    null se ainda não chegou.
// 3. Quando o batch resolve, dispara um evento (`access-summaries-updated`)
//    que os badges escutam pra rerender. Sem global re-render do menu.
//
// Por que não Context?
//   - O badge é puramente cosmético no card. Re-render do menu inteiro
//     quando 270 summaries chegam = janks. Evento + ref local resolve
//     com mínimo de overhead.
//   - Cache em módulo sobrevive entre rotas (admin → client detail →
//     volta) — sem rebuscar.
//
// TTL: 5 minutos. Refetch automático quando expira. Não invalida em
// mutation (acessos só mudam por usuário externo, mutations admin não
// afetam o número).

import { getAccessSummariesBatch } from "../../../lib/api";

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // token → { summary, fetchedAt }
let inflight = null;     // Promise da request em voo, pra dedup

const listeners = new Set();

function emit() {
  for (const cb of listeners) {
    try { cb(); } catch { /* swallow */ }
  }
}

export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getCachedSummary(shortToken) {
  if (!shortToken) return null;
  const entry = cache.get(shortToken);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry.summary;
}

/**
 * Dispara um batch fetch dos tokens fornecidos. Tokens já cacheados
 * (válidos) são filtrados out — só pede o que falta. Dedupe em voo:
 * múltiplas chamadas simultâneas viram 1 só.
 */
export async function prefetchAccessSummaries(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  const now = Date.now();
  const toFetch = tokens.filter((t) => {
    if (!t) return false;
    const entry = cache.get(t);
    if (!entry) return true;
    return now - entry.fetchedAt > TTL_MS;
  });
  if (toFetch.length === 0) return;

  // Se já tem um batch em voo, espera ele resolver antes de pedir o
  // resto. Reduz o caso patológico de 2 prefetches paralelos que cobrem
  // tokens sobrepostos.
  if (inflight) {
    await inflight.catch(() => {});
  }
  const stillNeeded = toFetch.filter((t) => {
    const entry = cache.get(t);
    return !entry || Date.now() - entry.fetchedAt > TTL_MS;
  });
  if (stillNeeded.length === 0) return;

  inflight = getAccessSummariesBatch(stillNeeded)
    .then((summaries) => {
      const at = Date.now();
      for (const [token, summary] of Object.entries(summaries || {})) {
        cache.set(token, { summary, fetchedAt: at });
      }
      // Tokens pedidos mas sem dado vão pra cache como zeros pra evitar
      // refetch agressivo
      for (const t of stillNeeded) {
        if (!cache.has(t)) {
          cache.set(t, {
            summary: { total_pageviews: 0, unique_sessions: 0, last_access_at: null, range_days: 30 },
            fetchedAt: at,
          });
        }
      }
      emit();
    })
    .catch((err) => {
      // Falha silenciosa — badge cai pra zeros. Próxima tentativa em 5min.
      // Logamos pra Sentry/console pra detectar regressão silenciosa.
      // eslint-disable-next-line no-console
      console.warn("[accessSummaryCache] batch failed:", err?.message || err);
    })
    .finally(() => {
      inflight = null;
    });

  await inflight;
}

/**
 * Hook minimalista pro AccessBadge consumir o cache. Re-renderiza
 * quando o cache muda (evento `access-summaries-updated`).
 */
import { useEffect, useState } from "react";

export function useCachedAccessSummary(shortToken) {
  const [summary, setSummary] = useState(() => getCachedSummary(shortToken));
  useEffect(() => {
    setSummary(getCachedSummary(shortToken));
    const unsub = subscribe(() => {
      setSummary(getCachedSummary(shortToken));
    });
    return unsub;
  }, [shortToken]);
  return summary;
}
