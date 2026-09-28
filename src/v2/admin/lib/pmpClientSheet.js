// Planilha de cliente do PMP — helpers puros do frontend.
//
// Espelho de backend/pmp_client_sheet.py (unit_key_for / default_seat_id).
// A chave da unidade PRECISA bater com a do backend: é o target_id da
// integração. Card agrupado → o grupo inteiro; line solta → par source:line_id.

/** 'group:<id>' ou 'line:<source>:<line_id>'. null sem line. */
export function unitKeyFor(line) {
  if (!line) return null;
  if (line.group_id) return `group:${line.group_id}`;
  if (line.line_id == null || line.line_id === "") return null;
  return `line:${line.source || "xandr"}:${Number(line.line_id)}`;
}

/** Deal ID que o cliente ativa no seat da DSP (default da coluna "ID do
 *  Seat"). PubMatic: external_deal_id; Xandr: deal_ids. */
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
