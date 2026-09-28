// src/v2/admin/components/PmpClientSheetBlock.jsx
//
// Bloco "Planilha do cliente" no drawer da line do PMP.
//
// Conecta uma Google Sheet dedicada ao deal com a entrega diária no recorte
// que pode ir pro cliente: Dia, Line, ID do Seat, Receita Bruta e Impressões
// (backend/pmp_client_sheet.py). A planilha ganha link público de leitura —
// é esse link que se manda pro cliente — e é reescrita a cada sync do PMP.
//
// Line agrupada → a planilha é do GRUPO (todas as lines, 1 row por dia × line).
//
// Estados: carregando → não conectada (seat + conectar) → ativa (abrir,
// copiar link, sync, seat, excluir) → erro/revogada (tentar de novo /
// reconectar). Não-editor só vê o link quando existe.

import { useEffect, useState, useCallback } from "react";
import {
  pmpClientSheetStatus,
  pmpClientSheetConnect,
  pmpClientSheetSyncNow,
  pmpClientSheetSetSeat,
  pmpClientSheetDelete,
} from "../../../lib/api";
import { loadGisScript, requestOAuthCode } from "../../../shared/googleOAuthCode";
import { fmtDateTimeBR } from "../../../shared/format";
import { cn } from "../../../ui/cn";
import { unitKeyFor, defaultSeatId } from "../lib/pmpClientSheet";

const COLUMNS_LABEL = "Dia · Line · ID do Seat · Receita Bruta · Impressões";

export function PmpClientSheetBlock({ line, canEdit = false }) {
  const unitKey = unitKeyFor(line);
  const isGroup = !!line?.group_id;
  const seatDefault = defaultSeatId(line);

  // undefined = carregando · null = nunca conectada · objeto = integração
  const [integration, setIntegration] = useState(undefined);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);
  const [seat, setSeat]   = useState("");
  const [editingSeat, setEditingSeat] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!unitKey) return;
    let cancelled = false;
    setIntegration(undefined);
    setError(null);
    setEditingSeat(false);
    setConfirmDelete(null);
    pmpClientSheetStatus(unitKey)
      .then(integ => {
        if (cancelled) return;
        setIntegration(integ);
        setSeat(integ?.config?.seat_id || "");
      })
      .catch(() => { if (!cancelled) setIntegration(null); });
    return () => { cancelled = true; };
  }, [unitKey]);

  const run = useCallback(async (fn, fallbackMsg) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e.message || fallbackMsg);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleConnect = () => run(async () => {
    await loadGisScript();
    const code = await requestOAuthCode();
    const res = await pmpClientSheetConnect({ unitKey, code, seatId: seat.trim() });
    setIntegration(res.integration || await pmpClientSheetStatus(unitKey));
  }, "Erro ao conectar");

  const handleSyncNow = () => run(async () => {
    const res = await pmpClientSheetSyncNow(unitKey);
    if (res.integration) setIntegration(res.integration);
  }, "Erro ao sincronizar");

  const handleSaveSeat = () => run(async () => {
    const res = await pmpClientSheetSetSeat(unitKey, seat.trim());
    if (res.integration) setIntegration(res.integration);
    setEditingSeat(false);
  }, "Erro ao salvar o seat");

  const handleConfirmDelete = () => run(async () => {
    await pmpClientSheetDelete(unitKey, { deleteSheet: confirmDelete?.deleteSheet });
    setIntegration(null);
    setConfirmDelete(null);
    setSeat("");
  }, "Erro ao excluir");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(integration.spreadsheet_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Não deu pra copiar — abra a planilha e copie o link de lá.");
    }
  };

  if (!unitKey) return null;

  if (integration === undefined) {
    return (
      <Shell>
        <Header />
        <div className="text-[11px] text-fg-subtle">Carregando…</div>
      </Shell>
    );
  }

  const seatInput = (
    <input
      type="text"
      value={seat}
      onChange={e => setSeat(e.target.value)}
      disabled={busy}
      placeholder={seatDefault || "ID do seat"}
      className="w-full h-8 px-2.5 rounded-md bg-surface border border-border text-[12px] font-mono text-fg"
    />
  );

  // ── Não conectada ──────────────────────────────────────────────────────────
  if (!integration) {
    if (!canEdit) return null;
    return (
      <Shell>
        <Header />
        <p className="text-[11px] text-fg-muted leading-relaxed">
          Cria uma Google Sheet no seu Drive, com link de leitura pra mandar pro cliente,
          atualizada após cada sync do PMP. Só entram{" "}
          <span className="text-fg">{COLUMNS_LABEL}</span> — custo, margem e PI ficam de fora.
          {isGroup && (
            <> A planilha é do grupo inteiro ({line.group_member_count || "todas as"} lines).</>
          )}
        </p>
        <div className="mt-3">
          <div className="lbl-section mb-1">ID do seat</div>
          {seatInput}
          <div className="text-[10px] text-fg-subtle mt-1">
            Vazio = usa o Deal ID{seatDefault ? ` (${seatDefault})` : ""}.
          </div>
        </div>
        {error && <ErrorLine msg={error} />}
        <button
          type="button"
          onClick={handleConnect}
          disabled={busy}
          className="mt-3 inline-flex items-center h-8 px-3 text-[11px] font-semibold rounded-md bg-signature text-canvas hover:opacity-90 disabled:opacity-50 transition cursor-pointer"
        >
          {busy ? "Conectando..." : "Conectar Google Sheets"}
        </button>
      </Shell>
    );
  }

  // ── Ativa ──────────────────────────────────────────────────────────────────
  if (integration.status === "active") {
    const seatShown = integration.config?.seat_id || seatDefault || "—";
    return (
      <Shell>
        <Header pill={<Pill tone="ok">Ativa</Pill>} />
        <div className="text-[11px] text-fg-subtle space-y-0.5">
          {integration.last_synced_at && (
            <div>Último sync: <span className="text-fg-muted">{fmtDateTimeBR(integration.last_synced_at)}</span></div>
          )}
          {integration.created_by_email && (
            <div>Conectada por <span className="text-fg-muted">{integration.created_by_email}</span></div>
          )}
          {isGroup && <div>Inclui todas as lines do grupo.</div>}
        </div>

        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          <a
            href={integration.spreadsheet_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center h-8 px-3 text-[11px] font-semibold rounded-md bg-signature text-canvas hover:opacity-90 transition cursor-pointer"
          >
            Abrir planilha
          </a>
          <SmallButton onClick={handleCopy}>{copied ? "Link copiado" : "Copiar link"}</SmallButton>
          {canEdit && (
            <SmallButton onClick={handleSyncNow} disabled={busy}>
              {busy ? "Sincronizando..." : "Sincronizar agora"}
            </SmallButton>
          )}
        </div>

        <div className="mt-3 pt-2.5 border-t border-border">
          <div className="lbl-section mb-1">ID do seat</div>
          {editingSeat ? (
            <div className="space-y-1.5">
              {seatInput}
              <div className="text-[10px] text-fg-subtle">Vazio = volta pro Deal ID. Salvar re-sincroniza a planilha.</div>
              <div className="flex items-center gap-2">
                <SmallButton onClick={handleSaveSeat} disabled={busy} tone="primary">
                  {busy ? "Salvando..." : "Salvar"}
                </SmallButton>
                <SmallButton
                  onClick={() => { setEditingSeat(false); setSeat(integration.config?.seat_id || ""); }}
                  disabled={busy}
                >
                  Cancelar
                </SmallButton>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-mono text-fg truncate" title={seatShown}>{seatShown}</span>
              {canEdit && (
                <button type="button" onClick={() => setEditingSeat(true)}
                        className="text-[11px] text-fg-muted hover:text-fg cursor-pointer">
                  Editar
                </button>
              )}
            </div>
          )}
        </div>

        {error && <ErrorLine msg={error} />}

        {canEdit && !confirmDelete && (
          <button
            type="button"
            onClick={() => { setError(null); setConfirmDelete({ deleteSheet: false }); }}
            disabled={busy}
            className="mt-3 text-[11px] text-fg-subtle hover:text-danger cursor-pointer"
          >
            Excluir integração
          </button>
        )}
        {confirmDelete && (
          <DeleteConfirm
            busy={busy}
            deleteSheet={confirmDelete.deleteSheet}
            onToggle={v => setConfirmDelete({ deleteSheet: v })}
            onConfirm={handleConfirmDelete}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
      </Shell>
    );
  }

  // ── Erro / revogada ────────────────────────────────────────────────────────
  return (
    <Shell tone="error">
      <Header pill={<Pill tone="err">{integration.status}</Pill>} />
      {integration.last_error && (
        <p className="text-[11px] text-danger break-words">{integration.last_error}</p>
      )}
      <p className="text-[11px] text-fg-muted mt-1.5">
        {integration.status === "revoked"
          ? "Acesso revogado ou planilha apagada. Reconectar cria uma planilha nova (o link muda)."
          : "Falha no último sync, pode ter sido instabilidade do Google. Tente de novo na mesma planilha; reconecte só se persistir."}
      </p>
      {error && <ErrorLine msg={error} />}
      {canEdit && (
        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          {integration.status !== "revoked" && (
            <SmallButton onClick={handleSyncNow} disabled={busy} tone="primary">
              {busy ? "..." : "Tentar de novo"}
            </SmallButton>
          )}
          <SmallButton onClick={handleConnect} disabled={busy}>Reconectar</SmallButton>
        </div>
      )}
    </Shell>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────
function Shell({ children, tone }) {
  return (
    <div className={cn(
      "rounded-lg border px-4 py-3",
      tone === "error" ? "border-danger/40 bg-danger-soft" : "border-border bg-surface/40",
    )}>
      {children}
    </div>
  );
}

function Header({ pill }) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <div className="lbl-section">Planilha do cliente</div>
      {pill}
    </div>
  );
}

function Pill({ tone, children }) {
  const cls = tone === "ok"
    ? "bg-success/10 text-success border-success/30"
    : "bg-danger/10 text-danger border-danger/30";
  return <span className={`lbl-micro px-2 py-0.5 rounded-full border ${cls}`}>{children}</span>;
}

function SmallButton({ children, onClick, disabled, tone }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center h-8 px-3 text-[11px] rounded-md border transition cursor-pointer disabled:opacity-50",
        tone === "primary"
          ? "font-semibold bg-signature text-canvas border-transparent hover:opacity-90"
          : "border-border text-fg-muted hover:text-fg hover:border-fg-muted",
      )}
    >
      {children}
    </button>
  );
}

function DeleteConfirm({ busy, deleteSheet, onToggle, onConfirm, onCancel }) {
  return (
    <div className="mt-3 pt-2.5 border-t border-border space-y-2">
      <div className="text-[11px] text-fg-muted">
        Excluir a integração? A planilha para de atualizar.
      </div>
      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={deleteSheet}
          onChange={e => onToggle(e.target.checked)}
          disabled={busy}
          className="mt-0.5 accent-signature"
        />
        <span className="text-[11px] text-fg-muted">
          <span className="text-fg">Também apagar a planilha do Drive.</span>{" "}
          O cliente perde o acesso ao link.
        </span>
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="text-[11px] text-danger h-8 px-3 rounded-md bg-danger/15 border border-danger/30 hover:bg-danger/25 disabled:opacity-50 transition cursor-pointer"
        >
          {busy ? "Excluindo..." : "Confirmar exclusão"}
        </button>
        <SmallButton onClick={onCancel} disabled={busy}>Cancelar</SmallButton>
      </div>
    </div>
  );
}

function ErrorLine({ msg }) {
  return <p className="text-[11px] text-danger mt-2">{msg}</p>;
}
