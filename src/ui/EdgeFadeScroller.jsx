// src/ui/EdgeFadeScroller.jsx
//
// Container de scroll horizontal pra tabela/grade larga dentro de card. No
// celular a tabela rola pro lado; as bordas esmaecem enquanto houver coluna
// escondida daquele lado (ver useEdgeFade). Sem overflow, é uma div comum.

import { cn } from "./cn";
import { useEdgeFade } from "./useEdgeFade";

export function EdgeFadeScroller({ className, children, ...rest }) {
  const ref = useEdgeFade();
  return (
    <div ref={ref} className={cn("overflow-x-auto edge-fade-x", className)} {...rest}>
      {children}
    </div>
  );
}
