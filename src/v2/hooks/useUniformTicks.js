// src/v2/hooks/useUniformTicks.js
//
// Ticks do eixo X com passo uniforme (ver lib/dateTicks), medindo a largura
// do wrapper do gráfico. `reservedPx` é o que não é área de plot: largura do
// YAxis + margens + padding do XAxis.

import { uniformTicks } from "../lib/dateTicks";
import { useElementWidth } from "./useElementWidth";

export function useUniformTicks(values, { reservedPx = 0, slotPx, steps } = {}) {
  const [ref, width] = useElementWidth();
  const ticks = uniformTicks(values, width > 0 ? width - reservedPx : 0, { slotPx, steps });
  return [ref, ticks];
}
