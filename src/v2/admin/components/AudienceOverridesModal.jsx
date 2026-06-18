// src/v2/admin/components/AudienceOverridesModal.jsx
//
// Gerencia os overrides de NOME de audiência (Report Center). Abre pelo botão
// "Editar nomes de audiência" no CampaignDrawer.
//
// Agrupa as audiências da campanha pelo nome resolvido (merge por nome exato) e
// deixa o admin escolher o ESCOPO de cada correção:
//   • Anunciante    → vale em todas as campanhas do cliente.
//   • Esta campanha → vale só neste report (vence o do anunciante).
//
// PERF: o display/agrupamento sai do mapa EFETIVO que já vem no payload do
// report (data.audience_overrides) + estado otimista do hook — instantâneo, sem
// esperar rede. O selo de escopo (anunciante × campanha) de cada override é
// carregado em SEGUNDO PLANO (list endpoint) e não trava a tela.

import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../../../ui/cn";
import { toast } from "../../../lib/toast";
import { extractAudience, normAudienceKey } from "../../../shared/aggregations";
import { ScopeToggle } from "../../components/FormatBreakdownTableV2";
import { useAudienceOverrides } from "../../hooks/useAudienceOverrides";
import { listAudienceOverrides } from "../../../lib/api";

export function AudienceOverridesModal({
  open,
  onOpenChange,
  clientName,
  shortToken,
  detailRows,           // reportData.detail — pra descobrir as audiências cruas
  overrideMap,          // reportData.audience_overrides — mapa EFETIVO {raw_key: display}
}) {
  const aud = useAudienceOverrides({
    initialMap: overrideMap,
    clientName,
    shortToken,
    isAdmin: true,
  });
  const [scope, setScope] = useState("campaign");          // escopo p/ NOVAS edições (default: só esta campanha)
  const [scopeByKey, setScopeByKey] = useState(null);     // raw_key -> 'advertiser'|'campaign' (selo, async)
  const [newRaw, setNewRaw] = useState("");
  const [newName, setNewName] = useState("");

  // Selos de escopo — carregados em segundo plano; NÃO travam a lista.
  const reloadScopes = async () => {
    if (!clientName) { setScopeByKey({}); return; }
    try {
      const r = await listAudienceOverrides(clientName);
      const rel = (r?.overrides || []).filter(
        (o) => o.scope_token === "" || o.scope_token === shortToken,
      );
      const m = {};
      for (const o of rel) if (o.scope_token === "") m[o.raw_key] = "advertiser";
      for (const o of rel) if (o.scope_token && o.scope_token === shortToken) m[o.raw_key] = "campaign";
      setScopeByKey(m);
    } catch {
      setScopeByKey({}); // falha no selo não quebra a edição
    }
  };

  useEffect(() => {
    if (!open) return;
    setScopeByKey(null);
    setNewRaw("");
    setNewName("");
    reloadScopes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clientName, shortToken]);

  // Candidatos = audiências cruas da campanha (detail) ∪ overrides do mapa
  // efetivo. Display sai do mapa efetivo (override do hook), sem rede.
  const candidates = useMemo(() => {
    const byKey = new Map(); // raw_key -> { key, raw, display }
    for (const r of detailRows || []) {
      const raw = extractAudience(r.line_name);
      if (!raw || raw === "N/A" || /survey/i.test(raw)) continue;
      const key = normAudienceKey(raw);
      if (!byKey.has(key)) byKey.set(key, { key, raw, display: aud.overrideMap[key] || raw });
    }
    for (const [key, display] of Object.entries(aud.overrideMap || {})) {
      if (!byKey.has(key)) byKey.set(key, { key, raw: key, display });
    }
    return [...byKey.values()];
  }, [detailRows, aud.overrideMap]);

  // Agrupa por nome resolvido (merge por nome exato).
  const groups = useMemo(() => {
    const byDisplay = new Map();
    for (const c of candidates) {
      if (!byDisplay.has(c.display)) byDisplay.set(c.display, { display: c.display, members: [] });
      byDisplay.get(c.display).members.push({
        key: c.key,
        raw: c.raw,
        overridden: aud.overrideMap[c.key] != null,
        scope: scopeByKey?.[c.key] || null,
      });
    }
    return [...byDisplay.values()].sort((a, b) => a.display.localeCompare(b.display));
  }, [candidates, aud.overrideMap, scopeByKey]);

  const renameGroup = (members, name) =>
    aud.renameAudience(members.map((m) => m.raw), name, members.map((m) => m.key).join("|"), scope)
      .then(reloadScopes)
      .catch((e) => toast.error(e?.message || "Erro ao salvar"));
  const revertMember = (raw, key) =>
    aud.resetAudience([raw], key, "all")
      .then(reloadScopes)
      .catch((e) => toast.error(e?.message || "Erro ao reverter"));

  const handleAdd = () => {
    const raw = newRaw.trim();
    const name = newName.trim();
    if (!raw || !name) return;
    aud.renameAudience([raw], name, "__new__", scope)
      .then(() => { setNewRaw(""); setNewName(""); return reloadScopes(); })
      .catch((e) => toast.error(e?.message || "Erro ao adicionar"));
  };

  return (
    <Dialog.Root open={open} onOpenChange={aud.busyAudience ? undefined : onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-[60] bg-black/60 backdrop-blur-[3px]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 duration-200",
          )}
        />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-[70] -translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-32px)] max-w-[600px] max-h-[calc(100vh-48px)] overflow-hidden",
            "rounded-2xl border border-border-strong bg-canvas-elevated shadow-2xl",
            "flex flex-col outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 duration-200",
          )}
        >
          {/* Header */}
          <div className="px-5 pt-4 pb-3 border-b border-border">
            <Dialog.Title className="text-sm font-bold text-fg">
              Nomes de audiência · {clientName}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-fg-muted leading-relaxed">
              Renomeie audiências que vieram estranhas da plataforma. Ajudam a IA do hub.
            </Dialog.Description>
            <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-signature/10 border border-signature/20 px-3 py-2">
              <MergeIcon className="mt-px shrink-0 text-signature" />
              <p className="text-[11px] leading-relaxed text-fg-muted">
                <span className="font-semibold text-fg">Dê o mesmo nome a duas audiências</span> para
                mesclá-las (somam métricas no report).
              </p>
            </div>
            <div className="mt-2.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-fg-muted">Aplicar edições em:</span>
              <ScopeToggle scope={scope} onChange={setScope} size="md" />
            </div>
          </div>

          {/* Lista */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2.5">
            {detailRows == null ? (
              <div className="py-8 text-center text-xs text-fg-subtle">Carregando audiências…</div>
            ) : groups.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-fg-subtle">
                Nenhuma audiência com entrega nesta campanha. Adicione um
                mapeamento manual abaixo se já souber o rótulo cru.
              </div>
            ) : (
              groups.map((g) => (
                <GroupCard
                  key={`${g.display}:${g.members.map((m) => m.key).join("|")}`}
                  group={g}
                  busy={aud.busyAudience}
                  onRename={(name) => renameGroup(g.members, name)}
                  onRevert={revertMember}
                />
              ))
            )}
          </div>

          {/* Adicionar manual */}
          <div className="px-5 pt-3 pb-3 border-t border-border">
            <div className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle mb-2">
              Adicionar manualmente
            </div>
            <div className="flex items-center gap-2">
              <input
                value={newRaw}
                onChange={(e) => setNewRaw(e.target.value)}
                placeholder="Rótulo cru (ex: SPORTS-STORE)"
                className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-2.5 py-1.5 text-xs text-fg outline-none focus:ring-1 focus:ring-signature"
              />
              <span className="text-fg-subtle text-xs">→</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
                placeholder="Nome corrigido"
                maxLength={120}
                className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-2.5 py-1.5 text-xs text-fg outline-none focus:ring-1 focus:ring-signature"
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

          {/* Footer */}
          <div className="px-5 py-3 border-t border-border flex justify-end">
            <button
              type="button"
              onClick={() => onOpenChange?.(false)}
              disabled={!!aud.busyAudience}
              className="rounded-md border border-border px-3.5 py-1.5 text-xs font-semibold text-fg hover:bg-surface disabled:opacity-40"
            >
              Fechar
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function GroupCard({ group, busy, onRename, onRevert }) {
  const [draft, setDraft] = useState(group.display || "");
  const merged = group.members.length > 1;
  const overriddenMembers = group.members.filter((m) => m.overridden);
  const overridden = overriddenMembers.length > 0;
  const groupScope = overriddenMembers.some((m) => m.scope === "campaign") ? "campaign"
    : overriddenMembers.some((m) => m.scope === "advertiser") ? "advertiser" : null;
  const groupBusy = busy === group.members.map((m) => m.key).join("|");

  const commit = () => {
    const name = draft.trim();
    if (name && name !== (group.display || "")) onRename(name);
  };

  return (
    <div className={cn("rounded-lg border bg-surface", merged ? "border-signature/40" : "border-border")}>
      <div className="flex items-center gap-2 px-3 py-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
          onBlur={commit}
          maxLength={120}
          disabled={groupBusy}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xs font-semibold text-fg outline-none focus:border-signature focus:bg-canvas"
        />
        {merged && (
          <span className="shrink-0 rounded-full bg-signature/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-signature">
            mesclada · {group.members.length}
          </span>
        )}
        {overridden && groupScope && (
          <span
            title={groupScope === "campaign" ? "Vale só nesta campanha" : "Vale em todo o anunciante"}
            className="shrink-0 rounded-full bg-fg/10 px-2 py-0.5 text-[10px] font-semibold text-fg-muted"
          >
            {groupScope === "campaign" ? "campanha" : "anunciante"}
          </span>
        )}
        {groupBusy && <span className="shrink-0 text-[11px] text-fg-subtle">…</span>}
      </div>

      {merged ? (
        <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
          {group.members.map((m) => (
            <span key={m.key} className="inline-flex items-center gap-1 rounded-md bg-canvas-deeper px-2 py-1 text-[10px] font-mono text-fg-muted">
              {m.raw}
              <button
                type="button"
                onClick={() => onRevert(m.raw, m.key)}
                disabled={busy === m.key}
                title="Separar do merge (reverter este rótulo)"
                className="text-fg-subtle hover:text-danger disabled:opacity-40"
                aria-label={`Separar ${m.raw}`}
              >
                <XMini />
              </button>
            </span>
          ))}
        </div>
      ) : (
        overridden && (
          <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5">
            <span className="text-[10px] text-fg-subtle truncate">
              cru: <span className="font-mono">{group.members[0]?.raw}</span>
            </span>
            <button
              type="button"
              onClick={() => onRevert(group.members[0]?.raw, group.members[0]?.key)}
              disabled={busy === group.members[0]?.key}
              title="Reverter ao nome original da plataforma"
              className="shrink-0 text-[11px] font-semibold text-fg-subtle hover:text-danger disabled:opacity-40"
            >
              Reverter
            </button>
          </div>
        )
      )}
    </div>
  );
}

function MergeIcon({ className }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="12" r="3" />
      <path d="M9 6c4 0 6 2 6 6M9 18c4 0 6-2 6-6" />
    </svg>
  );
}

function XMini() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
