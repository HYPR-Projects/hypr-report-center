/**
 * Auth helpers for the HYPR Report Hub front-end.
 *
 * Three jobs:
 *
 *  1. Persist the Google id_token across the menu → report navigation.
 *     The id_token is what the backend uses to mint our short-lived
 *     custom admin JWT. It lives in sessionStorage so it dies with the
 *     tab and is never sent to a third party.
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

const SS_GOOGLE_ID_TOKEN = "hypr.googleIdToken";

// ─── Google id_token persistence (sessionStorage) ────────────────────────────
export function setGoogleIdToken(token) {
  try {
    if (token) sessionStorage.setItem(SS_GOOGLE_ID_TOKEN, token);
    else sessionStorage.removeItem(SS_GOOGLE_ID_TOKEN);
  } catch {
    /* sessionStorage may be blocked (private mode, etc) — ignore */
  }
}

export function getGoogleIdToken() {
  try {
    return sessionStorage.getItem(SS_GOOGLE_ID_TOKEN) || null;
  } catch {
    return null;
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
