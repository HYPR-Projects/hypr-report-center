// src/v2/dashboards/PdoohV2.jsx
//
// Tab "PDOOH" V2 — wrapper que reusa UploadTab + PdoohDashboard Legacy
// preservados em src/dashboards/. PdoohDashboard internamente já usa
// PdoohMap (Leaflet) pra mostrar inventário OOH georreferenciado.
//
// Por que wrapper e não reescrita
//   PdoohDashboard tem 232 linhas + PdoohMap com Leaflet. Reescrever
//   o mapa em V2 quebraria a integração com a lib (initialização,
//   markers customizados, popups) sem ganho visual proporcional —
//   Leaflet renderiza tiles próprios que não respeitam tokens da app.
//   Frame V2 (header + chat) é o que importa pro cliente perceber
//   coerência visual com as outras tabs.

import UploadTab from "../../dashboards/UploadTab";
import TabChat from "../../components/TabChat";
import { useTheme } from "../hooks/useTheme";
import { legacyThemeObj } from "../legacyThemeBridge";

export default function PdoohV2({ token, data, isAdmin, adminJwt }) {
  const [theme] = useTheme();
  const isDark = theme === "dark";
  const legacyTheme = legacyThemeObj(theme);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-bold text-fg">
          PDOOH · Programmatic OOH
        </h2>
        <p className="text-sm text-fg-muted">
          Inventário georreferenciado de Digital Out of Home programático.
          {isAdmin ? " Faça upload do Excel para atualizar." : ""}
        </p>
      </header>

      <UploadTab
        type="PDOOH"
        token={token}
        serverData={data?.pdooh}
        readOnly={!isAdmin}
        adminJwt={adminJwt}
        isDark={isDark}
      />

      <TabChat
        token={token}
        tabName="PDOOH"
        author={isAdmin ? "HYPR" : "Cliente"}
        adminJwt={adminJwt}
        theme={legacyTheme}
      />
    </div>
  );
}
