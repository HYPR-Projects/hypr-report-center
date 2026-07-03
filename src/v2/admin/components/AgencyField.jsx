// src/v2/admin/components/AgencyField.jsx
//
// Campo inline no CampaignDrawer pra definir a AGÊNCIA do cliente exibida no
// eyebrow do header do report ("OBOTICÁRIO · ALMAPBBDO"). A fonte primária é
// o Sales Center (checklists.agency); este override cobre campanhas
// pré-Sales Center e correções. Precedência no report: override > Sales
// Center > nada. Limpar o campo remove o override (volta ao Sales Center).
//
// Estados:
//   - loading: skeleton do input enquanto fetch inicial do override
//   - override presente: input preenchido, label "Definida manualmente"
//   - sem override + salesAgency: input vazio com placeholder da agência do
//     Sales Center, label "Via Sales Center"
//   - sem override + sem salesAgency: input vazio, placeholder genérico
//
// Save no Enter ou no blur (só quando o valor mudou). Flash "Salvo ✓" inline
// por 2s — mesma linguagem do AbsToggle.

import { useEffect, useState, useRef } from "react";
import { getAgencyOverride, saveAgencyOverride } from "../../../lib/api";

const BRIEFCASE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="14" rx="2" />
    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
  </svg>
);

const CHECK_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const SAVED_FLASH_MS = 2000;

export function AgencyField({ shortToken, salesAgency = null }) {
  const [loading, setLoading] = useState(true);
  const [value, setValue] = useState("");
  // Último valor persistido — referência pra saber se o blur precisa salvar.
  const [savedValue, setSavedValue] = useState("");
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
    getAgencyOverride({ short_token: shortToken })
      .then((override) => {
        if (cancelled) return;
        const agency = override?.agency || "";
        setValue(agency);
        setSavedValue(agency);
      })
      .catch(() => {
        if (cancelled) return;
        setValue("");
        setSavedValue("");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [shortToken]);

  const handleSave = async () => {
    const next = value.trim();
    if (saving || next === savedValue) return;
    setSaving(true);
    setError(null);
    try {
      await saveAgencyOverride({ short_token: shortToken, agency: next });
      setSavedValue(next);
      setValue(next);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      setJustSaved(true);
      savedTimerRef.current = setTimeout(() => setJustSaved(false), SAVED_FLASH_MS);
    } catch {
      setError("Falha ao salvar — tenta de novo");
    } finally {
      setSaving(false);
    }
  };

  const hasOverride = !!savedValue;

  return (
    <div>
      <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-2">
        Agência
      </div>
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface border border-border">
        <span className="shrink-0 text-fg-muted">{BRIEFCASE_ICON}</span>
        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="h-6 rounded bg-surface-strong animate-pulse" />
          ) : (
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setValue(savedValue);
                  e.currentTarget.blur();
                }
              }}
              disabled={saving}
              placeholder={salesAgency || "ex: AlmapBBDO"}
              aria-label="Agência do cliente"
              className={[
                "w-full bg-transparent text-xs font-medium text-fg placeholder:text-fg-subtle",
                "focus:outline-none",
                saving && "opacity-60",
              ].filter(Boolean).join(" ")}
            />
          )}
          {/* Prioridade de label: erro > flash de salvo > origem do valor. */}
          {error ? (
            <p className="text-[10.5px] text-danger mt-0.5">{error}</p>
          ) : justSaved ? (
            <p className="text-[10.5px] text-success mt-0.5 flex items-center gap-1">
              <span>{CHECK_ICON}</span>
              <span>Salvo</span>
            </p>
          ) : hasOverride ? (
            <p className="text-[10.5px] text-fg-subtle mt-0.5">
              Definida manualmente — aparece no header do report
            </p>
          ) : salesAgency ? (
            <p className="text-[10.5px] text-fg-subtle mt-0.5">
              Via Sales Center — preencha pra sobrescrever
            </p>
          ) : (
            <p className="text-[10.5px] text-fg-subtle mt-0.5">
              Aparece no header do report, ao lado do cliente
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
