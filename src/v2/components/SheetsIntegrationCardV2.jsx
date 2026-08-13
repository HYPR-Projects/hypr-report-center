// src/v2/components/SheetsIntegrationCardV2.jsx
//
// Card "Integração Google Sheets" exibido no topo da aba Base de Dados.
//
// Três estados visuais:
//   1. NÃO CONECTADA  — admin vê botão "Conectar Google Sheets". Cliente
//                        não vê o card.
//   2. CONECTADA      — todo mundo vê link pra abrir a sheet. Admin vê
//                        também: quem ativou, último sync, sync_until,
//                        botões "Sincronizar agora" e "Excluir integração".
//   3. ERRO/REVOGADA  — admin vê banner "Reconectar". Cliente não vê o card.
//
// Campanha encerrada NÃO é um quarto estado: passada a janela de sync
// (`sync_until`), a integração continua CONECTADA/ativa — some só o sync
// automático, porque não entra dado novo em campanha encerrada. Até ago/2026
// o backend rebaixava essas rows pra `paused` e o card caía no estado 3,
// dizendo "Integração com erro — falha no último sync (ex.: 502)" pra ~92
// integrações que nunca tinham falhado. Ver `computeFreshness`.
//
// OAuth flow
// ──────────
// Usa Google Identity Services (GIS) `oauth2.initCodeClient` em modo
// popup. O popup retorna o `code` (authorization code) na callback
// JS — não precisa de redirect URL configurada no Cloud Console além
// dos JS origins já existentes pro login admin.
//
// Pedimos `prompt: "consent"` na primeira autorização e
// `access_type: "offline"` pra Google retornar o `refresh_token`. Sem
// isso, autorizações subsequentes só vêm com access_token (1h TTL),
// o que mata o sync diário. Esse é o gotcha #1 do GIS code flow.
//
// O `code` é mandado pro backend via POST /sheets_create, que faz a
// troca por tokens server-side (o client_secret não pode vir pro front).

import { useEffect, useState, useCallback } from "react";
import { API_URL } from "../../shared/config";
import { adminAuthHeaders } from "../../shared/auth";
import { fmtDateTimeBR, fmtDateBR } from "../../shared/format";
// loadGisScript/requestOAuthCode extraídos pra shared/googleOAuthCode.js
// (reusados pelo CompplanSheetCard) — comportamento idêntico ao original.
import { loadGisScript, requestOAuthCode } from "../../shared/googleOAuthCode";
import { useReportTrackingContext } from "../contexts/ReportTrackingContext";

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function postAdmin(action, body, adminJwt) {
  const res = await fetch(`${API_URL}?action=${action}`, {
    method: "POST",
    headers: {
      ...adminAuthHeaders(adminJwt),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 401 quase sempre = JWT admin expirou (sessão de 30min). Mensagem
    // específica orienta o user a recarregar pelo menu — o erro genérico
    // "Não autorizado" do backend confunde porque o user acabou de logar.
    if (res.status === 401) {
      throw new Error(
        "Sessão admin expirou. Recarregue o report pelo menu admin e tente de novo."
      );
    }
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

// ─── Component ───────────────────────────────────────────────────────────────
/**
 * @param {object}  props
 * @param {string}  props.token                short_token da campanha (compat —
 *                                              quando targetType/targetId não
 *                                              vem, usa este como token-target)
 * @param {string?} props.targetType           "token" | "merge" — defaults a "token"
 * @param {string?} props.targetId             id do alvo (token ou merge_id) —
 *                                              se omitido, usa props.token
 * @param {boolean} props.isAdmin
 * @param {string}  props.adminJwt
 * @param {object?} props.initialIntegration   payload.sheets_integration vindo
 *                                              do backend no carregamento.
 *                                              {url, status} pra cliente,
 *                                              objeto completo pra admin.
 */
export default function SheetsIntegrationCardV2({
  token,
  targetType: targetTypeProp,
  targetId:   targetIdProp,
  isAdmin,
  adminJwt,
  initialIntegration,
}) {
  // target_type/target_id efetivos (compat: cai em token/{token} se não passado)
  const targetType = targetTypeProp || "token";
  const targetId   = targetIdProp   || token;

  // trackCta vem do contexto montado pelo ClientDashboardV2. Fora desse
  // dashboard (ex: preview/teste isolado) cai em noop default — sem erro.
  const { trackCta } = useReportTrackingContext();

  const [integration, setIntegration] = useState(initialIntegration || null);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState(null);
  // Estado de confirmação de delete: null = inativo;
  // objeto = mostrando UI de confirm com flag deleteSheet
  const [confirmDelete, setConfirmDelete] = useState(null);

  // Quando o target muda (ex.: alterna entre Visão agregada e mês X), reseta
  // pro initialIntegration daquele contexto. Sem isso, o card carregaria
  // sempre a integração do primeiro target visto.
  useEffect(() => {
    setIntegration(initialIntegration || null);
    setError(null);
    setConfirmDelete(null);
  }, [targetType, targetId, initialIntegration]);

  // Quando admin loga e o payload trouxe view pública, busca view completa
  // pra ter created_by, last_synced_at, etc.
  useEffect(() => {
    if (!isAdmin || !adminJwt || !targetId) return;
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams({
          action:      "sheets_status",
          target_type: targetType,
          target_id:   targetId,
        }).toString();
        const res = await fetch(`${API_URL}?${qs}`, {
          headers: adminAuthHeaders(adminJwt),
        });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setIntegration(json.integration || null);
      } catch {
        /* silently ignore — initialIntegration suffices for client view */
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, adminJwt, targetType, targetId]);

  const handleConnect = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await loadGisScript();
      const code = await requestOAuthCode();
      const res = await postAdmin(
        "sheets_create",
        {
          target_type:  targetType,
          target_id:    targetId,
          code,
          redirect_uri: "postmessage",
        },
        adminJwt,
      );
      const qs = new URLSearchParams({
        action:      "sheets_status",
        target_type: targetType,
        target_id:   targetId,
      }).toString();
      const status = await fetch(`${API_URL}?${qs}`, {
        headers: adminAuthHeaders(adminJwt),
      }).then((r) => r.json());
      setIntegration(status.integration || {
        spreadsheet_url: res.spreadsheet_url,
        status: "active",
      });
    } catch (e) {
      setError(e.message || "Erro ao conectar");
    } finally {
      setBusy(false);
    }
  }, [targetType, targetId, adminJwt]);

  const handleSyncNow = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await postAdmin(
        "sheets_sync_now",
        { target_type: targetType, target_id: targetId },
        adminJwt,
      );
      setIntegration(res.integration || integration);
    } catch (e) {
      setError(e.message || "Erro ao sincronizar");
    } finally {
      setBusy(false);
    }
  }, [targetType, targetId, adminJwt, integration]);

  const handleDeleteClick = useCallback(() => {
    // Abre UI inline de confirmação. Default: NÃO deletar a sheet do Drive
    // (preserva histórico — comportamento conservador).
    setError(null);
    setConfirmDelete({ deleteSheet: false });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!confirmDelete) return;
    setBusy(true);
    setError(null);
    try {
      await postAdmin(
        "sheets_delete",
        {
          target_type:  targetType,
          target_id:    targetId,
          delete_sheet: confirmDelete.deleteSheet,
        },
        adminJwt,
      );
      setIntegration(null);
      setConfirmDelete(null);
    } catch (e) {
      setError(e.message || "Erro ao excluir");
    } finally {
      setBusy(false);
    }
  }, [targetType, targetId, adminJwt, confirmDelete]);

  const handleCancelDelete = useCallback(() => {
    setConfirmDelete(null);
    setError(null);
  }, []);

  // ── Cliente sem integração ativa: nada renderiza ──────────────────────────
  if (!isAdmin && !isActiveLike(integration)) {
    return null;
  }

  // ── Admin sem integração: estado "vazio" ──────────────────────────────────
  if (isAdmin && !integration) {
    const isMerge = targetType === "merge";
    return (
      <Card>
        <div className="flex items-start gap-4">
          <SheetIcon />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-fg">
              {isMerge
                ? "Sincronizar Visão Agregada com Google Sheets"
                : "Sincronizar com Google Sheets"}
            </div>
            <p className="text-xs text-fg-muted mt-1 max-w-2xl">
              {isMerge
                ? "Cria uma planilha no seu Drive com a base unificada de todos os tokens do grupo (com colunas extras Mês e Token), atualizada automaticamente às 08h e 12h BRT todos os dias."
                : "Cria uma planilha no seu Drive com a Base de Dados completa, atualizada automaticamente às 08h e 12h BRT todos os dias. Compartilhe com o cliente como faria com qualquer planilha. O sync automático para 30 dias após o término da campanha — a integração e a planilha continuam ativas, com os dados finais."}
            </p>
            {error && <ErrorLine msg={error} />}
          </div>
          <button
            type="button"
            onClick={handleConnect}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-signature text-canvas hover:opacity-90 disabled:opacity-50 transition cursor-pointer"
          >
            {busy
              ? "Conectando..."
              : isMerge
                ? "Conectar sheet do agregado"
                : "Conectar Google Sheets"}
          </button>
        </div>
      </Card>
    );
  }

  // ── Estado ATIVO ──────────────────────────────────────────────────────────
  if (isActiveLike(integration)) {
    // Cliente vê só ícone + título + pill + botão — alinhamento ao centro
    // dá leitura mais limpa. Admin tem metadados em coluna abaixo do
    // título (created_by, last_sync, sync_until), então alinha ao topo
    // pra ícone/título encostarem na primeira linha de texto.
    const rowAlign = isAdmin ? "items-start" : "items-center";
    const freshness = isAdmin ? computeFreshness(integration) : { level: "fresh" };
    // "closed" = janela de sync vencida (campanha encerrada). Sync velho ali é
    // o esperado, então nada de banner de alerta — só a linha informativa.
    const showStaleBanner = freshness.level !== "fresh" && freshness.level !== "closed";
    const windowClosed = isSyncWindowClosed(integration);
    return (
      <Card variant={showStaleBanner ? "warning" : undefined}>
        <div className="flex flex-col gap-3">
          {showStaleBanner && <StaleBanner freshness={freshness} />}
          <div className={`flex ${rowAlign} gap-4`}>
            <SheetIcon />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold text-fg">
                  Google Sheets conectado
                </div>
                <StatusPill status="active" />
              </div>
              {isAdmin && (
                <div className="mt-1 text-[11px] text-fg-subtle space-y-0.5">
                  {integration.created_by_email && (
                    <div>
                      Ativado por <span className="text-fg-muted">{integration.created_by_email}</span>
                    </div>
                  )}
                  {integration.last_synced_at && (
                    <div>
                      Último sync com sucesso: <span className="text-fg-muted">{fmtDateTimeBR(integration.last_synced_at)}</span>
                    </div>
                  )}
                  {integration.last_attempt_at && (
                    <div>
                      Última tentativa: <span className="text-fg-muted">{fmtDateTimeBR(integration.last_attempt_at)}</span>
                    </div>
                  )}
                  {integration.sync_until && (
                    windowClosed ? (
                      <div>
                        Sync automático encerrado em{" "}
                        <span className="text-fg-muted">{fmtDateBR(integration.sync_until)}</span>
                        {" "}— campanha finalizada. A integração segue ativa e a planilha
                        mantém os dados finais.
                      </div>
                    ) : (
                      <div>
                        Sync ativo até: <span className="text-fg-muted">{fmtDateBR(integration.sync_until)}</span>
                      </div>
                    )
                  )}
                </div>
              )}
              {error && <ErrorLine msg={error} />}
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <a
                href={integration.spreadsheet_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackCta("sheets_open")}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-signature text-canvas hover:opacity-90 transition cursor-pointer"
              >
                Abrir no Google Sheets
              </a>
            </div>
          </div>
          {isAdmin && (
            <div className="pt-2 border-t border-border">
              {confirmDelete ? (
                <div className="space-y-3">
                  <div className="text-xs text-fg-muted">
                    Tem certeza que quer excluir esta integração? O sync diário será interrompido.
                  </div>
                  <label className="flex items-start gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={confirmDelete.deleteSheet}
                      onChange={(e) =>
                        setConfirmDelete({ deleteSheet: e.target.checked })
                      }
                      disabled={busy}
                      className="mt-0.5 accent-signature"
                    />
                    <span className="text-xs text-fg-muted">
                      <span className="text-fg">Também deletar a planilha do Google Drive.</span>{" "}
                      Sem isso, o arquivo permanece no Drive de quem ativou.
                    </span>
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleConfirmDelete}
                      disabled={busy}
                      className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 disabled:opacity-50 transition cursor-pointer"
                    >
                      {busy ? "Excluindo..." : confirmDelete.deleteSheet ? "Excluir tudo" : "Confirmar exclusão"}
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelDelete}
                      disabled={busy}
                      className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md border border-border text-fg-muted hover:text-fg disabled:opacity-50 transition cursor-pointer"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSyncNow}
                    disabled={busy}
                    className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md border border-border text-fg-muted hover:text-fg hover:border-fg-muted disabled:opacity-50 transition cursor-pointer"
                  >
                    {busy ? "Sincronizando..." : "Sincronizar agora"}
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteClick}
                    disabled={busy}
                    className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md border border-border text-fg-subtle hover:text-fg-muted disabled:opacity-50 transition cursor-pointer"
                  >
                    Excluir integração
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    );
  }

  // ── Estado ERRO/REVOGADO (admin only) ─────────────────────────────────────
  // Só quebra DE VERDADE entra aqui. A condição era `status !== "active"`, que
  // varria pra cá qualquer status novo/legado (foi assim que `paused` de
  // campanha encerrada virou "Integração com erro").
  if (isAdmin && integration &&
      (integration.status === "error" || integration.status === "revoked")) {
    return (
      <Card variant="error">
        <div className="flex items-start gap-4">
          <SheetIcon />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-fg">
                Integração com erro
              </div>
              <StatusPill status={integration.status} />
            </div>
            {integration.last_error && (
              <p className="text-xs text-red-300 mt-1 break-words">
                {integration.last_error}
              </p>
            )}
            <p className="text-xs text-fg-muted mt-2">
              {integration.status === "revoked"
                ? "Acesso revogado pelo Google ou planilha foi deletada. Reconecte pra recriar a planilha."
                : "Falha no último sync — pode ter sido um erro temporário do Google (ex.: 502). Tente sincronizar de novo na MESMA planilha. Só reconecte (que recria uma planilha nova) se o erro persistir."}
            </p>
            {error && <ErrorLine msg={error} />}
          </div>
          <div className="shrink-0 flex flex-col gap-2">
            {/* Em erro genérico (transiente), a ação primária NÃO-destrutiva é
                re-sincronizar a planilha existente — não recriar. Reconectar
                fica como fallback. Em 'revoked' o acesso à planilha sumiu, então
                reconectar (recria) é o caminho primário. */}
            {integration.status !== "revoked" && (
              <button
                type="button"
                onClick={handleSyncNow}
                disabled={busy}
                className="px-3 py-1.5 text-[11px] font-semibold rounded-md bg-signature text-canvas hover:opacity-90 disabled:opacity-50 transition cursor-pointer"
              >
                {busy ? "..." : "Tentar de novo"}
              </button>
            )}
            <button
              type="button"
              onClick={handleConnect}
              disabled={busy}
              className={
                integration.status === "revoked"
                  ? "px-3 py-1.5 text-[11px] font-semibold rounded-md bg-signature text-canvas hover:opacity-90 disabled:opacity-50 transition cursor-pointer"
                  : "px-3 py-1.5 text-[11px] font-semibold rounded-md border border-border text-fg-subtle hover:text-fg-muted disabled:opacity-50 transition cursor-pointer"
              }
            >
              {busy && integration.status === "revoked" ? "..." : "Reconectar (recria)"}
            </button>
            <button
              type="button"
              onClick={handleDeleteClick}
              disabled={busy}
              className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md border border-border text-fg-subtle hover:text-fg-muted disabled:opacity-50 transition cursor-pointer"
            >
              Excluir
            </button>
          </div>
        </div>
      </Card>
    );
  }

  return null;
}

// ─── Subcomponents ───────────────────────────────────────────────────────────
function Card({ children, variant }) {
  // Variants usam tokens do design system (theme-aware via theme.css):
  // - error → --color-danger (vermelho)
  // - warning → --color-warning (amarelo/mustard)
  const styles = {
    error:   { border: "border-danger/40",  bg: "bg-danger-soft" },
    warning: { border: "border-warning/40", bg: "bg-warning-soft" },
  };
  const s = styles[variant] || { border: "border-border", bg: "bg-surface" };
  return (
    <div className={`rounded-xl border ${s.border} ${s.bg} p-5`}>
      {children}
    </div>
  );
}

function StaleBanner({ freshness }) {
  // 2 sub-estados: "tried-and-failed" (cron tentou recentemente, mas essa
  // row específica não atualizou — sintoma do bug que vimos em 08/05) e
  // "never-tried" (cron pode ter parado globalmente). Mensagens diferentes
  // pra orientar o admin sobre onde olhar.
  const isTriedFailed = freshness.level === "tried-and-failed";
  const ago = formatHoursAgo(freshness.hoursSinceSync);
  return (
    <div className="rounded-lg bg-warning-soft border border-warning/40 px-3 py-2">
      <div className="text-xs font-semibold text-warning">
        ⚠ Dados podem estar desatualizados
      </div>
      <div className="text-[11px] text-fg-muted mt-0.5">
        Última sync com sucesso {ago}.{" "}
        {isTriedFailed
          ? "O cron tentou recentemente e falhou nessa integração — verifique os logs do Cloud Run."
          : "O cron pode ter parado de rodar — confira o Cloud Scheduler."}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const styles = {
    active:  "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    paused:  "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    revoked: "bg-red-500/10 text-red-400 border-red-500/30",
    error:   "bg-red-500/10 text-red-400 border-red-500/30",
  };
  const labels = {
    active:  "Ativo",
    // Legado — backend não escreve mais 'paused' (ver isActiveLike).
    paused:  "Ativo",
    revoked: "Revogado",
    error:   "Erro",
  };
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${styles[status] || styles.error}`}>
      {labels[status] || status}
    </span>
  );
}

function ErrorLine({ msg }) {
  return (
    <p className="text-xs text-red-400 mt-2">
      {msg}
    </p>
  );
}

function SheetIcon() {
  // Ícone neutro de planilha — não é o logo Google porque branding
  // policies do Google proíbem uso fora do botão de auth oficial.
  return (
    <div className="shrink-0 w-10 h-10 rounded-lg bg-canvas-deeper flex items-center justify-center">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-signature">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9"  x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
        <line x1="9"  y1="3" x2="9"  y2="21" />
        <line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    </div>
  );
}

// Detecta sync travado.
//
// `last_synced_at` é a fonte da verdade pra freshness — o card mente "ATIVO"
// quando o cron crasha no meio do loop (timeout/OOM antes de marcar a row).
// O sync corre 2x/dia (08h e 12h BRT), então > 26h sem sucesso já é vermelho.
//
// `last_attempt_at` (gravado ANTES de cada iteração no backend) sub-classifica:
//   - tried-and-failed: tentou recentemente mas não sincronizou → erro real
//                        no processamento dessa row específica.
//   - never-tried:      nem tentou recentemente → cron parou globalmente, ou
//                        a row não foi processada no último run que crashou.
function computeFreshness(integration) {
  // Janela vencida: a campanha encerrou há mais de 30 dias, o cron parou de
  // sincronizar de propósito e nada de novo vai entrar. `last_synced_at` velho
  // aqui é o estado correto, não sintoma de nada.
  if (isSyncWindowClosed(integration)) return { level: "closed" };
  if (!integration?.last_synced_at) return { level: "fresh" };
  const now      = Date.now();
  const synced   = new Date(integration.last_synced_at).getTime();
  const attempt  = integration.last_attempt_at
    ? new Date(integration.last_attempt_at).getTime()
    : null;
  const hoursSinceSync    = (now - synced) / (1000 * 60 * 60);
  const hoursSinceAttempt = attempt ? (now - attempt) / (1000 * 60 * 60) : Infinity;

  if (hoursSinceSync < 26) return { level: "fresh" };
  // Tentou nas últimas 14h (= último ciclo de cron) mas não sincronizou.
  if (hoursSinceAttempt < 14) {
    return { level: "tried-and-failed", hoursSinceSync };
  }
  return { level: "never-tried", hoursSinceSync };
}

// Uma integração continua "ativa" pra sempre — inclusive depois que a campanha
// encerra e o sync para. `paused` é status LEGADO (backend não escreve mais)
// e é tratado como ativo pra que rows antigas não sumam nem virem card de erro.
function isActiveLike(integration) {
  const s = integration?.status;
  return s === "active" || s === "paused";
}

// True quando a janela de sync já fechou: `sync_until` (end_date + 30d) é
// anterior a hoje. Estado normal e permanente de campanha encerrada.
// `sync_until` vem como DATE (YYYY-MM-DD), então comparar as strings ISO
// evita fuso: `new Date("2026-07-30")` parseia como UTC e volta um dia no BRT.
function isSyncWindowClosed(integration) {
  const until = integration?.sync_until;
  if (!until) return false;   // sem janela definida (ex.: compplan)
  const d = new Date();
  const todayISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return String(until).slice(0, 10) < todayISO;
}

function formatHoursAgo(hours) {
  if (hours < 24) return `há ${Math.round(hours)}h`;
  return `há ${Math.round(hours / 24)} dia${Math.round(hours / 24) === 1 ? "" : "s"}`;
}
