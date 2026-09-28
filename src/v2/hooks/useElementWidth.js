// src/v2/hooks/useElementWidth.js
//
// Largura atual de um elemento (ResizeObserver). Usado pelos gráficos
// diários pra escolher quantos labels de data cabem no eixo X.

import { useEffect, useRef, useState } from "react";

export function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
