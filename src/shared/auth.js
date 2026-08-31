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

import { API_URL } from "./config.js";
import { evictStaleCache, evictAllCache } from "../lib/persistedCache.js";

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
 * Persiste user + Google id_token (+ admin JWT) com TTL de 8h. Substitui o
 * antigo sessionStorage que morria com a aba.
 *
 * `adminJwt` é opcional por compatibilidade, mas o caminho de login passa o
 * JWT AQUI, junto: a tela de login só considera a entrada bem-sucedida depois
 * de trocar o id_token pelo JWT do backend (ver LoginScreen). Gravar os dois
 * de uma vez é o que garante que não existe sessão persistida sem credencial
 * de trabalho — que era o estado em que o app entrava, batia 401 em tudo e
 * voltava pro login em laço.
 *
 * DEVOLVE se conseguiu gravar — mas ABRE ESPAÇO antes de desistir.
 *
 * O caso real que ensinou isso: o cache persistido (`hypr.cache.*`) guarda a
 * lista de campanhas e nunca apagava as entradas de builds antigos, então o
 * localStorage do domínio ia enchendo deploy a deploy até o teto de ~5MB.
 * Nesse estado, gravar POR CIMA da sessão existente ainda funcionava (mesma
 * chave, tamanho parecido, não pede quota nova) — foi o que manteve o
 * problema invisível. No dia em que a sessão cresceu alguns bytes (o admin
 * JWT passou a ser gravado junto), o `setItem` começou a estourar quota.
 *
 * Cache é reconstruível com um fetch; sessão não é. Então quota estourada
 * não é motivo pra falhar: é motivo pra jogar cache fora e gravar.
 */
export function saveSession(user, idToken, adminJwt = null, ttlSeconds = 0) {
  const payload = JSON.stringify({
    user,
    idToken,
    adminJwt,
    // Prazo do JWT medido pelo relógio DESTA máquina (ver `adminJwtUntil`
    // em _hydrateFromSession): duração é comparável entre relógios
    // diferentes, instante não é.
    adminJwtUntil: adminJwt ? Date.now() + (Number(ttlSeconds) || 8 * 60 * 60) * 1000 : 0,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  const write = () => {
    try {
      localStorage.setItem(LS_SESSION_KEY, payload);
      return true;
    } catch {
      return false;
    }
  };
  if (write()) return true;
  // 1ª tentativa de espaço: o cache que a própria leitura já ignora.
  if (evictStaleCache() > 0 && write()) return true;
  // 2ª: todo o cache. Perde-se o paint instantâneo da próxima visita, que é
  // um preço óbvio ao lado de não conseguir manter alguém logado.
  if (evictAllCache() > 0 && write()) return true;
  // Aqui sim é bloqueio de verdade (política, extensão, modo privado).
  return false;
}

/**
 * O localStorage deste navegador aceita escrita?
 *
 * Não dá pra inferir de `loadSession()`: sessão ausente é indistinguível de
 * armazenamento bloqueado, e os dois levam a sintomas completamente
 * diferentes (um é "faça login", o outro é "seu navegador está bloqueando
 * este site"). A sonda escreve e apaga uma chave própria.
 */
export function storageWritable() {
  const probe = "hypr.__probe";
  try {
    // Sonda do TAMANHO de uma sessão (~4KB), não de um byte. Com 1 byte ela
    // respondia "ok" num navegador onde gravar a sessão estourava quota — e
    // o rodapé de diagnóstico exibia "armazenamento: ok" ao lado de uma
    // mensagem dizendo que o armazenamento estava bloqueado. Sonda que não
    // mede o que interessa é pior que sonda nenhuma.
    localStorage.setItem(probe, "x".repeat(4096));
    localStorage.removeItem(probe);
    return true;
  } catch {
    try { localStorage.removeItem(probe); } catch { /* ignore */ }
    return false;
  }
}

/**
 * Desvio entre o relógio do SERVIDOR e o deste computador, em ms, medido no
 * ato do mint: positivo = este computador está atrasado; negativo =
 * adiantado.
 *
 * `exp` vem do backend (relógio dele) e `ttl` é a janela que ele mesmo
 * declarou, então `exp - ttl` é "agora" segundo o servidor. Comparado com o
 * `Date.now()` local, dá o desvio.
 *
 * Serve pra duas coisas: avisar o operador quando o relógio da máquina dele
 * está errado (é ele que conserta, em dois cliques) e deixar o desvio à
 * vista num print da tela de login.
 */
export function measureClockSkewMs(adminJwt, ttlSeconds) {
  const exp = Number(decodeJwtPayload(adminJwt)?.exp || 0);
  const ttl = Number(ttlSeconds || 0);
  if (!exp || !ttl) return null;
  return (exp - ttl) * 1000 - Date.now();
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
      // Precisa vir junto: é por este prazo (medido no relógio local, ver
      // saveSession) que o cache decide se o JWT ainda serve. Sem ele nesta
      // projeção, quem lê a sessão caía sempre no `exp` do token — que é do
      // relógio do servidor, exatamente o que essa mudança evita.
      adminJwtUntil: Number(parsed.adminJwtUntil || 0),
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
 * Derruba a sessão gravada SOMENTE se ela for a que esta aba estava usando.
 * Devolve `true` se derrubou (ou se já não havia nada), `false` se deixou
 * quieto porque a sessão gravada é outra.
 *
 * O BUG QUE ISTO RESOLVE
 * ──────────────────────────────────────────────────────────────────────────
 * `localStorage` é COMPARTILHADO por todas as abas do mesmo domínio, e é lá
 * que a sessão admin vive. Uma aba esquecida aberta desde ontem continua
 * pollando (frescor das bases, saúde das DSPs) com credencial morta, leva
 * 401 — e o handler de 401 apagava a chave. Só que a chave apagada era a
 * MESMA que a aba nova tinha acabado de gravar ao fazer login. Pra quem
 * estava logando o efeito era "entrei e o sistema disse que minha sessão
 * expirou", numa aba onde nada estava errado. Foi o que travou um operador
 * por uma manhã inteira — a aba culpada estava em outra janela.
 *
 * A regra aqui é a mínima que fecha isso: 401 de uma credencial só autoriza
 * derrubar ESSA credencial. Se o storage tem outra, ela é de um login mais
 * novo e não é desta aba pra jogar fora.
 */
export function clearSessionIfCurrent(adminJwt) {
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    if (adminJwt) {
      // Credencial diferente da que falhou → login mais novo, preserva.
      if (parsed?.adminJwt && parsed.adminJwt !== adminJwt) return false;
    } else {
      // Esta aba falhou SEM credencial — não sabe nada sobre a sessão que
      // está gravada agora. Só derruba se ela também estiver morta.
      //
      // "Morta" tem que olhar a CREDENCIAL, não só a janela de 8h: sessão
      // com JWT vencido e janela viva existe (máquina que dormiu, aba de
      // ontem) e é exatamente a que precisa sair do caminho — senão a aba
      // nova fica presa num estado sem credencial, sem modal e sem tela de
      // login, o pior dos três.
      const jwtAlive = !!parsed?.adminJwt && (
        Number(parsed.adminJwtUntil || 0) > Date.now()
        || (!parsed.adminJwtUntil && !isJwtExpired(parsed.adminJwt))
      );
      const windowAlive = !!parsed?.expiresAt && Date.now() <= parsed.expiresAt;
      if (jwtAlive && windowAlive) return false;
    }
    localStorage.removeItem(LS_SESSION_KEY);
    return true;
  } catch {
    return true;
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
export function updateSessionAdminJwt(adminJwt, ttlSeconds = 0) {
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.expiresAt || Date.now() > parsed.expiresAt) {
      localStorage.removeItem(LS_SESSION_KEY);
      return;
    }
    parsed.adminJwt = adminJwt;
    parsed.adminJwtUntil = Date.now() + (Number(ttlSeconds) || 8 * 60 * 60) * 1000;
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
 * Troca o id_token do Google pelo admin JWT do backend.
 *
 * Sucesso  → `{ token, email, ttl }`
 * Recusa   → `{ token: null, status, reason }`  (nunca null seco)
 *
 * O shape de falha é objeto, não `null`, porque quem chama precisa saber a
 * DIFERENÇA entre "o backend recusou esta conta" (status 401/403, `reason`
 * vindo de backend/auth.py) e "não deu pra perguntar agora" (rede fora,
 * 5xx, endpoint ausente). São dois problemas com donos diferentes: o
 * primeiro é conta/Workspace, o segundo é infra — e o front tratava os dois
 * como o mesmo `null`, o que virava um loop de login sem explicação.
 *
 * Callers antigos que só testam `issued?.token` continuam corretos.
 */
export async function issueAdminJwt(googleIdToken) {
  if (!googleIdToken) return { token: null, status: 0, reason: "missing_id_token" };
  let res;
  try {
    res = await fetch(`${API_URL}?action=issue_admin_token`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${googleIdToken}`,
        "Content-Type": "application/json",
      },
    });
  } catch {
    // Rede fora, CORS, backend inalcançável — não houve veredito.
    return { token: null, status: 0, reason: "network_error" };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* corpo vazio ou não-JSON — segue com data = null */
  }
  if (!res.ok || !data?.token) {
    return {
      token: null,
      status: res.status,
      // `reason` do backend quando existe; senão o status conta a história.
      reason: data?.reason || (res.ok ? "malformed_response" : `http_${res.status}`),
    };
  }
  return data;
}

/**
 * Renova um admin JWT ainda válido SEM passar pelo Google
 * (`?action=refresh_admin_token`, ver backend/auth.py::refresh_admin_jwt).
 *
 * Sucesso  → `{ token, ttl }`.
 * Recusa   → `{ token: null, status, reason }` (nunca null seco — mesmo
 * shape de `issueAdminJwt`, pelo mesmo motivo: quem chama precisa saber a
 * diferença entre "o backend respondeu e recusou" (status != 0 — JWT
 * inválido, sessão estourou o teto) e "não deu pra perguntar" (status 0 —
 * rede fora, timeout). Antes os dois casos viravam o mesmo `null`, e
 * `getOrIssueAdminJwt` reofertava a credencial morta como "última
 * instância" mesmo depois do backend já ter recusado explicitamente —
 * deixando o app preso no banner de "dados desatualizados" pra sempre, sem
 * nunca escalar pro modal de sessão expirada. Ver `getOrIssueAdminJwt` pra
 * onde essa distinção é usada.
 *
 * É isto que faz "loguei de manhã" durar o dia: a renovação deixa de
 * depender do id_token do Google, que vive ~1h e é renovado por One Tap
 * silencioso — mecanismo que falha calado em navegador com FedCM ou cookies
 * de terceiros bloqueados. Quando ele falha, sem esta rota a sessão morre no
 * meio da tarde e a pessoa acha que "o sistema desloga o tempo todo". O
 * Google volta a ser necessário quando a jornada estoura o teto do backend
 * ou quando o JWT expira de vez sem uso.
 */
export async function refreshAdminJwt(currentJwt) {
  if (!currentJwt) return { token: null, status: 0, reason: "missing_token" };
  let res;
  try {
    res = await fetch(`${API_URL}?action=refresh_admin_token`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${currentJwt}`,
        "Content-Type": "application/json",
      },
    });
  } catch {
    // Rede fora, CORS, backend inalcançável — não houve veredito.
    return { token: null, status: 0, reason: "network_error" };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* corpo vazio ou não-JSON — segue com data = null */
  }
  if (!res.ok || !data?.token) {
    return {
      token: null,
      status: res.status,
      reason: data?.reason || (res.ok ? "malformed_response" : `http_${res.status}`),
    };
  }
  return data;
}

// ─── Cached JWT for the menu tab ─────────────────────────────────────────────
// Cache em memória pra que uma sequência de ações admin (save_logo,
// save_loom, etc) na mesma aba não fique relendo localStorage. Backed por
// localStorage (`hypr.session.adminJwt`) pra sobreviver a refresh da aba.
let _cachedAdminJwt = null;
let _cachedExpiryMs = 0;
// Renova 30min antes de vencer, não 1min. Com 1min, a renovação acontecia
// no último instante possível — e se ela falhasse ali (id_token do Google já
// morto, rede oscilando) a pessoa era jogada pro login sem aviso, no meio do
// expediente. 30min dão espaço pra tentar, falhar e tentar de novo em vários
// ciclos antes de a credencial atual virar pó.
const _RENEW_BUFFER_MS = 30 * 60 * 1000;

// Promise in-flight pra dedupe de mint concorrente. Sem isso, N calls
// admin que 401am em paralelo (ex: 5 calls de uma listagem ao abrir a
// página) cada uma chama issue_admin_token simultaneamente, e cada
// chamada do backend faz round-trip pro tokeninfo do Google (50-150ms).
// Resultado: 5 tokeninfo paralelos + 5 escritas race no localStorage.
let _mintInFlight = null;
// Mesmo motivo do dedupe de mint: N chamadas admin que precisam renovar ao
// mesmo tempo têm que compartilhar uma única renovação.
let _refreshInFlight = null;

function _hydrateFromSession() {
  // Lê o JWT persistido. Só hidrata cache se ainda válido (com buffer).
  //
  // O prazo vem de `adminJwtUntil`, gravado no ato do mint com o relógio
  // DESTA máquina. Antes vinha do `exp` do token, que é do relógio do
  // SERVIDOR — e comparar instante de um relógio com "agora" de outro é o
  // que fazia máquina com data adiantada tratar JWT recém-emitido como
  // vencido. `exp` continua como fallback pra sessões gravadas antes deste
  // campo existir (e `isJwtExpired` já tem tolerância de relógio).
  const session = loadSession();
  if (!session?.adminJwt) return;
  const until = Number(session.adminJwtUntil || 0)
    || Number(decodeJwtPayload(session.adminJwt)?.exp || 0) * 1000;
  if (until && Date.now() < until - _RENEW_BUFFER_MS) {
    _cachedAdminJwt = session.adminJwt;
    _cachedExpiryMs = until;
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
  // A credencial atual está velha (ou dentro da janela de renovação), mas
  // pode ainda ser válida pro backend: tenta renovar com ela ANTES de
  // recorrer ao Google. É o caminho que mantém a jornada de pé quando o
  // refresh silencioso do id_token não acontece.
  const stale = _cachedAdminJwt || loadSession()?.adminJwt || null;
  // true quando o BACKEND respondeu e recusou (status != 0) — diferente de
  // rede fora/timeout (status 0), que é ambíguo e não prova que a
  // credencial morreu. É essa distinção que decide, lá embaixo, se o
  // fallback de última instância pode reofertar `stale` ou se tem que
  // desistir dele de vez.
  let staleConfirmedDead = false;
  if (stale) {
    if (!_refreshInFlight) {
      _refreshInFlight = refreshAdminJwt(stale).finally(() => {
        _refreshInFlight = null;
      });
    }
    const renewed = await _refreshInFlight;
    if (renewed?.token) {
      _adoptFreshJwt(renewed.token, renewed.ttl);
      return _cachedAdminJwt;
    }
    staleConfirmedDead = renewed?.status !== 0;
  }

  // Renovação recusada (jornada estourada, JWT expirado de vez) — só então
  // volta pro Google.
  const idToken = getGoogleIdToken();
  if (!idToken) {
    // Sem id_token pra tentar mintar e a renovação já foi recusada
    // explicitamente pelo backend: mesmo raciocínio do fallback lá embaixo
    // (ver comentário perto de `staleConfirmedDead`) — deixar `stale`
    // gravada faria o próximo 401 encontrar `adminJwtUntil` ainda no
    // futuro e `clearSessionIfCurrent` recusar derrubar a sessão, nunca
    // disparando o modal.
    if (staleConfirmedDead) clearCachedAdminJwt(stale);
    return null;
  }
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
    _adoptFreshJwt(issued.token, issued.ttl);
    return _cachedAdminJwt;
  }

  // Último recurso: nem a renovação nem o mint funcionaram AGORA, mas a
  // credencial atual pode não ter vencido de fato — a gente só entrou na
  // janela de 30min de renovação. Usar a que existe é melhor que devolver
  // nada: o backend ainda a aceita, e devolver null aqui derrubaria a sessão
  // de quem só teve uma oscilação de rede na hora de renovar.
  //
  // MAS só quando a renovação foi ambígua (`!staleConfirmedDead` — rede
  // fora, timeout). Se o backend JÁ respondeu recusando `stale`
  // explicitamente, devolvê-la de novo aqui é reofertar uma credencial que
  // sabemos morta: o caller manda de novo, toma 401 de novo, e como o
  // relógio local (`adminJwtUntil`) ainda marca "não vencido", o handler de
  // 401 em api.js (`clearSessionIfCurrent`) também acha que a sessão está
  // viva e recusa derrubá-la — ninguém nunca chama `emitSessionExpired()`.
  // Resultado: o app fica preso no banner de "dados desatualizados" pra
  // sempre, sem jamais mostrar o modal de sessão expirada. Nesse caso é
  // melhor derrubar a credencial aqui mesmo e devolver null, pra que o
  // 401 seguinte já ache o storage limpo e escale corretamente.
  const until = Number(loadSession()?.adminJwtUntil || 0);
  if (stale && !staleConfirmedDead && until && Date.now() < until) return stale;
  if (staleConfirmedDead) clearCachedAdminJwt(stale);
  return null;
}

/** Grava um JWT novo em memória e no storage, com prazo medido aqui. */
function _adoptFreshJwt(token, ttlSeconds) {
  const ttlSec = Number(ttlSeconds) || 8 * 60 * 60;
  _cachedAdminJwt = token;
  _cachedExpiryMs = Date.now() + ttlSec * 1000;
  updateSessionAdminJwt(token, ttlSec);
  touchSession();
}

/**
 * Re-hidrata o cache em memória a partir do storage e devolve o JWT adotado
 * quando ele é DIFERENTE do que esta aba tinha. É assim que uma aba velha se
 * conserta sozinha depois que outra aba fez login: no ciclo seguinte de
 * poll/refetch ela já usa a credencial nova, sem reload e sem intervenção.
 */
export function adoptStoredSession() {
  const before = _cachedAdminJwt;
  _cachedAdminJwt = null;
  _cachedExpiryMs = 0;
  _hydrateFromSession();
  return _cachedAdminJwt && _cachedAdminJwt !== before ? _cachedAdminJwt : null;
}

/**
 * `true` quando existe alguma credencial admin plausível (JWT em memória,
 * JWT gravado, ou id_token pra mintar). Serve pros pollers de fundo não
 * dispararem request condenada a 401 — era isso que enchia o console de
 * erro e mantinha aba morta batendo no backend a cada ciclo.
 */
export function hasAdminCredential() {
  if (_cachedAdminJwt) return true;
  const session = loadSession();
  return !!(session?.adminJwt || session?.idToken);
}

/**
 * Avisa quando a sessão muda em OUTRA aba (evento `storage`, que só dispara
 * entre abas diferentes do mesmo domínio). Devolve o desinscritor.
 */
export function onSessionChanged(handler) {
  if (typeof window === "undefined") return () => {};
  const listener = (e) => {
    // `key === null` = alguém chamou localStorage.clear().
    if (e.key === LS_SESSION_KEY || e.key === null) handler();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

// Adoção automática: toda aba passa a acompanhar o login feito nas outras.
// Sem isto, a aba antiga só se recuperaria por reload — e reload automático
// em cima de 401 é exatamente o laço que já custou caro aqui.
if (typeof window !== "undefined") {
  onSessionChanged(() => { adoptStoredSession(); });
}

/**
 * Semeia o cache EM MEMÓRIA com um JWT recém-mintado (usado pela tela de
 * login, que minta antes de deixar entrar).
 *
 * Duas razões:
 *   1. evita um segundo mint na primeira chamada admin da sessão;
 *   2. é o que faz a aba funcionar quando o localStorage está bloqueado —
 *      sem persistência o operador perde a sessão a cada refresh, mas
 *      trabalha na aba aberta em vez de levar 401 em tudo.
 *
 * A validade é contada com o relógio DESTE computador (`Date.now() + ttl`),
 * não com o `exp` do token: `ttl` é uma duração, e duração não depende de os
 * dois relógios concordarem.
 */
export function primeAdminJwt(adminJwt, ttlSeconds) {
  if (!adminJwt) return;
  const ttlSec = Number(ttlSeconds) || 8 * 60 * 60;
  _cachedAdminJwt = adminJwt;
  _cachedExpiryMs = Date.now() + ttlSec * 1000;
}

export function clearCachedAdminJwt(usedJwt = null) {
  const dropped = usedJwt || _cachedAdminJwt;
  _cachedAdminJwt = null;
  _cachedExpiryMs = 0;
  // Invalida o JWT persistido pra forçar renovação na próxima call — mas só
  // se o gravado for o MESMO que falhou. Zerar o campo sem comparar apagava
  // a credencial que outra aba tinha acabado de gravar (mesmo motivo de
  // clearSessionIfCurrent).
  //
  // E sem credencial pra comparar (`dropped` nulo) o storage não é tocado:
  // "eu não tenho credencial" não é motivo pra apagar a que está gravada —
  // ela pode ser de um login feito em outra aba um segundo atrás. Quem quer
  // derrubar a sessão inteira usa clearSession() (é o que o logout faz).
  if (!dropped) return;
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed?.adminJwt && parsed.adminJwt !== dropped) return;
    parsed.adminJwt = null;
    parsed.adminJwtUntil = 0;
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

/**
 * Tolerância de relógio na comparação `exp` (do SERVIDOR) × `Date.now()`
 * (deste computador).
 *
 * Sem ela, computador com a data adiantada transformava JWT recém-emitido em
 * "expirado" ANTES de sair: `adminAuthHeaders` descartava o header, toda
 * chamada admin ia sem credencial, tudo voltava 401 e o operador levava
 * "sua sessão expirou" no primeiro clique — com a conta perfeita, o backend
 * de pé e nada de errado do lado dele além do relógio. Nenhum reinício ou
 * janela anônima resolve isso, porque o relógio é da máquina.
 *
 * 12h é maior que a TTL de 8h de propósito: na prática significa "só
 * descarta o token quando o `exp` for absurdamente antigo". A decisão que
 * vale é do backend, que confere assinatura e expiração com o próprio
 * relógio; aqui é só uma economia de round-trip, e economizar round-trip
 * nunca justificou trancar alguém fora do sistema.
 */
const CLOCK_SKEW_TOLERANCE_MS = 12 * 60 * 60 * 1000;

export function isJwtExpired(token, toleranceMs = CLOCK_SKEW_TOLERANCE_MS) {
  const p = decodeJwtPayload(token);
  if (!p?.exp) return true;
  return Number(p.exp) * 1000 + toleranceMs <= Date.now();
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
