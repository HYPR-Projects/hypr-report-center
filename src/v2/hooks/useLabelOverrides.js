// src/v2/hooks/useLabelOverrides.js
//
// Estado + ações do override de NOME de um rótulo genérico (Report Center),
// parametrizado por `dimension`:
//   • "format"        → tamanho do criativo (creative_size), tabela "Por Tamanho"
//   • "creative_line" → linha criativa (getCreativeLineKey), tabela homônima
//
// É o gêmeo genérico de `useAudienceOverrides`. Mesma mecânica (relabel/merge,
// escopo anunciante × campanha, estado otimista sem refetch), só que:
//   • a chave crua é o próprio valor (tamanho/linha), não o penúltimo token
//     do line_name;
//   • NÃO vira seed da IA do hub — é puramente Report Center.
//
// `initialMap` vem no payload do report em data.label_overrides[dimension],
// keyed por normLabelKey(rótulo_cru). Mutamos local (otimista); a fonte de
// verdade já foi gravada no BQ e outros reports pegam no próximo TTL.

import { useState, useCallback } from "react";
import { normLabelKey } from "../../shared/aggregations";
import { saveLabelOverride, deleteLabelOverride } from "../../lib/api";

export function useLabelOverrides({ dimension, initialMap, clientName, shortToken, isAdmin }) {
  const [overrideMap, setOverrideMap] = useState(() => ({ ...(initialMap || {}) }));
  const [busyLabel, setBusyLabel] = useState(null);
  const [error, setError] = useState(null);

  // Renomeia (e funde, quando vira nome de outro grupo) um conjunto de rótulos
  // crus pro `newName`. rawLabels = row._rawLabels da tabela agrupada.
  // `scope`: "advertiser" (todo o anunciante) | "campaign" (só este report).
  const renameLabel = useCallback(async (rawLabels, newName, busyKey = null, scope = "advertiser") => {
    if (!isAdmin || !clientName) return;
    const labels = (Array.isArray(rawLabels) ? rawLabels : [rawLabels]).filter(Boolean);
    const name = String(newName || "").trim();
    if (!labels.length || !name) return;
    setBusyLabel(busyKey ?? name);
    setError(null);
    try {
      await saveLabelOverride({
        client_name: clientName,
        dimension,
        raw_value: labels,
        display_name: name,
        short_token: shortToken,
        scope,
      });
      setOverrideMap((prev) => {
        const next = { ...prev };
        for (const l of labels) next[normLabelKey(l)] = name;
        return next;
      });
    } catch (e) {
      setError(e?.message || "Erro ao salvar o nome");
      throw e;
    } finally {
      setBusyLabel(null);
    }
  }, [isAdmin, clientName, shortToken, dimension]);

  // Reverte — volta ao rótulo cru da plataforma. `scope` default "all" limpa
  // o efeito neste report (anunciante + esta campanha).
  const resetLabel = useCallback(async (rawLabels, busyKey = null, scope = "all") => {
    if (!isAdmin || !clientName) return;
    const labels = (Array.isArray(rawLabels) ? rawLabels : [rawLabels]).filter(Boolean);
    if (!labels.length) return;
    setBusyLabel(busyKey ?? labels[0]);
    setError(null);
    try {
      await deleteLabelOverride({
        client_name: clientName,
        dimension,
        raw_value: labels,
        short_token: shortToken,
        scope,
      });
      setOverrideMap((prev) => {
        const next = { ...prev };
        for (const l of labels) delete next[normLabelKey(l)];
        return next;
      });
    } catch (e) {
      setError(e?.message || "Erro ao reverter o nome");
      throw e;
    } finally {
      setBusyLabel(null);
    }
  }, [isAdmin, clientName, shortToken, dimension]);

  // Um conjunto de rótulos crus está overridado se QUALQUER um tem entrada no mapa.
  const isOverridden = useCallback(
    (rawLabels) => (Array.isArray(rawLabels) ? rawLabels : [rawLabels])
      .some((l) => l && overrideMap[normLabelKey(l)] != null),
    [overrideMap],
  );

  return { overrideMap, renameLabel, resetLabel, isOverridden, busyLabel, error };
}
