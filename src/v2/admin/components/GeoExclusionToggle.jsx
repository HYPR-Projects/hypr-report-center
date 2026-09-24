// src/v2/admin/components/GeoExclusionToggle.jsx
//
// Toggle no CampaignDrawer pra retirar do report do cliente a entrega DV360
// fora do Brasil (ajuste excepcional de set/2026: line sem geo targeting em
// open exchange). O backend recalcula as frações a partir do relatório de
// Region e só aplica se o Region conciliar com a entrega (backend/geo_exclusions.py).
//
// Diferente dos outros toggles do drawer, o save não é otimista no resultado:
// ligar recalcula a campanha no BQ (segundos) e o que volta importa (conciliou?
// quanto saiu?). Então o switch vai pra posição pedida na hora, mostra que está
// aplicando com um contador, e só assenta quando o backend responde. Estado
// explícito em texto ("Ativo", "Desligado", "Aplicando… 6s") pra nunca ficar
// a dúvida de se clicou ou não.

import { useEffect, useRef, useState, useCallback } from "react";
import { cn } from "../../../ui/cn";
import { getGeoExclusions, saveGeoExclusion, deleteGeoExclusion } from "../../../lib/api";

const PIN_OFF_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z" />
    <path d="M4 4l16 16" />
  </svg>
);

const CHECK_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const REASON = "Entrega fora do BR por erro de setup (line sem geo targeting)";
const DONE_FLASH_MS = 6000;

const nf = new Intl.NumberFormat("pt-BR");
function compact(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} mil`;
  return nf.format(Math.round(v));
}
function brl(n) {
  return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
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
      <p className="text-[10.5px] text-danger mt-1 leading-snug">
        Region não conciliou com a entrega (diferença de {row.recon_diff_pct}%). O report segue
        com o último ajuste que fechou, ou sem ajuste.
      </p>
    );
  }
  if (row.status === "no_data" || !row.status) {
    return (
      <p className="text-[10.5px] text-fg-subtle mt-1 leading-snug">
        Sem dado de país no Region pra essa campanha. Nada foi retirado.
      </p>
    );
  }
  const removedShare = pct(row.removed_imps, row.unified_imps);
  const estShare = pct(row.estimated_imps, row.unified_imps);
  const noGeoShare = pct(row.no_geo_imps, row.unified_imps);
  const video = Number(row.removed_video_100) || 0;
  return (
    <div className="text-[10.5px] text-fg-subtle mt-1 leading-snug space-y-0.5">
      <p>
        <span className="text-fg font-medium">{compact(row.removed_imps)} impressões</span> retiradas
        {removedShare ? ` (${removedShare} da entrega)` : ""}
        {video > 0 ? `, incluindo ${compact(video)} views 100% de vídeo` : ", nada de vídeo fora do BR"}.
      </p>
      {row.removed_cost > 0 && (
        <p>Custo DSP fora do BR: {brl(row.removed_cost)}. Continua no Gasto do admin.</p>
      )}
      <p>
        Conciliação Region × entrega: {row.recon_diff_pct}%.
        {row.estimated_imps > 0 && estShare ? ` ${estShare} estimado (dia sem Region).` : ""}
        {row.no_geo_imps > 0 && noGeoShare ? ` ${noGeoShare} sem país (Yahoo/outras DSPs), mantido.` : ""}
      </p>
    </div>
  );
}

// Switch próprio: o do AbsToggle desligado (trilho cinza, sem borda) lia como
// "desabilitado". Aqui desligado tem trilho claro com borda e bolinha escura;
// aplicando mostra spinner na bolinha e cursor de espera.
function GeoSwitch({ checked, busy, disabled, onClick }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy}
      aria-label="Retirar do report a entrega fora do BR"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative shrink-0 w-10 h-[22px] rounded-full border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        checked ? "bg-signature border-signature" : "bg-canvas-elevated border-border-strong",
        busy ? "cursor-wait" : disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-signature",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] left-[2px] w-4 h-4 rounded-full shadow-sm transition-transform flex items-center justify-center",
          checked ? "translate-x-[18px] bg-canvas-elevated" : "bg-fg-muted",
        )}
      >
        {busy && (
          <span className={cn(
            "block w-2.5 h-2.5 rounded-full border-2 border-t-transparent animate-spin",
            checked ? "border-signature" : "border-canvas-elevated",
          )} />
        )}
      </span>
    </button>
  );
}

export function GeoExclusionToggle({ shortToken, onChange }) {
  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState(null);        // config+status, ou null (desligado)
  const [pending, setPending] = useState(null); // null | "on" | "off"
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState(null);       // null | "on" | "off" (flash de confirmação)
  const [error, setError] = useState(null);
  const timerRef = useRef(null);
  const doneRef = useRef(null);

  useEffect(() => () => {
    clearInterval(timerRef.current);
    clearTimeout(doneRef.current);
  }, []);

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
  const shownOn = pending ? pending === "on" : isOn;

  const handleToggle = useCallback(async () => {
    if (loading || pending) return;
    const target = isOn ? "off" : "on";
    setPending(target);
    setError(null);
    setDone(null);
    setElapsed(0);
    const t0 = Date.now();
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    try {
      const { status, warning } = target === "off"
        ? await deleteGeoExclusion({ short_token: shortToken })
        : await saveGeoExclusion({ short_token: shortToken, reason: REASON });
      const next = target === "off" ? null : (status.find((r) => r.short_token === shortToken) || { status: null });
      setRow(next);
      if (warning) setError(warning);
      setDone(target);
      clearTimeout(doneRef.current);
      doneRef.current = setTimeout(() => setDone(null), DONE_FLASH_MS);
      onChange?.(!!next);
    } catch (e) {
      setError(e?.message ? `Não aplicou: ${e.message}` : "Não aplicou. Tenta de novo.");
    } finally {
      clearInterval(timerRef.current);
      setPending(null);
    }
  }, [loading, pending, isOn, shortToken, onChange]);

  let badge;
  if (loading) badge = <span className="h-4 w-14 rounded-full bg-surface-strong animate-pulse" />;
  else if (pending) badge = (
    <span className="text-[10px] font-semibold uppercase tracking-wide text-signature">
      {pending === "on" ? "Aplicando" : "Desligando"}… {elapsed}s
    </span>
  );
  else if (isOn) badge = (
    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-success-soft text-success">
      Ativo
    </span>
  );
  else badge = (
    <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">Desligado</span>
  );

  return (
    <div className={cn(
      "px-3 py-2.5 rounded-lg border transition-colors",
      isOn || pending === "on" ? "bg-signature-soft/40 border-signature/40" : "bg-surface border-border",
    )}>
      <div className="flex items-start gap-3">
        <span className="shrink-0 text-fg-muted mt-0.5">{PIN_OFF_ICON}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-fg">Retirar do report a entrega fora do BR</span>
            {badge}
          </div>

          {error ? (
            <p className="text-[10.5px] text-danger mt-1 leading-snug">{error}</p>
          ) : pending === "on" ? (
            <p className="text-[10.5px] text-fg-subtle mt-1 leading-snug">
              Calculando pelo Region do DV360 quanto saiu do Brasil (display e vídeo) e conferindo
              com a entrega. Pode fechar o drawer: o ajuste termina sozinho.
            </p>
          ) : pending === "off" ? (
            <p className="text-[10.5px] text-fg-subtle mt-1 leading-snug">Voltando a mostrar a entrega cheia…</p>
          ) : done === "on" && row?.status === "ok" ? (
            <>
              <p className="text-[10.5px] text-success mt-1 flex items-center gap-1">
                <span>{CHECK_ICON}</span>
                <span>Aplicado. A lista recarrega agora e o report do cliente atualiza em até 1 min.</span>
              </p>
              <StatusLine row={row} />
            </>
          ) : done === "off" ? (
            <p className="text-[10.5px] text-success mt-1 flex items-center gap-1">
              <span>{CHECK_ICON}</span>
              <span>Desligado. O report volta a mostrar a entrega cheia em até 1 min.</span>
            </p>
          ) : isOn ? (
            <StatusLine row={row} />
          ) : !loading ? (
            <p className="text-[10.5px] text-fg-subtle mt-1 leading-snug">
              Só DV360 (única DSP com país no BQ), display e vídeo. Países liberados acima continuam no report.
            </p>
          ) : null}
        </div>
        <GeoSwitch
          checked={shownOn}
          busy={!!pending}
          disabled={loading || !!pending}
          onClick={handleToggle}
        />
      </div>
    </div>
  );
}
