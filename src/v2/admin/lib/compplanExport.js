// src/v2/admin/lib/compplanExport.js
//
// Aba "Compplan" do export do PMP Deals — replica o modelo da planilha
// HYPR_PMP_Deals_All-Time usada pra controlar o compplan (bônus por entrega).
//
// Colunas (mesma ordem da planilha):
//   Customer | Deal ID | Campaign Total | Flight Date | Client PI Negotiation
//   | Client PI Net | Impressions | Curator Cost | Curator Revenue
//   | Curator Margin | Margin % | % Delivery Margin | % Delivery Rev.
//   | eCPM | Status | Compp
//
// Granularidade: 1 row por DEAL — lines agrupadas (Fixed+Flex sob mesmo PI)
// colapsam numa row só, com métricas somadas e PI único (resolveGroupPi).
// Dataset é sempre lifetime (all-time), independente da aba/filtros ativos.

import { resolveGroupPi, effectiveStatus } from "./pmpFormat";

// PI líquido = PI negociado × fator (comissão/impostos). Fator extraído da
// própria planilha de compplan (constante em todas as rows históricas).
export const PI_NET_FACTOR = 0.8347;

// Regra do comp: entrega total (% Delivery Rev ≥ 99%) paga 0,75% do PI
// líquido; abaixo de 99% paga 0,25%.
export const COMPP_FULL_RATE = 0.0075;
export const COMPP_PARTIAL_RATE = 0.0025;
export const COMPP_DELIVERY_THRESHOLD = 0.99;

const STATUS_EN = {
  Finalizado: "Finished",
  Andamento:  "Running",
  Pausado:    "Paused",
  Pendente:   "Not Started",
  "Revisão":  "Review",
  Cancelado:  "Canceled",
};

// Status do deal quando o grupo tem lines em estados diferentes: o mais
// "vivo" ganha (uma line rodando = deal rodando).
const STATUS_PRIORITY = ["Andamento", "Revisão", "Pausado", "Pendente", "Finalizado", "Cancelado"];

/** "2026-05-06" → "Q2 - 26" (formato Flight Date da planilha). */
function quarterLabel(ymdStr) {
  if (!ymdStr) return "";
  const [y, m] = String(ymdStr).slice(0, 10).split("-").map(Number);
  if (!y || !m) return "";
  return `Q${Math.ceil(m / 3)} - ${String(y % 100).padStart(2, "0")}`;
}

const round2 = (v) => Math.round(v * 100) / 100;

export function buildCompplanRows(lines) {
  // 1 unidade-de-conta por deal: grupo colapsa, line solta fica 1:1.
  const units = new Map();
  for (const l of lines) {
    if (l.is_archived) continue;
    if (effectiveStatus(l) === "Cancelado") continue;
    const key = l.group_id || `line:${l.line_id}`;
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(l);
  }

  const rows = [];
  for (const members of units.values()) {
    const pick = (fn) => { for (const m of members) { const v = fn(m); if (v) return v; } return null; };
    const sum  = (fn) => members.reduce((s, m) => s + Number(fn(m) || 0), 0);

    const pi      = resolveGroupPi(members);
    const piNet   = pi != null && pi > 0 ? round2(Number(pi) * PI_NET_FACTOR) : null;
    const imps    = sum(m => m.imps);
    const cost    = sum(m => m.curator_total_cost);
    const revenue = sum(m => m.curator_revenue);
    const margin  = sum(m => m.curator_margin);

    const dealIds = [...new Set(members.flatMap(m => m.deal_ids || []))];
    const statusPt = STATUS_PRIORITY.find(s => members.some(m => effectiveStatus(m) === s)) || "Pendente";
    const startDate = members.map(m => m.start_date).filter(Boolean).sort()[0] || null;

    const pctMargin = (pi && pi > 0) ? margin / pi : null;
    const pctRev    = (pi && pi > 0) ? revenue / pi : null;
    // Comp só calculado quando já houve delivery — deal Not Started fica em
    // branco (não dá pra saber a faixa ainda).
    const compp = (piNet != null && revenue > 0)
      ? round2(piNet * (pctRev >= COMPP_DELIVERY_THRESHOLD ? COMPP_FULL_RATE : COMPP_PARTIAL_RATE))
      : null;

    rows.push({
      _sort: startDate || "9999-99-99",
      "Customer":              pick(m => m.customer) || "",
      "Deal ID":               dealIds.join(", "),
      "Campaign Total":        pick(m => m.group_id ? m.group_name : null) || pick(m => m.campaign_name) || "",
      "Flight Date":           quarterLabel(startDate),
      "Client PI Negotiation": pi != null ? Number(pi) : "",
      "Client PI Net":         piNet ?? "",
      "Impressions":           imps,
      "Curator Cost":          round2(cost),
      "Curator Revenue":       round2(revenue),
      "Curator Margin":        round2(margin),
      "Margin %":              revenue > 0 ? margin / revenue : "",
      "% Delivery Margin":     pctMargin ?? "",
      "% Delivery Rev.":       pctRev ?? "",
      "eCPM":                  imps > 0 ? round2((revenue * 1000) / imps) : "",
      "Status":                STATUS_EN[statusPt] || statusPt,
      "Compp":                 compp ?? "",
    });
  }

  // Mesma ordenação da planilha: cronológica por flight.
  rows.sort((a, b) => a._sort.localeCompare(b._sort));
  rows.forEach(r => delete r._sort);
  return rows;
}

// Formatos de célula pra abrir no Excel/Sheets já com a cara da planilha
// (R$, %, milhar). Índices 0-based das colunas na ordem acima.
const CURRENCY_COLS = [4, 5, 7, 8, 9, 13, 15];
const PERCENT_COLS  = [10, 11, 12];
const INT_COLS      = [6];

export function applyCompplanFormats(XLSX, ws, rowCount) {
  for (let r = 1; r <= rowCount; r++) {
    for (const c of CURRENCY_COLS) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = '"R$"#,##0.00';
    }
    for (const c of PERCENT_COLS) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = "0.00%";
    }
    for (const c of INT_COLS) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = "#,##0";
    }
  }
  ws["!cols"] = [
    { wch: 16 }, { wch: 14 }, { wch: 34 }, { wch: 10 }, { wch: 18 },
    { wch: 16 }, { wch: 13 }, { wch: 14 }, { wch: 16 }, { wch: 15 },
    { wch: 9 },  { wch: 16 }, { wch: 14 }, { wch: 11 }, { wch: 12 },
    { wch: 11 },
  ];
}
