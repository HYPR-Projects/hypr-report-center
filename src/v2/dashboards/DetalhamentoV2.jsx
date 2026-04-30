// src/v2/dashboards/DetalhamentoV2.jsx
//
// Tab "Detalhamento" — base de dados completa da campanha em formato
// tabular. Cada linha = combinação única de Data × Line × Criativo,
// com todas as métricas brutas (impressões, visíveis, clicks, custo,
// completions, etc).
//
// Por que tem tab dedicada (PR-16)
//   Antes vivia como CollapsibleSection fechada na Visão Geral. Mas é
//   conceitualmente diferente do resto da Visão Geral (que é executive
//   summary / insights agregados): aqui é raw data pra auditoria e
//   exportação CSV. Tab separada deixa Visão Geral mais leve, e dá
//   destaque proporcional pra quem precisa investigar/exportar.
//
// Diferença vs DisplayDetailTable / VideoDetailTable
//   As tabs Display e Video têm tables próprias com colunas otimizadas
//   pra cada mídia (CTR/CPC pra Display, VTR/CPCV pra Video). Esta tab
//   usa o DataTableV2 universal com filter Tudo/Display/Video interno —
//   útil quando o user quer ver TUDO num lugar só, ou exportar o CSV
//   completo da campanha.
//
// Integração Google Sheets (PR-C sheets)
//   No topo da tab, SheetsIntegrationCardV2 mostra o estado da integração:
//   - admin sem integração: botão "Conectar Google Sheets"
//   - todos com integração ativa: link "Abrir no Google Sheets"
//   - admin com erro/revogada: banner de reconexão
//   Cliente sem integração ativa não vê o card.

import { DataTableV2 } from "../components/DataTableV2";
import SheetsIntegrationCardV2 from "../components/SheetsIntegrationCardV2";

export default function DetalhamentoV2({ data, aggregates, token, isAdmin, adminJwt }) {
  const camp = data.campaign;
  const { detail } = aggregates;

  if (!detail || detail.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center text-fg-muted">
        Sem dados de detalhamento disponíveis para esta campanha.
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      <div>
        <h2 className="text-base font-bold text-fg">Base de Dados</h2>
        <p className="text-xs text-fg-muted mt-1 max-w-2xl">
          Base de dados completa: cada linha representa uma combinação única
          de Data × Linha × Criativo, com todas as métricas brutas. Use os
          filtros pra restringir por mídia ou exporte CSV pra análise externa.
        </p>
      </div>
      <SheetsIntegrationCardV2
        token={token}
        isAdmin={isAdmin}
        adminJwt={adminJwt}
        initialIntegration={data?.sheets_integration || null}
      />
      <DataTableV2 detail={detail} campaignName={camp.campaign_name} />
    </div>
  );
}
