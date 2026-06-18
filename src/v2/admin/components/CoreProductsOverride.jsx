// src/v2/admin/components/CoreProductsOverride.jsx
//
// Curadoria admin de QUAIS core products (O2O / OOH / Groundflow) aparecem no
// report de um token. Existe pra resolver bug recorrente: ao encerrar a campanha
// o CS remove uma frente no Command, mas checklist_info mantém contracted_<frente>_*
// stale (a pipeline hyprster não zera frente removida) e a frente "fantasma"
// reaparece no report (que lê contrato AO VIVO, até congelado).
//
// Este override VENCE o checklist_info: o backend zera contratado/bônus das
// frentes desmarcadas em _fetch_contracts, propagando pra toda a matemática e
// pro gating de tab. Ausência de override ≡ "Automático" (deriva do checklist).
//
// UX: espelha AbsToggle (optimistic save, flash "Salvo ✓" inline, erro inline).
//   - Sem override        → modo "Automático", as 3 frentes marcadas (default).
//   - Editar uma checkbox → vira "Manual", salva o set marcado (override).
//   - "Restaurar automático" → remove o override (volta a derivar do checklist).

import { useEffect, useState, useCallback, useRef } from "react";
import { cn } from "../../../ui/cn";
import { getCoreProductsOverride, saveCoreProductsOverride } from "../../../lib/api";

const FRENTES = [
  { id: "O2O", label: "O2O" },
  { id: "OOH", label: "OOH" },
  { id: "GROUNDFLOW", label: "Groundflow" },
];

const LAYERS_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 2 9 5-9 5-9-5 9-5z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" />
  </svg>
);

const INFO_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
  </svg>
);

const CHECK_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const SAVED_FLASH_MS = 2000;
const ALL = FRENTES.map((f) => f.id);

export function CoreProductsOverride({ shortToken, onChange }) {
  const [loading, setLoading] = useState(true);
  // `selected` = frentes marcadas. Em modo automático, todas marcadas (default).
  const [selected, setSelected] = useState(() => new Set(ALL));
  const [hasOverride, setHasOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState(null);
  const savedTimerRef = useRef(null);

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCoreProductsOverride({ short_token: shortToken })
      .then((override) => {
        if (cancelled) return;
        if (override?.products?.length) {
          setHasOverride(true);
          setSelected(new Set(override.products));
        } else {
          setHasOverride(false);
          setSelected(new Set(ALL));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setHasOverride(false);
        setSelected(new Set(ALL));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [shortToken]);

  const persist = useCallback(async (nextSet) => {
    const products = ALL.filter((id) => nextSet.has(id));
    // Tudo marcado ≡ sem restrição → remove o override (volta ao automático).
    const isAutomatic = products.length === ALL.length;
    setSaving(true);
    setError(null);
    try {
      await saveCoreProductsOverride({
        short_token: shortToken,
        products: isAutomatic ? [] : products,
      });
      setHasOverride(!isAutomatic);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      setJustSaved(true);
      savedTimerRef.current = setTimeout(() => setJustSaved(false), SAVED_FLASH_MS);
      onChange?.(products);
    } catch {
      setError("Falha ao salvar — tenta de novo");
      // Reverte pro estado servido pelo backend.
      getCoreProductsOverride({ short_token: shortToken })
        .then((o) => {
          setHasOverride(!!o?.products?.length);
          setSelected(new Set(o?.products?.length ? o.products : ALL));
        })
        .catch(() => {});
    } finally {
      setSaving(false);
    }
  }, [shortToken, onChange]);

  const toggle = (id) => {
    if (loading || saving) return;
    const next = new Set(selected);
    if (next.has(id)) {
      // Não deixa desmarcar TODAS (report sem frente nenhuma não faz sentido).
      if (next.size <= 1) return;
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelected(next); // optimistic
    persist(next);
  };

  const restoreAutomatic = () => {
    if (loading || saving) return;
    const next = new Set(ALL);
    setSelected(next);
    persist(next);
  };

  return (
    <div>
      <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-2">
        Core products no report
      </div>
      <div className="px-3 py-2.5 rounded-lg bg-surface border border-border">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="shrink-0 text-fg-muted">{LAYERS_ICON}</span>
          <div className="text-xs font-medium text-fg flex items-center gap-1.5">
            Frentes exibidas
            <span
              className="text-fg-subtle"
              title="Sobrescreve o checklist: as frentes desmarcadas somem do report (Visão Geral, Display, Video, pacing), mesmo que o Command/checklist ainda traga volumetria delas. Use ao encerrar uma campanha em que uma frente foi removida mas continua 'fantasma'."
            >
              {INFO_ICON}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {FRENTES.map((f) => {
            const on = selected.has(f.id);
            return (
              <button
                key={f.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={loading || saving}
                onClick={() => toggle(f.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold",
                  "border transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
                  on
                    ? "border-signature bg-signature-soft text-signature"
                    : "border-border bg-surface text-fg-subtle hover:border-border-strong hover:text-fg",
                  (loading || saving) ? "opacity-70 cursor-not-allowed" : "cursor-pointer",
                )}
              >
                {on && <span>{CHECK_ICON}</span>}
                {f.label}
              </button>
            );
          })}
        </div>

        {/* Label de estado: erro > flash salvo > modo (automático/manual). */}
        <div className="mt-2 min-h-[14px]">
          {error ? (
            <p className="text-[10.5px] text-danger">{error}</p>
          ) : justSaved ? (
            <p className="text-[10.5px] text-success flex items-center gap-1">
              <span>{CHECK_ICON}</span><span>Salvo</span>
            </p>
          ) : loading ? (
            <p className="text-[10.5px] text-fg-subtle">Carregando…</p>
          ) : hasOverride ? (
            <p className="text-[10.5px] text-fg-subtle flex items-center gap-2">
              <span>Manual — sobrescreve o checklist</span>
              <button
                type="button"
                onClick={restoreAutomatic}
                disabled={saving}
                className="text-signature hover:underline disabled:opacity-60 cursor-pointer"
              >
                Restaurar automático
              </button>
            </p>
          ) : (
            <p className="text-[10.5px] text-fg-subtle">Automático — derivado do checklist</p>
          )}
        </div>
      </div>
    </div>
  );
}
