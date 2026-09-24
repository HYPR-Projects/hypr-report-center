// src/v2/admin/components/GeoExclusionToggle.jsx
//
// Toggle no CampaignDrawer pra retirar do report do cliente a entrega DV360
// fora do Brasil (ajuste excepcional de set/2026: line sem geo targeting em
// open exchange). O backend recalcula as frações na hora a partir do relatório
// de Region e só aplica se o Region conciliar com a entrega (backend/geo_exclusions.py).
//
// Diferente dos outros toggles do drawer, o save não é otimista: ele leva
// ~1 min (recálculo no BQ) e o resultado importa (conciliou? quanto saiu?).
// Então o switch fica em "recalculando" até o backend responder com o status.

import { useEffect, useState, useCallback } from "react";
import { getGeoExclusions, saveGeoExclusion, deleteGeoExclusion } from "../../../lib/api";
import { Switch } from "./AbsToggle";

const PIN_OFF_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z" />
    <path d="M4 4l16 16" />
  </svg>
);

const REASON = "Entrega fora do BR por erro de setup (line sem geo targeting)";

const nf = new Intl.NumberFormat("pt-BR");
function compact(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} mil`;
  return nf.format(Math.round(v));
}
function pct(part, total) {
  const t = Number(total) || 0;
  if (!t) return null;
  const p = (Number(part) || 0) / t * 100;
  return `${p.toLocaleString("pt-BR", { maximumFractionDigits: p < 10 ? 1 : 0 })}%`;
}

function StatusLine({ row }) {
  if (!row) return null;
  if (row.status === "blocked") {
    return (
      <p className="text-[10.5px] text-danger mt-0.5 leading-snug">
        Region não conciliou com a entrega (diferença de {row.recon_diff_pct}%). O report segue
        com o último ajuste que fechou, ou sem ajuste.
      </p>
    );
  }
  if (row.status === "no_data" || !row.status) {
    return (
      <p className="text-[10.5px] text-fg-subtle mt-0.5 leading-snug">
        Sem dado de país no Region pra essa campanha. Nada foi retirado.
      </p>
    );
  }
  const removedShare = pct(row.removed_imps, row.unified_imps);
  const estShare = pct(row.estimated_imps, row.unified_imps);
  const noGeoShare = pct(row.no_geo_imps, row.unified_imps);
  return (
    <p className="text-[10.5px] text-fg-subtle mt-0.5 leading-snug">
      {compact(row.removed_imps)} impressões retiradas{removedShare ? ` (${removedShare} da entrega)` : ""}.
      {" "}Conciliação Region × entrega: {row.recon_diff_pct}%.
      {row.estimated_imps > 0 && estShare ? ` ${estShare} estimado (dia sem Region).` : ""}
      {row.no_geo_imps > 0 && noGeoShare ? ` ${noGeoShare} sem país (Yahoo/outras DSPs), mantido.` : ""}
    </p>
  );
}

export function GeoExclusionToggle({ shortToken, onChange }) {
  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState(null);      // linha da config+status, ou null (desligado)
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getGeoExclusions()
      .then((rows) => {
        if (!cancelled) setRow(rows.find((r) => r.short_token === shortToken) || null);
      })
      .catch(() => { if (!cancelled) setRow(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [shortToken]);

  const isOn = !!row;

  const handleToggle = useCallback(async () => {
    if (loading || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { status, warning } = isOn
        ? await deleteGeoExclusion({ short_token: shortToken })
        : await saveGeoExclusion({ short_token: shortToken, reason: REASON });
      const next = isOn ? null : (status.find((r) => r.short_token === shortToken) || { status: null });
      setRow(next);
      if (warning) setError(warning);
      onChange?.(!!next);
    } catch (e) {
      setError(e?.message ? `Falha: ${e.message}` : "Falha ao salvar, tenta de novo");
    } finally {
      setSaving(false);
    }
  }, [loading, saving, isOn, shortToken, onChange]);

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-surface border border-border">
      <span className="shrink-0 text-fg-muted mt-0.5">{PIN_OFF_ICON}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-fg">Retirar do report a entrega fora do BR</div>
        {error ? (
          <p className="text-[10.5px] text-danger mt-0.5">{error}</p>
        ) : saving ? (
          <p className="text-[10.5px] text-fg-subtle mt-0.5">Recalculando pelo Region do DV360, leva até 1 min…</p>
        ) : isOn ? (
          <StatusLine row={row} />
        ) : (
          <p className="text-[10.5px] text-fg-subtle mt-0.5 leading-snug">
            Só DV360 (única DSP com país no BQ). Países liberados acima continuam no report.
          </p>
        )}
      </div>
      <Switch checked={isOn} disabled={loading || saving} loading={loading || saving} onClick={handleToggle} />
    </div>
  );
}
