export const enrichDetailCosts = (detailRows, totalsRows) => {
  const totalsMap = {};
  totalsRows.forEach(t => {
    const key = `${t.media_type}|${t.tactic_type}`;
    totalsMap[key] = t;
  });
  const groupSums = {};
  detailRows.forEach(r => {
    const key = `${r.media_type}|${r.tactic_type}`;
    if (!groupSums[key]) groupSums[key] = { vi: 0, v100: 0 };
    groupSums[key].vi  += r.viewable_impressions || 0;
    groupSums[key].v100 += r.video_view_100 || 0;
  });
  return detailRows.map(r => {
    const key = `${r.media_type}|${r.tactic_type}`;
    const tot = totalsMap[key];
    const grp = groupSums[key];
    if (!tot || !grp) return { ...r, effective_total_cost: 0, effective_cost_with_over: 0 };
    const isVideo = r.media_type === "VIDEO";
    const delivered = isVideo ? (r.video_view_100 || 0) : (r.viewable_impressions || 0);
    const totalDelivered = isVideo ? grp.v100 : grp.vi;
    const proportion = totalDelivered > 0 ? delivered / totalDelivered : 0;
    return {
      ...r,
      effective_total_cost:      Math.round(proportion * (tot.effective_total_cost || 0) * 100) / 100,
      effective_cost_with_over:  Math.round(proportion * (tot.effective_cost_with_over || 0) * 100) / 100,
      deal_cpm_amount:           tot.deal_cpm_amount || 0,
      deal_cpcv_amount:          tot.deal_cpcv_amount || 0,
      effective_cpm_amount:      tot.effective_cpm_amount || 0,
      effective_cpcv_amount:     tot.effective_cpcv_amount || 0,
    };
  });
};
