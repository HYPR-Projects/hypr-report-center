// src/v2/hooks/useAudienceOverrides.js
//
// Estado + ações do override de NOME de audiência (Report Center).
//
// Por que existe
// ──────────────
// A quebra "Por Audiência" do report usa o penúltimo token do line_name como
// nome (extractAudience) — cru, exatamente como a plataforma (DSP) entregou.
// Às vezes vem estranho ou mal separado ("SPORTS-STORE", duas variações do
// mesmo público). O admin pode corrigir o nome aqui; a correção:
//   • é APLICADA no Report Center (relabel/merge da quebra, via overrideMap);
//   • vira SEED pra IA do Client Hub (backend), que continua decidindo lá.
//
// Escopo POR ANUNCIANTE (client_name): a correção de um rótulo cru vale em
// todos os reports daquele cliente. Persistência por rótulo CRU — por isso
// renomear um grupo já mesclado aplica o nome a TODOS os `_rawLabels` dele.
//
// `initialMap` vem no payload do report (data.audience_overrides), keyed por
// `normAudienceKey(rótulo_cru)`. Mutamos local (otimista) pra a tabela
// re-renderizar na hora, sem refetch — o mapa é pequeno e a fonte de verdade
// já foi gravada no BQ. Outros reports do anunciante pegam no próximo TTL.

import { useState, useCallback } from "react";
import { normAudienceKey } from "../../shared/aggregations";
import { saveAudienceOverride, deleteAudienceOverride } from "../../lib/api";

export function useAudienceOverrides({ initialMap, clientName, shortToken, isAdmin }) {
  const [overrideMap, setOverrideMap] = useState(() => ({ ...(initialMap || {}) }));
  // chave do grupo em edição/salvamento (pra spinner/disable na linha certa).
  const [busyAudience, setBusyAudience] = useState(null);
  const [error, setError] = useState(null);

  // Renomeia (e funde, quando vira nome de outro grupo) um conjunto de rótulos
  // crus pro `newName`. rawLabels = row._rawLabels da tabela agrupada.
  const renameAudience = useCallback(async (rawLabels, newName, busyKey = null) => {
    if (!isAdmin || !clientName) return;
    const labels = (Array.isArray(rawLabels) ? rawLabels : [rawLabels]).filter(Boolean);
    const name = String(newName || "").trim();
    if (!labels.length || !name) return;
    setBusyAudience(busyKey ?? name);
    setError(null);
    try {
      await saveAudienceOverride({
        client_name: clientName,
        raw_audience: labels,
        display_name: name,
        short_token: shortToken,
      });
      setOverrideMap((prev) => {
        const next = { ...prev };
        for (const l of labels) next[normAudienceKey(l)] = name;
        return next;
      });
    } catch (e) {
      setError(e?.message || "Erro ao salvar nome da audiência");
      throw e;
    } finally {
      setBusyAudience(null);
    }
  }, [isAdmin, clientName, shortToken]);

  // Reverte (remove override) — volta ao rótulo cru da plataforma.
  const resetAudience = useCallback(async (rawLabels, busyKey = null) => {
    if (!isAdmin || !clientName) return;
    const labels = (Array.isArray(rawLabels) ? rawLabels : [rawLabels]).filter(Boolean);
    if (!labels.length) return;
    setBusyAudience(busyKey ?? labels[0]);
    setError(null);
    try {
      await deleteAudienceOverride({
        client_name: clientName,
        raw_audience: labels,
        short_token: shortToken,
      });
      setOverrideMap((prev) => {
        const next = { ...prev };
        for (const l of labels) delete next[normAudienceKey(l)];
        return next;
      });
    } catch (e) {
      setError(e?.message || "Erro ao reverter nome da audiência");
      throw e;
    } finally {
      setBusyAudience(null);
    }
  }, [isAdmin, clientName, shortToken]);

  // Um conjunto de rótulos crus está overridado se QUALQUER um deles tem entrada
  // no mapa (a tabela mostra "reverter" quando o nome não é mais o cru).
  const isOverridden = useCallback(
    (rawLabels) => (Array.isArray(rawLabels) ? rawLabels : [rawLabels])
      .some((l) => l && overrideMap[normAudienceKey(l)] != null),
    [overrideMap],
  );

  return { overrideMap, renameAudience, resetAudience, isOverridden, busyAudience, error };
}
