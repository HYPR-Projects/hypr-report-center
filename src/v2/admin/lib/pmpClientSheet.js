// Planilha de cliente do PMP — helpers puros do frontend.
//
// O deal (quais lines entram) e a chave da planilha são resolvidos no backend
// (backend/pmp_client_sheet.py, resolve_for_line). Aqui fica só o que a UI
// precisa mostrar sem ir ao servidor.

/** Deal ID que o cliente ativa no seat da DSP (default da coluna "ID do
 *  Seat"). PubMatic: external_deal_id; Xandr: deal_ids. Espelho de
 *  default_seat_id do backend. */
export function defaultSeatId(line) {
  const ext = String(line?.external_deal_id || "").trim();
  if (ext) return ext;
  let ids = line?.deal_ids;
  if (typeof ids === "string") {
    try { ids = JSON.parse(ids); } catch { ids = ids.split(/[,\s]+/); }
  }
  if (ids == null) return "";
  if (!Array.isArray(ids)) ids = [ids];
  return ids.filter(i => i != null && i !== "").join(", ");
}

/** "3 lines · tokens 1PIT7I, B154D4" — resumo do que a planilha inclui. */
export function dealSummaryLabel(deal) {
  const n = deal?.lines?.length || 0;
  const toks = deal?.tokens || [];
  const parts = [n === 1 ? "1 line" : `${n} lines`];
  if (toks.length) parts.push(`${toks.length === 1 ? "token" : "tokens"} ${toks.join(", ")}`);
  return parts.join(" · ");
}
