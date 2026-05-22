/**
 * useFrenteBreakdown — lê o detalhe prefetched da campanha (cache em memória
 * populado pelo hover no card) e devolve o pacing por frente (O2O/OOH) pra
 * Display e Video.
 *
 * Retorno:
 *   { displaySubBars, videoSubBars }
 * onde cada subBars é null (quando só há uma frente, ou detalhe ainda não
 * chegou) ou [{ label: "O2O", pacing }, { label: "OOH", pacing }].
 *
 * Por que aqui em vez de buscar do `?list=true`: o backend devolve apenas
 * pacing agregado na listagem. O detalhe full (com tactic_type por row) já
 * é prefetchado no hover do card pra abrir o report rápido — reaproveitamos
 * esse cache pra evitar tráfego extra.
 *
 * Quando o detalhe ainda não foi carregado, devolve null pros dois subBars
 * — o caller mantém o comportamento legado (cor pela média agregada). Assim
 * que o prefetch resolve, o hook re-renderiza via subscribeDetail.
 */

import { useSyncExternalStore } from "react";
import { getPrefetchedDetail, subscribeDetail } from "../../../lib/prefetchReport";
import { computeMediaPacing } from "../../../shared/aggregations";

/**
 * Calcula pacing por frente (O2O/OOH) pra uma media (DISPLAY ou VIDEO).
 * Devolve null quando há frente única — caller mantém comportamento padrão.
 */
export function buildFrenteSubBars(rows, camp, mediaType) {
  if (!rows || rows.length === 0) return null;
  const o2oRows = rows.filter((r) => r.tactic_type === "O2O");
  const oohRows = rows.filter((r) => r.tactic_type === "OOH");
  // Frente única (campanha só O2O ou só OOH) — sem breakdown.
  if (o2oRows.length === 0 || oohRows.length === 0) return null;
  return [
    { label: "O2O", pacing: computeMediaPacing(o2oRows, camp, mediaType, "O2O") },
    { label: "OOH", pacing: computeMediaPacing(oohRows, camp, mediaType, "OOH") },
  ];
}

export function useFrenteBreakdown(token) {
  const detail = useSyncExternalStore(
    subscribeDetail,
    () => getPrefetchedDetail(token),
    () => null,
  );

  if (!detail?.campaign) {
    return { displaySubBars: null, videoSubBars: null };
  }
  return {
    displaySubBars: buildFrenteSubBars(detail.display, detail.campaign, "DISPLAY"),
    videoSubBars:   buildFrenteSubBars(detail.video,   detail.campaign, "VIDEO"),
  };
}
