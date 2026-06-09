/**
 * Auth helpers for the HYPR Report Center front-end.
 *
 * Três responsabilidades:
 *
 *  1. Persistir a sessão admin (user + Google id_token + admin JWT) entre
 *     refreshes e fechamentos de aba. Vive no localStorage com TTL de 8h.
 *     O admin JWT é persistido junto pra que o refresh da aba não force
 *     re-mintar via id_token (que pode ter expirado e silent refresh
 *     falhado em silêncio quando FedCM tá bloqueado).
 *
 *  2. Trocar o id_token pelo admin JWT via `?action=issue_admin_token`
 *     (backend faz com TTL 8h, ver backend/auth.py). Esse JWT é o que vai
 *     no header `Authorization: Bearer` de toda call admin. Como o JWT
 *     do backend dura 8h, depois do login inicial não dependemos mais do
 *     id_token do Google (que dura ~1h).
 *
 *  3. Build `Authorization: Bearer <jwt>` headers and read the `?adm=`
 *     query param the menu sets when opening a report.
 *
 * Graceful degradation: if the backend hasn't been redeployed yet (the
 * `issue_admin_token` endpoint doesn't exist), the menu falls back to
 * the legacy `?ak=hypr2026` URL so admins keep working during the rollout.
 */

import { API_URL } from "./config";

// Sessão persiste 8h (jornada de trabalho) em localStorage. Diferente do
// modelo antigo, agora o admin JWT do backend (também 8h) é persistido
// junto, então mesmo que o id_token do Google expire (1h) e o silent
// refresh falhe (FedCM bloqueado, etc.), o usuário continua trabalhando
// até a janela de 8h estourar.
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LS_SESSION_KEY = "hypr.session";
const LS_CLIENT_UNLOCK_PREFIX = "hypr.clientUnlock.";

// ─── Acesso a features restritas ─────────────────────────────────────────────
// Lista curada de operadores que enxergam features sensíveis: reconstrução
// manual das bases ("Reconstruir agora") e a aba PMP Deals. Demais usuários
// @hypr.mobi continuam no menu admin normal, sem esses controles.
//
// Gate é puramente frontend — guard rail de UX, não barreira de segurança. O
// reforço real vem do admin JWT validado no backend.
export const FEATURE_ADMINS = new Set([
  "joao.buzolin@hypr.mobi",
  "matheus.machado@hypr.mobi",
  "gianlucca.nardo@hypr.mobi",
  "mateus.duarte@hypr.mobi",
]);

export function isFeatureAdmin(user) {
  const email = user?.email;
  if (!email || typeof email !== "string") return false;
  return FEATURE_ADMINS.has(email.toLowerCase());
}

// ─── Admin session persistence (localStorage, 8h TTL) ────────────────────────
/**
 * Persiste user + Google id_token com TTL de 8h. Substitui o antigo
 * sessionStorage que morria com a aba. O admin JWT é persistido depois
 * via `updateSessionAdminJwt()` (depois do primeiro mint via id_token).
 */
export function saveSession(user, idToken) {
  try {
    const payload = {
      user,
      idToken,
      adminJwt: null,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify(payload));
  } catch {
    /* localStorage may be blocked — ignore */
  }
}

/**
 * Retorna { user, idToken, adminJwt } se a sessão está válida
 * (não-expirada), caso contrário null. Limpa automaticamente sessões
 * expiradas.
 *
 * Mudança vs versão anterior: NÃO derruba mais a sessão quando o
 * id_token do Google expira (1h). O admin JWT persistido (8h, mintado
 * pelo backend) é independente do id_token depois do login — então o
 * usuário continua trabalhando mesmo se o silent refresh do Google
 * tiver falhado. O id_token só importa pra (a) login inicial, (b)
 * re-mintar admin JWT se o persistido expirou. Se o admin JWT também
 * expirou e id_token também, o auto-retry em api.js dispara o modal
 * de "sessão expirada".
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
    return {
      user: parsed.user || null,
      idToken: parsed.idToken || null,
      adminJwt: parsed.adminJwt || null,
    };
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

/**
 * Sliding-window: estende `expiresAt` pra now + 8h. Chamado a cada call
 * admin bem-sucedida (em api.js), com throttle interno pra não martelar
 * o localStorage. Resultado: enquanto o user tiver atividade, a sessão
 * nunca expira; quando largar a aba, a 8h conta normalmente.
 *
 * Throttle de 60s (em memória) — escritas no localStorage são baratas
 * mas não-grátis, e ficar reescrevendo o mesmo blob a cada click é
 * desnecessário. 1x por minuto é suficiente pra manter a janela viva.
 *
 * No-op se não há sessão (não cria sessão "do nada" — só estende uma
 * existente).
 */
let _lastTouchMs = 0;
const _TOUCH_THROTTLE_MS = 60 * 1000;
export function touchSession() {
  const now = Date.now();
  if (now - _lastTouchMs < _TOUCH_THROTTLE_MS) return;
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.expiresAt) return;
    if (now > parsed.expiresAt) {
      // Já expirou — não estende, deixa loadSession() limpar na próxima leitura.
      return;
    }
    parsed.expiresAt = now + SESSION_TTL_MS;
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify(parsed));
    _lastTouchMs = now;
  } catch {
    /* ignore */
  }
}

/**
 * Atualiza apenas o `idToken` da sessão existente, preservando o
 * `expiresAt` original. Usado pelo refresh silencioso do Google: o
 * id_token novo (~1h de TTL) substitui o antigo, mas a janela de 8h
 * da sessão admin continua contando desde o login inicial.
 *
 * No-op se não há sessão ou se a janela de 8h já expirou.
 */
export function updateSessionIdToken(idToken) {
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.expiresAt || Date.now() > parsed.expiresAt) {
      localStorage.removeItem(LS_SESSION_KEY);
      return;
    }
    parsed.idToken = idToken;
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify(parsed));
  } catch {
    /* ignore */
  }
}

/**
 * Persiste o admin JWT mintado pelo backend dentro da sessão. Chamado
 * por `getOrIssueAdminJwt()` depois de mintar com sucesso, pra que
 * refresh da aba não perca o JWT (e não force re-mint via id_token,
 * que pode ter expirado).
 *
 * No-op se não há sessão ou se a janela de 8h já expirou.
 */
export function updateSessionAdminJwt(adminJwt) {
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.expiresAt || Date.now() > parsed.expiresAt) {
      localStorage.removeItem(LS_SESSION_KEY);
      return;
    }
    parsed.adminJwt = adminJwt;
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify(parsed));
  } catch {
    /* ignore */
  }
}

// ─── Google id_token getter (delega para a sessão) ──────────────────────────
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
// Cache em memória pra que uma sequência de ações admin (save_logo,
// save_loom, etc) na mesma aba não fique relendo localStorage. Backed por
// localStorage (`hypr.session.adminJwt`) pra sobreviver a refresh da aba.
let _cachedAdminJwt = null;
let _cachedExpiryMs = 0;
const _RENEW_BUFFER_MS = 60 * 1000; // re-minta 1min antes da expiração

// Promise in-flight pra dedupe de mint concorrente. Sem isso, N calls
// admin que 401am em paralelo (ex: 5 calls de uma listagem ao abrir a
// página) cada uma chama issue_admin_token simultaneamente, e cada
// chamada do backend faz round-trip pro tokeninfo do Google (50-150ms).
// Resultado: 5 tokeninfo paralelos + 5 escritas race no localStorage.
let _mintInFlight = null;

function _hydrateFromSession() {
  // Lê o JWT persistido. Só hidrata cache se ainda válido (com buffer).
  const session = loadSession();
  if (!session?.adminJwt) return;
  const payload = decodeJwtPayload(session.adminJwt);
  const expMs = Number(payload?.exp || 0) * 1000;
  if (expMs && Date.now() < expMs - _RENEW_BUFFER_MS) {
    _cachedAdminJwt = session.adminJwt;
    _cachedExpiryMs = expMs;
  }
}

/**
 * Returns a valid admin JWT, minting a fresh one if needed.
 *
 * Ordem de busca:
 *   1. Cache em memória (rápido, mesma aba)
 *   2. localStorage via loadSession() (sobrevive refresh)
 *   3. Mint via id_token + backend (último recurso, exige id_token válido)
 *
 * Returns null se nenhum dos caminhos resultar em JWT válido — o caller
 * (tipicamente o wrapper apiFetch em api.js) trata como sessão expirada.
 */
export async function getOrIssueAdminJwt() {
  if (_cachedAdminJwt && Date.now() < _cachedExpiryMs - _RENEW_BUFFER_MS) {
    touchSession();
    return _cachedAdminJwt;
  }
  // Cache em memória vazio ou expirado — tenta hidratar do localStorage.
  _hydrateFromSession();
  if (_cachedAdminJwt && Date.now() < _cachedExpiryMs - _RENEW_BUFFER_MS) {
    touchSession();
    return _cachedAdminJwt;
  }
  // localStorage vazio ou expirado — tenta mintar via id_token.
  const idToken = getGoogleIdToken();
  if (!idToken) return null;
  // Dedup de mint concorrente: se já há um mint em voo, retorna o mesmo
  // promise pra todos os callers em paralelo. Sem isso, N calls admin que
  // 401am juntas geram N tokeninfo round-trips no backend.
  if (!_mintInFlight) {
    _mintInFlight = issueAdminJwt(idToken).finally(() => {
      _mintInFlight = null;
    });
  }
  const issued = await _mintInFlight;
  if (issued?.token) {
    _cachedAdminJwt = issued.token;
    const ttlSec = Number(issued.ttl) || 8 * 60 * 60;
    _cachedExpiryMs = Date.now() + ttlSec * 1000;
    updateSessionAdminJwt(issued.token);
    touchSession();
    return _cachedAdminJwt;
  }
  return null;
}

export function clearCachedAdminJwt() {
  _cachedAdminJwt = null;
  _cachedExpiryMs = 0;
  // Também invalida o JWT persistido — chamado em logout e em 401 pra
  // forçar re-mint na próxima call (não em cada 401, ver api.js).
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    parsed.adminJwt = null;
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify(parsed));
  } catch {
    /* ignore */
  }
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
