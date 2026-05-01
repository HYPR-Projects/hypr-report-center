// src/v2/admin/components/MergeGroupCardV2.jsx
//
// Wrapper visual para campanhas que pertencem a um mesmo grupo de Merge
// Reports. Renderizado pelo ClientDetailPage (e potencialmente outras
// listas) para que admin enxergue os tokens unificados como UMA unidade,
// sem perder o card individual de cada token (que continua sendo clicável
// pra abrir Drawer/Modal de Merge/Logo/Owner/etc).
//
// Layout:
//   ┌── outer container (border signature soft) ───────────────┐
//   │ Header: nome da campanha + N reports · período total     │
//   │ ────────────────────────────────────────────────────────  │
//   │  CampaignCardV2  (Jan 26)                                 │
//   │  CampaignCardV2  (Fev 26)                                 │
//   └───────────────────────────────────────────────────────────┘
//
// Decisões:
//   - Sem collapse (expanded sempre). Group raramente terá > 4 membros e
//     esconder cards de campanha estraga o scan vertical do admin.
//   - O nome exibido no header é o `campaign_name` do membro mais RECENTE
//     (representativo do "estado atual" do grupo).
//   - Período total = min(start) → max(end) entre membros.
//   - Click no header → abre o Drawer do membro mais recente como atalho
//     (mesma ação que clicar nele individualmente). Útil pra "Gerenciar
//     merge" rapidamente sem precisar achar qual card clicar.

import { CampaignCardV2 } from "./CampaignCardV2";
import { formatDateRange } from "../lib/format";

export function MergeGroupCardV2({ members, onOpen, onOpenReport, teamMap = {} }) {
  if (!members || members.length === 0) return null;

  // Membro de referência para o título = mais recente por start_date.
  // Garante que o nome reflete a "campanha atual" do grupo, não algo
  // legado de meses atrás.
  const sortedDesc = [...members].sort((a, b) =>
    (b.start_date || "").localeCompare(a.start_date || "")
  );
  const latest = sortedDesc[0];

  const earliestStart = members.reduce(
    (acc, m) => (acc && acc < (m.start_date || "")) ? acc : (m.start_date || acc),
    null,
  );
  const latestEnd = members.reduce(
    (acc, m) => (m.end_date && (!acc || m.end_date > acc)) ? m.end_date : acc,
    null,
  );
  const periodLabel = formatDateRange(earliestStart, latestEnd);

  return (
    <section
      className="rounded-xl border border-signature/30 bg-signature/[0.04] overflow-hidden"
      aria-label={`Grupo merged ${latest.campaign_name || ""}`}
    >
      {/* Header — meta do grupo */}
      <header
        className="flex items-center gap-3 px-4 py-3 border-b border-signature/20 bg-signature/[0.06]"
      >
        <span className="shrink-0 text-signature">
          <MergeIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-[0.18em] font-bold text-signature">
              Mesclado
            </span>
            <span className="text-fg-subtle text-[10px]">·</span>
            <span className="text-[12.5px] font-semibold text-fg truncate">
              {latest.campaign_name || "—"}
            </span>
          </div>
          <p className="text-[11px] text-fg-muted mt-0.5 tabular-nums">
            {members.length} {members.length === 1 ? "report" : "reports"}
            {periodLabel && (
              <>
                <span className="mx-1.5 text-fg-subtle">·</span>
                {periodLabel}
              </>
            )}
          </p>
        </div>
        <span
          className="hidden md:inline-flex shrink-0 items-center gap-1 px-2 py-1 rounded-md bg-signature/10 border border-signature/30 text-[10px] font-bold text-signature uppercase tracking-wider"
          title="Esses tokens compartilham um único link de report unificado"
        >
          1 link unificado
        </span>
      </header>

      {/* Lista de cards individuais — sem alterar o componente, só com
          um wrapper de padding interno e gap menor pra deixar claro que
          são "filhos" do mesmo grupo. */}
      <div className="space-y-1.5 p-2">
        {members.map((m) => (
          <CampaignCardV2
            key={m.short_token}
            campaign={m}
            onOpen={onOpen}
            onOpenReport={onOpenReport}
            teamMap={teamMap}
          />
        ))}
      </div>
    </section>
  );
}

function MergeIcon() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6"  cy="6"  r="2.5" />
      <circle cx="6"  cy="18" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M9 6c4 0 6 2 6 6M9 18c4 0 6-2 6-6" />
    </svg>
  );
}
