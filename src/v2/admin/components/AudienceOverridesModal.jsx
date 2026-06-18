// src/v2/admin/components/AudienceOverridesModal.jsx
//
// Gerencia os overrides de NOME de audiência de um ANUNCIANTE (Report Center).
// Abre pelo botão "Editar nomes de audiência" no CampaignDrawer.
//
// O fluxo principal de CRIAÇÃO é inline na tabela "Por Audiência" do report
// (lá o admin vê o rótulo cru da plataforma e renomeia o que enxerga). Este
// modal é a tela de GESTÃO: lista o que já foi corrigido pra aquele cliente,
// permite ajustar o nome / reverter em lote, e adicionar um mapeamento manual
// (rótulo cru → nome) quando o admin já sabe o rótulo.
//
// Escopo por anunciante: a correção vale em todos os reports do cliente e vira
// seed pra IA do Client Hub (backend). Nested dialog sobre o Drawer (Radix
// empilha as camadas).

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../../../ui/cn";
import { toast } from "../../../lib/toast";
import {
  listAudienceOverrides,
  saveAudienceOverride,
  deleteAudienceOverride,
} from "../../../lib/api";

export function AudienceOverridesModal({ open, onOpenChange, clientName, shortToken }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState(null);
  // adicionar manual
  const [newRaw, setNewRaw] = useState("");
  const [newName, setNewName] = useState("");

  const reload = async () => {
    if (!clientName) return;
    setLoading(true);
    setError(null);
    try {
      const r = await listAudienceOverrides(clientName);
      setRows(r?.overrides || []);
    } catch (e) {
      setError(e?.message || "Erro ao carregar audiências");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setNewRaw("");
    setNewName("");
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clientName]);

  const handleRename = async (row, name) => {
    const display = String(name || "").trim();
    if (!display || display === row.display_name) return;
    setBusyKey(row.raw_key);
    try {
      await saveAudienceOverride({
        client_name: clientName,
        raw_audience: row.raw_audience,
        display_name: display,
        short_token: shortToken,
      });
      toast.success("Nome da audiência atualizado");
      await reload();
    } catch (e) {
      toast.error(e?.message || "Erro ao salvar");
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemove = async (row) => {
    setBusyKey(row.raw_key);
    try {
      await deleteAudienceOverride({
        client_name: clientName,
        raw_audience: row.raw_audience,
        short_token: shortToken,
      });
      toast.success("Override revertido");
      await reload();
    } catch (e) {
      toast.error(e?.message || "Erro ao reverter");
    } finally {
      setBusyKey(null);
    }
  };

  const handleAdd = async () => {
    const raw = newRaw.trim();
    const display = newName.trim();
    if (!raw || !display) return;
    setBusyKey("__new__");
    try {
      await saveAudienceOverride({
        client_name: clientName,
        raw_audience: raw,
        display_name: display,
        short_token: shortToken,
      });
      toast.success("Override adicionado");
      setNewRaw("");
      setNewName("");
      await reload();
    } catch (e) {
      toast.error(e?.message || "Erro ao adicionar");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={busyKey ? undefined : onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-[60] bg-black/60 backdrop-blur-[3px]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "duration-200",
          )}
        />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-[70]",
            "-translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-32px)] max-w-[560px]",
            "max-h-[calc(100vh-48px)] overflow-hidden",
            "rounded-2xl border border-border-strong bg-canvas-elevated shadow-2xl",
            "flex flex-col outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            "duration-200",
          )}
        >
          <div className="px-5 pt-4 pb-3 border-b border-border">
            <Dialog.Title className="text-sm font-bold text-fg">
              Nomes de audiência
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-fg-muted">
              Correções de nome para <span className="font-semibold text-fg">{clientName}</span>.
              Valem em todos os reports do anunciante e ajudam a IA do hub a
              identificar melhor. Você também renomeia direto na tabela do report.
            </Dialog.Description>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {error && (
              <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {error}
              </div>
            )}

            {loading ? (
              <div className="py-8 text-center text-xs text-fg-subtle">Carregando…</div>
            ) : rows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-fg-subtle">
                Nenhuma audiência renomeada ainda. Renomeie direto na tabela
                "Por Audiência" do report, ou adicione manualmente abaixo.
              </div>
            ) : (
              <div className="space-y-2">
                {rows.map((row) => (
                  <OverrideRow
                    // inclui display_name na key: remonta (reinicia o draft) quando
                    // o nome muda pós-reload, sem precisar de setState em effect.
                    key={`${row.raw_key}:${row.display_name}`}
                    row={row}
                    busy={busyKey === row.raw_key}
                    onRename={(name) => handleRename(row, name)}
                    onRemove={() => handleRemove(row)}
                  />
                ))}
              </div>
            )}

            {/* Adicionar manual: rótulo cru (como vem da plataforma) → nome */}
            <div className="mt-2 rounded-lg border border-border bg-surface px-3 py-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle mb-2">
                Adicionar manualmente
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={newRaw}
                  onChange={(e) => setNewRaw(e.target.value)}
                  placeholder="Rótulo cru (ex: SPORTS-STORE)"
                  className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-2 py-1.5 text-xs text-fg outline-none focus:ring-1 focus:ring-signature"
                />
                <span className="text-fg-subtle text-xs">→</span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Nome corrigido"
                  maxLength={120}
                  className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-2 py-1.5 text-xs text-fg outline-none focus:ring-1 focus:ring-signature"
                />
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={!newRaw.trim() || !newName.trim() || busyKey === "__new__"}
                  className="shrink-0 rounded-md bg-signature px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                >
                  {busyKey === "__new__" ? "…" : "Add"}
                </button>
              </div>
            </div>
          </div>

          <div className="px-5 py-3 border-t border-border flex justify-end">
            <button
              type="button"
              onClick={() => onOpenChange?.(false)}
              disabled={!!busyKey}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface disabled:opacity-40"
            >
              Fechar
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OverrideRow({ row, busy, onRename, onRemove }) {
  const [draft, setDraft] = useState(row.display_name || "");

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="min-w-0 flex-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onRename(draft); }}
          onBlur={() => onRename(draft)}
          maxLength={120}
          disabled={busy}
          className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-fg outline-none focus:border-signature focus:bg-canvas"
        />
        {row.raw_audience && (
          <div className="mt-0.5 px-1 text-[10px] text-fg-subtle truncate">
            cru: <span className="font-mono">{row.raw_audience}</span>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        title="Reverter ao nome original da plataforma"
        className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-fg-subtle hover:text-danger disabled:opacity-40"
      >
        {busy ? "…" : "Reverter"}
      </button>
    </div>
  );
}
