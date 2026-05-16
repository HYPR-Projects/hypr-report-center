// src/v2/admin/components/MonthGroupedSections.jsx
//
// Renderiza uma lista agrupada por mês com headers colapsáveis. Extraído
// do MonthLayout original do CampaignMenuV2 pra ser reusado:
//   1) Menu admin "Por mês" (campanhas globais)
//   2) Drilldown de cliente (campanhas do cliente agrupadas por mês)
//
// Ambos os usos compartilham a UX de:
//   - Header sticky com label do mês (uppercase tracking) + contador
//   - Click no header colapsa/expande
//   - Default: meses passados colapsados, mês corrente expandido, último
//     mês da lista sempre aberto (cobre o caso "dia 1 do mês novo, sem
//     dados ainda no corrente, abrir o último com dados")
//   - Auto-expand quando há filtro ativo (filterSignature mudou)
//   - Setas keyboard accessible
//
// API
// ───
//   <MonthGroupedSections
//     groups={[{ key: "2026-05", label: "Maio de 2026", items: [...] }]}
//     renderItem={(item) => <CampaignCardV2 ... />}
//     filterSignature="kenvue|joao@hypr.mobi"
//     emptyMessage="Nenhuma campanha encontrada com os filtros atuais."
//   />
//
// Os `items` são opacos — o caller decide o shape e o renderItem casa.
// Permite item poder ser `Campaign`, `{ kind: 'single'|'group', ... }`,
// etc. sem o componente saber a estrutura.

import { useEffect, useState, useCallback } from "react";
import { cn } from "../../../ui/cn";

export function MonthGroupedSections({
  groups,
  renderItem,
  filterSignature = "",
  emptyMessage = "Nenhuma campanha encontrada com os filtros atuais.",
}) {
  const currentYM = new Date().toISOString().slice(0, 7);

  // Estado de colapso por chave de mês. Default: meses passados começam
  // colapsados, mês atual expandido, último mês da lista sempre aberto.
  // Toggles do user persistem entre filtros — só inicializa keys NOVAS.
  const [collapsed, setCollapsed] = useState({});

  useEffect(() => {
    setCollapsed((prev) => {
      const next = { ...prev };
      let changed = false;
      const mostRecentKey = groups
        .map((g) => g.key)
        .filter((k) => k !== "no-date")
        .sort()
        .at(-1);
      for (const g of groups) {
        if (g.key === "no-date") continue;
        if (!(g.key in next)) {
          next[g.key] = g.key < currentYM && g.key !== mostRecentKey;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [groups, currentYM]);

  // Auto-expand quando filtro ativo. Sinature vazia preserva toggles do user.
  const isFiltering = !!filterSignature;
  useEffect(() => {
    if (isFiltering) setCollapsed({});
  }, [filterSignature, isFiltering]);

  const toggle = useCallback(
    (key) => setCollapsed((s) => ({ ...s, [key]: !s[key] })),
    []
  );

  if (!groups.length) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <p className="text-sm text-fg-muted">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {groups.map((g, gi) => {
        const canCollapse = g.key !== "no-date";
        const isCollapsed = canCollapse && !!collapsed[g.key];
        return (
          <section key={g.key}>
            <button
              type="button"
              onClick={() => canCollapse && toggle(g.key)}
              disabled={!canCollapse}
              aria-expanded={!isCollapsed}
              className={cn(
                "w-full flex items-center justify-between mb-3 group rounded",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature/40",
                canCollapse && "cursor-pointer"
              )}
            >
              <div className="flex items-center gap-2">
                {canCollapse && (
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                    className={cn(
                      "text-fg-subtle transition-transform duration-150 group-hover:text-fg",
                      isCollapsed ? "-rotate-90" : "rotate-0"
                    )}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="3 4.5 6 7.5 9 4.5" />
                  </svg>
                )}
                <h2 className="text-[11px] uppercase tracking-widest font-bold text-fg-muted group-hover:text-fg transition-colors">
                  {g.label}
                </h2>
              </div>
              <span className="text-[11px] text-fg-subtle">
                {g.items.length} campanha{g.items.length === 1 ? "" : "s"}
              </span>
            </button>
            {/* Items wrapper:
                - Quando canCollapse=true (meses normais), usamos o padrão
                  action-expand (grid-template-rows 0fr↔1fr + opacity) pra
                  animar smooth abrir/fechar. Trade-off: items ficam sempre
                  montados (custo de render). Aceitável até ~300 cards;
                  acima disso, considerar lazy mount por mês.
                - Quando !canCollapse (grupo "no-date"), conditional render
                  normal — não tem toggle, não precisa de animação.
                - `inert` quando collapsed evita foco em items invisíveis (a11y). */}
            {canCollapse ? (
              <div className={cn("action-expand", !isCollapsed && "is-open")}>
                <div className="action-expand-content" inert={isCollapsed || undefined}>
                  <div className="space-y-2">
                    {g.items.map((item, i) => renderItem(item, gi * 1000 + i))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {g.items.map((item, i) => renderItem(item, gi * 1000 + i))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
