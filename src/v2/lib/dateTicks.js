// src/v2/lib/dateTicks.js
//
// Ticks do eixo X das séries diárias. O automático do Recharts
// (interval="preserveStartEnd" + minTickGap) decide label a label se cabe:
// como "11/09" é mais estreito que "08/09" na Urbanist, ele mostra todo dia
// num trecho, pula dia em outro e ainda força o último ("22/09 · 24/09 ·
// 27/09"). Aqui o passo é um só pro eixo inteiro, escolhido pela largura
// disponível, e ancorado no último dia (o mais recente é o que mais se lê).

// Passos "redondos": 7 e 14 caem sempre no mesmo dia da semana.
const STEPS = [1, 2, 3, 7, 14, 28, 56];

// Largura reservada por label "dd/mm" em 10px, já com respiro entre eles.
export const DATE_LABEL_SLOT_PX = 52;

export function pickDateStep(count, plotWidth, slotPx = DATE_LABEL_SLOT_PX) {
  if (!(count > 1)) return 1;
  // Sem largura medida ainda (primeiro render): assume um card de desktop.
  const width = plotWidth > 0 ? plotWidth : 720;
  const perDay = width / count;
  return STEPS.find((s) => s * perDay >= slotPx) ?? Math.ceil(slotPx / perDay);
}

export function dailyTicks(dates, plotWidth, slotPx = DATE_LABEL_SLOT_PX) {
  if (!Array.isArray(dates) || dates.length === 0) return [];
  const step = pickDateStep(dates.length, plotWidth, slotPx);
  const out = [];
  for (let i = dates.length - 1; i >= 0; i -= step) out.push(dates[i]);
  return out.reverse();
}
