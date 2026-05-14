// Distribui o custo total de cada grupo (media_type, tactic_type) entre as
// linhas do detail proporcionalmente à entrega.
//
// Por que existe
// --------------
// O detail vindo de unified_daily_performance_metrics traz custos brutos do
// DSP que NÃO batem com o custo efetivo negociado da HYPR. O custo "real" pra
// exibição vive nos `totals` (agregado por media×tactic). Esta função
// redistribui esse total proporcionalmente entre as linhas do detail, usando
// como peso:
//   - viewable_impressions   pra DISPLAY
//   - video_view_100         pra VIDEO
//
// Largest-remainder method
// ------------------------
// A versão ingênua faz `round(proportion × total, 2)` em cada linha. Em ~100
// linhas isso acumula até R$1 de deriva contra o totals, e quebra a soma do
// Google Sheets vs o KPI do dashboard.
//
// Aqui usamos largest-remainder (Hamilton/Hare): arredonda pra baixo cada
// share em centavos, soma os centavos sobrando vs o total alvo, e distribui
// esses centavos pelas linhas com maiores restos descartados. Garante:
//
//   Σ detail.effective_total_cost === round(tot.effective_total_cost, 2)
//
// ao centavo exato, mantendo a proporção o mais próxima possível do raw.
export function distributeLargestRemainder(weights, targetTotal) {
  const n = weights.length;
  if (n === 0) return [];
  const targetCents = Math.round(targetTotal * 100);
  if (targetCents === 0) {
    return new Array(n).fill(0);
  }
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) {
    return new Array(n).fill(0);
  }
  const rawCents = weights.map(w => (w / totalWeight) * targetCents);
  const floorCents = rawCents.map(c => Math.floor(c));
  let remainder = targetCents - floorCents.reduce((s, c) => s + c, 0);
  // Índices ordenados por maior resto descartado; estável (índice original
  // como tiebreaker pra reproducibilidade).
  const order = rawCents
    .map((c, i) => ({ i, frac: c - floorCents[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const result = floorCents.slice();
  for (let k = 0; k < order.length && remainder > 0; k++) {
    result[order[k].i] += 1;
    remainder -= 1;
  }
  // Edge case: targetCents negativo (não deveria, mas seguro)
  for (let k = 0; k < order.length && remainder < 0; k++) {
    result[order[k].i] -= 1;
    remainder += 1;
  }
  return result.map(c => c / 100);
}

export const enrichDetailCosts = (detailRows, totalsRows) => {
  const totalsMap = {};
  totalsRows.forEach(t => {
    const key = `${t.media_type}|${t.tactic_type}`;
    totalsMap[key] = t;
  });
  // Indexa rows de cada grupo (preservando ordem original)
  const groupIndices = {};
  detailRows.forEach((r, idx) => {
    const key = `${r.media_type}|${r.tactic_type}`;
    if (!groupIndices[key]) groupIndices[key] = [];
    groupIndices[key].push(idx);
  });
  // Pré-calcula o custo redistribuído por linha pra cada grupo
  const costByIdx = new Array(detailRows.length).fill(0);
  const costOverByIdx = new Array(detailRows.length).fill(0);
  Object.entries(groupIndices).forEach(([key, idxs]) => {
    const tot = totalsMap[key];
    if (!tot) return;
    const isVideo = key.startsWith("VIDEO|");
    const weights = idxs.map(i => {
      const r = detailRows[i];
      return isVideo ? (r.video_view_100 || 0) : (r.viewable_impressions || 0);
    });
    const sharesCost = distributeLargestRemainder(weights, tot.effective_total_cost || 0);
    const sharesOver = distributeLargestRemainder(weights, tot.effective_cost_with_over || 0);
    idxs.forEach((origIdx, k) => {
      costByIdx[origIdx]     = sharesCost[k];
      costOverByIdx[origIdx] = sharesOver[k];
    });
  });
  return detailRows.map((r, idx) => {
    const key = `${r.media_type}|${r.tactic_type}`;
    const tot = totalsMap[key];
    if (!tot) return { ...r, effective_total_cost: 0, effective_cost_with_over: 0 };
    return {
      ...r,
      effective_total_cost:      costByIdx[idx],
      effective_cost_with_over:  costOverByIdx[idx],
      deal_cpm_amount:           tot.deal_cpm_amount || 0,
      deal_cpcv_amount:          tot.deal_cpcv_amount || 0,
      effective_cpm_amount:      tot.effective_cpm_amount || 0,
      effective_cpcv_amount:     tot.effective_cpcv_amount || 0,
    };
  });
};
