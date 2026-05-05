// src/v2/admin/components/AbsToggle.jsx
//
// Toggle inline no CampaignDrawer pra marcar Brand Safety pre-bid (ABS) numa
// campanha. Existe pra cobrir o caso onde o sinal automático do BQ não detecta
// — principalmente Xandr Curate em open exchange (deal_id=0), que é a maioria
// do volume Xandr e onde a config de ABS mora dentro da UI do Xandr, fora do
// pipeline de ingestão atual.
//
// Estados:
//   - loading: skeleton enquanto fetch inicial do override
//   - override marcado (admin ligou): toggle ON, editable, label "Marcado manualmente"
//   - sem override + autoDetected:    toggle ON, desabilitado, label "Detectado automaticamente"
//   - sem override + !autoDetected:   toggle OFF, editable
//
// `autoDetected` da prop é OR (sinal_automático || override) porque vem da
// flag agregada do payload — então sempre fazemos GET pra decidir qual dos
// dois é a verdadeira fonte do ON.
//
// Auto-save optimistic: o toggle muda visualmente na hora; save assíncrono
// dispara em paralelo. Se falha, reverte e mostra erro inline.

import { useEffect, useState, useCallback } from "react";
import { cn } from "../../../ui/cn";
import { getAbsOverride, saveAbsOverride } from "../../../lib/api";

const SHIELD_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

const INFO_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </svg>
);

export function AbsToggle({ shortToken, autoDetected, onChange }) {
  const [loading, setLoading] = useState(true);
  const [overrideExists, setOverrideExists] = useState(false);
  const [overrideOn, setOverrideOn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Fetch inicial sempre — `autoDetected` da prop é OR, então só o GET diz
  // se o ON vem de sinal automático ou de override manual.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAbsOverride({ short_token: shortToken })
      .then((override) => {
        if (cancelled) return;
        setOverrideExists(override !== null);
        setOverrideOn(!!override?.has_abs);
      })
      .catch(() => {
        if (cancelled) return;
        setOverrideExists(false);
        setOverrideOn(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [shortToken]);

  // Auto detectado de verdade = sinal do payload ON E não há override marcado.
  // Quando override existe, o admin é dono do estado — toggle vira editável.
  const trulyAuto = autoDetected && !overrideExists;

  const handleToggle = useCallback(async () => {
    if (trulyAuto || saving) return;
    const next = !overrideOn;
    // Optimistic update: UI responde na hora.
    setOverrideOn(next);
    setOverrideExists(true);
    setSaving(true);
    setError(null);
    try {
      await saveAbsOverride({ short_token: shortToken, has_abs: next });
      onChange?.(next);
    } catch (e) {
      // Reverte e expõe erro inline. Não usa toast pra não poluir — o erro
      // some sozinho na próxima interação ou ao fechar o drawer.
      setOverrideOn(!next);
      setError("Falha ao salvar — tenta de novo");
    } finally {
      setSaving(false);
    }
  }, [trulyAuto, saving, overrideOn, shortToken, onChange]);

  const isOn = trulyAuto || overrideOn;
  const disabled = trulyAuto || loading || saving;

  return (
    <div>
      <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-2">
        Brand Safety
      </div>
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface border border-border">
        <span className="shrink-0 text-fg-muted">{SHIELD_ICON}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-fg flex items-center gap-1.5">
            Pre-bid (DV ABS / IAS)
            <span
              className="text-fg-subtle"
              title="Marque se a campanha tem brand safety pre-bid configurado no DSP (DV ABS no DV360, ou DV/IAS no Xandr). Quando ativo, os thresholds eCPM/CTR ficam permissivos no score do Top Performers."
            >
              {INFO_ICON}
            </span>
          </div>
          {trulyAuto && (
            <p className="text-[10.5px] text-fg-subtle mt-0.5">Detectado automaticamente</p>
          )}
          {!trulyAuto && overrideOn && (
            <p className="text-[10.5px] text-fg-subtle mt-0.5">Marcado manualmente</p>
          )}
          {error && (
            <p className="text-[10.5px] text-danger mt-0.5">{error}</p>
          )}
        </div>
        <Switch
          checked={isOn}
          disabled={disabled}
          loading={loading || saving}
          onClick={handleToggle}
        />
      </div>
    </div>
  );
}

function Switch({ checked, disabled, loading, onClick }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative shrink-0 w-9 h-5 rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        checked ? "bg-signature" : "bg-surface-strong",
        disabled && !loading && "opacity-70 cursor-not-allowed",
        !disabled && "cursor-pointer"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-canvas-elevated shadow-sm transition-transform",
          checked && "translate-x-4",
          loading && "animate-pulse"
        )}
      />
    </button>
  );
}
