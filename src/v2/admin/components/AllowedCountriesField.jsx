// src/v2/admin/components/AllowedCountriesField.jsx
//
// Campo no CampaignDrawer pra liberar países em que a campanha PODE entregar
// fora do Brasil — a entrega neles deixa de contar no box "Fora do BR" das big
// metrics (vira "previsto").
//
// Existe porque a regra automática lê o país no NOME (line, campanha na DSP,
// campanha no checklist: "CHILE", "AON CH ELUX"), e nomenclatura sempre
// escapa em algum caso. Aqui o ad ops resolve na hora, sem mexer em código.
//
// Salva a cada adição/remoção (a lista inteira, otimista). Falhou → reverte e
// mostra o erro inline. Mesmo vocabulário visual do AbsToggle ("Salvo ✓").

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../ui/cn";
import { getCountryOverride, saveCountryOverride } from "../../../lib/api";

const GLOBE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

const CHECK_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

// Onde a HYPR realmente roda fora do BR primeiro (LATAM), depois o resto.
// Lista curada: um select com 250 países esconde os 5 que importam.
const COUNTRY_OPTIONS = [
  "CL", "PE", "CO", "AR", "MX", "UY", "PY", "BO", "EC", "VE",
  "CR", "PA", "GT", "DO", "PR", "US", "CA", "PT", "ES",
];

const SAVED_FLASH_MS = 2000;

let _names = null;
function countryName(code) {
  try {
    _names = _names || new Intl.DisplayNames(["pt-BR"], { type: "region" });
    return _names.of(code) || code;
  } catch {
    return code;
  }
}

export function AllowedCountriesField({ shortToken, onChange }) {
  const [loading, setLoading] = useState(true);
  const [countries, setCountries] = useState([]);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState(null);
  const savedTimerRef = useRef(null);

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getCountryOverride({ short_token: shortToken })
      .then((o) => { if (!cancelled) setCountries(o?.countries || []); })
      .catch(() => { if (!cancelled) setCountries([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [shortToken]);

  const available = useMemo(
    () => COUNTRY_OPTIONS.filter((c) => !countries.includes(c)),
    [countries],
  );

  const persist = async (next) => {
    const prev = countries;
    setCountries(next);
    setSaving(true);
    setError(null);
    try {
      const saved = await saveCountryOverride({ short_token: shortToken, countries: next });
      setCountries(saved);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      setJustSaved(true);
      savedTimerRef.current = setTimeout(() => setJustSaved(false), SAVED_FLASH_MS);
      onChange?.(saved);
    } catch (e) {
      setCountries(prev);
      setError(e?.message ? `Falha ao salvar: ${e.message}` : "Falha ao salvar, tenta de novo");
    } finally {
      setSaving(false);
    }
  };

  const busy = loading || saving;

  return (
    <div>
      <div className="lbl-section mb-2">
        Entrega fora do Brasil
      </div>
      <div className="px-3 py-2.5 rounded-lg bg-surface border border-border">
        <div className="flex items-start gap-3">
          <span className="shrink-0 text-fg-muted mt-0.5">{GLOBE_ICON}</span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-fg">Países liberados</div>
            <p className="text-[10.5px] text-fg-subtle mt-0.5 leading-snug">
              Entrega nestes países não conta no box "Fora do BR". País no nome
              da line ou da campanha (ex.: CHILE, CH) já é liberado sozinho.
            </p>

            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {loading ? (
                <span className="h-6 w-24 rounded-full bg-surface-strong animate-pulse" />
              ) : (
                <>
                  {countries.map((c) => (
                    <span
                      key={c}
                      className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full border border-border bg-canvas-elevated text-[11px] font-semibold text-fg"
                      title={countryName(c)}
                    >
                      {c}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => persist(countries.filter((x) => x !== c))}
                        aria-label={`Remover ${countryName(c)}`}
                        className={cn(
                          "inline-flex items-center justify-center size-4 rounded-full text-fg-subtle",
                          "hover:text-fg hover:bg-surface-strong cursor-pointer disabled:cursor-not-allowed",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                        )}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {available.length > 0 && (
                    <select
                      value=""
                      disabled={busy}
                      onChange={(e) => {
                        const code = e.target.value;
                        if (code) persist([...countries, code].sort());
                      }}
                      aria-label="Adicionar país liberado"
                      className={cn(
                        "h-6 w-[88px] pl-2 pr-5 rounded-full border border-dashed border-border bg-transparent",
                        "text-[11px] text-fg-muted cursor-pointer disabled:cursor-not-allowed",
                        "hover:border-border-strong hover:text-fg",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                      )}
                    >
                      <option value="">+ país</option>
                      {available.map((c) => (
                        <option key={c} value={c}>{c} · {countryName(c)}</option>
                      ))}
                    </select>
                  )}
                </>
              )}
            </div>

            {error ? (
              <p className="text-[10.5px] text-danger mt-1.5">{error}</p>
            ) : justSaved ? (
              <p className="text-[10.5px] text-success mt-1.5 flex items-center gap-1">
                <span>{CHECK_ICON}</span>
                <span>Salvo. O box "Fora do BR" recalcula na hora.</span>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
