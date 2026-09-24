// src/v2/hooks/useMaReport.js
//
// Métricas Max Attention do período, com cache em memória compartilhado:
// o card do Resumo por mídia (Visão Geral) e a aba Max Attention pedem a
// mesma chave (token · view · período) e fazem UMA requisição.
//
// O backend já cacheia 10 min por peça e período; aqui o TTL é curto (5 min)
// só para trocar de aba sem piscar. `reload({ refresh: true })` (admin) fura
// os dois caches.

import { useCallback, useEffect, useState } from "react";
import { getMaReport } from "../../lib/api";
import { ymd } from "../../shared/dateFilter";

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key → { data, error, at, promise }
const listeners = new Map(); // key → Set<fn>

function keyOf({ token, view, from, to }) {
  return [token || "", view || "", from || "", to || ""].join("|");
}

function notify(key) {
  for (const fn of listeners.get(key) || []) fn();
}

function load(params, { refresh = false, adminJwt = null } = {}) {
  const key = keyOf(params);
  const hit = cache.get(key);
  if (!refresh && hit?.promise) return hit.promise;
  if (!refresh && hit && !hit.error && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.data);
  const promise = getMaReport({ ...params, refresh, adminJwt })
    .then((data) => {
      cache.set(key, { data, error: null, at: Date.now(), promise: null });
      notify(key);
      return data;
    })
    .catch((error) => {
      cache.set(key, { data: hit?.data || null, error, at: Date.now(), promise: null });
      notify(key);
      throw error;
    });
  cache.set(key, { ...(hit || {}), promise });
  notify(key);
  return promise;
}

/**
 * Começa a buscar as métricas antes de alguém abrir a aba (o report chama
 * ao carregar, em qualquer aba). Mesma chave do hook: quando a aba ou o card
 * da Visão Geral montam, pegam a requisição em voo ou o resultado pronto.
 */
export function prefetchMaReport({ token, view = null, range = null }) {
  if (!token) return;
  const from = range?.from ? ymd(range.from) : null;
  const to = range?.to ? ymd(range.to) : null;
  load({ token, view, from, to }).catch(() => {});
}

/** Limpa o cache (ex.: depois de salvar vínculos). */
export function invalidateMaReport(token = null) {
  for (const k of [...cache.keys()]) {
    if (!token || k.startsWith(`${token}|`)) cache.delete(k);
  }
  for (const k of listeners.keys()) notify(k);
}

/**
 * @param {{ token: string, view?: string|null, range?: {from: Date, to: Date}|null, enabled?: boolean, adminJwt?: string|null }} opts
 * @returns {{ status: "idle"|"loading"|"ready"|"error", data: object|null, error: Error|null, reload: (o?: {refresh?: boolean}) => Promise<any> }}
 */
export function useMaReport({ token, view = null, range = null, enabled = true, adminJwt = null }) {
  const from = range?.from ? ymd(range.from) : null;
  const to = range?.to ? ymd(range.to) : null;
  const key = keyOf({ token, view, from, to });
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !token) return undefined;
    const fn = () => setTick((t) => t + 1);
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    load({ token, view, from, to }).catch(() => {});
    return () => {
      listeners.get(key)?.delete(fn);
    };
  }, [enabled, token, view, from, to, key]);

  const reload = useCallback(
    ({ refresh = false } = {}) => load({ token, view, from, to }, { refresh, adminJwt }),
    [token, view, from, to, adminJwt],
  );

  const entry = cache.get(key);
  let status = "idle";
  if (enabled && token) {
    if (entry?.promise && !entry?.data) status = "loading";
    else if (entry?.error && !entry?.data) status = "error";
    else if (entry?.data) status = "ready";
    else status = "loading";
  }
  return {
    status,
    data: entry?.data || null,
    error: entry?.error || null,
    refreshing: !!entry?.promise && !!entry?.data,
    reload,
  };
}
