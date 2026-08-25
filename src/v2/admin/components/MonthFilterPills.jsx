// src/v2/admin/components/MonthFilterPills.jsx
//
// Filtro de mês — antes uma fileira de pílulas, agora o painel do chip
// "Período".
//
// Por que saiu da fileira
// ────────────────────────────────────────────────────────────────────────
// A lista tinha "Todos" + um mês por cohort presente na base. Com 2026 em
// andamento isso já eram DEZ pílulas ocupando uma faixa inteira de 52px,
// que quebrava em duas linhas em telas médias — uma segunda barra de
// navegação horizontal logo abaixo da primeira, com o mesmo peso visual da
// busca e da ordenação ao lado. E as pílulas eram permanentes: ocupavam a
// faixa toda mesmo quando "Todos" estava selecionado, que é o estado
// default e o mais comum.
//
// Como painel, os mesmos meses com as mesmas contagens ficam a um clique —
// e o chip mostra qual está ativo (`Período · Ago 26`), o que a fileira não
// conseguia dizer sem você varrer dez pílulas procurando a tintada.
//
// A semântica não mudou em nada: clicar no mês ativo limpa, "Todos" é o
// estado sem filtro, e a contagem por mês é a mesma (campanhas cujo
// `start_date` cai naquele mês).

import { formatMonthLabel } from "../lib/format";
import { useMonthBuckets } from "../lib/filterLabels";
import { FilterPanel, FilterOption } from "./FilterBar";

// `useMonthBuckets` e `monthFilterLabel` vivem em ../lib/filterLabels.js.

/** Conteúdo do popover do chip "Período". */
export function MonthFilterPanel({ campaigns, activeMonth, onChange, onClose }) {
  const months = useMonthBuckets(campaigns);
  const total = campaigns?.length || 0;

  const pick = (month) => {
    onChange(month);
    onClose?.();
  };

  return (
    <FilterPanel title="Mês de início" maxHeight={340}>
      <FilterOption
        label="Todos os meses"
        count={total}
        selected={activeMonth === null}
        onSelect={() => pick(null)}
      />
      {months.map(({ month, count }) => (
        <FilterOption
          key={month}
          label={formatMonthLabel(month)}
          count={count}
          selected={activeMonth === month}
          // Reclicar o mês ativo limpa — mesmo comportamento das pílulas.
          onSelect={() => pick(activeMonth === month ? null : month)}
        />
      ))}
    </FilterPanel>
  );
}
