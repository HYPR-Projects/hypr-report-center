// src/shared/videoRetention.js
//
// Curva de retenção do vídeo a partir do detail: views iniciadas e os
// quartis (video_view_25/50/75/100) somados no recorte.

export function buildRetention(detail) {
  const sum = (k) => (detail || []).reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const starts = sum("video_starts");
  const points = [
    { key: "start", label: "Início", value: starts },
    { key: "q1", label: "25%", value: sum("video_view_25") },
    { key: "mid", label: "50%", value: sum("video_view_50") },
    { key: "q3", label: "75%", value: sum("video_view_75") },
    { key: "end", label: "100%", value: sum("video_view_100") },
  ];
  // Sem quartis intermediários no payload (fonte antiga): não inventa curva.
  const hasQuartiles = points.slice(1, 4).some((p) => p.value > 0);
  return { starts, points, hasQuartiles };
}
