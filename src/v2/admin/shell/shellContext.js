// src/v2/admin/shell/shellContext.js
//
// Contexto do AdminShell, num módulo separado.
//
// Por que separado: o `react-refresh/only-export-components` do ESLint
// exige que um arquivo de componente exporte SÓ componentes — hot reload
// não consegue preservar estado de um módulo que mistura os dois. Como
// `AdminShell.jsx` precisa exportar o componente, o contexto e os hooks
// moram aqui.
//
// O que o conteúdo consegue pelo shell:
//
//   scrollToTop          — o scroll agora é do PAINEL, não da janela, então
//                          `window.scrollTo` não move mais nada no admin.
//   registerSearchFocus  — a barra de filtros registra como focar a própria
//                          busca; o rail e a tecla "/" chamam por aqui, sem
//                          atravessar refs por três níveis de prop.
//   isDense              — densidade atual, pra quem precisa decidir em JS
//                          (número de pontos numa sparkline, por exemplo).
//                          Para estilo, prefira a variant `dense:`.

import { createContext, useContext } from "react";

export const ShellContext = createContext(null);

// Fallback fora do shell (teste isolado de um card, ou um componente
// reaproveitado no report do cliente): no-ops. Degradar pra "não rola" é
// melhor que quebrar a árvore.
const FALLBACK = {
  scrollToTop: () => {},
  registerSearchFocus: () => () => {},
  isDense: false,
};

export function useAdminShell() {
  return useContext(ShellContext) || FALLBACK;
}

/** Atalho para quem só quer rolar o painel pro topo. */
export function useAdminShellScroll() {
  return useAdminShell().scrollToTop;
}
