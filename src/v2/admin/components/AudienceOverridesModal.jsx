// src/v2/admin/components/AudienceOverridesModal.jsx
//
// Gerencia os overrides de NOME de audiência de um ANUNCIANTE (Report Center).
// Abre pelo botão "Editar nomes de audiência" no CampaignDrawer.
//
// Lista as audiências CRUAS da campanha (derivadas do detail) ∪ os overrides
// já existentes do anunciante — cada uma renomeável direto aqui. Renomear
// também funciona inline na tabela "Por Audiência" do report; este modal é o
// atalho admin que não exige rolar até a tabela.
//
// Escopo por anunciante: a correção vale em todos os reports do cliente e vira
// seed pra IA do Client Hub (backend). Nested dialog sobre o Drawer (Radix
// empilha as camadas).

import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../../../ui/cn";
import { toast } from "../../../lib/toast";
import {
  extractAudience,
  applyAudienceOverride,
  normAudienceKey,
} from "../../../shared/aggregations";
import { useAudienceOverrides } from "../../hooks/useAudienceOverrides";

export function AudienceOverridesModal({
  open,
  onOpenChange,
  clientName,
  shortToken,
  detailRows,           // reportData.detail — pra descobrir as audiências cruas
  overrideMap,          // reportData.audience_overrides — {raw_key: display} do anunciante
}) {
  const aud = useAudienceOverrides({
    initialMap: overrideMap,
    clientName,
    shortToken,
    isAdmin: true,
  });
  const [newRaw, setNewRaw] = useState("");
  const [newName, setNewName] = useState("");

  // Candidatos = audiências cruas da campanha (detail) ∪ overrides já existentes
  // (overrideMap traz TODOS do anunciante, inclusive de outras campanhas).
  // Cada um vira uma linha renomeável — não só os já editados.
  const candidates = useMemo(() => {
    const byKey = new Map(); // key -> { key, raw, display }
    for (const r of detailRows || []) {
      const raw = extractAudience(r.line_name);
      if (!raw || raw === "N/A" || /survey/i.test(raw)) continue;
      const key = normAudienceKey(raw);
      if (!byKey.has(key)) {
        byKey.set(key, { key, raw, display: applyAudienceOverride(raw, aud.overrideMap) });
      }
    }
    // Overrides que não apareceram no detail desta campanha (criados em outra
    // campanha do anunciante) — ainda mostráveis/revertíveis. Sem o rótulo cru
    // original, usamos a própria raw_key (normalize_key é idempotente, então
    // salvar/reverter por ela funciona).
    for (const [key, display] of Object.entries(aud.overrideMap || {})) {
      if (!byKey.has(key)) byKey.set(key, { key, raw: key, display });
    }
    return [...byKey.values()].sort((a, b) => a.display.localeCompare(b.display));
  }, [detailRows, aud.overrideMap]);

  const rename = (raw, name) =>
    aud.renameAudience([raw], name, raw).catch((e) =>
      toast.error(e?.message || "Erro ao salvar"));
  const reset = (raw) =>
    aud.resetAudience([raw], raw).catch((e) =>
      toast.error(e?.message || "Erro ao reverter"));

  const handleAdd = () => {
    const raw = newRaw.trim();
    const name = newName.trim();
    if (!raw || !name) return;
    aud.renameAudience([raw], name, "__new__")
      .then(() => { setNewRaw(""); setNewName(""); })
      .catch((e) => toast.error(e?.message || "Erro ao adicionar"));
  };

  return (
    <Dialog.Root open={open} onOpenChange={aud.busyAudience ? undefined : onOpenChange}>
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
            {detailRows == null ? (
              <div className="py-8 text-center text-xs text-fg-subtle">Carregando audiências…</div>
            ) : candidates.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-fg-subtle">
                Nenhuma audiência com entrega nesta campanha. Adicione um
                mapeamento manual abaixo se já souber o rótulo cru.
              </div>
            ) : (
              <div className="space-y-2">
                {candidates.map((c) => (
                  <CandidateRow
                    // inclui display na key: remonta (reinicia o draft) quando o
                    // nome muda pós-save, sem setState em effect.
                    key={`${c.key}:${c.display}`}
                    raw={c.raw}
                    display={c.display}
                    overridden={aud.isOverridden([c.raw])}
                    busy={aud.busyAudience === c.raw}
                    onRename={(name) => rename(c.raw, name)}
                    onReset={() => reset(c.raw)}
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
                  disabled={!newRaw.trim() || !newName.trim() || aud.busyAudience === "__new__"}
                  className="shrink-0 rounded-md bg-signature px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                >
                  {aud.busyAudience === "__new__" ? "…" : "Add"}
                </button>
              </div>
            </div>
          </div>

          <div className="px-5 py-3 border-t border-border flex justify-end">
            <button
              type="button"
              onClick={() => onOpenChange?.(false)}
              disabled={!!aud.busyAudience}
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

function CandidateRow({ raw, display, overridden, busy, onRename, onReset }) {
  const [draft, setDraft] = useState(display || "");
  const commit = () => {
    const name = draft.trim();
    if (name && name !== (display || "")) onRename(name);
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
            onBlur={commit}
            maxLength={120}
            disabled={busy}
            className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-fg outline-none focus:border-signature focus:bg-canvas"
          />
          {overridden && (
            <span
              title="Nome editado pelo admin"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-signature"
            />
          )}
        </div>
        {raw && raw !== display && (
          <div className="mt-0.5 px-1 text-[10px] text-fg-subtle truncate">
            cru: <span className="font-mono">{raw}</span>
          </div>
        )}
      </div>
      {busy ? (
        <span className="shrink-0 px-2 text-[11px] text-fg-subtle">…</span>
      ) : overridden ? (
        <button
          type="button"
          onClick={onReset}
          title="Reverter ao nome original da plataforma"
          className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-fg-subtle hover:text-danger"
        >
          Reverter
        </button>
      ) : null}
    </div>
  );
}
