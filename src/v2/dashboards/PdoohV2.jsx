// src/v2/dashboards/PdoohV2.jsx
//
// Tab "PDOOH" V2: frame da aba (título + descrição) em volta do UploadTab,
// que cuida do upload do Excel (admin) e do PdoohDashboard (KPIs, entrega
// por dia, mapa de telas e tabela de pontos).
//
// O período vem da barra do report (`range`), como nas outras abas. A
// conversa que ficava no rodapé foi para o painel de comentários do topo
// (thread "PDOOH", mesmas mensagens).

import UploadTab from "../../dashboards/UploadTab";
import { useTheme } from "../hooks/useTheme";

export default function PdoohV2({ token, data, isAdmin, adminJwt, onUploaded, range }) {
  const [theme] = useTheme();
  const isDark = theme === "dark";

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-bold text-fg">PDOOH · Programmatic OOH</h2>
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
        onUploaded={onUploaded}
        range={range}
      />
    </div>
  );
}
