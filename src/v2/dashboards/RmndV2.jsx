// src/v2/dashboards/RmndV2.jsx
//
// Tab "RMND" V2: frame da aba (título + descrição) em volta do UploadTab,
// que cuida do upload do Excel da Amazon Ads (admin) e do RmndDashboard.
//
// O período vem da barra do report (`range`): o dashboard deixa de ter
// filtro de data próprio e segue o mesmo período das outras abas. A
// conversa que ficava no rodapé foi para o painel de comentários do topo
// (thread "RMND", mesmas mensagens).

import UploadTab from "../../dashboards/UploadTab";
import { useTheme } from "../hooks/useTheme";

export default function RmndV2({ token, data, isAdmin, adminJwt, onUploaded, range }) {
  const [theme] = useTheme();
  const isDark = theme === "dark";

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-bold text-fg">RMND · Amazon Ads</h2>
        <p className="text-sm text-fg-muted">
          Dados de retail media network display importados do relatório Amazon Ads.
          {isAdmin ? " Faça upload do Excel para atualizar." : ""}
        </p>
      </header>

      <UploadTab
        type="RMND"
        token={token}
        serverData={data?.rmnd}
        readOnly={!isAdmin}
        adminJwt={adminJwt}
        isDark={isDark}
        onUploaded={onUploaded}
        range={range}
      />
    </div>
  );
}
