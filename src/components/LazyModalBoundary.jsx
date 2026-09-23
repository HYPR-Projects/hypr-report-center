// src/components/LazyModalBoundary.jsx
//
// Boundary em volta de modal carregado sob demanda (lazyWithPreload).
//
// Esses modais eram import estático: não tinham como "falhar de baixar". Com
// o lazy, um download que falha (rede oscilando, deploy novo) viraria um erro
// de render subindo até o ErrorBoundary da página — o report inteiro trocado
// por "Algo quebrou" por causa de um modal. Aqui o erro para no modal:
//
//  - Falha de chunk → tenta o reload único de deploy (chunkReload), que é o
//    que resolve: o navegador guarda a falha do módulo e não baixa de novo
//    sem recarregar. Se as guardas não deixarem (já recarregou há < 60s,
//    offline), chama `onFail` (o pai fecha/desmonta o modal) e renderiza
//    nada — o modal não abre, mas o resto da página segue funcionando.
//  - Qualquer outro erro → relançado no render, sobe pro boundary de cima
//    exatamente como antes (um bug de verdade não fica escondido aqui).

import { Component } from "react";
import { isChunkLoadError, reloadForChunkError } from "../shared/chunkReload";

export default class LazyModalBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    if (!isChunkLoadError(error)) return;
    console.warn("[LazyModalBoundary] modal não carregou:", error?.message || error);
    if (!reloadForChunkError()) this.props.onFail?.();
  }

  render() {
    const { error } = this.state;
    if (error) {
      if (!isChunkLoadError(error)) throw error;
      return null;
    }
    return this.props.children;
  }
}
