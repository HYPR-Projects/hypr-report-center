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
// TTL: 5 minutos. Stale-while-revalidate: o badge segue exibindo o último
// valor conhecido após o TTL e o hook dispara refetch em background. Sem
// isso, badge caía em `0` quando o TTL expirava enquanto o user ficava
// muito tempo na página (sintoma: "deixei a aba aberta e zerou").
//
// Em erro, aplica backoff de ERROR_BACKOFF_MS pra não martelar backend
// (e flickar o skeleton) quando JWT expira ou rede está ruim.

import { getAccessSummariesBatch } from "../../../lib/api";

const TTL_MS = 5 * 60 * 1000;
const ERROR_BACKOFF_MS = 30 * 1000;
const cache = new Map(); // token → { summary, fetchedAt }
let inflight = null;     // Promise da request em voo, pra dedup
let lastErrorAt = 0;     // timestamp do último erro de batch, p/ backoff
// Tokens que entraram em alguma prefetch — usado pelo badge pra
// distinguir "estado de loading" (não rolou prefetch ainda) de
// "0 acessos confirmado" (prefetch resolveu, valor é 0 real).
const requestedTokens = new Set();

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

// Micro-batch p/ refetches de entries stale. Quando 60+ badges remontam
// stale ao mesmo tempo (ex: troca de filtro depois do TTL), agrupamos
// os tokens em um único request via queueMicrotask em vez de N
// chamadas sequenciais.
const staleQueue = new Set();
let staleScheduled = false;
function flushStaleQueue() {
  staleScheduled = false;
  if (staleQueue.size === 0) return;
  const tokens = [...staleQueue];
  staleQueue.clear();
  prefetchAccessSummaries(tokens).catch(() => { /* silencioso */ });
}
function requestRefreshIfStale(shortToken) {
  if (!shortToken) return;
  const entry = cache.get(shortToken);
  if (entry && Date.now() - entry.fetchedAt <= TTL_MS) return; // ainda fresh
  staleQueue.add(shortToken);
  if (!staleScheduled) {
    staleScheduled = true;
    queueMicrotask(flushStaleQueue);
  }
}

/**
 * Retorna o ÚLTIMO valor conhecido — mesmo depois do TTL. Combinado com
 * `requestRefreshIfStale` no hook, dá stale-while-revalidate: o número
 * antigo continua visível enquanto o refetch corre em background.
 *
 * Antes desta mudança, expirar o TTL retornava null e o badge caía em
 * `0` quando o card remontava (troca de filtro, busca, etc.) — sintoma
 * de "deixei aberto e zerou".
 */
export function getCachedSummary(shortToken) {
  if (!shortToken) return null;
  const entry = cache.get(shortToken);
  if (!entry) return null;
  return entry.summary;
}

/**
 * True se há entry em cache mas passou do TTL. Caller (hook) usa pra
 * disparar refetch em background sem trocar o número visível.
 */
export function isStaleSummary(shortToken) {
  if (!shortToken) return false;
  const entry = cache.get(shortToken);
  if (!entry) return false;
  return Date.now() - entry.fetchedAt > TTL_MS;
}

/**
 * Loading = NÃO temos nenhum dado em cache + há request em voo. Se já
 * temos dado (mesmo stale), retornamos false: o badge mostra o número,
 * não o skeleton. Refetch em background atualiza quando chegar.
 */
export function isLoadingSummary(shortToken) {
  if (!shortToken) return false;
  if (cache.has(shortToken)) return false;
  return inflight != null;
}

/**
 * Dispara um batch fetch dos tokens fornecidos. Tokens já cacheados
 * (válidos) são filtrados out — só pede o que falta. Dedupe em voo:
 * múltiplas chamadas simultâneas viram 1 só.
 */
export async function prefetchAccessSummaries(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  for (const t of tokens) {
    if (t) requestedTokens.add(t);
  }
  // Backoff em erro recente: evita martelar backend quando JWT expirou
  // ou rede está ruim. UI continua mostrando dado stale; nova tentativa
  // só após o backoff (ou hard refresh, que reseta este módulo).
  if (lastErrorAt && Date.now() - lastErrorAt < ERROR_BACKOFF_MS) return;

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

  // CRÍTICO: seta `inflight` ANTES de emit. Os listeners (badges)
  // checam isLoadingSummary() que depende de inflight != null —
  // sem essa ordem, o primeiro emit não conta como loading e os
  // badges pulam direto pro número final sem mostrar skeleton.
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
      lastErrorAt = 0;
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[accessSummaryCache] batch failed:", err?.message || err);
      lastErrorAt = Date.now();
    })
    .finally(() => {
      inflight = null;
      // Emit no finally garante 1 update ordenado APÓS inflight=null.
      // Subscribers veem estado consistente: cache populado (sucesso) ou
      // inflight=null (erro) → saem do skeleton sem ficar travados.
      emit();
    });

  // Emit DEPOIS de inflight estar setado pros listeners vejam loading=true.
  // Sem isso, badges não trocam pra skeleton no 1º carregamento.
  emit();
  await inflight;
}

/**
 * Hook minimalista pro AccessBadge consumir o cache. Re-renderiza
 * quando o cache muda (evento `access-summaries-updated`).
 */
import { useEffect, useState } from "react";

export function useCachedAccessSummary(shortToken) {
  const [state, setState] = useState(() => ({
    summary: getCachedSummary(shortToken),
    loading: isLoadingSummary(shortToken),
  }));
  useEffect(() => {
    setState({
      summary: getCachedSummary(shortToken),
      loading: isLoadingSummary(shortToken),
    });
    // Stale-while-revalidate: se o cache expirou (TTL > 5min), dispara
    // refetch em background. Micro-batched: 60+ badges remontando juntos
    // viram 1 só request.
    requestRefreshIfStale(shortToken);
    const unsub = subscribe(() => {
      setState({
        summary: getCachedSummary(shortToken),
        loading: isLoadingSummary(shortToken),
      });
    });
    return unsub;
  }, [shortToken]);
  return state;
}
