// src/shared/pdoohParse.js
//
// Parser do relatório PDOOH (HYPR_PDOOH_REPORT) usado pelo modal de upload
// "rico" (com filtros) — mesmo padrão do rmndParse.js. O arquivo bruto tem
// algumas linhas de cabeçalho/metadados antes da linha real de header:
//
//   Report: HYPR_PDOOH_REPORT
//   Generated on 2026-05-22 …
//   Breakdown: DAILY from 2026-03-23 …
//   Filters:
//   (linha vazia)
//   DATE | CAMPAIGN | CITY | LINE_ITEM | MEDIA_OWNER | … | IMPRESSIONS | PLAYS
//   <dados…>
//
// Decisões de produto:
//   - DATE chega como serial do Excel (46104 = 2026-03-23). Normalizamos pra
//     ISO YYYY-MM-DD na hora do parse pra evitar inconsistência no dashboard.
//   - Preservamos TODAS as colunas originais (o PdoohDashboard lê várias
//     direto: CAMPAIGN, CITY, LINE_ITEM, MEDIA_OWNER, IMPRESSIONS, PLAYS,
//     SCREEN_LATITUDE/LONGITUDE, etc.).
//   - Filtros expostos: período + line item + media owner + cidade.

const REQUIRED_KEYS = ["DATE", "LINE_ITEM", "MEDIA_OWNER", "CITY", "IMPRESSIONS", "PLAYS"];

// Excel serial → "YYYY-MM-DD" (mesma fórmula do dateFilter.js)
export function excelSerialToIso(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n <= 25569 || n >= 60000) return null;
  const dt = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
  return dt.toISOString().slice(0, 10);
}

export function normalizePdoohDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "number") return excelSerialToIso(v);
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const iso = excelSerialToIso(Number(s));
    if (iso) return iso;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
    const [dd, mm, yyyy] = s.slice(0, 10).split("/");
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function findHeaderRow(matrix) {
  // Header é a primeira linha que contém ao menos DATE + uma das outras chaves.
  for (let i = 0; i < Math.min(matrix.length, 25); i++) {
    const row = (matrix[i] || []).map((c) => String(c ?? "").trim().toUpperCase());
    if (!row.includes("DATE")) continue;
    const hits = REQUIRED_KEYS.filter((k) => row.includes(k)).length;
    if (hits >= 3) return i;
  }
  return -1;
}

export async function parsePdoohFile(file, XLSX) {
  if (!file) throw new Error("Arquivo vazio");
  if (!XLSX) throw new Error("Biblioteca XLSX não carregada");
  const ab = await file.arrayBuffer();
  const wb = XLSX.read(ab, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
  if (!matrix.length) throw new Error("Arquivo vazio ou ilegível");

  const headerIdx = findHeaderRow(matrix);
  if (headerIdx === -1) {
    throw new Error("Cabeçalho do relatório PDOOH não encontrado. Verifique se o arquivo segue o formato HYPR_PDOOH_REPORT.");
  }
  const headers = matrix[headerIdx].map((c) => String(c ?? "").trim());
  const upper = headers.map((h) => h.toUpperCase());

  // Valida campos críticos
  const missing = ["DATE", "LINE_ITEM"].filter((k) => !upper.includes(k));
  if (missing.length) {
    throw new Error(`Colunas obrigatórias ausentes: ${missing.join(", ")}.`);
  }

  const idxDate       = upper.indexOf("DATE");
  const idxLineItem   = upper.indexOf("LINE_ITEM");
  const idxMediaOwner = upper.indexOf("MEDIA_OWNER");
  const idxCity       = upper.indexOf("CITY");

  const rows = [];
  const lineItems   = new Set();
  const mediaOwners = new Set();
  const cities      = new Set();
  let minDate = null;
  let maxDate = null;

  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const cells = matrix[i];
    if (!cells || cells.every((c) => c === "" || c == null)) continue;
    const dateIso = normalizePdoohDate(cells[idxDate]);
    if (!dateIso) continue;

    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = cells[j] != null ? cells[j] : "";
    }
    obj["DATE"] = dateIso;
    rows.push(obj);

    if (idxLineItem >= 0) {
      const v = String(cells[idxLineItem] ?? "").trim();
      if (v) lineItems.add(v);
    }
    if (idxMediaOwner >= 0) {
      const v = String(cells[idxMediaOwner] ?? "").trim();
      if (v) mediaOwners.add(v);
    }
    if (idxCity >= 0) {
      const v = String(cells[idxCity] ?? "").trim();
      if (v) cities.add(v);
    }
    if (!minDate || dateIso < minDate) minDate = dateIso;
    if (!maxDate || dateIso > maxDate) maxDate = dateIso;
  }

  if (!rows.length) {
    throw new Error("Nenhuma linha de dados foi reconhecida.");
  }

  return {
    rows,
    headers,
    lineItems:   [...lineItems].sort(),
    mediaOwners: [...mediaOwners].sort(),
    cities:      [...cities].sort(),
    dateRange:   { from: minDate, to: maxDate },
    totalRaw:    rows.length,
  };
}

/**
 * Filtra rows por line items, media owners, cidades e dateRange.
 *
 * Semântica explícita por dimensão:
 *   - `null`/`undefined`  → sem filtro (tudo passa)
 *   - array (mesmo vazio) → filtro literal (array vazio = zero rows passam)
 *
 * Importante pra UX cruzada: se a seleção do user ficar fora do "disponível"
 * dado os outros filtros, o consumidor pode passar `[]` pra forçar zero rows
 * em vez de cair em "tudo" silenciosamente.
 */
export function filterPdoohRows(rows, { lineItems, mediaOwners, cities, dateRange } = {}) {
  const liSet = lineItems   == null ? null : new Set(lineItems);
  const moSet = mediaOwners == null ? null : new Set(mediaOwners);
  const cSet  = cities      == null ? null : new Set(cities);
  const from = dateRange?.from || null;
  const to   = dateRange?.to   || null;
  return rows.filter((r) => {
    const d = r["DATE"];
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (liSet && !liSet.has(String(r["LINE_ITEM"] ?? "").trim())) return false;
    if (moSet && !moSet.has(String(r["MEDIA_OWNER"] ?? "").trim())) return false;
    if (cSet && !cSet.has(String(r["CITY"] ?? "").trim())) return false;
    return true;
  });
}

/** Totais agregados pra preview no modal. */
export function summarizePdooh(rows) {
  const out = {
    rowCount: rows.length,
    impressions: 0,
    plays: 0,
    days: new Set(),
    lineItems: new Set(),
    mediaOwners: new Set(),
    cities: new Set(),
  };
  for (const r of rows) {
    out.impressions += Number(r["IMPRESSIONS"]) || 0;
    out.plays       += Number(r["PLAYS"]) || 0;
    if (r["DATE"]) out.days.add(r["DATE"]);
    const li = String(r["LINE_ITEM"] ?? "").trim();
    const mo = String(r["MEDIA_OWNER"] ?? "").trim();
    const ci = String(r["CITY"] ?? "").trim();
    if (li) out.lineItems.add(li);
    if (mo) out.mediaOwners.add(mo);
    if (ci) out.cities.add(ci);
  }
  return {
    rowCount: out.rowCount,
    impressions: out.impressions,
    plays: out.plays,
    daysCount: out.days.size,
    lineItemsCount: out.lineItems.size,
    mediaOwnersCount: out.mediaOwners.size,
    citiesCount: out.cities.size,
  };
}
