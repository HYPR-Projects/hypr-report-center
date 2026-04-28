// src/v2/components/CampaignHeaderV2.jsx
//
// Header do dashboard V2. Renderiza:
//   - Nome da campanha (h1)
//   - Cliente (subtítulo)
//   - Período (start_date — end_date) ou rótulo do filtro ativo
//   - Badge de status (rodando, encerrada, futura)
//   - Slot de ações à direita (geralmente o botão "Voltar à versão atual")
//
// Status é derivado das datas + "agora" — não há campo `status` no payload.

import { Badge } from "../../ui/Badge";

const fmtDate = (ymd) => {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

// Deriva status a partir das datas. Mantém a mesma lógica usada pelo
// pacing — campanha "rodando" se hoje está dentro do intervalo, "futura"
// se ainda não começou, "encerrada" se já passou. Não há "pausada"
// aqui porque o backend não expõe isso (precisaria de outro campo).
function deriveStatus(startStr, endStr) {
  if (!startStr || !endStr) {
    return { variant: "neutral", label: "Sem período" };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);

  if (today < start) return { variant: "warning", label: "Futura" };
  if (today > end)   return { variant: "neutral", label: "Encerrada" };
  return { variant: "success", label: "Rodando" };
}

export function CampaignHeaderV2({
  campaignName,
  clientName,
  startDate,
  endDate,
  rangeLabel, // texto do filtro ativo (ex: "Últimos 7 dias"); null = sem filtro
  actions,    // ReactNode opcional, slot à direita
}) {
  const status = deriveStatus(startDate, endDate);
  const start = fmtDate(startDate);
  const end = fmtDate(endDate);

  return (
    <header className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 pb-6 border-b border-border">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <Badge variant={status.variant} size="sm">{status.label}</Badge>
          {clientName && (
            <span className="text-xs uppercase tracking-wider text-fg-subtle font-medium">
              {clientName}
            </span>
          )}
        </div>

        <h1 className="text-2xl md:text-3xl font-bold text-fg leading-tight truncate">
          {campaignName || "Campanha sem nome"}
        </h1>

        <p className="mt-2 text-sm text-fg-muted">
          {start && end ? (
            <>
              <span className="tabular-nums">{start}</span>
              <span className="mx-2 text-fg-subtle">→</span>
              <span className="tabular-nums">{end}</span>
            </>
          ) : (
            "Período não definido"
          )}
          {rangeLabel && (
            <>
              <span className="mx-2 text-fg-subtle">·</span>
              <span className="text-signature font-semibold">
                {rangeLabel}
              </span>
            </>
          )}
        </p>
      </div>

      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </header>
  );
}
