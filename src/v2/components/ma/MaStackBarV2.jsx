// src/v2/components/ma/MaStackBarV2.jsx
//
// Participação de cada superfície/botão/controle, em linhas de barra
// ordenadas do maior para o menor (MaBarRows). Linha ordenada lê melhor que
// barra 100% quando um item domina (ex.: capa com 98,9% deixava o resto
// como fios de 2px).
//
// `list`: as partes não somam um todo (pessoas por ação, em que uma pessoa
// faz mais de uma). A barra é relativa à maior parte e a participação, se
// vier `shareBase`, é sobre essa base (ex.: pessoas que interagiram).

import { fmt } from "../../../shared/format";
import { MaBarRows } from "./maUi";

/** Abaixo disso, percentual de clique não indica preferência. */
export const SMALL_SAMPLE = 20;

const share = (v) => `${fmt(v, v > 0 && v < 1 ? 2 : 1)}%`;

// `percentOnly`: só a participação (%), sem contagem. No report do cliente os
// cliques no CTA contados pela peça não aparecem em número absoluto — somados,
// competiriam com os cliques da DSP.
export function MaStackBarV2({ parts = [], unit = "", list = false, percentOnly = false, shareBase = null }) {
  const total = parts.reduce((s, p) => s + (p.value || 0), 0);
  if (!parts.length || total <= 0) {
    return <p className="text-[13px] text-fg-subtle">Sem registros no período.</p>;
  }
  const sorted = [...parts].filter((p) => p.value > 0).sort((a, b) => b.value - a.value);

  if (list) {
    const max = Math.max(...sorted.map((p) => p.value), 1);
    return (
      <MaBarRows
        label={unit ? `Em ${unit}` : undefined}
        rows={sorted.map((p) => ({
          label: p.label,
          valueText: fmt(p.value),
          shareText: shareBase > 0 ? share((p.value / shareBase) * 100) : "",
          width: (p.value / max) * 100,
        }))}
      />
    );
  }

  return (
    <MaBarRows
      label={unit ? `Participação no total de ${unit}` : undefined}
      rows={sorted.map((p) => {
        const s = (p.value / total) * 100;
        return {
          label: p.label,
          valueText: percentOnly ? share(s) : fmt(p.value),
          shareText: percentOnly ? "" : share(s),
          width: s,
        };
      })}
    />
  );
}
