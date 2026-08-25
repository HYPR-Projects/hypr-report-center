// src/v2/admin/lib/filterLabels.js
//
// Rótulos e derivações dos chips da FilterBar.
//
// Moram fora dos componentes por duas razões. A técnica: o
// `react-refresh/only-export-components` do ESLint exige que um arquivo de
// componente exporte só componentes. A de fundo: o texto que aparece NO
// chip é a única coisa que o usuário lê pra saber o que está filtrando —
// vale ter um lugar onde as regras de rotulagem se leem juntas, em vez de
// espalhadas por cinco painéis.
//
// A convenção de todas elas: devolvem `undefined` quando não há filtro, e
// nunca uma string como "Todos". `undefined` deixa o chip em estado neutro
// (só o rótulo, sem tinta); uma string faria o chip anunciar um filtro que
// não existe — e aí "Período · Todos os meses" ocuparia o mesmo peso visual
// de "Período · Ago 26", que é um filtro de verdade.

import { useMemo } from "react";
import { formatMonthLabel } from "./format";

/**
 * Owners selecionados.
 *
 *   []                        → undefined
 *   ["joao@…"]                → "João Buzolin"
 *   ["joao@…", "duda@…", …]   → "João Buzolin +2"
 */
export function ownerFilterLabel(selected, teamMembers) {
  if (!selected?.length) return undefined;
  const all = [...(teamMembers?.cps || []), ...(teamMembers?.css || [])];
  const first = selected[0];
  const name = all.find((m) => m.email === first)?.name || first.split("@")[0];
  return selected.length === 1 ? name : `${name} +${selected.length - 1}`;
}

/** Mês ativo, no formato curto ("Ago 26"). */
export function monthFilterLabel(activeMonth) {
  if (!activeMonth) return undefined;
  return formatMonthLabel(activeMonth, "short");
}

/**
 * Meses presentes na base, decrescente, com contagem de campanhas cujo
 * `start_date` cai naquele mês. Mesma conta que as pílulas faziam.
 */
export function useMonthBuckets(campaigns) {
  return useMemo(() => {
    const counter = new Map();
    for (const c of campaigns || []) {
      const m = c.start_date?.slice(0, 7);
      if (!m) continue;
      counter.set(m, (counter.get(m) || 0) + 1);
    }
    return [...counter.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, count]) => ({ month, count }));
  }, [campaigns]);
}

/**
 * Rótulo humano de cada bucket do worklist. Usado no painel do chip
 * "Situação" e no chip de filtro ativo.
 */
export const WORKLIST_LABELS = {
  pacing_critical:    "pacing crítico",
  no_owner:           "sem owner",
  ending_soon:        "encerram em 7 dias",
  reports_not_viewed: "reports não vistos",
};

/**
 * Rótulo do chip "Situação" do menu — combina o toggle "apenas ativas" com
 * o bucket de worklist selecionado, que antes eram dois controles em faixas
 * diferentes (uma pill e uma fileira de pills) apesar de responderem à
 * mesma pergunta: "que recorte de campanha eu quero ver?".
 */
export function situationLabel({ onlyActive, worklistKey, worklistLabels }) {
  const parts = [];
  if (onlyActive) parts.push("Ativas");
  if (worklistKey) parts.push(worklistLabels?.[worklistKey] || worklistKey);
  if (parts.length === 0) return undefined;
  return parts.join(" · ");
}
