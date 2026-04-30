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
import { API_URL, GOOGLE_CLIENT_ID } from "../../shared/config";
import { adminAuthHeaders } from "../../shared/auth";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function loadGisScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    let s = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (!s) {
      s = document.createElement("script");
      s.src   = "https://accounts.google.com/gsi/client";
      s.async = true;
      document.body.appendChild(s);
    }
    s.addEventListener("load",  () => resolve());
    s.addEventListener("error", () => reject(new Error("Falha ao carregar GIS")));
    // Already loaded?
    if (window.google?.accounts?.oauth2) resolve();
  });
}

// Inicia OAuth code flow, retorna o `code` quando o usuário autoriza.
function requestOAuthCode() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      return reject(new Error("Google Identity Services não disponível"));
    }
    const client = window.google.accounts.oauth2.initCodeClient({
      client_id: GOOGLE_CLIENT_ID,
      scope:     "https://www.googleapis.com/auth/drive.file",
      ux_mode:   "popup",
      // prompt='consent' força o re-consent screen, garantindo que o
      // refresh_token vem mesmo se o usuário já autorizou antes
      // (ver gotcha no top do arquivo).
      prompt:    "consent",
      // access_type='offline' é o que pede o refresh_token. Sem isso,
      // só access_token (1h) — sync diário quebra.
      access_type: "offline",
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        if (!resp.code) return reject(new Error("Code ausente na resposta"));
        resolve(resp.code);
      },
      error_callback: (err) => {
        // Usuário fechou popup, popup bloqueado, etc.
        reject(new Error(err?.message || err?.type || "Autorização cancelada"));
      },
    });
    client.requestCode();
  });
}

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
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ─── Component ───────────────────────────────────────────────────────────────
/**
 * @param {object}  props
 * @param {string}  props.token                short_token da campanha
 * @param {boolean} props.isAdmin
 * @param {string}  props.adminJwt
 * @param {object?} props.initialIntegration   payload.sheets_integration vindo
 *                                              do backend no carregamento.
 *                                              {url, status} pra cliente,
 *                                              objeto completo pra admin.
 */
export default function SheetsIntegrationCardV2({
  token,
  isAdmin,
  adminJwt,
  initialIntegration,
}) {
  const [integration, setIntegration] = useState(initialIntegration || null);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState(null);
  // Estado de confirmação de delete: null = inativo;
  // objeto = mostrando UI de confirm com flag deleteSheet
  const [confirmDelete, setConfirmDelete] = useState(null);

  // Quando admin loga e o payload trouxe view pública, busca view completa
  // pra ter created_by, last_synced_at, etc.
  useEffect(() => {
    if (!isAdmin || !adminJwt) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${API_URL}?action=sheets_status&token=${encodeURIComponent(token)}`,
          { headers: adminAuthHeaders(adminJwt) },
        );
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setIntegration(json.integration || null);
      } catch {
        /* silently ignore — initialIntegration suffices for client view */
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, adminJwt, token]);

  const handleConnect = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await loadGisScript();
      const code = await requestOAuthCode();
      const res = await postAdmin(
        "sheets_create",
        { short_token: token, code, redirect_uri: "postmessage" },
        adminJwt,
      );
      // Refetch pra trazer view admin completa
      const status = await fetch(
        `${API_URL}?action=sheets_status&token=${encodeURIComponent(token)}`,
        { headers: adminAuthHeaders(adminJwt) },
      ).then((r) => r.json());
      setIntegration(status.integration || {
        spreadsheet_url: res.spreadsheet_url,
        status: "active",
      });
    } catch (e) {
      setError(e.message || "Erro ao conectar");
    } finally {
      setBusy(false);
    }
  }, [token, adminJwt]);

  const handleSyncNow = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await postAdmin("sheets_sync_now", { short_token: token }, adminJwt);
      setIntegration(res.integration || integration);
    } catch (e) {
      setError(e.message || "Erro ao sincronizar");
    } finally {
      setBusy(false);
    }
  }, [token, adminJwt, integration]);

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
        { short_token: token, delete_sheet: confirmDelete.deleteSheet },
        adminJwt,
      );
      setIntegration(null);
      setConfirmDelete(null);
    } catch (e) {
      setError(e.message || "Erro ao excluir");
    } finally {
      setBusy(false);
    }
  }, [token, adminJwt, confirmDelete]);

  const handleCancelDelete = useCallback(() => {
    setConfirmDelete(null);
    setError(null);
  }, []);

  // ── Cliente sem integração ativa: nada renderiza ──────────────────────────
  if (!isAdmin && (!integration || integration.status !== "active")) {
    return null;
  }

  // ── Admin sem integração: estado "vazio" ──────────────────────────────────
  if (isAdmin && !integration) {
    return (
      <Card>
        <div className="flex items-start gap-4">
          <SheetIcon />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-fg">
              Sincronizar com Google Sheets
            </div>
            <p className="text-xs text-fg-muted mt-1 max-w-2xl">
              Cria uma planilha no seu Drive com a Base de Dados completa,
              atualizada diariamente às 06:00 BRT. Compartilhe com o cliente
              como faria com qualquer planilha. Sync automático para 30 dias
              após o término da campanha.
            </p>
            {error && <ErrorLine msg={error} />}
          </div>
          <button
            type="button"
            onClick={handleConnect}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-signature text-canvas hover:opacity-90 disabled:opacity-50 transition"
          >
            {busy ? "Conectando..." : "Conectar Google Sheets"}
          </button>
        </div>
      </Card>
    );
  }

  // ── Estado ATIVO ──────────────────────────────────────────────────────────
  if (integration?.status === "active") {
    return (
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-4">
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
                      Último sync: <span className="text-fg-muted">{formatDateTime(integration.last_synced_at)}</span>
                    </div>
                  )}
                  {integration.sync_until && (
                    <div>
                      Sync ativo até: <span className="text-fg-muted">{formatDate(integration.sync_until)}</span>
                    </div>
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
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-signature text-canvas hover:opacity-90 transition"
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
                      className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 disabled:opacity-50 transition"
                    >
                      {busy ? "Excluindo..." : confirmDelete.deleteSheet ? "Excluir tudo" : "Confirmar exclusão"}
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelDelete}
                      disabled={busy}
                      className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md border border-border text-fg-muted hover:text-fg disabled:opacity-50 transition"
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
                    className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md border border-border text-fg-muted hover:text-fg hover:border-fg-muted disabled:opacity-50 transition"
                  >
                    {busy ? "Sincronizando..." : "Sincronizar agora"}
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteClick}
                    disabled={busy}
                    className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md border border-border text-fg-subtle hover:text-fg-muted disabled:opacity-50 transition"
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
  if (isAdmin && integration && integration.status !== "active") {
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
                ? "Acesso revogado pelo Google ou planilha foi deletada. Reconecte pra recriar."
                : "Falha no último sync. Você pode tentar reconectar (recria sheet) ou excluir e começar do zero."}
            </p>
            {error && <ErrorLine msg={error} />}
          </div>
          <div className="shrink-0 flex flex-col gap-2">
            <button
              type="button"
              onClick={handleConnect}
              disabled={busy}
              className="px-3 py-1.5 text-[11px] font-semibold rounded-md bg-signature text-canvas hover:opacity-90 disabled:opacity-50 transition"
            >
              {busy ? "..." : "Reconectar"}
            </button>
            <button
              type="button"
              onClick={handleDeleteClick}
              disabled={busy}
              className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md border border-border text-fg-subtle hover:text-fg-muted disabled:opacity-50 transition"
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
  const border = variant === "error" ? "border-red-500/40" : "border-border";
  const bg     = variant === "error" ? "bg-red-500/5"     : "bg-surface";
  return (
    <div className={`rounded-xl border ${border} ${bg} p-5`}>
      {children}
    </div>
  );
}

function StatusPill({ status }) {
  const styles = {
    active:  "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    paused:  "bg-amber-500/10 text-amber-400 border-amber-500/30",
    revoked: "bg-red-500/10 text-red-400 border-red-500/30",
    error:   "bg-red-500/10 text-red-400 border-red-500/30",
  };
  const labels = {
    active:  "Ativo",
    paused:  "Pausado",
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

// ─── Format helpers ──────────────────────────────────────────────────────────
function formatDateTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch { return iso; }
}
