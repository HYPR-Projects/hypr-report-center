// src/v2/dashboards/RmndV2.jsx
//
// Tab "RMND" V2 — wrapper que reusa o UploadTab + RmndDashboard Legacy
// preservados em src/dashboards/. Adiciona apenas o frame visual V2:
// header de seção com título + descrição, espaçamento padrão das tabs
// V2 e o TabChat embedado embaixo (mesmo comportamento do Legacy).
//
// Por que wrapper e não reescrita
//   A diretiva da Fase 3 é "Legacy intocado" — qualquer modificação no
//   UploadTab/RmndDashboard arrisca regredir comportamento que clientes
//   reais já dependem (upload Excel, parsing de header, persistência
//   localStorage + backend). O dashboard interno em si é display-only;
//   o que precisa ser modernizado visualmente está nos KPIs e charts
//   internos dele, e isso fica como tech debt pra Fase 4.
//
// O frame V2 (header + chat) já é suficiente pra que a tab não pareça
// "de outro produto" quando o cliente alterna entre Visão Geral V2 e
// RMND. Os internals do RmndDashboard tem paleta dark-friendly que
// ainda funciona razoável em cima do canvas V2.

import UploadTab from "../../dashboards/UploadTab";
import TabChat from "../../components/TabChat";

export default function RmndV2({ token, data, isAdmin, adminJwt }) {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-bold text-fg">RMND · Amazon Ads</h2>
        <p className="text-sm text-fg-muted">
          Dados de retail media network display importados do relatório Amazon Ads.
          {isAdmin
            ? " Faça upload do Excel para atualizar."
            : ""}
        </p>
      </header>

      <UploadTab
        type="RMND"
        token={token}
        serverData={data?.rmnd}
        readOnly={!isAdmin}
        adminJwt={adminJwt}
        isDark={true}
      />

      <TabChat
        token={token}
        tabName="RMND"
        author={isAdmin ? "HYPR" : "Cliente"}
        adminJwt={adminJwt}
        theme="dark"
      />
    </div>
  );
}
