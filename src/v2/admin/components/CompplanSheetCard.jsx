// src/v2/admin/components/CompplanSheetCard.jsx
//
// Card da planilha Google auto-atualizada do compplan (PMP Deals).
//
// Espelha a aba "Compplan" do export (modelo HYPR_PMP_Deals_All-Time) numa
// sheet do Drive de quem conectar, reescrita automaticamente após cada
// pmp_sync_v2 (cron diário ~04:00 BRT) — sem exportar/colar manual.
//
// Integração singleton (uma só pra empresa toda): reconectar com outra
// conta SUBSTITUI a integração e cria planilha nova (mesma semântica do
// "Reconectar" das sheets de campanha — scope drive.file não permite
// escrever numa planilha pré-existente criada à mão).
//
// Estados: carregando → não conectada (botão conectar) → ativa (link +
// sync agora + excluir) → erro/revogada (tentar de novo / reconectar).

import { useEffect, useState, useCallback } from "react";
import {
  compplanSheetStatus,
  compplanSheetConnect,
  compplanSheetSyncNow,
  compplanSheetDelete,
} from "../../../lib/api";
import { loadGisScript, requestOAuthCode } from "../../../shared/googleOAuthCode";
import { fmtDateTimeBR } from "../../../shared/format";

export default function CompplanSheetCard() {
  // undefined = carregando · null = nunca conectada · objeto = integração
  const [integration, setIntegration] = useState(undefined);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const integ = await compplanSheetStatus();
        if (!cancelled) setIntegration(integ);
      } catch {
        if (!cancelled) setIntegration(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleConnect = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await loadGisScript();
      const code = await requestOAuthCode();
      await compplanSheetConnect({ code });
      setIntegration(await compplanSheetStatus());
    } catch (e) {
      setError(e.message || "Erro ao conectar");
    } finally {
      setBusy(false);
    }
  }, []);

  const handleSyncNow = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await compplanSheetSyncNow();
      setIntegration(res.integration || integration);
    } catch (e) {
      setError(e.message || "Erro ao sincronizar");
    } finally {
      setBusy(false);
    }
  }, [integration]);

  const handleConfirmDelete = useCallback(async () => {
    if (!confirmDelete) return;
    setError(null);
    setBusy(true);
    try {
      await compplanSheetDelete({ deleteSheet: confirmDelete.deleteSheet });
      setIntegration(null);
      setConfirmDelete(null);
    } catch (e) {
      setError(e.message || "Erro ao excluir");
    } finally {
      setBusy(false);
    }
  }, [confirmDelete]);

  if (integration === undefined) {
    return (
      <div className="rounded-xl border border-border bg-surface p-4 text-xs text-fg-subtle">
        Carregando integração do compplan…
      </div>
    );
  }

  // ── Não conectada ──────────────────────────────────────────────────────────
  if (!integration) {
    return (
      <Card>
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-[240px]">
            <div className="text-sm font-semibold text-fg">Compplan em planilha Google</div>
            <p className="text-xs text-fg-muted mt-1 max-w-2xl">
              Cria a planilha <span className="text-fg">HYPR_PMP_Deals_All-Time (Auto)</span> no
              seu Drive, no modelo da aba Compplan do export (1 linha por deal, all-time),
              reescrita automaticamente após o sync diário do PMP (~04h) — sem exportar/colar manual.
            </p>
            {error && <ErrorLine msg={error} />}
          </div>
          <button
            type="button"
            onClick={handleConnect}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-signature text-canvas hover:opacity-90 disabled:opacity-50 transition cursor-pointer"
          >
            {busy ? "Conectando..." : "Conectar Google Sheets"}
          </button>
        </div>
      </Card>
    );
  }

  // ── Ativa ──────────────────────────────────────────────────────────────────
  if (integration.status === "active") {
    return (
      <Card>
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-[240px]">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-fg">Compplan Sheet conectada</div>
              <Pill tone="ok">Ativo</Pill>
            </div>
            <div className="mt-1 text-[11px] text-fg-subtle space-y-0.5">
              {integration.created_by_email && (
                <div>Ativado por <span className="text-fg-muted">{integration.created_by_email}</span></div>
              )}
              {integration.last_synced_at && (
                <div>Último sync: <span className="text-fg-muted">{fmtDateTimeBR(integration.last_synced_at)}</span></div>
              )}
              <div>Atualiza automaticamente após cada sync do PMP (~04h BRT).</div>
            </div>
            {error && <ErrorLine msg={error} />}
          </div>
          <div className="shrink-0 flex items-center gap-2 flex-wrap">
            <a
              href={integration.spreadsheet_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-4 py-2 text-xs font-semibold rounded-lg bg-signature text-canvas hover:opacity-90 transition cursor-pointer"
            >
              Abrir planilha
            </a>
            <button
              type="button"
              onClick={handleSyncNow}
              disabled={busy}
              className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider rounded-md border border-border text-fg-muted hover:text-fg hover:border-fg-muted disabled:opacity-50 transition cursor-pointer"
            >
              {busy ? "Sincronizando..." : "Sincronizar agora"}
            </button>
            <button
              type="button"
              onClick={() => { setError(null); setConfirmDelete({ deleteSheet: false }); }}
              disabled={busy}
              className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider rounded-md border border-border text-fg-subtle hover:text-fg-muted disabled:opacity-50 transition cursor-pointer"
            >
              Excluir
            </button>
          </div>
        </div>
        {confirmDelete && (
          <div className="mt-3 pt-3 border-t border-border space-y-2">
            <div className="text-xs text-fg-muted">
              Excluir a integração? O push automático pós-sync será interrompido.
            </div>
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={confirmDelete.deleteSheet}
                onChange={(e) => setConfirmDelete({ deleteSheet: e.target.checked })}
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
                {busy ? "Excluindo..." : "Confirmar exclusão"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                disabled={busy}
                className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md border border-border text-fg-muted hover:text-fg disabled:opacity-50 transition cursor-pointer"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </Card>
    );
  }

  // ── Erro / revogada / pausada ──────────────────────────────────────────────
  return (
    <Card variant="error">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-fg">Compplan Sheet com problema</div>
            <Pill tone="err">{integration.status}</Pill>
          </div>
          {integration.last_error && (
            <p className="text-xs text-red-300 mt-1 break-words">{integration.last_error}</p>
          )}
          <p className="text-xs text-fg-muted mt-2">
            {integration.status === "revoked"
              ? "Acesso revogado ou planilha deletada. Reconecte pra recriar a planilha."
              : "Falha no último sync — pode ter sido erro temporário do Google. Tente sincronizar de novo na MESMA planilha; só reconecte (recria) se persistir."}
          </p>
          {error && <ErrorLine msg={error} />}
        </div>
        <div className="shrink-0 flex flex-col gap-2">
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
            className="px-3 py-1.5 text-[11px] font-semibold rounded-md border border-border text-fg-subtle hover:text-fg-muted disabled:opacity-50 transition cursor-pointer"
          >
            Reconectar (recria)
          </button>
        </div>
      </div>
    </Card>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────
function Card({ children, variant }) {
  const s = variant === "error"
    ? "border-danger/40 bg-danger-soft"
    : "border-border bg-surface";
  return <div className={`rounded-xl border ${s} p-4`}>{children}</div>;
}

function Pill({ tone, children }) {
  const cls = tone === "ok"
    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
    : "bg-red-500/10 text-red-400 border-red-500/30";
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${cls}`}>
      {children}
    </span>
  );
}

function ErrorLine({ msg }) {
  return <p className="text-xs text-red-400 mt-2">{msg}</p>;
}
