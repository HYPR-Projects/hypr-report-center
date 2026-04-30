/**
 * API client — camada única de comunicação com o backend.
 *
 * Por que existe
 * --------------
 * Antes desta camada, fetches estavam espalhados em 6 arquivos com 14 chamadas
 * diferentes, cada uma reconstruindo URL, headers e parsing à mão. Mudanças no
 * contrato do backend (renomear action, adicionar header, mudar formato de
 * erro) exigiam edição em todos os pontos. Aqui tudo vive num único módulo.
 *
 * Convenções
 * ----------
 * - Toda função retorna o JSON parseado (ou null/array vazio em caminhos de
 *   "falha silenciosa" que o front já tratava antes — preservamos comportamento).
 * - Funções admin recebem `adminJwt` como parâmetro explícito quando o caller
 *   já tem o JWT em mão (ex.: ClientDashboard recebe via prop). Quando o
 *   caller é o menu (que opera com JWT em cache no módulo auth), as funções
 *   chamam `getOrIssueAdminJwt()` internamente.
 * - Erros de rede são propagados via `throw` quando o caller original tratava
 *   com try/catch; preservamos o mesmo contrato pra não mudar comportamento.
 *
 * Importante: este módulo NÃO altera nenhum comportamento existente. É puro
 * recortar e colar com nomes melhores. Se o build passa e cada chamada continua
 * fazendo a mesma request HTTP que fazia antes, está correto.
 */

import { API_URL } from "../shared/config";
import { adminAuthHeaders, getOrIssueAdminJwt } from "../shared/auth";

// ── Helpers internos ─────────────────────────────────────────────────────────

const jsonHeaders = { "Content-Type": "application/json" };

async function postJson(url, body, extraHeaders = {}) {
  return fetch(url, {
    method: "POST",
    headers: { ...jsonHeaders, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

// ── Campaign reads (públicas, usam short_token como ticket) ──────────────────

/**
 * Busca dados completos de uma campanha pelo short_token.
 * Lança erro em status != 2xx ou se response.campaign for null.
 * Usado pelo ClientDashboard ao carregar /report/:token.
 */
export async function getCampaign(token) {
  const r = await fetch(`${API_URL}?token=${encodeURIComponent(token)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (!d.campaign) throw new Error("Campanha não encontrada");
  return d;
}

/**
 * Variante usada pelo CampaignMenu.checkToken — só verifica se token existe,
 * sem lançar erro em "não encontrado". Retorna { campaign } ou null.
 */
export async function checkCampaignToken(token) {
  try {
    const r = await fetch(`${API_URL}?token=${encodeURIComponent(token)}`);
    const d = await r.json();
    return d?.campaign ? d : null;
  } catch {
    return null;
  }
}

// ── Campaigns list (admin) ───────────────────────────────────────────────────

/**
 * Lista todas as campanhas (admin only). Faz dedupe por short_token.
 * Em falha, retorna [] — mesmo comportamento defensivo do CampaignMenu.fetchList.
 *
 * Se o id_token do Google estiver expirado (TTL ~1h), o backend rejeita
 * com 401. Nesse caso limpa a sessão e recarrega pra UI mandar o usuário
 * pra tela de login em vez de mostrar "0 campanhas" silenciosamente.
 */
export async function listCampaigns() {
  try {
    const jwt = await getOrIssueAdminJwt();
    const r = await fetch(`${API_URL}?list=true`, {
      headers: { ...adminAuthHeaders(jwt) },
    });
    if (r.status === 401 || r.status === 403) {
      // Token expirou no meio da sessão. Limpa e recarrega pra reabrir login.
      try { localStorage.removeItem("hypr.session"); } catch { /* ignore */ }
      window.location.reload();
      return [];
    }
    const d = await r.json();
    const raw = d.campaigns || [];
    const seen = new Set();
    const filtered = raw.filter(c => {
      if (seen.has(c.short_token)) return false;
      seen.add(c.short_token);
      return true;
    });
    // Pré-popula cache local de share_ids com o que vem no payload
    // (Frente 2 — backend agora devolve share_id no ?list=true). Resultado:
    // clicks em "Link Cliente" são instantâneos desde o primeiro,
    // em qualquer device e qualquer sessão. Campanhas sem share_id ainda
    // criado caem no fallback on-demand do `getShareId`.
    for (const c of filtered) {
      if (c.share_id) setCachedShareId(c.short_token, c.share_id);
    }
    return filtered;
  } catch {
    return [];
  }
}

/**
 * Lista clientes agregados + worklist para a view "Por cliente" do
 * menu admin V2.
 *
 * Tenta o endpoint nativo `?action=list_clients` (PR-1 do redesign).
 * Se o backend ainda não tem (404) ou falha (5xx), faz fallback
 * derivando agregação client-side a partir de `listCampaigns()`. O
 * fallback não tem sparkline nem trend (essas exigem query temporal
 * que só o backend faz), mas todo o resto funciona.
 *
 * Retorno:
 *   { clients: [...], worklist: {...}, source: "backend" | "client" }
 *
 * O campo `source` permite ao caller mostrar (no DevTools) se está
 * usando o backend nativo ou caiu no fallback. Útil pra deploys
 * graduais onde o frontend chega antes da Cloud Function nova.
 */
export async function listClients() {
  // 1ª tentativa — endpoint nativo
  try {
    const jwt = await getOrIssueAdminJwt();
    if (!jwt) throw new Error("no admin jwt");
    const r = await fetch(`${API_URL}?action=list_clients`, {
      headers: { ...adminAuthHeaders(jwt) },
    });
    if (r.status === 401 || r.status === 403) {
      try { localStorage.removeItem("hypr.session"); } catch { /* ignore */ }
      window.location.reload();
      return { clients: [], worklist: emptyWorklist(), source: "backend" };
    }
    if (r.ok) {
      const d = await r.json();
      return {
        clients:  d.clients  || [],
        worklist: d.worklist || emptyWorklist(),
        source:   "backend",
      };
    }
    // qualquer outro status (404 quando deploy do backend ainda não rolou,
    // 5xx em falhas pontuais) cai no fallback abaixo sem propagar erro.
  } catch {
    // erro de rede ou JWT — segue pra fallback
  }

  // 2ª tentativa — agregação client-side a partir da lista de campanhas
  try {
    const campaigns = await listCampaigns();
    const { aggregateClients, computeWorklist } = await import(
      "../v2/admin/lib/aggregation.js"
    );
    return {
      clients:  aggregateClients(campaigns),
      worklist: computeWorklist(campaigns),
      source:   "client",
    };
  } catch {
    return { clients: [], worklist: emptyWorklist(), source: "client" };
  }
}

function emptyWorklist() {
  return {
    pacing_critical:    { count: 0, tokens: [] },
    no_owner:           { count: 0, tokens: [] },
    ending_soon:        { count: 0, tokens: [] },
    reports_not_viewed: { count: 0, tokens: [] },
  };
}

// ── Team / owners (admin) ────────────────────────────────────────────────────

/**
 * Lista membros do time (CPs e CSs) lidos da planilha de De-Para.
 * Falha silenciosa: retorna { cps: [], css: [] } se backend não tem o endpoint
 * ainda (rollout) ou se JWT indisponível.
 */
export async function listTeamMembers() {
  try {
    const jwt = await getOrIssueAdminJwt();
    if (!jwt) return { cps: [], css: [] };
    const r = await fetch(`${API_URL}?action=list_team_members`, {
      headers: { ...adminAuthHeaders(jwt) },
    });
    if (!r.ok) return { cps: [], css: [] };
    const d = await r.json();
    return { cps: d.cps || [], css: d.css || [] };
  } catch {
    return { cps: [], css: [] };
  }
}

/**
 * Salva os emails de CP/CS de uma campanha. Lança erro em status != 2xx
 * pra o caller (modal) mostrar alerta.
 */
export async function saveReportOwner({ short_token, cp_email, cs_email }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(
    `${API_URL}?action=save_report_owner`,
    { short_token, cp_email, cs_email },
    adminAuthHeaders(jwt),
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

// ── Share IDs (admin) ────────────────────────────────────────────────────────

/**
 * Cache localStorage dos share_ids resolvidos. Share_id é permanente uma vez
 * criado (16 chars URL-safe, sem expiração no banco), então cachear no
 * dispositivo é seguro e elimina round-trip pro backend a cada click em
 * "Link Cliente".
 *
 * Antes: cada click → cloud function (potencial cold start 1-3s) + query
 *        BigQuery + JWT auth = 1-4s de latência percebida pelo admin.
 * Agora: primeiro click custa o mesmo (cria/busca no banco e cacheia);
 *        clicks subsequentes na mesma campanha = instantâneo (cache hit).
 *
 * Se em algum momento o backend passar a devolver share_id no payload de
 * `?list=true` (Frente 2), basta popular este cache no `listCampaigns`
 * que o copyLink já fica zero-latency desde o primeiro click.
 */
const SHARE_ID_CACHE_KEY = "hypr.share_ids";

function readShareIdCache() {
  try {
    return JSON.parse(localStorage.getItem(SHARE_ID_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeShareIdCache(map) {
  try {
    localStorage.setItem(SHARE_ID_CACHE_KEY, JSON.stringify(map));
  } catch {
    /* quota exceeded ou storage indisponível — falha graciosa */
  }
}

export function getCachedShareId(short_token) {
  if (!short_token) return null;
  return readShareIdCache()[short_token] || null;
}

export function setCachedShareId(short_token, share_id) {
  if (!short_token || !share_id) return;
  const map = readShareIdCache();
  if (map[short_token] === share_id) return;
  map[short_token] = share_id;
  writeShareIdCache(map);
}

/**
 * Retorna o `share_id` público de uma campanha. Cria sob demanda no backend
 * se ainda não existir (idempotente). Usado pelo botão "Link Cliente" para
 * gerar URLs compartilháveis sem expor a senha (short_token) no path.
 *
 * Cache local elimina round-trip em clicks subsequentes — share_id é
 * permanente, então cachear é seguro.
 *
 * Se o backend não tem o endpoint ainda (rollout em andamento) ou o JWT
 * estiver indisponível, retorna null — o caller cai no formato legacy
 * (URL com short_token) sem quebrar o fluxo.
 */
export async function getShareId(short_token) {
  // Fast path: cache hit (clicks subsequentes na mesma campanha)
  const cached = getCachedShareId(short_token);
  if (cached) return cached;

  try {
    const jwt = await getOrIssueAdminJwt();
    if (!jwt) return null;
    const r = await fetch(
      `${API_URL}?action=get_share_id&token=${encodeURIComponent(short_token)}`,
      { headers: { ...adminAuthHeaders(jwt) } },
    );
    if (!r.ok) return null;
    const d = await r.json();
    const share_id = d?.share_id || null;
    setCachedShareId(short_token, share_id);
    return share_id;
  } catch {
    return null;
  }
}

/**
 * Resolve um share_id → short_token sem senha. Admin-only.
 *
 * Caso de uso: admin colou uma URL com share_id em outra aba/janela
 * enquanto ainda está com sessão admin ativa. App pula a tela de senha,
 * mas o dashboard precisa do short_token canônico pra chamar os
 * endpoints de dados. Este lookup faz isso autenticado pelo JWT admin.
 *
 * Retorna null em qualquer falha — caller deve mostrar erro pro admin
 * (provavelmente share_id digitado errado ou link de outra campanha).
 */
export async function lookupShare(share_id) {
  try {
    const jwt = await getOrIssueAdminJwt();
    if (!jwt) return null;
    const r = await fetch(
      `${API_URL}?action=lookup_share&share_id=${encodeURIComponent(share_id)}`,
      { headers: { ...adminAuthHeaders(jwt) } },
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d?.short_token || null;
  } catch {
    return null;
  }
}

// ── Logo (admin) ─────────────────────────────────────────────────────────────

/**
 * Salva o logo (base64) de uma campanha. Não lança em falha — caller original
 * usava try/catch e console.warn pra falha silenciosa no fluxo "criar nova".
 */
export async function saveLogo({ short_token, logo_base64 }) {
  const jwt = await getOrIssueAdminJwt();
  return postJson(
    `${API_URL}?action=save_logo`,
    { short_token, logo_base64 },
    adminAuthHeaders(jwt),
  );
}

// ── Loom (admin) ─────────────────────────────────────────────────────────────

export async function saveLoom({ short_token, loom_url }) {
  const jwt = await getOrIssueAdminJwt();
  return postJson(
    `${API_URL}?action=save_loom`,
    { short_token, loom_url },
    adminAuthHeaders(jwt),
  );
}

// ── Survey (admin) ───────────────────────────────────────────────────────────

/**
 * Salva configuração do survey (lista de perguntas com URLs ctrl/exp).
 * `survey_data` deve ser string JSON pronta — o backend só armazena.
 */
export async function saveSurvey({ short_token, survey_data }) {
  const jwt = await getOrIssueAdminJwt();
  return postJson(
    `${API_URL}?action=save_survey`,
    { short_token, survey_data },
    adminAuthHeaders(jwt),
  );
}

/**
 * Proxy do Typeform para evitar CORS. Caller (SurveyTab) recebe o JSON cru
 * com formato { type: "choice"|"matrix", ... }. Lança em status != 2xx.
 */
export async function fetchTypeformViaProxy(formUrl) {
  const url = `${API_URL}?action=typeform_proxy&form_url=${encodeURIComponent(formUrl)}`;
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// ── Comments / chat ──────────────────────────────────────────────────────────

/**
 * Busca comentários de uma campanha. Falha silenciosa retorna [].
 * `options.signal` permite cancelamento via AbortController (usado pelo TabChat).
 */
export async function getComments(token, options = {}) {
  try {
    const r = await fetch(
      `${API_URL}?action=get_comments&token=${encodeURIComponent(token)}`,
      { signal: options.signal },
    );
    const d = await r.json();
    return d?.comments || [];
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    return [];
  }
}

/**
 * Envia comentário. Quando author === "HYPR", exige adminJwt — sem ele
 * alguém poderia se passar pela HYPR. Cliente comenta sem auth.
 */
export async function saveComment({ short_token, metric_name, author, comment, adminJwt }) {
  const authHeaders = author === "HYPR" ? adminAuthHeaders(adminJwt) : {};
  return postJson(
    `${API_URL}?action=save_comment`,
    { short_token, metric_name, author, comment },
    authHeaders,
  );
}

// ── Alcance & Frequência (admin) ─────────────────────────────────────────────

export async function saveAlcanceFrequencia({ short_token, alcance, frequencia, adminJwt }) {
  return postJson(
    `${API_URL}?action=save_af`,
    { short_token, alcance, frequencia },
    adminAuthHeaders(adminJwt),
  );
}

// ── Upload RMND/PDOOH (admin) ────────────────────────────────────────────────

/**
 * Persiste o JSON parseado do upload no backend. Não bloqueia UI — caller
 * original usa .catch(console.warn). Mantemos esse contrato.
 */
export async function saveUpload({ short_token, type, data_json, adminJwt }) {
  return postJson(
    `${API_URL}?action=save_upload`,
    { short_token, type, data_json },
    adminAuthHeaders(adminJwt),
  );
}
