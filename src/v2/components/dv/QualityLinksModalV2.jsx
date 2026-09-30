// src/v2/components/dv/QualityLinksModalV2.jsx
//
// Admin: conectar a campanha HYPR às campanhas da DoubleVerify e escolher o
// período que entra na análise da aba Quality. Os nomes da DV são livres
// ("Gatorade_F1_2026"), então nada conecta sozinho — a lista só vem ordenada
// pelas palavras em comum com o nome da campanha, e o admin confirma. Em
// report agrupado, escolhe o mês (token) que recebe a conexão.

import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { getDvCampaigns, getQualityLinks, saveQualityLinks } from "../../../lib/api";
import { rankDvCampaigns } from "../../../shared/dvQualityReport";
import { Button } from "../../../ui/Button";
import { cn } from "../../../ui/cn";

const MAX = 20;
const DATE_INPUT = "h-8 rounded-md border border-border bg-canvas-deeper px-2 text-xs text-fg tabular-nums";

function fmtDay(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function QualityLinksModalV2({
  open, onOpenChange, targets, defaultTarget, adminJwt, campaignHint, defaultFrom, defaultTo, onSaved,
}) {
  const [target, setTarget] = useState(defaultTarget);
  const [catalog, setCatalog] = useState({ names: [], loading: true, error: null });
  const [current, setCurrent] = useState({ loading: true, error: null, data: null });
  const [selected, setSelected] = useState([]);
  const [from, setFrom] = useState(defaultFrom || "");
  const [to, setTo] = useState(defaultTo || "");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Catálogo de campanhas DV (uma vez por abertura).
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    getDvCampaigns({ adminJwt })
      .then((names) => { if (!cancelled) setCatalog({ names, loading: false, error: null }); })
      .catch((e) => { if (!cancelled) setCatalog({ names: [], loading: false, error: e }); });
    return () => { cancelled = true; };
  }, [open, adminJwt]);

  // Conexão atual do token escolhido.
  useEffect(() => {
    if (!open || !target) return undefined;
    let cancelled = false;
    setCurrent({ loading: true, error: null, data: null });
    getQualityLinks({ short_token: target, adminJwt })
      .then((d) => {
        if (cancelled) return;
        setCurrent({ loading: false, error: null, data: d });
        setSelected(d?.linked ? d.campaigns || [] : []);
        setFrom(d?.linked && d.date_from ? d.date_from : defaultFrom || "");
        setTo(d?.linked && d.date_to ? d.date_to : defaultTo || "");
      })
      .catch((e) => { if (!cancelled) setCurrent({ loading: false, error: e, data: null }); });
    return () => { cancelled = true; };
  }, [open, target, adminJwt, defaultFrom, defaultTo]);

  const ranked = useMemo(() => rankDvCampaigns(catalog.names, campaignHint), [catalog.names, campaignHint]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = t ? ranked.filter((n) => n.toLowerCase().includes(t)) : ranked;
    // Selecionadas primeiro: é o que o admin precisa conferir antes de salvar.
    const sel = new Set(selected);
    return [...list.filter((n) => sel.has(n)), ...list.filter((n) => !sel.has(n))];
  }, [ranked, q, selected]);

  const linked = !!current.data?.linked;
  const periodOk = from && to && from <= to;
  const canSave = selected.length > 0 && periodOk && !saving && !current.loading;

  const toggle = (n) =>
    setSelected((s) => (s.includes(n) ? s.filter((x) => x !== n) : s.length >= MAX ? s : [...s, n]));

  const persist = async (campaigns) => {
    setSaving(true);
    setError(null);
    try {
      await saveQualityLinks({
        short_token: target, campaigns, date_from: campaigns.length ? from : null, date_to: campaigns.length ? to : null, adminJwt,
      });
      await onSaved?.();
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[3px]" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-32px)] max-w-[720px] max-h-[calc(100vh-48px)]",
            "rounded-2xl border border-border-strong bg-canvas-elevated shadow-2xl flex flex-col outline-none",
          )}
        >
          <div className="px-6 pt-5 pb-4 border-b border-border flex items-start justify-between gap-4 shrink-0">
            <div className="min-w-0">
              <Dialog.Title className="text-[10.5px] font-bold uppercase tracking-[1.5px] text-signature">
                Conectar DoubleVerify
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] text-fg-muted leading-snug">
                Escolha as campanhas da DV que correspondem a esta campanha e o período da análise.
                A aba Quality aparece para o cliente assim que você salvar.
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Fechar" className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-surface cursor-pointer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </Dialog.Close>
          </div>

          <div className="overflow-y-auto px-6 py-5 space-y-6">
            {targets.length > 1 && (
              <label className="flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
                Conectar ao mês
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="h-8 rounded-md border border-border bg-canvas-deeper px-2 text-xs text-fg"
                  disabled={saving}
                >
                  {targets.map((t) => (
                    <option key={t.token} value={t.token}>{t.label}</option>
                  ))}
                </select>
              </label>
            )}

            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted mb-2">Período da análise</h3>
              <div className="flex flex-wrap items-center gap-2">
                <input type="date" aria-label="Início" value={from} onChange={(e) => setFrom(e.target.value)} className={DATE_INPUT} />
                <span className="text-fg-subtle text-xs">até</span>
                <input type="date" aria-label="Fim" value={to} onChange={(e) => setTo(e.target.value)} className={DATE_INPUT} />
                {defaultFrom && defaultTo && (from !== defaultFrom || to !== defaultTo) && (
                  <Button variant="ghost" size="sm" onClick={() => { setFrom(defaultFrom); setTo(defaultTo); }}>
                    Toda a campanha ({fmtDay(defaultFrom)} → {fmtDay(defaultTo)})
                  </Button>
                )}
              </div>
              {!periodOk && (from || to) && (
                <p className="mt-1.5 text-[11px] text-danger">O início precisa ser antes do fim.</p>
              )}
              <p className="mt-1.5 text-[11px] text-fg-subtle">Dias futuros entram conforme a DV fecha cada dia (D-1).</p>
            </section>

            <section>
              <div className="flex flex-wrap items-end justify-between gap-2 mb-2">
                <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">
                  Campanhas da DV <span className="text-fg-subtle normal-case tracking-normal font-medium">· {selected.length} selecionada{selected.length === 1 ? "" : "s"}</span>
                </h3>
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar campanha da DV…"
                  aria-label="Buscar campanha da DV"
                  className="h-8 w-full sm:w-[260px] px-2.5 rounded-md bg-surface border border-border text-[12.5px] text-fg placeholder:text-fg-subtle outline-none focus:border-signature"
                />
              </div>
              {catalog.loading || current.loading ? (
                <p className="text-[12px] text-fg-subtle">Carregando campanhas da DoubleVerify…</p>
              ) : catalog.error || current.error ? (
                <p className="text-[12px] text-danger">{(catalog.error || current.error).message}</p>
              ) : (
                <ul className="max-h-[320px] overflow-y-auto divide-y divide-border rounded-lg border border-border">
                  {shown.length === 0 && (
                    <li className="px-3 py-3 text-[12px] text-fg-subtle">Nenhuma campanha encontrada.</li>
                  )}
                  {shown.map((n) => {
                    const on = selected.includes(n);
                    return (
                      <li key={n}>
                        <label className={cn(
                          "flex items-center gap-2.5 px-3 py-2 cursor-pointer text-[12.5px] hover:bg-surface",
                          on ? "text-fg font-semibold" : "text-fg-muted",
                        )}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggle(n)}
                            disabled={!on && selected.length >= MAX}
                            className="size-3.5 accent-[var(--color-signature)] cursor-pointer"
                          />
                          <span className="break-all">{n}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {error && <p role="alert" className="text-[12px] text-danger">{error.message}</p>}
          </div>

          <div className="px-6 py-4 border-t border-border flex flex-wrap items-center justify-between gap-2 shrink-0">
            <div className="text-[11px] text-fg-subtle">
              {linked && current.data?.linked_by ? `Conectado por ${current.data.linked_by}` : ""}
            </div>
            <div className="flex gap-2 ml-auto">
              {linked && (
                <Button variant="ghost" size="sm" onClick={() => persist([])} disabled={saving}>
                  Desconectar
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancelar
              </Button>
              <Button variant="primary" size="sm" onClick={() => persist(selected)} disabled={!canSave}>
                {saving ? "Salvando…" : "Salvar"}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
