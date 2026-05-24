/**
 * useFrenteBreakdown — devolve o pacing por frente (O2O/OOH) pra Display e
 * Video do card.
 *
 * Retorno:
 *   { displaySubBars, videoSubBars }
 * onde cada subBars é null (frente única) ou [{ label, pacing }, ...].
 *
 * Fontes em ordem de prioridade:
 *   1. campaign.display_pacing_o2o/ooh, video_pacing_o2o/ooh — vêm direto do
 *      backend `?list=true` (PR-pacing-tactic). Disponíveis no primeiro paint,
 *      sem flicker. Esta é a fonte default desde que o backend foi atualizado.
 *   2. detail prefetched (cache populado pelo hover/IntersectionObserver) —
 *      fallback pra deployments antigos do backend que ainda não emitem os
 *      campos por tactic. Será removido quando o backend estabilizar.
 *
 * Render quando ambas as tactics têm CONTRATO (não exige delivery). Frente
 * vendida mas ainda não iniciada aparece como 0% — sinal visual pro CS.
 */

import { useSyncExternalStore } from "react";
import { getPrefetchedDetail, subscribeDetail } from "../../../lib/prefetchReport";
import { buildFrenteSubBars } from "../../../shared/aggregations";

// Re-exporta pra preservar imports legados do CampaignDrawer.
export { buildFrenteSubBars };

/**
 * Constrói as subBars a partir dos campos diretos do payload de lista.
 * Retorna null quando só uma das frentes tem pacing emitido (frente única).
 */
function subBarsFromCampaign(o2oPacing, oohPacing) {
  const hasO2O = o2oPacing != null;
  const hasOOH = oohPacing != null;
  if (!hasO2O || !hasOOH) return null;
  return [
    { label: "O2O", pacing: o2oPacing },
    { label: "OOH", pacing: oohPacing },
  ];
}

export function useFrenteBreakdown(token, campaign) {
  // Sempre subscreve — hooks têm que rodar incondicionalmente. Quando o
  // backend já manda os pacings por tactic na lista, o detail nem chega
  // a ser usado (otimização do payload prefetched continua válida pra abrir
  // o report, esse hook só não depende mais dele).
  const detail = useSyncExternalStore(
    subscribeDetail,
    () => getPrefetchedDetail(token),
    () => null,
  );

  // Fonte primária: campos do payload `?list=true`. Sem flicker.
  if (campaign && (
    campaign.display_pacing_o2o != null || campaign.display_pacing_ooh != null ||
    campaign.video_pacing_o2o   != null || campaign.video_pacing_ooh   != null
  )) {
    return {
      displaySubBars: subBarsFromCampaign(campaign.display_pacing_o2o, campaign.display_pacing_ooh),
      videoSubBars:   subBarsFromCampaign(campaign.video_pacing_o2o,   campaign.video_pacing_ooh),
    };
  }

  // Fallback: detail prefetched (backend antigo).
  if (!detail?.campaign) {
    return { displaySubBars: null, videoSubBars: null };
  }
  return {
    displaySubBars: buildFrenteSubBars(detail, "DISPLAY"),
    videoSubBars:   buildFrenteSubBars(detail, "VIDEO"),
  };
}
