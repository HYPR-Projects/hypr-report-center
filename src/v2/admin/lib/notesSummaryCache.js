// src/v2/admin/lib/notesSummaryCache.js
//
// Cache em módulo das notas internas por campanha — alimenta o indicador
// discreto no card (quantas notas, quem escreveu a última, snippet no
// tooltip). Fonte: POST ?action=campaign_notes_batch.
//
// Mesmo desenho do accessSummaryCache (prefetch batched + evento +
// leitura sync pelos badges), com duas diferenças deliberadas:
//
//   1. Sem estado de "loading": o indicador só existe quando há nota.
//      Enquanto o batch não chega, o card simplesmente não mostra nada —
//      não há flash de "0 notas" pra evitar, então skeleton seria ruído.
//   2. `patchNoteSummary` — a thread é escrita pela própria UI (drawer /
//      sheet do Diagnóstico). Ao postar ou apagar uma nota, o contador do
//      card atualiza na hora, sem esperar o próximo batch (que só corre
//      no refresh da lista).
//
// TTL de 2min com stale-while-revalidate: notas mudam com frequência
// operacional (várias por dia numa campanha em fogo), e o custo é uma
// query agregada barata numa tabela clusterizada por short_token.

import { useEffect, useSyncExternalStore } from "react";
import { getCampaignNotesBatch } from "../../../lib/api";

const TTL_MS = 2 * 60 * 1000;
const ERROR_BACKOFF_MS = 30 * 1000;

const cache = new Map(); // token → { summary, fetchedAt }
let inflight = null;
let lastErrorAt = 0;

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

const EMPTY = { count: 0, last_at: null, last_author_email: null, last_author_name: null, last_snippet: null };

export function getCachedNoteSummary(shortToken) {
  if (!shortToken) return null;
  return cache.get(shortToken)?.summary ?? null;
}

/**
 * Atualiza o cache local após uma escrita na thread. `count` é o total
 * NOVO (a thread aberta conhece o número exato — não precisamos de delta,
 * que dessincronizaria se dois drawers mexessem no mesmo token).
 */
export function patchNoteSummary(shortToken, { count, last_at, last_author_email, last_author_name, last_snippet }) {
  if (!shortToken) return;
  const prev = cache.get(shortToken)?.summary ?? EMPTY;
  cache.set(shortToken, {
    summary: {
      ...prev,
      count: Number.isFinite(count) ? count : prev.count,
      last_at: last_at ?? prev.last_at,
      last_author_email: last_author_email ?? prev.last_author_email,
      last_author_name: last_author_name ?? prev.last_author_name,
      last_snippet: last_snippet ?? prev.last_snippet,
    },
    fetchedAt: Date.now(),
  });
  emit();
}

// Micro-batch dos refetches stale: 60+ cards remontando juntos (troca de
// filtro depois do TTL) viram 1 request só.
const staleQueue = new Set();
let staleScheduled = false;
function flushStaleQueue() {
  staleScheduled = false;
  if (staleQueue.size === 0) return;
  const tokens = [...staleQueue];
  staleQueue.clear();
  prefetchNoteSummaries(tokens).catch(() => { /* silencioso */ });
}
function requestRefreshIfStale(shortToken) {
  if (!shortToken) return;
  const entry = cache.get(shortToken);
  if (entry && Date.now() - entry.fetchedAt <= TTL_MS) return;
  staleQueue.add(shortToken);
  if (!staleScheduled) {
    staleScheduled = true;
    queueMicrotask(flushStaleQueue);
  }
}

/**
 * Dispara o batch dos tokens faltantes/stale. Dedup em voo; erro aplica
 * backoff pra não martelar o backend com JWT expirado.
 */
export async function prefetchNoteSummaries(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  if (lastErrorAt && Date.now() - lastErrorAt < ERROR_BACKOFF_MS) return;

  const now = Date.now();
  const toFetch = tokens.filter((t) => {
    if (!t) return false;
    const entry = cache.get(t);
    return !entry || now - entry.fetchedAt > TTL_MS;
  });
  if (toFetch.length === 0) return;

  if (inflight) await inflight.catch(() => {});
  const stillNeeded = toFetch.filter((t) => {
    const entry = cache.get(t);
    return !entry || Date.now() - entry.fetchedAt > TTL_MS;
  });
  if (stillNeeded.length === 0) return;

  inflight = getCampaignNotesBatch(stillNeeded)
    .then((summaries) => {
      const at = Date.now();
      for (const [token, summary] of Object.entries(summaries || {})) {
        cache.set(token, { summary, fetchedAt: at });
      }
      // Token pedido e ausente da resposta = zero notas. Cacheia o zero pra
      // não refetchar em loop.
      for (const t of stillNeeded) {
        if (!(summaries || {})[t]) cache.set(t, { summary: EMPTY, fetchedAt: at });
      }
      lastErrorAt = 0;
    })
    .catch((err) => {
      console.warn("[notesSummaryCache] batch failed:", err?.message || err);
      lastErrorAt = Date.now();
    })
    .finally(() => {
      inflight = null;
      emit();
    });

  await inflight;
}

/**
 * Hook do indicador no card. useSyncExternalStore (e não useState+effect)
 * porque o cache É uma store externa: o snapshot por token é estável por
 * referência até um patch/refetch, então o badge só re-renderiza quando o
 * número dele muda de fato — sem setState dentro de effect.
 */
export function useCachedNoteSummary(shortToken) {
  const summary = useSyncExternalStore(
    subscribe,
    () => getCachedNoteSummary(shortToken),
  );
  // Stale-while-revalidate: o badge segue mostrando o último valor conhecido
  // e o refetch corre em background (micro-batched com os outros cards).
  useEffect(() => {
    requestRefreshIfStale(shortToken);
  }, [shortToken]);
  return summary;
}
