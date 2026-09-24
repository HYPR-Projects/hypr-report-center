// src/v2/components/ma/MaLinksModalV2.jsx
//
// Admin: vincular peças Max Attention à campanha. Nada vincula sozinho — o
// backend sugere (AdBolt, token no nome, nome casado com a linha criativa da
// DSP, nome da campanha, mesmo cliente) e o admin confirma. O ponto de
// partida são as LINHAS CRIATIVAS da DSP: cada uma mostra a peça vinculada
// ou a sugerida, e vincular a sugestão já marca todos os tamanhos da linha
// (é daí que sai a impressão da DSP da peça, camada Mídia). Em report
// agrupado, escolhe o mês (token) que recebe.

import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { getMaLinks, saveMaLinks, searchMaCreatives } from "../../../lib/api";
import { formatLabel } from "../../../shared/maMetrics";
import { lineCoverage, lineSearchQuery, namesToLink, rowPicks, strongSuggestions } from "../../../shared/maLinking";
import { Button } from "../../../ui/Button";
import { Input } from "../../../ui/Input";
import { cn } from "../../../ui/cn";

const REASONS = {
  adbolt: "Tag da DSP (AdBolt)",
  token: "Token no nome",
  name: "Casa com criativo da DSP",
  campaign: "Nome da campanha",
  client: "Mesmo cliente",
  query: "Busca",
};
const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
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
    dsp_creative_names: Array.isArray(item.dsp_creative_names) ? item.dsp_creative_names : item.match_name ? [item.match_name] : [],
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
  const dspLines = useMemo(() => search.context?.lines || [], [search.context]);
  const terms = search.context?.terms || [];

  const add = (item) => {
    setLinks((ls) => {
      if (ls.length >= MAX || ls.some((l) => l.creative_id === String(item.creative_id).toLowerCase())) return ls;
      return [...ls, { ...toLink(item), dsp_creative_names: namesToLink(item, ls) }];
    });
  };
  const addMany = (items) => items.forEach(add);
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
  const coverage = useMemo(() => lineCoverage(dspLines, links, search.items || []), [dspLines, links, search.items]);
  const strong = strongSuggestions(coverage, suggestions);
  const uncovered = coverage.filter((r) => r.covered < r.names.length).length;
  const searchLine = (line) => {
    const query = lineSearchQuery(line, terms);
    setQ(query);
    runSearch(query);
  };

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
                Partimos dos criativos que rodaram na DSP e sugerimos a peça de cada um. Você confirma; os tamanhos da linha já vêm marcados.
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
              <div className="flex flex-wrap items-end justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">Criativos da DSP nesta campanha</h3>
                  <p className="mt-0.5 text-[11px] text-fg-subtle">
                    {search.context?.client ? `Cliente ${search.context.client}` : "Cliente não identificado"}
                    {dspLines.length ? ` · ${dspLines.length} ${dspLines.length === 1 ? "linha criativa" : "linhas criativas"}` : ""}
                    {dspLines.length ? ` · ${uncovered} sem peça` : ""}
                  </p>
                </div>
                {strong.length > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => addMany(strong)} disabled={links.length >= MAX}>
                    Vincular {strong.length === 1 ? "a sugestão" : `as ${strong.length} sugestões`}
                  </Button>
                )}
              </div>
              {search.loading && !dspLines.length ? (
                <p className="text-[12px] text-fg-subtle">Lendo os criativos da campanha…</p>
              ) : !dspLines.length ? (
                <p className="text-[12px] text-fg-subtle">Nenhum criativo da DSP no report desta campanha ainda. Busque a peça pelo nome abaixo.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {coverage.map((row) => {
                    const picks = rowPicks(row);
                    const full = row.covered >= row.names.length;
                    return (
                      <li key={row.line} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                        <div className="min-w-0 flex-1 basis-[260px]">
                          <div className="text-[12px] font-semibold text-fg break-all">{row.line}</div>
                          <div className="text-[11px] text-fg-subtle">
                            {compact.format(row.impressions || 0)} imp. · {row.names.length} {row.names.length === 1 ? "tamanho" : "tamanhos"}
                            {row.covered > 0 && !full ? ` · ${row.covered} com peça` : ""}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
                          {row.linked.length > 0 && (
                            <span
                              className={cn(
                                "inline-flex max-w-[280px] items-center gap-1.5 truncate rounded-md border px-2 py-1 text-[11px] font-semibold",
                                full ? "border-success/30 bg-success-soft text-success" : "border-border text-fg-muted",
                              )}
                              title={row.linked.map((l) => l.name).join(", ")}
                            >
                              ✓ {row.linked.length === 1 ? row.linked[0].name || row.linked[0].creative_id : `${row.linked.length} peças`}
                            </span>
                          )}
                          {!full && picks.length > 0 && (
                            <>
                              <span className="max-w-[240px] truncate text-[12px] text-fg" title={picks.map((p) => p.name).join("\n")}>
                                {picks.length === 1 ? picks[0].name : `${picks.length} peças, uma por tamanho`}
                              </span>
                              <Button size="sm" variant="secondary" onClick={() => addMany(picks)} disabled={links.length >= MAX}>
                                {picks.length === 1 ? "Vincular" : `Vincular ${picks.length}`}
                              </Button>
                            </>
                          )}
                          {!full && picks.length === 0 && (
                            <>
                              <span className="text-[11px] text-fg-subtle">{row.covered ? "Resto sem peça sugerida" : "Sem peça sugerida"}</span>
                              <Button size="sm" variant="ghost" onClick={() => searchLine(row.line)} disabled={search.loading}>Buscar</Button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

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
                      <DspNamesPicker value={l.dsp_creative_names} lines={dspLines} onChange={(names) => setNames(l.creative_id, names)} />
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
                <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">Todas as sugestões da Platform</h3>
                {terms.length > 0 && (
                  <span className="text-[11px] text-fg-subtle">Busca automática por: {terms.join(", ")}</span>
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
                <div className="text-[12px] text-fg-subtle space-y-2">
                  <p>
                    {q.trim()
                      ? `Nenhuma peça da Platform com "${q.trim()}" no nome.`
                      : `Nenhuma peça da Platform casou com ${[
                          search.context?.client && `o cliente ${search.context.client}`,
                          terms.length && `os termos ${terms.join(", ")}`,
                          dspLines.length && `${dspLines.length} linhas criativas da DSP`,
                        ].filter(Boolean).join(", ") || "o contexto da campanha"}.`}
                    {" "}Confira se a peça foi criada na Platform com o nome do criativo, ou busque por outra palavra.
                  </p>
                  {terms.length > 0 && q.trim() && (
                    <div className="flex flex-wrap gap-1.5">
                      {terms.map((t) => (
                        <button key={t} type="button" onClick={() => { setQ(t); runSearch(t); }} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:text-fg hover:border-border-strong cursor-pointer">
                          {t}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
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
                            <span key={r} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-fg-muted">
                              {REASONS[r] || r}
                            </span>
                          ))}
                          {(it.dsp_lines || []).map((line) => (
                            <span key={line} className="rounded border border-signature/30 bg-signature-soft px-1.5 py-0.5 text-[10px] text-signature break-all" title="Linha criativa da DSP que esta peça é">
                              {line}
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

function DspNamesPicker({ value = [], lines = [], onChange }) {
  const norm = (n) => String(n || "").trim().toUpperCase();
  const chosen = new Set(value.map(norm));
  const known = new Set(lines.flatMap((e) => e.names.map(norm)));
  // Nome salvo que não está mais no report (período mudou, criativo pausado):
  // continua aparecendo pra poder desmarcar.
  const orphans = value.filter((n) => !known.has(norm(n)));
  const linesOn = lines.filter((e) => e.names.some((n) => chosen.has(norm(n))));
  const label =
    value.length === 0
      ? "Sem criativo da DSP"
      : linesOn.length === 1 && !orphans.length
        ? linesOn[0].line
        : `${linesOn.length + orphans.length} criativos da DSP`;
  const toggleLine = (e) => {
    const all = e.names.every((n) => chosen.has(norm(n)));
    const names = new Set(e.names.map(norm));
    onChange(all ? value.filter((n) => !names.has(norm(n))) : [...value, ...e.names.filter((n) => !chosen.has(norm(n)))]);
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "max-w-[240px] truncate h-7 px-2.5 rounded-md border text-[11px] font-semibold cursor-pointer",
            value.length ? "border-signature/40 bg-signature-soft text-signature" : "border-warning/40 text-warning hover:text-fg",
          )}
          title="Criativos da DSP que são esta peça (origem da impressão da DSP)"
        >
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={16} className="z-[60] w-[360px] max-h-[340px] overflow-y-auto rounded-xl border border-border bg-surface-2 p-3 shadow-2xl">
          <div className="text-[10.5px] font-bold uppercase tracking-widest text-fg-muted mb-2">Linhas criativas da DSP</div>
          {lines.length === 0 && orphans.length === 0 ? (
            <p className="text-[12px] text-fg-subtle">Nenhum criativo da DSP encontrado no período da campanha.</p>
          ) : (
            <ul className="space-y-1">
              {lines.map((e) => {
                const n = e.names.filter((x) => chosen.has(norm(x))).length;
                return (
                  <li key={e.line}>
                    <label className="flex items-start gap-2 rounded px-1.5 py-1 text-[12px] text-fg hover:bg-surface cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-3.5 accent-signature"
                        checked={n > 0 && n === e.names.length}
                        ref={(el) => { if (el) el.indeterminate = n > 0 && n < e.names.length; }}
                        onChange={() => toggleLine(e)}
                      />
                      <span className="min-w-0">
                        <span className="block break-all">{e.line}</span>
                        <span className="block text-[10.5px] text-fg-subtle">
                          {compact.format(e.impressions || 0)} imp. · {e.names.length} {e.names.length === 1 ? "tamanho" : "tamanhos"}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
              {orphans.map((name) => (
                <li key={name}>
                  <label className="flex items-start gap-2 rounded px-1.5 py-1 text-[12px] text-fg-muted hover:bg-surface cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-3.5 accent-signature"
                      checked
                      onChange={() => onChange(value.filter((x) => x !== name))}
                    />
                    <span className="break-all">{name} <span className="text-[10.5px] text-fg-subtle">(fora do período)</span></span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
