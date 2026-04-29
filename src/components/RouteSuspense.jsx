// src/components/RouteSuspense.jsx
//
// Wrapper de <Suspense> usado pelas rotas lazy-loaded em App.jsx.
//
// Por que existe um fallback dedicado (em vez de inline)
//   1. As rotas lazy carregam módulos que importam estilos diferentes
//      — Login/CampaignMenu/ClientDashboard usam estilos inline +
//      GlobalStyle (Legacy), enquanto ClientDashboardV2 importa v2.css
//      (Tailwind). Esse fallback NÃO pode depender de Tailwind, porque
//      durante o load inicial do V2, o v2.css ainda não foi parseado.
//   2. Centralizar evita inconsistência visual entre fallbacks de
//      rotas diferentes.
//
// Estilo: spinner HYPR blue centralizado em fundo escuro neutro
// (#1C262F = canvas dark). Em light theme o usuário só chega aqui
// durante a transição entre rotas, então fundo escuro neutro é
// aceitável (~200ms). Não vale a pena instanciar lógica de tema
// só pra um fallback de loading.

import Spinner from "./Spinner";

export default function RouteSuspense() {
  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#1C262F",
      }}
    >
      <Spinner size={36} />
    </div>
  );
}
