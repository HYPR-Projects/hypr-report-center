// src/v2/components/TweenedValueV2.jsx
//
// Valor de KPI que conta do número antigo pro novo quando muda (período,
// filtro, troca de view), nascendo na cor signature e voltando à normal.
// Na montagem mostra o valor direto: a primeira leitura não espera
// animação nenhuma. Texto não numérico ou ReactNode passa sem mexer.
//
//   <TweenedValueV2 value={fmt(kpis.impr)} />

import { useTweenedText } from "../lib/motion";

export function TweenedValueV2({ value }) {
  const { text, changed } = useTweenedText(value);
  if (typeof value !== "string") return value;
  // key reinicia o flash a cada troca; o texto da contagem atualiza dentro
  // do mesmo span.
  return (
    <span key={changed} className={changed ? "value-flash" : undefined}>
      {text}
    </span>
  );
}
