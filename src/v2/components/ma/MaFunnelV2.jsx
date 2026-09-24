// src/v2/components/ma/MaFunnelV2.jsx
//
// Funil da peça em pessoas. Cada linha: etapa · barra · pessoas · conversão
// da etapa anterior. A maior perda depois da visualização ganha destaque.
//
// Escala: do "Viu a peça" para a primeira interação a queda costuma ser de
// 97–99%, e com a mesma régua todas as barras seguintes viram um risco. Nesse
// caso a base aparece inteira (esmaecida, marcada como base) e as demais
// etapas usam a régua da 2ª etapa — o rodapé avisa.

import { fmt } from "../../../shared/format";
import { funnelConversions } from "../../../shared/maMetrics";
import { cn } from "../../../ui/cn";

const pct = (v) => (v == null ? "—" : `${fmt(v, v < 1 ? 2 : 1)}%`);

// Celular: rótulo + números numa linha e a barra embaixo, na largura toda.
// sm+: uma linha só (rótulo · barra · pessoas · conversão).
const ROW = "grid items-center gap-x-3 gap-y-1 grid-cols-[minmax(0,1fr)_auto_4.5rem] sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_5.5rem_5rem]";
const BAR = "order-last col-span-3 sm:order-none sm:col-span-1";

export function MaFunnelV2({ steps, subs = [], note = null, unitLabel = "pessoas" }) {
  const { rows, biggestDrop } = funnelConversions(steps || []);
  if (!rows.length) return null;
  const base = rows[0].value;
  const second = rows[1]?.value || 0;
  const broken = rows.length > 1 && base > 0 && second / base < 0.2 && second > 0;
  const scale = broken ? second : base;
  const width = (v, i) => {
    if (i === 0) return 100;
    if (!scale) return 0;
    return Math.max(0.8, Math.min(100, (v / scale) * 100));
  };
  const last = rows[rows.length - 1]?.value || 0;

  return (
    <div>
      <div className="grid gap-1.5" role="table" aria-label="Funil em pessoas">
        {rows.map((r, i) => {
          const isDrop = biggestDrop?.index === i;
          return (
            <div
              key={r.key || r.label}
              role="row"
              className={ROW}
            >
              <span role="cell" className="text-[12px] text-fg-muted truncate" title={r.hint || r.label}>
                {r.label}
              </span>
              <div role="cell" className={cn("h-2.5 rounded-full bg-track overflow-hidden", BAR)}>
                <div
                  className={cn("h-full rounded-full", i === 0 ? "bg-fg-subtle/40" : "bg-signature")}
                  style={{ width: `${width(r.value, i)}%` }}
                />
              </div>
              <span role="cell" className="text-[12px] font-semibold text-fg tabular-nums text-right">
                {fmt(r.value)}
              </span>
              <span
                role="cell"
                className={cn(
                  "text-[11px] tabular-nums text-right",
                  isDrop ? "text-warning font-bold" : "text-fg-subtle",
                )}
                title={i === 0 ? "Base do funil" : "Conversão da etapa anterior"}
              >
                {i === 0 ? "base" : pct(r.conversion)}
              </span>
            </div>
          );
        })}
        {subs.map((s) => (
          <div
            key={s.key || s.label}
            role="row"
            className={ROW}
          >
            <span role="cell" className="text-[11px] text-fg-subtle truncate pl-3">↳ {s.label}</span>
            <div role="cell" className={cn("h-1.5 rounded-full bg-track overflow-hidden", BAR)}>
              <div className="h-full rounded-full bg-signature/55" style={{ width: `${width(s.value, 1)}%` }} />
            </div>
            <span role="cell" className="text-[11px] text-fg tabular-nums text-right">{fmt(s.value)}</span>
            <span role="cell" className="text-[11px] text-fg-subtle tabular-nums text-right" title="Parcela de quem chegou à última etapa">
              {last > 0 ? pct((s.value / last) * 100) : "—"}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-snug text-fg-subtle">
        {biggestDrop ? (
          <>
            Maior perda depois da visualização:{" "}
            <span className="font-semibold text-fg">{biggestDrop.from} → {biggestDrop.to}</span>{" "}
            (−{fmt(biggestDrop.drop)} {unitLabel}).{" "}
          </>
        ) : null}
        O percentual de cada etapa é sobre a etapa anterior{subs.length ? "; nos detalhes (↳), sobre a última etapa" : ""}.
        {" "}Todas as etapas contam {unitLabel} (sessões distintas).
        {broken ? " A barra da base está fora de escala; as demais usam a régua da segunda etapa." : ""}
        {note ? ` ${note}` : ""}
      </p>
    </div>
  );
}
