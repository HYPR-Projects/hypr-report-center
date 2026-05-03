// src/components/GlobalProgressBar.jsx
//
// Barra de progresso fininha (2px) no topo da viewport. Aparece sempre
// que há ≥1 task ativa registrada via `useLoadingTask`. Usa o keyframe
// `topbar-progress-slide` já definido em v2.css (stripe signature
// deslizando — indeterminate animation).
//
// Tem dois delays propositais:
//
//   1. Mostra só depois de 200ms — fetches resolvidos pelo SWR/cache
//      terminam antes e o usuário não vê flash.
//   2. Esconde com fade de 150ms — evita "snap" no fim, transição mais
//      suave entre states.
//
// Reduced-motion
// ──────────────
// Browser com `prefers-reduced-motion` para a animação CSS via
// `motion-reduce:` no Tailwind, então o stripe fica parado. A barra
// ainda aparece pra sinalizar atividade, mas sem o movimento.

import { useEffect, useState } from "react";
import { useActiveTaskCount } from "../shared/loading";

const SHOW_DELAY_MS = 200;
const HIDE_FADE_MS = 150;

export default function GlobalProgressBar() {
  const active = useActiveTaskCount() > 0;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (active) {
      // Atrasa pra evitar flash em fetch instantâneo (SWR cache hit).
      const t = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
      return () => clearTimeout(t);
    }
    setVisible(false);
  }, [active]);

  return (
    <div
      aria-hidden={!visible}
      className={`fixed top-0 left-0 right-0 z-[100] h-[2px] overflow-hidden pointer-events-none transition-opacity duration-[${HIDE_FADE_MS}ms] ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="topbar-progress-stripe absolute inset-y-0 w-1/3 bg-signature motion-reduce:animate-none" />
    </div>
  );
}
