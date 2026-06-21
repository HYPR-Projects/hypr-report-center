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
 * Sufixo de credencial admin legada (`&ak=hypr2026`) lido da URL da página.
 *
 * Por que existe: o menu admin abre o report com `?adm=<jwt>` quando consegue
 * mintar um JWT fresco do Google; quando o id_token do Google expirou (TTL
 * ~1h) e o silent refresh falhou (FedCM/cookies de terceiros bloqueados), ele
 * cai no fallback e abre com `?ak=hypr2026`. Nesse estado a UI mostra os
 * botões de admin (App.jsx: `isAdminMode` inclui `hasLegacyAk`), mas NÃO há
 * JWT disponível — então `adminAuthHeaders(null)` vira `{}` e toda escrita ia
 * sem `Authorization`, levando 401 do backend e disparando o falso "sua
 * sessão expirou" (sem nunca salvar).
 *
 * O backend já aceita `?ak=hypr2026` como credencial admin (authenticate_admin
 * Mode 2 em backend/auth.py). Encaminhar o `ak` da página para a própria call
 * de escrita restaura a capacidade de salvar mesmo com a sessão Google
 * totalmente expirada.
 *
 * Admin-only por construção: só está presente quando a URL da página carrega
 * `?ak=hypr2026` — link que vem do menu admin. Clientes recebem
 * `/report/<token>` sem `ak`/`adm` e caem na tela de senha (nunca admin).
 */
function legacyAkSuffix() {
  try {
    const ak = new URLSearchParams(window.location.search).get("ak");
    return ak === "hypr2026" ? "&ak=hypr2026" : "";
  } catch {
    return "";
  }
}

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
  // Sem JWT (prop null/expirado → adminAuthHeaders devolveu {}), mas a página
  // foi aberta pelo link admin legado: encaminha `?ak=hypr2026` pra própria
  // call de escrita. Se há JWT, o Bearer é a credencial e o `ak` é dispensável.
  const effectiveUrl = hasAuthHeader ? url : url + legacyAkSuffix();
  const res = await fetch(effectiveUrl, init);

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
/**
 * Timeout do fetch de report. Sem ele, uma request pendurada (instância
 * lenta/envenenada do backend — ver incidente do BQ timeout) deixava o
 * dashboard em DashboardSkeleton pra sempre, sem erro visível. 30s cobre
 * com folga o pior caso legítimo (cold start + 8 queries BQ frias ≈ 5-8s).
 */
const REPORT_FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getCampaign(token, options = {}) {
  // Demo report (`/report/DEMO`) — payload sintético gerado client-side.
  // Não toca BigQuery. Ver shared/demoData.js.
  if (isDemoToken(token)) return buildDemoPayload();
  const params = new URLSearchParams({ token });
  if (options.view) params.set("view", options.view);
  const url = `${API_URL}?${params.toString()}`;
  let r;
  try {
    r = await fetchWithTimeout(url, REPORT_FETCH_TIMEOUT_MS);
  } catch {
    // Timeout ou falha de rede: retry único. O GLB do GCP costuma rotear o
    // retry pra outra instância, então isso resolve o caso "instância ruim".
    try {
      r = await fetchWithTimeout(url, REPORT_FETCH_TIMEOUT_MS);
    } catch {
      // Mensagem amigável em vez do "The user aborted a request" do
      // AbortError — vai direto pro <p> da tela de erro do dashboard.
      throw new Error("O servidor demorou demais para responder. Tente novamente.");
    }
  }
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

/**
 * Lista campanhas com métricas agregadas dentro de uma janela [from, to].
 * Usado pelo Top Performers do menu admin pra evolução histórica do score.
 *
 * Diferenças do `listCampaigns()`:
 *   - métricas recalculadas só com delivery dentro da janela
 *   - pacing = realized / (daily_rate × overlap_days_da_janela_com_contrato)
 *   - inclui SÓ campanhas com viewable_impressions > 0 na janela
 *   - payload mais enxuto (sem pauses/closures/early_ends/merges/share_ids)
 *
 * Lança em 401/403 (recarrega login), 4xx/5xx, ou resposta malformada.
 * Caller deve tratar erro — pattern stale-while-revalidate é o recomendado.
 */
export async function listPerformersForPeriod({ from, to } = {}) {
  if (!from || !to) throw new Error("listPerformersForPeriod: from/to obrigatórios");
  const jwt = await getOrIssueAdminJwt();
  if (!jwt) throw new Error("no admin jwt");
  const qs = new URLSearchParams({ action: "performers", from, to }).toString();
  const r = await fetch(`${API_URL}?${qs}`, {
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
  return d.campaigns;
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

// ── Portal do Cliente ──────────────────────────────────────────────────────
//
// Dashboard central client-facing por cliente. Admin gerencia (config + senha
// + logo + curadoria de campanhas); cliente acessa via /c/<share_id> + senha.
// Ver backend/client_portal.py.

/**
 * Admin: salva o override de NOME de audiência (Report Center). Escopo POR
 * ANUNCIANTE (client_name). `raw_audience` pode ser string ou array (renomear
 * um grupo já mesclado aplica o mesmo nome a todos os rótulos crus dele).
 * `short_token` é opcional — só pro audit log. Lança em falha.
 */
export async function saveAudienceOverride({ client_name, raw_audience, display_name, short_token, scope }) {
  const jwt = await getOrIssueAdminJwt();
  const res = await postJson(
    `${API_URL}?action=save_audience_override`,
    { client_name, raw_audience, display_name, short_token, scope },
    adminAuthHeaders(jwt),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

/**
 * Admin: remove o override de audiência (reverte pro rótulo cru). `raw_audience`
 * string ou array. `scope`: "all" (default — limpa anunciante + esta campanha)
 * | "advertiser" | "campaign". Lança em falha.
 */
export async function deleteAudienceOverride({ client_name, raw_audience, short_token, scope }) {
  const jwt = await getOrIssueAdminJwt();
  const res = await postJson(
    `${API_URL}?action=delete_audience_override`,
    { client_name, raw_audience, short_token, scope },
    adminAuthHeaders(jwt),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

/**
 * Admin: lista os overrides de audiência de um anunciante (drawer "Gerenciar
 * audiências"). Retorna { overrides: [{raw_key, raw_audience, display_name,
 * edited_by, updated_at}] } ou lança.
 */
export async function listAudienceOverrides(client_name) {
  const jwt = await getOrIssueAdminJwt();
  if (!jwt) throw new Error("no admin jwt");
  const r = await fetch(
    `${API_URL}?action=list_audience_overrides&client_name=${encodeURIComponent(client_name)}`,
    { headers: { ...adminAuthHeaders(jwt) } },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * Admin: config do portal de um cliente + mapa de publicação por token.
 * Leve (2 lookups, sem a query pesada de campanhas — o caller já tem a lista
 * carregada na página). Lança em falha. Retorna
 * { config: {...}|null, publish_map: { TOKEN: bool } }.
 */
export async function getClientPortalConfig(slug) {
  const jwt = await getOrIssueAdminJwt();
  if (!jwt) throw new Error("no admin jwt");
  const r = await fetch(
    `${API_URL}?action=client_portal_config&slug=${encodeURIComponent(slug)}`,
    { headers: { ...adminAuthHeaders(jwt) } },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * Admin: salva a config do portal (senha, display_name, logo_base64,
 * accent_color, active). Campos ausentes preservam o valor atual no backend.
 * Retorna { config } ou lança.
 */
export async function saveClientPortal(fields) {
  const jwt = await getOrIssueAdminJwt();
  const res = await postJson(
    `${API_URL}?action=save_client_portal`,
    fields,
    adminAuthHeaders(jwt),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Admin: publica/despublica uma campanha no portal (curadoria). Retorna true
 * ou lança.
 */
export async function setClientPublish({ slug, short_token, published }) {
  const jwt = await getOrIssueAdminJwt();
  const res = await postJson(
    `${API_URL}?action=set_client_publish`,
    { slug, short_token, published },
    adminAuthHeaders(jwt),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

/**
 * Público: dados agregados client-safe do portal (por share_id). Sem auth —
 * o share_id é a credencial de leitura. Lança em 404 (portal inexistente/
 * inativo) ou erro. Retorna { client, campaigns }.
 */
export async function getClientPortalData(share_id) {
  const r = await fetch(
    `${API_URL}?action=client_portal_data&share_id=${encodeURIComponent(share_id)}`,
  );
  if (r.status === 404) throw new Error("portal_not_found");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * Público: brand lift mensal agregado do portal (lazy — chamado só ao abrir a
 * aba Analytics). Endpoint pesado (busca Typeform por form), com cache próprio
 * no backend. Retorna { months: [{month, liftRel, liftAbs, responses}],
 * has_survey: bool }. Timeout generoso (a 1ª chamada por cliente computa tudo).
 */
export async function getClientPortalBrandLift(share_id) {
  // Timeout generoso via AbortController — a 1ª chamada por cliente computa
  // tudo (busca Typeform por form), depois o backend cacheia (1h).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch(
      `${API_URL}?action=client_portal_brand_lift&share_id=${encodeURIComponent(share_id)}`,
      { signal: ctrl.signal },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Público: quebra por audiência agregada do portal (lazy — chamado só ao abrir
 * a aba Analytics). Endpoint pesado (1 query de detail por campanha), com cache
 * próprio no backend (1h). Retorna { rows: [{token, month, media, tactic,
 * audience, impressions, viewable_impressions, clicks}], groups, has_data }.
 * As audiências já vêm unificadas em grupos canônicos pelo backend.
 */
export async function getClientPortalAudiences(share_id) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch(
      `${API_URL}?action=client_portal_audiences&share_id=${encodeURIComponent(share_id)}`,
      { signal: ctrl.signal },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Público: resolve (share_id, senha) → slug. Gate de senha do portal. Sem auth.
 * Retorna { ok: true, slug } se a senha bate; { ok: false } se não.
 */
export async function resolveClientShare({ share_id, password }) {
  try {
    const r = await fetch(`${API_URL}?action=resolve_client_share`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ share_id, password }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, inactive: !!d.inactive };
    return { ok: !!d.ok, slug: d.slug };
  } catch {
    return { ok: false };
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

// ── Core products override (admin) ───────────────────────────────────────────

/**
 * Lê o override de core products ATIVOS do token. Devolve
 * {products: ["O2O", ...], updated_by, updated_at} ou null (= automático,
 * frentes derivadas do checklist). Curadoria de quais frentes aparecem no
 * report — vence o checklist_info (blinda frente removida no Command que a
 * pipeline ainda materializa stale).
 */
export async function getCoreProductsOverride({ short_token }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(
    `${API_URL}?action=get_core_products_override&short_token=${encodeURIComponent(short_token)}`,
    { headers: adminAuthHeaders(jwt) },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json().catch(() => ({}));
  return d?.override ?? null;
}

/**
 * Salva o override. `products` = array das frentes ativas (ex: ["O2O"]).
 * Array vazio remove o override (volta ao automático).
 */
export async function saveCoreProductsOverride({ short_token, products }) {
  const jwt = await getOrIssueAdminJwt();
  return postJson(
    `${API_URL}?action=save_core_products_override`,
    { short_token, products },
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

export async function saveCampaignClosure({ short_token, closed, details }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(
    `${API_URL}?action=save_campaign_closure`,
    { short_token, closed: !!closed, ...(details ? { details } : {}) },
    adminAuthHeaders(jwt),
  );
  return throwIfNotOk(r);
}

/**
 * Atualiza só os detalhes do fechamento (pós-venda, material extra,
 * checkups semanais) sem mexer no estado closed. Usado pelo admin pra
 * corrigir/completar os dados depois que a campanha já foi encerrada.
 */
export async function saveClosureDetails({ short_token, details }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(
    `${API_URL}?action=save_closure_details`,
    { short_token, details },
    adminAuthHeaders(jwt),
  );
  return throwIfNotOk(r);
}

/**
 * Lê os detalhes do fechamento (pré-popula o popup de edição).
 * Retorna null quando nunca foram salvos.
 */
export async function getClosureDetails({ short_token }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(
    `${API_URL}?action=get_closure_details&short_token=${encodeURIComponent(short_token)}`,
    { headers: adminAuthHeaders(jwt) },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json().catch(() => ({}));
  return d?.details ?? null;
}

/**
 * Pausa/retoma campanha temporariamente. paused=true grava paused_at=NOW
 * em `campaign_pauses`; paused=false remove o registro. Reversível.
 *
 * O frontend usa `paused_at` (junto com end_date e closed_at) pra derivar
 * status="paused" via getCampaignStatus quando a campanha ainda está em
 * vôo. Após end_date, pausa vira metadata e o ciclo natural toma conta.
 */
export async function saveCampaignPause({ short_token, paused, reason }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(
    `${API_URL}?action=save_campaign_pause`,
    { short_token, paused: !!paused, reason: reason || "" },
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

// ── Snapshot / freeze (admin) ────────────────────────────────────────────────

/**
 * Lê o status de freeze de um report. Retorna { frozen, frozen_at } ou null
 * em falha / sem sessão admin. Report encerrado é congelado (auto-freeze) e o
 * cliente passa a ver o SNAPSHOT verbatim — por isso "atualizar snapshot" só
 * faz sentido quando frozen=true.
 */
export async function getFreezeStatus({ short_token }) {
  try {
    const jwt = await getOrIssueAdminJwt();
    const r = await fetch(
      `${API_URL}?action=freeze_status&token=${encodeURIComponent(short_token)}`,
      { headers: { ...adminAuthHeaders(jwt) } },
    );
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return { frozen: !!d?.frozen, frozen_at: d?.frozen_at ?? null };
  } catch {
    return null;
  }
}

/**
 * Reconstrói o snapshot congelado de um report a partir dos dados ao vivo
 * (re-roda as queries do report e re-congela em cima). É o que faz uma edição
 * de checklist (volumetria, CPM negociado etc.) numa campanha JÁ ENCERRADA
 * finalmente aparecer pro cliente — sem isso, o report serve o snapshot antigo
 * indefinidamente. Backend: action=freeze_report → build_report_snapshot + UPSERT.
 */
export async function rebuildReportSnapshot({ short_token, note }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(
    `${API_URL}?action=freeze_report`,
    { short_token, note: note || "" },
    adminAuthHeaders(jwt),
  );
  const ok = await throwIfNotOk(r);
  return ok.json().catch(() => ({}));
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
 * `auto_alcance=true` inverte a relação: o admin preenche `frequencia` e o
 * `alcance` é derivado em runtime (`impressões / frequência`). Nesse modo o
 * backend ignora qualquer `alcance` enviado.
 *
 * Lança em status != 2xx pra o caller propagar o erro pra UI (diferente da
 * versão antiga que ignorava response status).
 */
export async function saveAlcanceFrequencia({ target_type, target_id, alcance, frequencia, auto_alcance, adminJwt }) {
  const r = await postJson(
    `${API_URL}?action=save_af`,
    { target_type, target_id, alcance, frequencia, auto_alcance: !!auto_alcance },
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
 * Persiste o JSON parseado do upload no backend.
 *
 * Lança em resposta não-2xx (ex.: 401 quando não há credencial admin válida).
 * Sem isso, o `postJson` devolvia a Response 401 sem erro e o RmndUploadModal
 * caía no branch de sucesso — disparando o toast "RMND … salvo" mesmo quando
 * nada foi salvo (enquanto o modal global de "sessão expirou" também aparecia).
 * Agora o caller cai no `catch` e mostra erro de verdade.
 */
export async function saveUpload({ short_token, type, data_json, adminJwt }) {
  const res = await postJson(
    `${API_URL}?action=save_upload`,
    { short_token, type, data_json },
    adminAuthHeaders(adminJwt),
  );
  if (!res || !res.ok) {
    throw new Error(
      `Falha ao salvar (HTTP ${res ? res.status : "sem resposta"}). ` +
      `Sessão admin sem credencial válida — recarregue a página e tente de novo.`,
    );
  }
  return res;
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

// ── Analytics + Audit Log (admin) ───────────────────────────────────────────

/**
 * Payload completo pro ReportAnalyticsModal — KPIs, timeline, abas, devices,
 * heatmap, sessões recentes e a data inicial do tracking.
 */
export async function getReportAnalytics({ short_token, range_days = 30, include_internal = false }) {
  const jwt = await getOrIssueAdminJwt();
  const params = new URLSearchParams({
    action: "report_analytics",
    token: short_token,
    range: String(range_days),
  });
  if (include_internal) params.set("include_internal", "true");
  const r = await fetch(`${API_URL}?${params}`, { headers: adminAuthHeaders(jwt) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * Batch — usado pelo CampaignMenu pra pré-carregar summaries de todos os
 * cards de uma vez. Sem isso, 270 cards = 270 requests simultâneos.
 * Limita a 500 tokens por request (backend impõe o cap).
 */
export async function getAccessSummariesBatch(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return {};
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(
    `${API_URL}?action=access_summary_batch`,
    { tokens },
    adminAuthHeaders(jwt),
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data?.summaries || {};
}

/**
 * Changelog de ações admin sobre um report — Loom adicionado, owner trocado,
 * etc. Ordenado por created_at DESC.
 */
export async function getReportAuditLog({ short_token, limit = 50 }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(
    `${API_URL}?action=report_audit_log&token=${encodeURIComponent(short_token)}&limit=${limit}`,
    { headers: adminAuthHeaders(jwt) },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data?.events || [];
}

// ── PMP Lines v2 (admin) ─────────────────────────────────────────────────────
// API redesenhada em volta de Line Items (a unidade real do negócio).
// Substitui o `pmp_deals*` da v1 progressivamente.

/** Lista de lines enriquecidas (line + IO + Command + delivery + health). */
export async function listPmpLines({ includeArchived = false, onlyActive = true } = {}) {
  const jwt = await getOrIssueAdminJwt();
  const qs = new URLSearchParams({ action: "pmp_lines_list" });
  if (includeArchived) qs.set("include_archived", "1");
  qs.set("only_active", onlyActive ? "1" : "0");
  const r = await fetch(`${API_URL}?${qs}`, { headers: { ...adminAuthHeaders(jwt) } });
  if (r.status === 401 || r.status === 403) {
    try { localStorage.removeItem("hypr.session"); } catch { /* ignore */ }
    window.location.reload();
    throw new Error("admin session expired");
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (!Array.isArray(d?.lines)) throw new Error("malformed response: lines missing");
  return d.lines;
}

/** Métricas de delivery agregadas por line dentro de [dateFrom, dateTo].
 *  Retorna mapa { [line_id]: { curator_total_cost, curator_revenue,
 *  curator_margin, imps, first_delivery_day, last_delivery_day, ... } }.
 *  Usado pra "janelar" as métricas do Histórico (tipo filtro de Excel). */
export async function pmpLineWindowMetrics({ dateFrom, dateTo }) {
  const jwt = await getOrIssueAdminJwt();
  const qs = new URLSearchParams({ action: "pmp_lines_window", date_from: dateFrom, date_to: dateTo });
  const r = await fetch(`${API_URL}?${qs}`, { headers: { ...adminAuthHeaders(jwt) } });
  if (r.status === 401 || r.status === 403) {
    try { localStorage.removeItem("hypr.session"); } catch { /* ignore */ }
    window.location.reload();
    throw new Error("admin session expired");
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return d?.metrics || {};
}

/** Série diária de delivery por line dentro de [dateFrom, dateTo].
 *  Retorna lista achatada [{ line_id, day, imps, viewable_imps, clicks,
 *  curator_total_cost, curator_revenue, curator_margin }] — uma row por
 *  (line, dia). Usado pelo Analytics do PMP pra fatiar por dia/mês e aplicar
 *  os filtros de line client-side. Difere do window (que soma a janela inteira
 *  num total por line). */
export async function pmpLinesTimeseries({ dateFrom, dateTo }) {
  const jwt = await getOrIssueAdminJwt();
  const qs = new URLSearchParams({ action: "pmp_lines_timeseries", date_from: dateFrom, date_to: dateTo });
  const r = await fetch(`${API_URL}?${qs}`, { headers: { ...adminAuthHeaders(jwt) } });
  if (r.status === 401 || r.status === 403) {
    try { localStorage.removeItem("hypr.session"); } catch { /* ignore */ }
    window.location.reload();
    throw new Error("admin session expired");
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return Array.isArray(d?.rows) ? d.rows : [];
}

/** Detalhe + timeseries diária de uma line. */
export async function getPmpLine(lineId) {
  if (!lineId) return null;
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(`${API_URL}?action=pmp_line_get&line_id=${encodeURIComponent(lineId)}`,
    { headers: { ...adminAuthHeaders(jwt) } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Salva campos manuais (status, notes, overrides). */
export async function savePmpLineOverrides({ line_id, ...fields }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(`${API_URL}?action=pmp_save_line_overrides`,
    { line_id, ...fields }, adminAuthHeaders(jwt));
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const d = await r.json(); if (d?.error) msg = d.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

/** Sugestões de checklists do Command pra vincular à line. */
export async function suggestPmpLinks(lineId) {
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(`${API_URL}?action=pmp_suggest_links&line_id=${encodeURIComponent(lineId)}`,
    { headers: { ...adminAuthHeaders(jwt) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return d.suggestions || [];
}

/** Vincula line ↔ short_token: PUT no Xandr + update local + refresh enriched. */
export async function linkPmpCommand({ line_id, short_token, force = false }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(`${API_URL}?action=pmp_link_command`,
    { line_id, short_token, force }, adminAuthHeaders(jwt));
  if (r.status === 409) {
    const d = await r.json();
    const err = new Error(d.error || "Conflito");
    err.conflict_line_id = d.conflict_line_id;
    err.is_conflict = true;
    throw err;
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const d = await r.json(); if (d?.error) msg = d.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

/** Lista lines do mesmo cliente que podem ser agrupadas com `lineId`. */
export async function listPmpGroupableLines(lineId) {
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(`${API_URL}?action=pmp_groupable_lines&line_id=${encodeURIComponent(lineId)}`,
    { headers: { ...adminAuthHeaders(jwt) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return d.lines || [];
}

/** Cria grupo OU anexa lines a grupo existente. Pelo menos 2 line_ids. */
export async function groupPmpLines({ line_ids, short_token, group_name }) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(`${API_URL}?action=pmp_group_lines`,
    { line_ids, short_token, group_name }, adminAuthHeaders(jwt));
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const d = await r.json(); if (d?.error) msg = d.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

/** Remove line do grupo (dissolve grupo se sobrar 1 line). */
export async function ungroupPmpLine(line_id) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(`${API_URL}?action=pmp_ungroup_line`,
    { line_id }, adminAuthHeaders(jwt));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Trigger manual do sync v2 (IOs + Lines + delivery + refresh view). */
export async function syncPmpV2({ interval = "last_7_days" } = {}) {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(`${API_URL}?action=pmp_sync_v2`,
    { report_interval: interval }, adminAuthHeaders(jwt));
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const d = await r.json(); if (d?.error) msg = d.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

/**
 * Frescor da base de dados unified_daily_performance_metrics, por DSP.
 * Cada item tem { source, max_date, days_in_window }. O backend também
 * devolve `server_now` (ISO UTC) — usado pelo indicador de freshness
 * pra decidir o cutoff "já passou das 7h?" com base no relógio do
 * servidor, evitando falso positivo por clock skew do client.
 */
export async function getDataFreshness() {
  const jwt = await getOrIssueAdminJwt();
  const r = await fetch(
    `${API_URL}?action=data_freshness`,
    { headers: adminAuthHeaders(jwt) },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return {
    sources:    Array.isArray(data?.sources) ? data.sources : [],
    unifiedMax: data?.unified_max || null,
    serverNow:  data?.server_now || null,
  };
}

/**
 * Dispara a reconstrução manual das bases unificadas (job dbt no Dagster+).
 * Escape pra quando o run diário falhou (fonte atrasada). Devolve
 * { run_id, run_url } pra UI linkar a run no Dagster. Lança com mensagem
 * amigável do backend em falha (config ausente, Dagster recusou, etc).
 */
export async function triggerUnifiedRebuild() {
  const jwt = await getOrIssueAdminJwt();
  const r = await postJson(`${API_URL}?action=rebuild_unified`, {}, adminAuthHeaders(jwt));
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const d = await r.json(); if (d?.error) msg = d.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}
