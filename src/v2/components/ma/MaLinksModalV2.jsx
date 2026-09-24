// src/v2/components/ma/MaLinksModalV2.jsx
//
// Admin: vincular peças Max Attention à campanha. Nada vincula sozinho — a
// Platform sugere (tag AdBolt, token no nome, nome parecido com o criativo da
// DSP, mesmo cliente) e o admin confirma. Para cada peça vinculada o admin
// marca quais criativos da DSP são ela: é daí que sai a impressão da DSP da
// peça (camada Mídia). Em report agrupado, escolhe o mês (token) que recebe.

import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { getMaLinks, saveMaLinks, searchMaCreatives } from "../../../lib/api";
import { formatLabel } from "../../../shared/maMetrics";
import { Button } from "../../../ui/Button";
import { Input } from "../../../ui/Input";
import { cn } from "../../../ui/cn";

const REASONS = {
  adbolt: "Tag da DSP (AdBolt)",
  token: "Token no nome",
  name: "Nome parecido com criativo da DSP",
  client: "Mesmo cliente",
  query: "Busca",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX = 20;

function toLink(item) {
  return {
    creative_id: String(item.creative_id).toLowerCase(),
    name: item.name || "",
    template_slug: item.template_slug || item.format || "",
    public_slug: item.public_slug || "",
    size: item.size || "",
    client_name: item.client_name || "",
    dsp_creative_names: item.dsp_creative_names || (item.match_name ? [item.match_name] : []),
    status: item.status || "",
  };
}

export function MaLinksModalV2({ open, onOpenChange, targets, defaultTarget, adminJwt, onSaved }) {
  const [target, setTarget] = useState(defaultTarget);
  const [links, setLinks] = useState([]);
  const [initial, setInitial] = useState("[]");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState({ items: [], configured: true, context: null, error: null, loading: false });
  const [manualId, setManualId] = useState("");

  // Carrega os vínculos do token escolhido e as sugestões de contexto.
  useEffect(() => {
    if (!open || !target) return undefined;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
    });
    getMaLinks({ short_token: target, adminJwt })
      .then(({ links: ls }) => {
        if (cancelled) return;
        const clean = ls.map(toLink);
        setLinks(clean);
        setInitial(JSON.stringify(clean));
      })
      .catch((e) => !cancelled && setError(e?.message || "Erro ao ler os vínculos"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [open, target, adminJwt]);

  const runSearch = (query = q) => {
    setSearch((s) => ({ ...s, loading: true, error: null }));
    searchMaCreatives({ token: target, q: query, adminJwt })
      .then((res) => setSearch({ ...res, loading: false }))
      .catch((e) => setSearch((s) => ({ ...s, loading: false, error: e?.message || "Busca falhou" })));
  };

  useEffect(() => {
    if (!open || !target) return undefined;
    let cancelled = false;
    Promise.resolve().then(() => !cancelled && setSearch((s) => ({ ...s, loading: true, error: null })));
    searchMaCreatives({ token: target, q: "", adminJwt })
      .then((res) => !cancelled && setSearch({ ...res, loading: false }))
      .catch((e) => !cancelled && setSearch((s) => ({ ...s, loading: false, error: e?.message || "Busca falhou" })));
    return () => { cancelled = true; };
  }, [open, target, adminJwt]);

  const linkedIds = useMemo(() => new Set(links.map((l) => l.creative_id)), [links]);
  const dirty = JSON.stringify(links) !== initial;
  const dspNames = search.context?.dsp_creative_names || [];

  const add = (item) => {
    if (links.length >= MAX || linkedIds.has(String(item.creative_id).toLowerCase())) return;
    setLinks((ls) => [...ls, toLink(item)]);
  };
  const remove = (id) => setLinks((ls) => ls.filter((l) => l.creative_id !== id));
  const move = (i, dir) =>
    setLinks((ls) => {
      const j = i + dir;
      if (j < 0 || j >= ls.length) return ls;
      const out = [...ls];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });
  const setNames = (id, names) =>
    setLinks((ls) => ls.map((l) => (l.creative_id === id ? { ...l, dsp_creative_names: names } : l)));

  const addManual = () => {
    const id = manualId.trim().toLowerCase();
    if (!UUID_RE.test(id)) {
      setError("ID de peça inválido: use o ID (UUID) da peça na Platform.");
      return;
    }
    add({ creative_id: id, name: `Peça ${id.slice(0, 8)}` });
    setManualId("");
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // `status` é só para a tela (peça arquivada); não vai para o backend.
      const payload = links.map((l) => {
        const out = { ...l };
        delete out.status;
        return out;
      });
      const saved = await saveMaLinks({ short_token: target, links: payload, adminJwt });
      const clean = (saved.length ? saved : payload).map(toLink);
      setLinks(clean);
      setInitial(JSON.stringify(clean));
      onSaved?.(clean, target);
      onOpenChange(false);
    } catch (e) {
      setError(e?.message || "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const suggestions = (search.items || []).filter((it) => !linkedIds.has(String(it.creative_id).toLowerCase()));

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[3px]" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-32px)] max-w-[880px] max-h-[calc(100vh-48px)]",
            "rounded-2xl border border-border-strong bg-canvas-elevated shadow-2xl flex flex-col outline-none",
          )}
        >
          <div className="px-6 pt-5 pb-4 border-b border-border flex items-start justify-between gap-4 shrink-0">
            <div className="min-w-0">
              <Dialog.Title className="text-[10.5px] font-bold uppercase tracking-[1.5px] text-signature">
                Max Attention · vínculo de peças
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] text-fg-muted leading-snug">
                A Platform sugere, você confirma. Marque em cada peça quais criativos da DSP são ela: a impressão da DSP da peça sai daí.
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Fechar" className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-surface cursor-pointer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </Dialog.Close>
          </div>

          <div className="overflow-y-auto px-6 py-5 space-y-6">
            {targets.length > 1 && (
              <label className="flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
                Vincular ao mês
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="h-8 rounded-md border border-border bg-canvas-deeper px-2 text-xs text-fg"
                  disabled={dirty || saving}
                  title={dirty ? "Salve ou descarte as mudanças antes de trocar de mês" : undefined}
                >
                  {targets.map((t) => (
                    <option key={t.token} value={t.token}>{t.label}</option>
                  ))}
                </select>
              </label>
            )}

            <section>
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">Vinculadas ({links.length}/{MAX})</h3>
                {dirty && <span className="text-[11px] text-warning">Alterações não salvas</span>}
              </div>
              {loading ? (
                <p className="text-[12px] text-fg-subtle">Carregando…</p>
              ) : links.length === 0 ? (
                <p className="text-[12px] text-fg-subtle">Nenhuma peça vinculada. Sem peça vinculada, a aba não aparece para o cliente.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {links.map((l, i) => (
                    <li key={l.creative_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold text-fg truncate">{l.name || l.creative_id}</div>
                        <div className="text-[11px] text-fg-subtle truncate">
                          {formatLabel(l.template_slug)}{l.size ? ` · ${l.size}` : ""}{l.client_name ? ` · ${l.client_name}` : ""}
                          {l.status === "archived" ? " · arquivada" : ""}
                        </div>
                      </div>
                      <DspNamesPicker value={l.dsp_creative_names} options={dspNames} onChange={(names) => setNames(l.creative_id, names)} />
                      <div className="flex items-center gap-1">
                        <IconBtn label="Subir" onClick={() => move(i, -1)} disabled={i === 0}>↑</IconBtn>
                        <IconBtn label="Descer" onClick={() => move(i, 1)} disabled={i === links.length - 1}>↓</IconBtn>
                        <IconBtn label={`Remover ${l.name}`} onClick={() => remove(l.creative_id)}>✕</IconBtn>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <div className="flex flex-wrap items-end justify-between gap-2 mb-2">
                <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">Sugestões da Platform</h3>
                {search.context?.client && (
                  <span className="text-[11px] text-fg-subtle">Contexto: cliente {search.context.client} · {dspNames.length} criativos da DSP na campanha</span>
                )}
              </div>
              <form
                className="flex gap-2 mb-3"
                onSubmit={(e) => { e.preventDefault(); runSearch(q); }}
              >
                <Input
                  size="sm"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar por nome, ID ou slug da peça"
                  aria-label="Buscar peças na Platform"
                />
                <Button type="submit" variant="secondary" size="sm" loading={search.loading}>Buscar</Button>
              </form>
              {!search.configured ? (
                <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[12px] text-fg-muted">
                  {search.error || "Integração com a Platform não configurada."} Ainda dá para vincular pelo ID da peça abaixo.
                </p>
              ) : search.error ? (
                <p className="text-[12px] text-danger">{search.error}</p>
              ) : search.loading ? (
                <p className="text-[12px] text-fg-subtle">Buscando…</p>
              ) : suggestions.length === 0 ? (
                <p className="text-[12px] text-fg-subtle">Nenhuma sugestão nova. Tente buscar pelo nome da peça.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {suggestions.map((it) => (
                    <li key={it.creative_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold text-fg truncate">{it.name}</div>
                        <div className="text-[11px] text-fg-subtle truncate">
                          {formatLabel(it.template_slug)}{it.size ? ` · ${it.size}` : ""}{it.client_name ? ` · ${it.client_name}` : ""}
                          {it.status && it.status !== "published" ? ` · ${it.status === "archived" ? "arquivada" : it.status}` : ""}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {(it.reasons || []).map((r) => (
                            <span key={r} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-fg-muted" title={r === "name" && it.match_name ? `Parecido com "${it.match_name}"` : undefined}>
                              {REASONS[r] || r}{r === "name" && it.match_name ? `: ${it.match_name}` : ""}
                            </span>
                          ))}
                        </div>
                      </div>
                      <Button size="sm" variant="secondary" onClick={() => add(it)} disabled={links.length >= MAX}>Vincular</Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  size="sm"
                  value={manualId}
                  onChange={(e) => setManualId(e.target.value)}
                  placeholder="Ou cole o ID da peça (UUID)"
                  aria-label="ID da peça"
                  className="max-w-[340px]"
                />
                <Button size="sm" variant="ghost" onClick={addManual} disabled={!manualId.trim()}>Adicionar por ID</Button>
              </div>
            </section>

            {error && <p className="text-[12px] text-danger">{error}</p>}
          </div>

          <div className="px-6 py-4 border-t border-border flex justify-end gap-2 shrink-0">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
            <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={!dirty || saving}>
              {saving ? "Salvando…" : "Salvar vínculos"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function IconBtn({ label, onClick, disabled, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex size-7 items-center justify-center rounded-md text-[12px] text-fg-muted hover:text-fg hover:bg-surface disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function DspNamesPicker({ value = [], options = [], onChange }) {
  const all = [...new Set([...options, ...value])];
  const label = value.length === 0 ? "Sem criativo da DSP" : value.length === 1 ? value[0] : `${value.length} criativos da DSP`;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "max-w-[220px] truncate h-7 px-2.5 rounded-md border text-[11px] font-semibold cursor-pointer",
            value.length ? "border-signature/40 bg-signature-soft text-signature" : "border-border text-fg-muted hover:text-fg",
          )}
          title="Criativos da DSP que são esta peça (origem da impressão da DSP)"
        >
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={16} className="z-[60] w-[320px] max-h-[320px] overflow-y-auto rounded-xl border border-border bg-surface-2 p-3 shadow-2xl">
          <div className="text-[10.5px] font-bold uppercase tracking-widest text-fg-muted mb-2">Criativos da DSP nesta campanha</div>
          {all.length === 0 ? (
            <p className="text-[12px] text-fg-subtle">Nenhum criativo da DSP encontrado no período da campanha.</p>
          ) : (
            <ul className="space-y-1">
              {all.map((n) => {
                const checked = value.includes(n);
                return (
                  <li key={n}>
                    <label className="flex items-start gap-2 rounded px-1.5 py-1 text-[12px] text-fg hover:bg-surface cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-3.5 accent-signature"
                        checked={checked}
                        onChange={() => onChange(checked ? value.filter((x) => x !== n) : [...value, n])}
                      />
                      <span className="break-all">{n}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
