/**
 * Auth helpers for the HYPR Report Center front-end.
 *
 * Three jobs:
 *
 *  1. Persist the admin session (user + Google id_token) across page
 *     refreshes and tab restarts. Lives in localStorage with an 8h TTL
 *     so a refresh doesn't kick the user back to the login screen.
 *     The Google id_token itself expires in 1h (per its `exp` claim),
 *     so admin write actions may fail before the 8h are up — at which
 *     point the user is asked to log in again.
 *
 *  2. Trade the id_token for a short-lived admin JWT via the backend
 *     endpoint `?action=issue_admin_token`. The custom JWT (5min TTL)
 *     is what we attach to admin write requests.
 *
 *  3. Build `Authorization: Bearer <jwt>` headers and read the `?adm=`
 *     query param the menu sets when opening a report.
 *
 * Graceful degradation: if the backend hasn't been redeployed yet (the
 * `issue_admin_token` endpoint doesn't exist), the menu falls back to
 * the legacy `?ak=hypr2026` URL so admins keep working during the rollout.
 */

import { API_URL } from "./config";

// Sessão persiste 8h (jornada de trabalho) em localStorage para sobreviver
// a refreshes e fechamentos de aba. O id_token do Google em si expira em 1h
// (controlado pelo `exp` do JWT), então ações admin podem falhar antes das
// 8h — nesse caso o backend rejeita e o usuário precisa relogar para
// emitir novos JWTs admin.
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LS_SESSION_KEY = "hypr.session";
const LS_CLIENT_UNLOCK_PREFIX = "hypr.clientUnlock.";

// ─── Admin session persistence (localStorage, 8h TTL) ────────────────────────
/**
 * Persiste user + Google id_token com TTL de 8h. Substitui o antigo
 * sessionStorage que morria com a aba.
 */
export function saveSession(user, idToken) {
  try {
    const payload = {
      user,
      idToken,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify(payload));
  } catch {
    /* localStorage may be blocked — ignore */
  }
}

/**
 * Retorna { user, idToken } se a sessão está válida (não-expirada),
 * caso contrário null. Limpa automaticamente sessões expiradas.
 *
 * Valida duas expirações:
 *  1) Janela própria de 8h (`expiresAt`) — UX da app.
 *  2) `exp` do próprio id_token do Google (~1h) — sem isso o backend
 *     rejeita ações admin (incluindo listar campanhas), gerando UI
 *     fantasma de "0 campanhas". Se expirou, força relogin.
 */
export function loadSession() {
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.expiresAt || Date.now() > parsed.expiresAt) {
      localStorage.removeItem(LS_SESSION_KEY);
      return null;
    }
    if (parsed.idToken && isJwtExpired(parsed.idToken)) {
      // id_token do Google venceu (TTL ~1h). Sem ele o backend não
      // emite JWT admin e qualquer ação retorna 401. Limpa pra
      // mandar o usuário pra tela de login.
      localStorage.removeItem(LS_SESSION_KEY);
      return null;
    }
    return { user: parsed.user || null, idToken: parsed.idToken || null };
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(LS_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

// ─── Google id_token getters/setters (delegam para a sessão) ─────────────────
// Mantidos para compatibilidade com chamadas existentes em outros componentes.
export function setGoogleIdToken(token) {
  if (!token) {
    clearSession();
    return;
  }
  // Atualiza apenas o idToken preservando o user existente.
  const current = loadSession();
  saveSession(current?.user || null, token);
}

export function getGoogleIdToken() {
  return loadSession()?.idToken || null;
}

// ─── Client password unlock (per-token, localStorage, 8h TTL) ────────────────
/**
 * Marca o token de campanha como desbloqueado para a aba/dispositivo atual,
 * com TTL de 8h. Cada campanha tem sua própria chave.
 *
 * Aceita opcionalmente o `resolvedShortToken` — quando a URL pública usa o
 * formato novo `/report/{share_id}`, o backend resolve para o short_token
 * real, que é o que o dashboard precisa para chamar os endpoints de dados.
 * No formato legacy (URL = short_token), `resolvedShortToken` é o próprio
 * `urlToken`, ou pode ser omitido (cai no fallback).
 */
export function markClientUnlocked(urlToken, resolvedShortToken = null) {
  if (!urlToken) return;
  try {
    const key = LS_CLIENT_UNLOCK_PREFIX + urlToken.toUpperCase();
    const payload = {
      expiresAt: Date.now() + SESSION_TTL_MS,
      shortToken: resolvedShortToken || urlToken,
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export function isClientUnlocked(token) {
  if (!token) return false;
  try {
    const key = LS_CLIENT_UNLOCK_PREFIX + token.toUpperCase();
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed?.expiresAt || Date.now() > parsed.expiresAt) {
      localStorage.removeItem(key);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Lê o short_token real (resolvido pelo backend) que está armazenado
 * junto ao registro de unlock. Retorna null se não existir / expirou.
 *
 * Usado quando a URL tem `share_id` em vez de short_token: o dashboard
 * precisa do short_token canônico para chamar os endpoints de dados.
 * No formato legacy o valor armazenado é o próprio `urlToken`.
 */
export function getResolvedShortToken(urlToken) {
  if (!urlToken) return null;
  try {
    const key = LS_CLIENT_UNLOCK_PREFIX + urlToken.toUpperCase();
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.expiresAt || Date.now() > parsed.expiresAt) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.shortToken || urlToken;
  } catch {
    return null;
  }
}

export function clearClientUnlock(token) {
  if (!token) return;
  try {
    localStorage.removeItem(LS_CLIENT_UNLOCK_PREFIX + token.toUpperCase());
  } catch {
    /* ignore */
  }
}

// ─── Trade Google id_token → custom admin JWT (5min TTL) ─────────────────────
/**
 * Calls backend to mint a short-lived admin JWT.
 * Returns { token, email, ttl } on success, or null if backend doesn't
 * support the endpoint yet (returns 404/501) or any other failure.
 */
export async function issueAdminJwt(googleIdToken) {
  if (!googleIdToken) return null;
  try {
    const res = await fetch(`${API_URL}?action=issue_admin_token`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${googleIdToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.token) return null;
    return data;
  } catch {
    return null;
  }
}

// ─── Cached JWT for the menu tab ─────────────────────────────────────────────
// In-memory cache so a sequence of admin actions (save_logo, save_loom, etc)
// in the same menu tab doesn't trigger a tokeninfo round-trip every time.
// The cache is intentionally per-tab (lives in module scope, not storage)
// to keep the JWT off disk.
let _cachedAdminJwt = null;
let _cachedExpiryMs = 0;
const _RENEW_BUFFER_MS = 30 * 1000; // renew 30s before actual expiry

/**
 * Returns a valid admin JWT, minting a fresh one if needed.
 * Returns null if no Google id_token is in session or if the backend
 * doesn't support the endpoint yet.
 */
export async function getOrIssueAdminJwt() {
  if (_cachedAdminJwt && Date.now() < _cachedExpiryMs - _RENEW_BUFFER_MS) {
    return _cachedAdminJwt;
  }
  const idToken = getGoogleIdToken();
  if (!idToken) return null;
  const issued = await issueAdminJwt(idToken);
  if (issued?.token) {
    _cachedAdminJwt = issued.token;
    const ttlSec = Number(issued.ttl) || 300;
    _cachedExpiryMs = Date.now() + ttlSec * 1000;
    return _cachedAdminJwt;
  }
  return null;
}

export function clearCachedAdminJwt() {
  _cachedAdminJwt = null;
  _cachedExpiryMs = 0;
}

// ─── Read ?adm=<jwt> from current URL ────────────────────────────────────────
export function getAdminJwtFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get("adm") || null;
  } catch {
    return null;
  }
}

// ─── Decode JWT payload (no verification — backend verifies) ─────────────────
/**
 * Decodes the payload of a JWT. Used purely for UI hints (showing which
 * email is logged in, checking expiry to avoid pointless requests). All
 * trust decisions are made server-side, where the signature is verified.
 */
export function decodeJwtPayload(token) {
  if (!token) return null;
  try {
    const part = token.split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function isJwtExpired(token) {
  const p = decodeJwtPayload(token);
  if (!p?.exp) return true;
  return Number(p.exp) * 1000 <= Date.now();
}

// ─── Build admin Authorization headers ───────────────────────────────────────
/**
 * Returns headers object with Authorization: Bearer <adminJwt> if a valid,
 * unexpired admin JWT is available. Empty object otherwise.
 *
 * Use spread when composing fetch headers:
 *   fetch(url, { headers: { ...adminAuthHeaders(jwt), 'Content-Type': '...' } })
 */
export function adminAuthHeaders(adminJwt) {
  if (!adminJwt || isJwtExpired(adminJwt)) return {};
  return { "Authorization": `Bearer ${adminJwt}` };
}
