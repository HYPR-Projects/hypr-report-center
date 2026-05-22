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
import { buildFrenteSubBars } from "../../../shared/aggregations";

// Re-exporta pra preservar imports legados do CampaignDrawer.
export { buildFrenteSubBars };

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
