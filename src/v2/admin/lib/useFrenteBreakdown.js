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
function subBarsFromCampaign(pacings) {
  const fronts = [
    { label: "O2O", pacing: pacings.o2o },
    { label: "OOH", pacing: pacings.ooh },
    { label: "GF",  pacing: pacings.groundflow },
  ].filter((f) => f.pacing != null);
  // Mostra a quebra só com 2+ frentes emitidas (frente única não compara).
  if (fronts.length < 2) return null;
  return fronts;
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
    campaign.display_pacing_o2o != null || campaign.display_pacing_ooh != null || campaign.display_pacing_groundflow != null ||
    campaign.video_pacing_o2o   != null || campaign.video_pacing_ooh   != null || campaign.video_pacing_groundflow   != null
  )) {
    return {
      displaySubBars: subBarsFromCampaign({ o2o: campaign.display_pacing_o2o, ooh: campaign.display_pacing_ooh, groundflow: campaign.display_pacing_groundflow }),
      videoSubBars:   subBarsFromCampaign({ o2o: campaign.video_pacing_o2o,   ooh: campaign.video_pacing_ooh,   groundflow: campaign.video_pacing_groundflow }),
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
