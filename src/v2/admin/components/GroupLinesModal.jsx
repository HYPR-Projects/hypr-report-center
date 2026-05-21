// src/v2/admin/components/GroupLinesModal.jsx
//
// Modal pra agrupar N lines do MESMO cliente sob um único PI compartilhado.
// Espelha o `MergeModal` do admin de reports — mas opera em line_id.
//
// Fluxo:
//   1. Admin clica "Agrupar" numa line → modal abre
//   2. Modal lista lines do mesmo cliente (via `listPmpGroupableLines`)
//   3. Admin marca checkboxes das lines que vão entrar no grupo
//   4. (Opcional) preenche nome do grupo e/ou short_token compartilhado
//   5. Salva → cria grupo no backend, fecha modal, refresca lista
//
// Estados especiais:
//   • Algumas lines candidatas já estão em OUTROS grupos → mostra badge
//     "já no grupo X" e desabilita o checkbox (admin precisa desagrupar antes)
//   • Se a line ATUAL já está em grupo → o modal vira "Adicionar membros"
//     em vez de "Criar grupo"

import { useState, useEffect, useMemo } from "react";
import {
  Drawer, DrawerContent, DrawerHeader, DrawerBody, DrawerFooter,
} from "../../../ui/Drawer";
import { Button } from "../../../ui/Button";
import { Skeleton } from "../../../ui/Skeleton";
import { cn } from "../../../ui/cn";
import {
  listPmpGroupableLines, groupPmpLines, ungroupPmpLine,
} from "../../../lib/api";
import {
  formatBRL, bidTypeLabel, bidTypeBadgeClass,
  statusPillClass, effectiveDeliveryMeta, effectiveStatus,
} from "../lib/pmpFormat";

export function GroupLinesModal({ open, onOpenChange, line, onGroupCreated }) {
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [groupName, setGroupName] = useState("");
  const [shortToken, setShortToken] = useState("");
  const [saving, setSaving] = useState(false);

  const alreadyInGroup = !!line?.group_id;

  // Reset state quando line muda
  useEffect(() => {
    if (!line) return;
    setSelected(new Set());
    setError(null);
    setGroupName(line.group_name || (line.customer ? `${line.customer} · ${line.campaign_name || ""}`.trim() : ""));
    setShortToken(line.short_token || line.group_short_token || "");
    setLoading(true);
    listPmpGroupableLines(line.line_id)
      .then((list) => {
        setCandidates(list);
        // Pré-seleciona lines que já estão no mesmo grupo (se houver)
        if (alreadyInGroup) {
          const same = list.filter(c => c.current_group_id === line.group_id).map(c => c.line_id);
          setSelected(new Set(same));
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [line, alreadyInGroup]);

  if (!line) return null;

  const toggle = (lineId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  };

  const handleSave = async () => {
    setError(null);
    if (selected.size === 0) {
      setError("Selecione pelo menos 1 line pra agrupar");
      return;
    }
    setSaving(true);
    try {
      const allIds = [line.line_id, ...Array.from(selected)];
      const group = await groupPmpLines({
        line_ids: allIds,
        group_name: groupName.trim() || null,
        short_token: shortToken.trim() || null,
      });
      onGroupCreated?.(group);
      onOpenChange(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleUngroup = async () => {
    if (!confirm(`Remover line ${line.line_id} do grupo? Se sobrar 1 line, o grupo será dissolvido.`)) return;
    setSaving(true); setError(null);
    try {
      await ungroupPmpLine(line.line_id);
      onGroupCreated?.(null); // sinaliza refresh
      onOpenChange(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent widthClass="sm:w-[560px]">
        <DrawerHeader
          title={alreadyInGroup ? "Editar grupo de lines" : "Agrupar lines sob mesmo PI"}
          subtitle={`Line ${line.line_id} · ${line.customer || "?"} · ${line.campaign_name || ""}`}
        />
        <DrawerBody>
          <div className="space-y-5">
            <div className="text-xs text-fg-muted leading-relaxed">
              Selecione lines do <strong>mesmo cliente</strong> que compartilham o
              mesmo PI. Os valores de revenue e margem do grupo serão somados
              e o % entrega calculado contra o PI único do checklist.
            </div>

            {/* Nome do grupo */}
            <FieldGroup label="Nome do grupo (opcional)">
              <input
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="ex: Nestlé Nutren A/B Fixed vs Flex"
                className="w-full h-9 px-3 rounded-md bg-surface border border-border text-sm text-fg"
              />
            </FieldGroup>

            {/* Short token compartilhado (Command checklist) */}
            <FieldGroup label="Short token Command (opcional — PI vem daqui)">
              <input
                type="text"
                value={shortToken}
                onChange={(e) => setShortToken(e.target.value.toUpperCase())}
                placeholder="ex: NO2015"
                className="w-full h-9 px-3 rounded-md bg-surface border border-border text-sm text-fg uppercase font-mono"
              />
            </FieldGroup>

            {/* Lista de candidatas */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
                  Lines do mesmo cliente ({line.customer || "?"})
                </div>
                <div className="text-[11px] text-fg-muted tabular-nums">
                  {selected.size} selecionada{selected.size === 1 ? "" : "s"}
                </div>
              </div>

              {loading && <Skeleton className="h-32 w-full rounded-md" />}

              {!loading && candidates.length === 0 && !error && (
                <div className="rounded-md border border-border bg-surface/40 px-3 py-6 text-center text-xs text-fg-muted">
                  Não tem outras lines desse cliente pra agrupar.
                </div>
              )}

              {!loading && candidates.length > 0 && (
                <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
                  {candidates.map((c) => {
                    const conflictGroup = c.current_group_id && c.current_group_id !== line.group_id;
                    const checked = selected.has(c.line_id);
                    // Considera o workflow status (Finalizado/Cancelado/Pausado vira cinza)
                    const dm = (c.delivery_status || c.status) ? effectiveDeliveryMeta(c) : null;
                    const wf = effectiveStatus(c);
                    return (
                      <label
                        key={c.line_id}
                        className={cn(
                          "flex items-start gap-3 p-3 rounded-md border transition-colors cursor-pointer",
                          conflictGroup ? "border-rose-500/20 bg-rose-500/5 cursor-not-allowed opacity-60"
                          : checked     ? "border-signature/40 bg-signature/5"
                          :               "border-border hover:bg-surface/50",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={conflictGroup}
                          onChange={() => toggle(c.line_id)}
                          className="mt-0.5 accent-signature shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-[11px] text-fg-muted">{c.line_id}</span>
                            {c.bid_type && (
                              <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-medium border", bidTypeBadgeClass(c.bid_type))}>
                                {bidTypeLabel(c.bid_type)}
                              </span>
                            )}
                            {dm && (
                              <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium border", dm.border, dm.text, dm.bg)}
                                    title="Estado de entrega">
                                <span className={cn("w-1 h-1 rounded-full", dm.dot)} />
                                {dm.label}
                              </span>
                            )}
                            {wf && wf !== "Pendente" && (
                              <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border", statusPillClass(wf))}
                                    title="Status workflow">
                                {wf}
                              </span>
                            )}
                            {c.short_token && (
                              <span className="font-mono text-[9px] text-signature bg-signature/10 px-1 py-0.5 rounded">
                                {c.short_token}
                              </span>
                            )}
                            {conflictGroup && (
                              <span className="text-[10px] text-rose-400 font-medium">
                                já no grupo {c.current_group_name || c.current_group_id}
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-fg mt-0.5 truncate">{c.line_name}</div>
                          {(c.start_date || c.end_date) && (
                            <div className="text-[10px] text-fg-subtle mt-0.5">
                              {c.start_date || "?"} → {c.end_date || "?"}
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {error && (
              <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-400">
                {error}
              </div>
            )}
          </div>
        </DrawerBody>
        <DrawerFooter>
          {alreadyInGroup && (
            <Button variant="ghost" size="md" onClick={handleUngroup} className="mr-auto" disabled={saving}>
              Desagrupar esta line
            </Button>
          )}
          <Button variant="ghost" size="md" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" size="md" onClick={handleSave} disabled={saving || selected.size === 0}>
            {saving ? "Salvando..." : (alreadyInGroup ? "Atualizar grupo" : `Agrupar ${selected.size + 1} lines`)}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function FieldGroup({ label, children }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}
