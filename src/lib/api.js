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
 */
export async function listCampaigns() {
  try {
    const jwt = await getOrIssueAdminJwt();
    const r = await fetch(`${API_URL}?list=true`, {
      headers: { ...adminAuthHeaders(jwt) },
    });
    const d = await r.json();
    const raw = d.campaigns || [];
    const seen = new Set();
    return raw.filter(c => {
      if (seen.has(c.short_token)) return false;
      seen.add(c.short_token);
      return true;
    });
  } catch {
    return [];
  }
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
