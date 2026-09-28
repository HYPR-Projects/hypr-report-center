// src/v2/hooks/useElementWidth.js
//
// Largura atual de um elemento (ResizeObserver). Usado pelos gráficos
// temporais pra escolher quantos labels de data cabem no eixo X.
//
// Devolve um callback ref, não um useRef: os gráficos retornam null enquanto
// não há dado, e o elemento só aparece num render posterior. Com useRef +
// efeito de montagem, a medição nunca rodaria nesse caso.

import { useEffect, useState } from "react";

export function useElementWidth() {
  const [node, setNode] = useState(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return;
    // O observer já entrega a primeira medida logo após o observe().
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  return [setNode, width];
}
