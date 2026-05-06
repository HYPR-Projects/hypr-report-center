// src/v2/hooks/useMediaQuery.js
//
// Hook genérico pra observar uma media query CSS. Útil pra trocar
// COMPORTAMENTO (não só estilo) entre desktop e mobile — ex: Popover
// desktop / Drawer mobile, lista de presets compacta vs expandida,
// número de pontos numa sparkline, etc.
//
// Pra apenas estilizar, prefira utilities Tailwind (`md:`, `lg:`) — são
// estáticas, sem custo de runtime e funcionam sem hidratação.
//
// SSR-safe: durante o primeiro render no servidor (sem window), retorna
// `false`. O cliente reidratará com o valor real no useEffect, evitando
// hydration mismatch silencioso (já é o React 19 que avisa em dev).
//
// API:
//   const isMobile = useMediaQuery("(max-width: 767px)");
//
// Atalhos prontos no useIsMobile.js (consumidor padrão).

import { useEffect, useState } from "react";

export function useMediaQuery(query) {
  const getMatch = () => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  };

  const [matches, setMatches] = useState(getMatch);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    // Não chamamos setMatches(mql.matches) sincronamente aqui — o
    // useState(getMatch) inicializer já avalia no client com o valor
    // correto, e qualquer mudança subsequente vem via 'change' listener
    // abaixo. Setar sincronamente dispararia render cascata sem ganho
    // (e o lint react-hooks/set-state-in-effect rejeita por isso).
    const onChange = (e) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
