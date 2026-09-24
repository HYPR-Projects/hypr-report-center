// src/v2/components/ma/maMapCamera.js
//
// Regras de câmera do mapa de endereços (MaAddressMapV2), fora do .jsx para
// ter teste. Duas garantias:
//   • o mapa só é recriado ou reenquadrado quando o CONJUNTO de pontos muda
//     de verdade (assinatura por conteúdo, não pela referência do array);
//   • focar um ponto nunca afasta: o zoom só sobe ou fica.

/** Zoom mínimo ao focar um endereço (nível de bairro). */
export const FOCUS_ZOOM = 13;

/** Até esta distância do centro, o foco desliza; acima, corta direto. */
export const NEAR_KM = 50;

/** Identidade estável do conjunto de pontos: muda só se chave ou coordenada mudar. */
export function pointsSignature(points) {
  return (points || []).map((p) => `${p.key}:${p.lat},${p.lng}`).join("|");
}

/** Distância em km entre dois { lat, lng } (haversine). */
export function haversineKm(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Como levar a câmera até um ponto focado.
 *   ease → desliza (ponto visível ou perto): centro e zoom interpolam juntos,
 *          então o movimento é só de aproximação;
 *   jump → corte direto (ponto longe ou movimento reduzido). Um pan animado
 *          de centenas de km em zoom de bairro carregaria tiles borrados, e
 *          o flyTo faria o arco de zoom-out que queremos evitar.
 * Em qualquer caso o zoom alvo nunca é menor que o atual.
 */
export function planFocus({ zoom, inView = false, distanceKm = Infinity, reducedMotion = false }) {
  const current = Number.isFinite(zoom) ? zoom : 0;
  const target = Math.max(current, FOCUS_ZOOM);
  if (reducedMotion) return { mode: "jump", zoom: target };
  if (inView || distanceKm < NEAR_KM) return { mode: "ease", zoom: target };
  return { mode: "jump", zoom: target };
}
