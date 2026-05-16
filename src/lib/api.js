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
import {
  adminAuthHeaders,
  getOrIssueAdminJwt,
  clearCachedAdminJwt,
  loadSession,
  touchSession,
} from "../shared/auth";
import { emitSessionExpired } from "./sessionEvents";
import { isDemoToken, buildDemoPayload, DEMO_TOKEN } from "../shared/demoData";

// ── Helpers internos ─────────────────────────────────────────────────────────

const jsonHeaders = { "Content-Type": "application/json" };

/**
 * POST com JSON. Quando o caller passa header `Authorization` (ou seja,
 * é uma call admin), `postJson` detecta 401/403 e tenta uma vez:
 *   1) Invalida o JWT em cache
 *   2) Re-minta via getOrIssueAdminJwt() (que tenta localStorage primeiro,
 *      depois mint via id_token)
 *   3) Refaz o request com o JWT novo
 *
 * Se o retry também falha (ou se não foi possível mintar JWT novo),
 * emite `session-expired` event pro modal global pegar — e devolve a
 * Response do retry (caller decide se trata).
 *
 * Por que dentro do postJson e não num wrapper separado: zero refactor
 * dos call sites existentes (saveLogo/saveLoom/etc continuam chamando
 * com a mesma assinatura).
 */
async function postJson(url, body, extraHeaders = {}) {
  const init = {
    method: "POST",
    headers: { ...jsonHeaders, ...extraHeaders },
    body: JSON.stringify(body),
  };
  const hasAuthHeader = !!(extraHeaders && extraHeaders.Authorization);
  const res = await fetch(url, init);

  if (res.status !== 401 && res.status !== 403) {
    // Sliding window: cada call admin bem-sucedida estende a janela de
    // 8h em hypr.session. Throttle interno em touchSession() evita
    // escritas redundantes no localStorage.
    if (hasAuthHeader && res.ok) touchSession();
    return res;
  }

  // É call admin se o caller anexou Authorization OU se há sessão admin
  // ativa (caso onde getOrIssueAdminJwt devolveu null em silêncio porque
  // id_token expirou e mint falhou — adminAuthHeaders(null) então virou
  // {} e o request foi sem header. Sem essa segunda checagem o 401 caía
  // num caminho silencioso e a UX quebrava exatamente como o user
  // reclamou).
  const wasAdminAttempt = hasAuthHeader || !!loadSession();
  if (!wasAdminAttempt) return res;

  // Tenta uma vez: invalida cache, re-minta, retry.
  clearCachedAdminJwt();
  const newJwt = await getOrIssueAdminJwt();
  if (newJwt) {
    const retryHeaders = {
      ...jsonHeaders,
      ...extraHeaders,
      Authorization: `Bearer ${newJwt}`,
    };
    const retryRes = await fetch(url, { ...init, headers: retryHeaders });
    if (retryRes.status !== 401 && retryRes.status !== 403) {
      if (retryRes.ok) touchSession();
      return retryRes;
    }
    // Retry também 401 — sessão genuinamente expirou (8h estourados ou
    // backend rejeitou JWT novo).
  }

  // Mint falhou ou retry 401 — emite evento pro modal global. Retorna a
  // response original (caller decide se trata).
  emitSessionExpired();
  return res;
}

// ── Campaign reads (públicas, usam short_token como ticket) ──────────────────

/**
 * Busca dados completos de uma campanha pelo short_token.
 * Lança erro em status != 2xx ou se response.campaign for null.
 * Usado pelo ClientDashboard ao carregar /report/:token.
 *
 * `options.view` (opcional, string): quando o token base pertence a um
 * grupo Merge Reports, passar `view` como o short_token de um membro
 * faz o backend devolver apenas os dados desse membro (drill-down "ver
 * só fevereiro" dentro do report agregado). Sem `view`, o backend
 * detecta o grupo e devolve o payload merged com `merge_meta`.
 */
export async function getCampaign(token, options = {}) {
  // Demo report (`/report/DEMO`) — payload sintético gerado client-side.
  // Não toca BigQuery. Ver shared/demoData.js.
  if (isDemoToken(token)) return buildDemoPayload();
  const params = new URLSearchParams({ token });
  if (options.view) params.set("view", options.view);
  const r = await fetch(`${API_URL}?${params.toString()}`);
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
  if (isDemoToken(token)) return buildDemoPayload();
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
 *
 * Contrato de erro
 * ----------------
 * - Sucesso (200): retorna array (pode ser vazio se backend devolveu
 *   `{campaigns: []}`).
 * - 401/403: dispara `window.location.reload()` pra reabrir login e
 *   lança `Error("admin session expired")` — caller pode ignorar pois
 *   a página vai recarregar.
 * - Qualquer outro erro (5xx, rede, JSON malformado): **lança**.
 *   Versões antigas retornavam `[]` silenciosamente, o que mascarava
 *   falhas como "lista realmente vazia" e gerava o bug de "0 campanhas"
 *   após blip de rede. Agora callers têm que tratar — o pattern
 *   recomendado é stale-while-revalidate via `persistedCache`.
 */
export async function listCampaigns({ refresh = false } = {}) {
  const jwt = await getOrIssueAdminJwt();
  // ?refresh=true bypassa o cache server (`_get_campaigns_list_cached` no
  // backend) e evita o HTTP cache do navegador (URL diferente de `?list=true`
  // sozinho). Usado por mutações que precisam ver efeito imediato (ex.
  // toggle de ABS no CampaignDrawer).
  const url = refresh ? `${API_URL}?list=true&refresh=true` : `${API_URL}?list=true`;
  const r = await fetch(url, {
    headers: { ...adminAuthHeaders(jwt) },
  });
  if (r.status === 401 || r.status === 403) {
    try { localStorage.removeItem("hypr.session"); } catch { /* ignore */ }
    window.location.reload();
    throw new Error("admin session expired");
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (!Array.isArray(d?.campaigns)) {
    throw new Error("malformed response: campaigns missing");
  }
  const seen = new Set();
  const filtered = d.campaigns.filter(c => {
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
 * Retorno em sucesso:
 *   { clients: [...], worklist: {...}, source: "backend" | "client" }
 *
 * Contrato de erro: lança quando ambos endpoint nativo E fallback
 * falham. Caller deve tratar (recomendado: stale-while-revalidate).
 * 401/403 dispara reload do mesmo jeito que `listCampaigns`.
 */
export async function listClients() {
  // 1ª tentativa — endpoint nativo
  let backendErr = null;
  try {
    const jwt = await getOrIssueAdminJwt();
    if (!jwt) throw new Error("no admin jwt");
    const r = await fetch(`${API_URL}?action=list_clients`, {
      headers: { ...adminAuthHeaders(jwt) },
    });
    if (r.status === 401 || r.status === 403) {
      try { localStorage.removeItem("hypr.session"); } catch { /* ignore */ }
      window.location.reload();
      throw new Error("admin session expired");
    }
    if (r.ok) {
      const d = await r.json();
      return {
        clients:  d.clients  || [],
        worklist: d.worklist || emptyWorklist(),
        source:   "backend",
      };
    }
    backendErr = new Error(`HTTP ${r.status}`);
  } catch (e) {
    backendErr = e;
  }

  // 2ª tentativa — agregação client-side a partir da lista de campanhas.
  // listCampaigns agora lança em falha real, então um throw aqui é
  // legítimo: ambos endpoints estão fora.
  const campaigns = await listCampaigns();
  const { aggregateClients, computeWorklist } = await import(
    "../v2/admin/lib/aggregation.js"
  );
  // Log do erro do backend nativo pra DevTools — útil em deploy gradual,
  // não polui UX.
  if (backendErr) {
    console.warn("[listClients] fallback to client-side aggregation:", backendErr.message);
  }
  return {
    clients:  aggregateClients(campaigns),
    worklist: computeWorklist(campaigns),
    source:   "client",
  };
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
 *
 * Lança em erros reais (rede, 5xx, parse). Se o JWT não está disponível
 * (sessão admin nunca iniciou), retorna `{ cps: [], css: [] }` — caso
 * legítimo durante o boot da app, não é falha.
 */
export async function listTeamMembers() {
  const jwt = await getOrIssueAdminJwt();
  if (!jwt) return { cps: [], css: [] };
  const r = await fetch(`${API_URL}?action=list_team_members`, {
    headers: { ...adminAuthHeaders(jwt) },
  });
  if (r.status === 401 || r.status === 403) {
    try { localStorage.removeItem("hypr.session"); } catch { /* ignore */ }
    window.location.reload();
    throw new Error("admin session expired");
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return { cps: d.cps || [], css: d.css || [] };
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
  // Demo report: usa o próprio token como share_id (mantém URL `/report/DEMO`).
  if (isDemoToken(short_token)) return DEMO_TOKEN;
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

/**
 * Lista metadados (sem base64) dos logos já cadastrados em outras
 * campanhas do mesmo cliente do `short_token`. Retorna ordenado por
 * updated_at DESC (mais recente primeiro). Em falha, retorna [].
 */
export async function listClientLogos({ short_token }) {
  try {
    const jwt = await getOrIssueAdminJwt();
    const r = await fetch(
      `${API_URL}?action=list_client_logos&short_token=${encodeURIComponent(short_token)}`,
      { headers: { ...adminAuthHeaders(jwt) } },
    );
    if (!r.ok) return [];
    const d = await r.json();
    return d.items || [];
  } catch {
    return [];
  }
}

/**
 * Busca o logo_base64 de um short_token específico. Usado pelo modal
 * de reaproveitamento, depois que o admin escolheu um item da galeria.
 * Retorna null em falha ou se o token não tem logo.
 */
export async function getLogo({ short_token }) {
  try {
    const jwt = await getOrIssueAdminJwt();
    const r = await fetch(
      `${API_URL}?action=get_logo&short_token=${encodeURIComponent(short_token)}`,
      { headers: { ...adminAuthHeaders(jwt) } },
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d.logo_base64 || null;
  } catch {
    return null;
  }
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

// ── Line items de uma campanha (admin) ──────────────────────────────────────

/**
 * Retorna lista de line items agregados ao período inteiro com métricas
 * brutas (impressions, viewable, clicks, video_starts, video_view_100,
 * total_cost). 1 entry por (line_name, media_type). Usado pelo
 * PerformerDrawer pra mostrar piores LIs.
 */
export async function getCampaignLines({ short_token }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(
    `${API_URL}?action=get_campaign_lines&short_token=${encodeURIComponent(short_token)}`,
    { headers: adminAuthHeaders(jwt) },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json().catch(() => ({}));
  return Array.isArray(d?.lines) ? d.lines : [];
}

// ── Brand Safety pre-bid override (admin) ───────────────────────────────────

/**
 * Lê o override manual de ABS de uma campanha. Retorna { has_abs, updated_by }
 * se admin marcou explicitamente, ou null se nunca foi configurado.
 *
 * Não distingue entre "automático off" e "auto on" — o caller cruza com o
 * payload de /api/admin/campaigns?list=true (campos display_has_abs/video_has_abs)
 * pra decidir se mostra o toggle como auto-detectado (desabilitado) ou
 * editável.
 */
export async function getAbsOverride({ short_token }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(
    `${API_URL}?action=get_abs_override&short_token=${encodeURIComponent(short_token)}`,
    { headers: adminAuthHeaders(jwt) },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json().catch(() => ({}));
  return d?.override ?? null;
}

export async function saveAbsOverride({ short_token, has_abs }) {
  const jwt = await getOrIssueAdminJwt();
  return postJson(
    `${API_URL}?action=save_abs_override`,
    { short_token, has_abs },
    adminAuthHeaders(jwt),
  );
}

// ── Campaign closure (admin) ────────────────────────────────────────────────

/**
 * Marca/desmarca campanha como "encerrada manualmente". Quando true, o
 * backend grava closed_at=NOW na tabela campaign_closures; quando false,
 * remove o registro (volta ao estado derivado por end_date + 30 dias).
 *
 * O frontend usa o campo `closed_at` da lista (junto com end_date) pra
 * derivar 3 estados visuais: in_flight, awaiting_closure, ended.
 *
 * Lança em status != 2xx pra o caller propagar o erro pra UI.
 */
/** Lê o `error` do body em respostas != 2xx pra dar mensagem útil pro caller
 *  (ex: "early_end_date não pode ser posterior ao fim..."). Fallback pra
 *  HTTP status quando o body não é JSON. */
async function throwIfNotOk(r) {
  if (r.ok) return r;
  let msg = `HTTP ${r.status}`;
  try { const d = await r.json(); if (d?.error) msg = d.error; } catch { /* ignore */ }
  throw new Error(msg);
}

export async function saveCampaignClosure({ short_token, closed }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(
    `${API_URL}?action=save_campaign_closure`,
    { short_token, closed: !!closed },
    adminAuthHeaders(jwt),
  );
  return throwIfNotOk(r);
}

/**
 * Pausa/retoma campanha temporariamente. paused=true grava paused_at=NOW
 * em `campaign_pauses`; paused=false remove o registro. Reversível.
 *
 * O frontend usa `paused_at` (junto com end_date e closed_at) pra derivar
 * status="paused" via getCampaignStatus quando a campanha ainda está em
 * vôo. Após end_date, pausa vira metadata e o ciclo natural toma conta.
 */
export async function saveCampaignPause({ short_token, paused }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(
    `${API_URL}?action=save_campaign_pause`,
    { short_token, paused: !!paused },
    adminAuthHeaders(jwt),
  );
  return throwIfNotOk(r);
}

/**
 * Encerramento antecipado da campanha — admin define a data real do fim
 * (≤ end_date original) + motivo opcional. Backend grava em
 * `campaign_early_ends` (upsert). Pacing original é mantido pra mostrar
 * a "perda" (Opção B do design).
 *
 * `reason` é admin-only — sai no payload da lista admin mas NÃO no
 * endpoint público `/api?token=X` que o cliente consome.
 */
export async function saveCampaignEarlyEnd({ short_token, early_end_date, reason }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(
    `${API_URL}?action=save_campaign_early_end`,
    { short_token, early_end_date, reason: reason || "" },
    adminAuthHeaders(jwt),
  );
  return throwIfNotOk(r);
}

/**
 * Reverte encerramento antecipado — apaga o registro em
 * `campaign_early_ends`. Campanha volta ao estado derivado pela end_date
 * original.
 */
export async function clearCampaignEarlyEnd({ short_token }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(
    `${API_URL}?action=delete_campaign_early_end`,
    { short_token },
    adminAuthHeaders(jwt),
  );
  return throwIfNotOk(r);
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
 * Busca a configuração salva de survey de uma campanha. Devolve o JSON
 * cru (string) ou null se nunca foi configurado. Usado pelo SurveyModal
 * pra entrar em modo de edição.
 */
export async function getSurvey({ short_token }) {
  // Demo report: devolve o JSON sintético do payload demo, sem JWT.
  if (isDemoToken(short_token)) {
    return buildDemoPayload().survey;
  }
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(
    `${API_URL}?action=get_survey&short_token=${encodeURIComponent(short_token)}`,
    { headers: adminAuthHeaders(jwt) },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json().catch(() => ({}));
  return d?.survey_data ?? null;
}

/**
 * Lista forms do Typeform na pasta "Survey" (últimos 120 dias). Cacheado
 * server-side por 5min. Devolve { forms: [{id, title, last_updated_at,
 * display_url}], scope: "workspace"|"account", count }.
 */
export async function listTypeformForms({ refresh = false } = {}) {
  const jwt = await getOrIssueAdminJwt();
  const url = `${API_URL}?action=typeform_list_forms${refresh ? "&refresh=true" : ""}`;
  const r = await fetch(url, { headers: adminAuthHeaders(jwt) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
  return d;
}

/**
 * Busca metadados de um form individual do Typeform: { form_id, type:
 * "matrix"|"choice"|"other", rows: [str] }. Usado pelo SurveyModal pra
 * pré-popular o dropdown de marca-foco com as linhas reais quando o
 * form é matrix. Cacheado server-side por 10min.
 */
export async function fetchTypeformFormMeta(formId, { refresh = false } = {}) {
  if (!formId) return null;
  const jwt = await getOrIssueAdminJwt();
  const url = `${API_URL}?action=typeform_form_meta&form_id=${encodeURIComponent(formId)}${refresh ? "&refresh=true" : ""}`;
  const r = await fetch(url, { headers: adminAuthHeaders(jwt) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
  return d;
}

/**
 * Proxy do Typeform para evitar CORS. Caller (SurveyTab) recebe o JSON cru
 * com formato { type: "choice"|"matrix", ... }. Lança em status != 2xx.
 *
 * `range` (opcional, admin-only no front): { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }.
 * Quando presente, filtra respostas pelo período via `since`/`until` da API
 * do Typeform — afeta contagens e lifts retornados.
 */
export async function fetchTypeformViaProxy(formUrl, range = null) {
  const params = new URLSearchParams({ action: "typeform_proxy", form_url: formUrl });
  if (range?.from) params.set("date_from", range.from);
  if (range?.to)   params.set("date_to",   range.to);
  const r = await fetch(`${API_URL}?${params.toString()}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// ── Negotiation (Sales Center) ───────────────────────────────────────────────

/**
 * Busca o checklist comercial cadastrado no Sales Center
 * (`hypr_sales_center.checklists`). Mesmo nível de acesso do report —
 * quem tem o short_token, vê. Retorna o objeto com PI, peças, proposta,
 * features, volumes negociados e times responsáveis. Devolve null
 * quando a campanha não está cadastrada (legacy pre-Sales Center) —
 * caller deve esconder o botão "Negociado" nesse caso.
 *
 * Falha de rede também retorna null (silenciosa) — o botão só some,
 * não polui UX com erro.
 */
export async function getNegotiation(short_token) {
  if (!short_token || isDemoToken(short_token)) return null;
  try {
    const r = await fetch(
      `${API_URL}?action=get_negotiation&short_token=${encodeURIComponent(short_token)}`,
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d?.negotiation ?? null;
  } catch {
    return null;
  }
}

// ── Comments / chat ──────────────────────────────────────────────────────────

/**
 * Busca comentários de uma campanha. Falha silenciosa retorna [].
 * `options.signal` permite cancelamento via AbortController (usado pelo TabChat).
 */
export async function getComments(token, options = {}) {
  if (isDemoToken(token)) return [];
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
  // Demo report — comentários não persistem (no-op silencioso).
  if (isDemoToken(short_token)) return new Response(null, { status: 200 });
  const authHeaders = author === "HYPR" ? adminAuthHeaders(adminJwt) : {};
  return postJson(
    `${API_URL}?action=save_comment`,
    { short_token, metric_name, author, comment },
    authHeaders,
  );
}

// ── Alcance & Frequência (admin) ─────────────────────────────────────────────

/**
 * Persiste alcance/frequência num escopo (`token` ou `merge`). O escopo é
 * obrigatório porque o mesmo grupo merge tem campos distintos pra:
 *   - cada report-membro (drill-down de mês): `target_type="token"`, id = short_token
 *   - a visão agregada do grupo:              `target_type="merge"`, id = merge_id
 *
 * `frequencia` é opcional. Quando vazia, o frontend calcula `impressões totais
 * / alcance` em runtime — o valor só vai pro banco se o admin sobrescrever.
 *
 * Lança em status != 2xx pra o caller propagar o erro pra UI (diferente da
 * versão antiga que ignorava response status).
 */
export async function saveAlcanceFrequencia({ target_type, target_id, alcance, frequencia, adminJwt }) {
  const r = await postJson(
    `${API_URL}?action=save_af`,
    { target_type, target_id, alcance, frequencia },
    adminAuthHeaders(adminJwt),
  );
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const d = await r.json();
      if (d?.error) msg = d.error;
    } catch { /* keep generic */ }
    throw new Error(msg);
  }
  return r;
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

// ── Merge Reports (admin) ────────────────────────────────────────────────────
// Unifica múltiplos PIs (short_tokens) do mesmo cliente em um único link
// público. Todas as ações exigem JWT admin. Os endpoints invalidam cache
// dos tokens afetados no backend; o caller refaz `listCampaigns()` pra
// pegar o estado atualizado (badges merged, etc).

async function jsonOrError(r, label) {
  if (r.ok) return r.json();
  let msg = `HTTP ${r.status}`;
  try {
    const d = await r.json();
    if (d?.error) msg = d.error;
  } catch { /* keep generic */ }
  throw new Error(`${label}: ${msg}`);
}

/** Lista tokens elegíveis para merge com `short_token` (mesmo cliente). */
export async function listMergeableTokens(short_token) {
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(
    `${API_URL}?action=list_mergeable_tokens&token=${encodeURIComponent(short_token)}`,
    { headers: { ...adminAuthHeaders(jwt) } },
  );
  const data = await jsonOrError(r, "list_mergeable_tokens");
  return data.tokens || [];
}

/** Busca estado completo de um grupo (membros + config). */
export async function getMergeGroup(merge_id) {
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(
    `${API_URL}?action=get_merge_group&merge_id=${encodeURIComponent(merge_id)}`,
    { headers: { ...adminAuthHeaders(jwt) } },
  );
  const data = await jsonOrError(r, "get_merge_group");
  return data.group;
}

/**
 * Cria/anexa tokens em um grupo merge. Se nenhum dos `tokens` está em grupo,
 * cria um novo. Se algum já está, anexa os outros a esse mesmo grupo.
 *
 * `rmnd_mode` / `pdooh_mode`: "merge" | "latest" | undefined (default = "merge")
 */
export async function mergeTokens({ tokens, rmnd_mode, pdooh_mode }) {
  const jwt = await getOrIssueAdminJwt();
  const body = { tokens };
  if (rmnd_mode  !== undefined) body.rmnd_mode  = rmnd_mode;
  if (pdooh_mode !== undefined) body.pdooh_mode = pdooh_mode;
  const r = await postJson(
    `${API_URL}?action=merge_tokens`,
    body,
    adminAuthHeaders(jwt),
  );
  const data = await jsonOrError(r, "merge_tokens");
  return data.group;
}

/** Remove `short_token` do seu grupo. Se sobrar 1 token, dissolve o grupo. */
export async function unmergeToken(short_token) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(
    `${API_URL}?action=unmerge_token`,
    { short_token },
    adminAuthHeaders(jwt),
  );
  return jsonOrError(r, "unmerge_token");
}

/** Atualiza rmnd_mode / pdooh_mode de um grupo existente. */
export async function updateMergeSettings({ merge_id, rmnd_mode, pdooh_mode }) {
  const jwt = await getOrIssueAdminJwt();
  const body = { merge_id };
  if (rmnd_mode  !== undefined) body.rmnd_mode  = rmnd_mode;
  if (pdooh_mode !== undefined) body.pdooh_mode = pdooh_mode;
  const r = await postJson(
    `${API_URL}?action=update_merge_settings`,
    body,
    adminAuthHeaders(jwt),
  );
  const data = await jsonOrError(r, "update_merge_settings");
  return data.group;
}
