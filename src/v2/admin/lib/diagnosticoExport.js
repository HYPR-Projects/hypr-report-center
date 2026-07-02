// src/v2/admin/lib/diagnosticoExport.js
//
// Export XLSX da aba Diagnóstico. UMA aba "Diagnóstico" com Display +
// Video lado a lado, e a coluna "Mídia" como dimensão — assim o user
// pode filtrar/pivotar cruzando Mídia × Cliente × CS × ABS sem ter que
// alternar entre planilhas.
//
// Colunas Views 100% (Completions) e VTR % só são preenchidas nas linhas
// de Video (em Display ficam vazias). Restante é unificado: "Impressões
// Viewable" e "Entrega D-1" carregam o conceito agnóstico — pra Display
// = viewable imps, pra Video = viewable imps + completions D-1.
//
// Por que XLSX e não CSV:
//   No Mac, o Excel respeita o list separator do system locale (geralmente
//   `,`). Nosso CSV pt-BR usa `;` separador + `,` decimal — o Excel-Mac
//   ignora o `;` e parte tudo pelo `,`, quebrando colunas no meio dos
//   decimais. XLSX nativo elimina o problema porque cada célula é cada
//   célula, sem separador.

// xlsx é importado dinamicamente dentro de downloadDiagnosticoXlsx — a lib
// tem ~430 kB e só é necessária no clique de "Exportar XLSX". Import
// estático aqui arrastava o chunk inteiro pro boot do menu admin.
import { localPartFromEmail } from "./format";

const STATUS_LABELS = {
  super_over:   "Possível Super Over",
  over:         "Over",
  under:        "Verificar Under",
  ok:           "Ok",
  tech_high:    "Tech Cost Alto",
  tech_at_risk: "Possível Tech Alto",
};

function csName(r, teamMap) {
  if (!r.cs_email) return "";
  return teamMap?.[r.cs_email] || localPartFromEmail(r.cs_email);
}

// "YYYY-MM-DD" → Date ancorada no MEIO-DIA local. Por que meio-dia e não
// meia-noite: o SheetJS converte Date → serial Excel usando UTC, e o Excel
// renderiza o serial em hora local. Se a Date for meia-noite local em BRT
// (UTC-3), o serial fica 03:00 UTC, que em renderização em fusos diferentes
// pode cair no dia anterior. Ancorando às 12:00 LOCAL, o serial vira 15:00
// UTC — qualquer fuso entre -11h e +11h fica no mesmo dia. Trade-off: o
// numFmt "dd/mm/yyyy" só lê a parte da data, ignora a hora.
function toDate(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

// Helper pra montar célula com formato. Mantém o número CRU pra Excel
// poder somar/ordenar; só o display é formatado.
const cell = (value, z) => (value == null || !Number.isFinite(value) ? null : { v: value, t: "n", z });
const cellDate = (date) => (date ? { v: date, t: "d", z: "dd/mm/yyyy" } : null);

// Formatos Excel canônicos (US-style — Excel adapta ao locale do usuário:
// em pt-BR, `,` vira `.` no separador de milhar e `.` vira `,` no decimal).
const NUM_INT  = "#,##0";
const NUM_PCT1 = '0.0"%"';                  // 84,8% (valor cru já é a %, não fração)
const NUM_PCT2 = '0.00"%"';                 // 0,84%
const NUM_BRL  = '"R$" #,##0.00';           // R$ 1.234,56

// ────────────────────────────────────────────────────────────────────────
// Schema unificado
// ────────────────────────────────────────────────────────────────────────
//
// Mídia vem como segunda coluna (logo após Cliente) — fica visível no
// scroll horizontal mesmo com freeze na primeira coluna.
const HEADERS = [
  "Cliente",
  "Mídia",
  "Campanha",
  "Token",
  "CS Responsável",
  "ABS",
  "Início",
  "Fim",
  "Status Pacing",
  "Status Tech Cost",
  "Entregue %",
  "Projetada %",
  "Impressões Totais",
  "Impressões Viewable",
  "Views 100% (Completions)",  // só Video
  "Entrega D-1",
  "Média Ideal/Dia",
  "Média Atual/Dia",
  "Mín. Diária Restante",
  "Clicks",
  "CTR %",
  "VTR %",                     // só Video
  "CPM Real",
  "Custo Real",
  "Tech Cost %",
  "Viewability %",
];

const COL_WIDTHS = [
  18, 8, 32, 10, 18, 6, 11, 11, 22, 22, 11, 12, 16, 18, 22, 14, 14, 14, 18, 10, 10, 10, 12, 14, 12, 14,
];

function rowAoA(r, teamMap, historical) {
  const isVideo = r.media === "video";

  // CTR — clicks / impressões totais. Faz sentido nas duas mídias (video
  // tem clicks raros mas existem).
  const ctr = r.totalImpressions && r.clicks
    ? (r.clicks / r.totalImpressions) * 100
    : null;

  // VTR — só Video. views 100% viewable / viewable imps. Em Display fica
  // vazio porque não tem semântica.
  const vtr = isVideo && r.viewableImpressions && r.delivered
    ? (r.delivered / r.viewableImpressions) * 100
    : null;

  // Conceito "Impressões Viewable":
  //   Display → r.delivered (= display_viewable_impressions)
  //   Video   → r.viewableImpressions (= video_viewable_impressions)
  const viewable = isVideo ? r.viewableImpressions : r.delivered;

  // Conceito "Views 100% (Completions)" — só preenchido em Video.
  // r.delivered em Video = video_viewable_completions.
  const completions = isVideo ? r.delivered : null;

  return [
    r.client_name || "",
    isVideo ? "Video" : "Display",
    r.campaign_name || "",
    r.short_token || "",
    csName(r, teamMap),
    r.has_abs ? "Sim" : "Não",
    cellDate(toDate(r.start_date)),
    cellDate(toDate(r.end_date)),
    STATUS_LABELS[r.status] || "",
    STATUS_LABELS[r.tech_status] || "",
    cell(r.totalEntreguePct,    NUM_PCT1),
    // Modo histórico: no lugar da projeção (que não existe em janela
    // fechada) vai o contrato pro-rata da janela — r.negotiated das rows
    // de buildDiagnosticoRowsForPeriod.
    ...(historical ? [cell(r.negotiated, NUM_INT)] : [cell(r.projetadaPct, NUM_PCT1)]),
    cell(r.totalImpressions,    NUM_INT),
    cell(viewable,              NUM_INT),
    cell(completions,           NUM_INT),
    cell(r.deliveredD1,         NUM_INT),
    cell(r.idealDiaria,         NUM_INT),
    cell(r.mediaDiariaAtual,    NUM_INT),
    cell(r.minDiariaContratada, NUM_INT),
    cell(r.clicks,              NUM_INT),
    cell(ctr,                   NUM_PCT2),
    cell(vtr,                   NUM_PCT2),
    cell(r.realEcpm,            NUM_BRL),
    cell(r.realTotalCost,       NUM_BRL),
    cell(r.techCostPct,         NUM_PCT1),
    cell(r.viewability,         NUM_PCT1),
  ];
}

// ────────────────────────────────────────────────────────────────────────
// Sheet builder
// ────────────────────────────────────────────────────────────────────────
function buildSheet(utils, headers, dataAoa, colWidths) {
  const sheet = utils.aoa_to_sheet([headers, ...dataAoa]);
  if (colWidths) sheet["!cols"] = colWidths.map((w) => ({ wch: w }));
  // Freeze do header.
  sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  // AutoFilter no header — Excel aplica os funis automaticamente.
  if (dataAoa.length > 0) {
    const lastCol = utils.encode_col(headers.length - 1);
    const lastRow = dataAoa.length + 1;
    sheet["!autofilter"] = { ref: `A1:${lastCol}${lastRow}` };
  }
  return sheet;
}

// ────────────────────────────────────────────────────────────────────────
// API principal
// ────────────────────────────────────────────────────────────────────────
export async function downloadDiagnosticoXlsx({ displayRows, videoRows, teamMap, period = null }) {
  const { utils, writeFile } = await import("xlsx");
  const wb = utils.book_new();

  // Modo histórico (period = {from, to}): rows vêm de
  // buildDiagnosticoRowsForPeriod — sem projeção/D-1/mínima (colunas ficam
  // vazias) e com "Contratado (Janela)" no lugar de "Projetada %".
  const historical = Boolean(period?.from && period?.to);
  const headers = historical
    ? HEADERS.map((h) => (h === "Projetada %" ? "Contratado (Janela)" : h))
    : HEADERS;

  // Display primeiro (operação mais comum), Video em sequência. A coluna
  // "Mídia" deixa a separação explícita no filter dropdown.
  const aoa = [
    ...displayRows.map((r) => rowAoA(r, teamMap, historical)),
    ...videoRows.map((r) => rowAoA(r, teamMap, historical)),
  ];

  const sheet = buildSheet(utils, headers, aoa, COL_WIDTHS);
  utils.book_append_sheet(wb, sheet, "Diagnóstico");

  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  // Sufixo do período no filename — deixa claro que o arquivo é a foto de
  // uma janela, não o diagnóstico corrente.
  const periodSuffix = historical ? `-${period.from}_${period.to}` : "";
  const filename = `diagnostico-hypr${periodSuffix}-${ts}.xlsx`;

  writeFile(wb, filename, { bookType: "xlsx" });
}
