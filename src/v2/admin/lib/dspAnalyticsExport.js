// src/v2/admin/lib/dspAnalyticsExport.js
//
// Export XLSX do Analytics › Saúde das DSPs: uma aba "Lines" com todas as
// lines do recorte (não só a página visível da tabela) e uma aba "Por DSP"
// com os totais. Números crus com formato de célula, pra somar e pivotar no
// Excel. XLSX e não CSV pelo mesmo motivo do Diagnóstico: Excel-Mac quebra o
// CSV pt-BR (`;` + `,` decimal).
//
// xlsx é importado sob demanda (~430 kB) só no clique.

import { FLAG_DEFS } from "./dspAnalytics.js";
import { dspLabel } from "../../../shared/dspMeta.js";
import { tacticLabel } from "../../../shared/tacticMeta.js";

const NUM_INT = "#,##0";
const NUM_PCT1 = '0.0"%"';
const NUM_PCT2 = '0.00"%"';
const NUM_BRL = '"R$" #,##0.00';
const NUM_BRL3 = '"R$" #,##0.000';

const cell = (v, z) => (v == null || !Number.isFinite(v) ? null : { v, t: "n", z });

const REASON = { fee: "Fee DV", cliente: "Lista de clientes", override: "Marcação manual" };

export const LINE_HEADERS = [
  "DSP", "Cliente", "Campanha", "Short token", "IO / Campaign DSP", "Line", "Tática", "Formato",
  "ABS", "Motivo ABS", "Survey", "Primeiro dia", "Último dia",
  "Impressões", "Mensuráveis", "Visíveis", "Cliques", "Completions visíveis",
  "Custo (R$)", "Fee DV (R$)", "eCPM", "vCPM", "CPCV",
  "CTR", "VTR", "Viewability", "Mensuração", "Visíveis / Total", "Red flags",
];

export function lineRowAoA(l) {
  return [
    dspLabel(l.s), l.client, l.campaign, l.token === "__none__" ? "" : l.token, l.io, l.name,
    tacticLabel(l.tactic || "none"),
    l.m === "VIDEO" ? "Vídeo" : l.m === "DISPLAY" ? "Display" : "Outro",
    l.abs ? "Sim" : "Não", REASON[l.reason] || "", l.sv ? "Sim" : "Não", l.first || "", l.last || "",
    cell(l.imp, NUM_INT), cell(l.meas, NUM_INT), cell(l.view, NUM_INT), cell(l.clk, NUM_INT),
    cell(l.m === "VIDEO" ? l.vcomp : null, NUM_INT),
    cell(l.cost, NUM_BRL), cell(l.fee || null, NUM_BRL),
    cell(l.ecpm, NUM_BRL), cell(l.vcpm, NUM_BRL), cell(l.cpcv, NUM_BRL3),
    cell(l.ctr, NUM_PCT2), cell(l.vtr, NUM_PCT1), cell(l.viewability, NUM_PCT1),
    cell(l.measRate, NUM_PCT1), cell(l.viewShare, NUM_PCT1),
    (l.flags || []).map((f) => FLAG_DEFS[f]?.label || f).join(", "),
  ];
}

const SOURCE_HEADERS = [
  "DSP", "Impressões", "Mensuráveis", "Visíveis", "Cliques", "Custo (R$)", "Share custo",
  "eCPM", "vCPM", "CTR", "VTR", "Viewability", "Mensuração", "Visíveis / Total",
];

function sourceRowAoA(c) {
  const m = c.metrics;
  return [
    dspLabel(c.source), cell(m.imp, NUM_INT), cell(m.meas, NUM_INT), cell(m.view, NUM_INT),
    cell(m.clk, NUM_INT), cell(m.cost, NUM_BRL), cell(c.shareCost, NUM_PCT1),
    cell(m.ecpm, NUM_BRL), cell(m.vcpm, NUM_BRL), cell(m.ctr, NUM_PCT2), cell(m.vtr, NUM_PCT1),
    cell(m.viewability, NUM_PCT1), cell(m.measRate, NUM_PCT1), cell(m.viewShare, NUM_PCT1),
  ];
}

export async function downloadDspAnalyticsXlsx({ lines, cards, from, to }) {
  const { utils, writeFile } = await import("xlsx");
  const wb = utils.book_new();
  const sheet = (headers, rows, widths) => {
    const ws = utils.aoa_to_sheet([headers, ...rows]);
    ws["!cols"] = widths.map((wch) => ({ wch }));
    ws["!autofilter"] = { ref: `A1:${utils.encode_col(headers.length - 1)}${rows.length + 1}` };
    return ws;
  };
  utils.book_append_sheet(wb, sheet(SOURCE_HEADERS, cards.map(sourceRowAoA), [12, ...SOURCE_HEADERS.slice(1).map(() => 13)]), "Por DSP");
  const sorted = [...lines].sort((a, b) => b.cost - a.cost);
  utils.book_append_sheet(
    wb,
    sheet(LINE_HEADERS, sorted.map(lineRowAoA), [10, 18, 28, 10, 26, 60, 20, 8, 6, 16, 7, 11, 11, ...LINE_HEADERS.slice(13).map(() => 12)]),
    "Lines",
  );
  writeFile(wb, `saude-dsps_${from}_${to}.xlsx`);
}
