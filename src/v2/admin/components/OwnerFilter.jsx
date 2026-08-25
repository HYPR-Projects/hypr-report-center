// src/v2/admin/components/OwnerFilter.jsx
//
// Seleção multiselect de owners (CPs + CSs) — agora como PAINEL, não como
// controle completo.
//
// O que mudou e por quê
// ────────────────────────────────────────────────────────────────────────
// Antes este arquivo era um Popover inteiro: gatilho próprio (`h-9 pl-3
// pr-3 rounded-lg`, com ícone de pessoa e chevron), header próprio com
// contador e "Limpar", e a lista. Ao lado dele, na mesma fileira, viviam um
// `<select>` de ordenação com OUTRO chevron, um botão de direção, uma pill
// "Apenas ativas" e dez pills de mês — cinco geometrias de controle pro
// mesmo tipo de decisão.
//
// O gatilho e o header agora vêm do `FilterChip` / `FilterPanel` do
// FilterBar, que é o mesmo par usado por período, situação, status e
// cliente. O que sobra aqui é o que só o owner sabe: como agrupar por
// papel (CS/CP), como rotular a seleção e por que o multiselect existe.
//
// Por que multiselect
// ───────────────────
// Pedido real da operação: "ver as campanhas do CP Eduarda E do CS João" —
// owners se cruzam em todo lugar. A regra de combinação (AND entre papéis,
// OR dentro do mesmo papel) vive em `../lib/ownerFilter.js`.

import { useMemo } from "react";
import {
  FilterPanel, FilterOption, FilterGroupLabel, FilterPanelClear,
} from "./FilterBar";

// O rótulo da seleção (`ownerFilterLabel`) vive em ../lib/filterLabels.js —
// junto com os outros rótulos de chip, e fora de um arquivo de componente.

/** Conteúdo do popover do chip "Owner". */
export function OwnerFilterPanel({ selected = [], onChange, teamMembers }) {
  const total = useMemo(
    () => (teamMembers?.cps?.length || 0) + (teamMembers?.css?.length || 0),
    [teamMembers],
  );

  const toggle = (email) => {
    if (selected.includes(email)) onChange(selected.filter((e) => e !== email));
    else onChange([...selected, email]);
  };

  return (
    <FilterPanel
      title={selected.length === 0 ? "Todos os owners" : `${selected.length} de ${total}`}
      maxHeight={340}
      footer={
        <FilterPanelClear
          onClear={() => onChange([])}
          disabled={selected.length === 0}
        />
      }
    >
      {total === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-fg-subtle">
          Nenhum owner disponível.
        </div>
      ) : (
        <>
          {/* CSs primeiro: é o papel que mais filtra por si mesmo no dia a
              dia, e a ordem antiga (CSs → CPs) já era essa. */}
          <OwnerGroup label="CSs" people={teamMembers?.css} selected={selected} onToggle={toggle} />
          <OwnerGroup label="CPs" people={teamMembers?.cps} selected={selected} onToggle={toggle} />
        </>
      )}
    </FilterPanel>
  );
}

function OwnerGroup({ label, people, selected, onToggle }) {
  if (!people?.length) return null;
  return (
    <div>
      <FilterGroupLabel>{label}</FilterGroupLabel>
      {people.map((p) => (
        <FilterOption
          key={p.email}
          multi
          label={p.name}
          selected={selected.includes(p.email)}
          onSelect={() => onToggle(p.email)}
        />
      ))}
    </div>
  );
}
