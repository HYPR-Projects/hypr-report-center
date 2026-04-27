import { useState, useEffect } from "react";

/**
 * Carrega Chart.js via CDN sob demanda. Reaproveita window.Chart se já carregado.
 * Retorna a referência da lib quando pronta, ou null durante o load.
 */
export const useChart = () => {
  const [lib, setLib] = useState(() => (typeof window !== "undefined" && window.Chart) || null);
  useEffect(()=>{
    if (lib) return;
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
    s.onload = () => setLib(() => window.Chart);
    document.head.appendChild(s);
  },[lib]);
  return lib;
};
