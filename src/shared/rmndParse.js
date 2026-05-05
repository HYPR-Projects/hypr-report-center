// src/shared/rmndParse.js
//
// Parser do relatório Amazon Ads (formato 2026, headers PT-BR) para a aba RMND.
//
// O CSV/XLSX que admin sobe traz colunas como:
//   "Data" ("19 de mar. de 2026"), "Produto de anúncio" ("Sponsored Products"
//   ou "Amazon DSP"), "Nome da campanha", "Nome do grupo de anúncios",
//   "Identificador do produto anunciado" (ASIN), "Nome do anúncio" (descrição
//   longa do produto), métricas: "Impressões visíveis", "Compras", "Vendas",
//   "Unidades vendidas", "Adicionar ao carrinho", "Vendas a partir de cliques",
//   "Vendas a partir de visualizações".
//
// Decisões de produto (ditadas pelo PO):
//   - Não exibimos impressões nem cliques (não há cliques no relatório novo).
//   - NUNCA spend.
//   - Identificador do anúncio (ID interno) NÃO é exibido — só o ASIN.
//   - IDs vêm com escape de Excel ("=\"460943624012042\"") — limpamos.
//
// Saída do parser: rows leves e tipadas pro dashboard.

const HEADER_ALIASES = {
  date:        ["Data", "data"],
  adProduct:   ["Produto de anúncio", "Produto de anuncio"],
  campaign:    ["Nome da campanha"],
  adGroup:     ["Nome do grupo de anúncios", "Nome do grupo de anuncios"],
  adName:      ["Nome do anúncio", "Nome do anuncio"],
  asin:        ["Identificador do produto anunciado"],
  sku:         ["SKU do produto anunciado"],
  purchases:   ["Compras"],
  sales:       ["Vendas"],
  units:       ["Unidades vendidas"],
  atc:         ["Adicionar ao carrinho"],
  ctSales:     ["Vendas a partir de cliques"],
  vtSales:     ["Vendas a partir de visualizações", "Vendas a partir de visualizacoes"],
};

// "19 de mar. de 2026" → "2026-03-19".
// Aceita variações com/sem ponto, abreviado/completo, en/pt.
const PT_MONTHS = {
  jan: "01", fev: "02", mar: "03", abr: "04", mai: "05", jun: "06",
  jul: "07", ago: "08", set: "09", out: "10", nov: "11", dez: "12",
  // fallback inglês caso o user troque o locale do Amazon Console
  feb: "02", apr: "04", may: "05", aug: "08", sep: "09", oct: "10", dec: "12",
  // nomes completos
  janeiro: "01", fevereiro: "02", marco: "03", março: "03", abril: "04",
  maio: "05", junho: "06", julho: "07", agosto: "08", setembro: "09",
  outubro: "10", novembro: "11", dezembro: "12",
};

export function parseAmazonDate(value) {
  if (value == null || value === "") return null;
  // Já veio em ISO (caso XLSX retorne Date object ou string ISO)
  if (value instanceof Date && !isNaN(value)) {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split("/");
    return `${yyyy}-${mm}-${dd}`;
  }
  // "19 de mar. de 2026" / "1 de janeiro de 2025" / "19 mar 2026"
  const m = s.match(/^(\d{1,2})\s*(?:de\s+)?([A-Za-zçãáéíóúâêôû]+)\.?\s*(?:de\s+)?(\d{4})$/i);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const monthKey = m[2].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const mm = PT_MONTHS[monthKey] || PT_MONTHS[monthKey.slice(0, 3)];
    if (mm) return `${m[3]}-${mm}-${dd}`;
  }
  return null;
}

// IDs do Amazon vêm como `="460943624012042"` pra forçar Excel a tratar como
// texto. Limpa a casca pra ter o ID puro.
export function cleanAmazonId(value) {
  if (value == null) return "";
  const s = String(value).trim();
  const m = s.match(/^="?([^"]+)"?$/);
  if (m) return m[1].trim();
  // Aspas duplas envolvendo: "12345"
  const q = s.match(/^"(.+)"$/);
  if (q) return q[1].trim();
  return s;
}

function findHeaderIndex(headers, aliases) {
  const norm = (s) => String(s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const normalizedHeaders = headers.map(norm);
  for (const alias of aliases) {
    const a = norm(alias);
    const idx = normalizedHeaders.indexOf(a);
    if (idx !== -1) return idx;
  }
  return -1;
}

function buildHeaderMap(headers) {
  const map = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    map[field] = findHeaderIndex(headers, aliases);
  }
  return map;
}

function num(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim().replace(/\s/g, "");
  // Amazon CSV usa "." decimal e sem separador de milhar — número direto.
  // Se vier no formato BR ("1.234,56"), tenta corrigir.
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) {
    const n = Number(s.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** Truncar nome longo do produto pra exibição. Mantém raw em separado. */
export function truncateProductName(name, max = 80) {
  if (!name) return "";
  const s = String(name).trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Normaliza UMA linha bruta (array de células ou objeto) pra shape canônico.
 * Retorna null se a linha for inválida (sem data, sem grupo, sem ASIN).
 */
function normalizeRow(rawCells, headerMap) {
  const get = (field) => {
    const i = headerMap[field];
    return i >= 0 ? rawCells[i] : undefined;
  };
  const date = parseAmazonDate(get("date"));
  if (!date) return null;
  const adGroup = String(get("adGroup") ?? "").trim();
  const adProduct = String(get("adProduct") ?? "").trim();
  if (!adGroup) return null;

  const asin = cleanAmazonId(get("asin"));
  const sku = cleanAmazonId(get("sku"));
  const adName = String(get("adName") ?? "").trim();

  return {
    date,
    adProduct,                                         // "Sponsored Products" | "Amazon DSP"
    campaign: String(get("campaign") ?? "").trim(),
    adGroup,
    asin,
    sku,
    productName: adName,                               // descrição longa do produto
    purchases: num(get("purchases")),
    sales:     num(get("sales")),
    units:     num(get("units")),
    atc:       num(get("atc")),
    ctSales:   num(get("ctSales")),
    vtSales:   num(get("vtSales")),
  };
}

/**
 * Lê um arquivo (File) e devolve { rows, adGroups, dateRange, totalRaw }.
 * Cada row já vem normalizada (shape canônico). adGroups é a lista única
 * pra popular o filtro do modal.
 */
export async function parseAmazonAdsFile(file, XLSX) {
  if (!file) throw new Error("Arquivo vazio");
  if (!XLSX) throw new Error("Biblioteca XLSX não carregada");
  const ab = await file.arrayBuffer();
  // raw:false força XLSX a entregar strings formatadas (mantém "19 de mar. de 2026"
  // ao invés de converter pra serial — nosso parseAmazonDate cuida do resto).
  const wb = XLSX.read(ab, { cellDates: false, raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
  if (!matrix.length) throw new Error("Arquivo vazio ou ilegível");

  // Detecta linha de header — primeira linha com pelo menos 3 aliases conhecidos.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(matrix.length, 10); i++) {
    const row = matrix[i].map((c) => String(c ?? "").trim());
    let hits = 0;
    for (const aliases of Object.values(HEADER_ALIASES)) {
      if (findHeaderIndex(row, aliases) >= 0) hits++;
      if (hits >= 3) break;
    }
    if (hits >= 3) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    throw new Error("Cabeçalhos do relatório Amazon Ads não foram encontrados. Verifique se está no formato correto.");
  }
  const headers = matrix[headerIdx].map((c) => String(c ?? "").trim());
  const headerMap = buildHeaderMap(headers);

  // Valida campos críticos
  const required = ["date", "adGroup"];
  const missing = required.filter((f) => headerMap[f] < 0);
  if (missing.length) {
    throw new Error(`Colunas obrigatórias ausentes no relatório: ${missing.join(", ")}.`);
  }

  const rows = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const cells = matrix[i];
    if (!cells || cells.every((c) => c === "" || c == null)) continue;
    const r = normalizeRow(cells, headerMap);
    if (r) rows.push(r);
  }
  if (!rows.length) throw new Error("Nenhuma linha de dados foi reconhecida.");

  const adGroupsSet = new Set();
  let minDate = rows[0].date;
  let maxDate = rows[0].date;
  for (const r of rows) {
    adGroupsSet.add(r.adGroup);
    if (r.date < minDate) minDate = r.date;
    if (r.date > maxDate) maxDate = r.date;
  }
  const adGroups = [...adGroupsSet].sort();

  return {
    rows,
    adGroups,
    dateRange: { from: minDate, to: maxDate },
    totalRaw: rows.length,
  };
}

/**
 * Filtra um conjunto de rows por adGroups (set/array) e dateRange (from/to ISO).
 * Vazio em filters[X] significa "tudo".
 */
export function filterRows(rows, { adGroups, dateRange }) {
  const groupSet = adGroups && adGroups.length ? new Set(adGroups) : null;
  const from = dateRange?.from || null;
  const to = dateRange?.to || null;
  return rows.filter((r) => {
    if (groupSet && !groupSet.has(r.adGroup)) return false;
    if (from && r.date < from) return false;
    if (to && r.date > to) return false;
    return true;
  });
}

/** Resumo rápido (totais agregados) pra preview no modal. */
export function summarize(rows) {
  const out = {
    rowCount: rows.length,
    sales: 0, purchases: 0, units: 0, atc: 0, ctSales: 0, vtSales: 0,
    days: new Set(),
    adGroups: new Set(),
  };
  for (const r of rows) {
    out.sales     += r.sales;
    out.purchases += r.purchases;
    out.units     += r.units;
    out.atc       += r.atc;
    out.ctSales   += r.ctSales;
    out.vtSales   += r.vtSales;
    out.days.add(r.date);
    out.adGroups.add(r.adGroup);
  }
  return {
    ...out,
    daysCount: out.days.size,
    adGroupsCount: out.adGroups.size,
  };
}
