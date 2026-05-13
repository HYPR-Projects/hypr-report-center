// Parser do export XLSX do VideoAsk.
//
// Estrutura do arquivo (observada no export real):
//   Linha 1 = headers: Date/Time, Name, Email, Phone, Product name, Consent,
//             Tags, Q1. <título> (<media-url>), Author Type, Reply, ...
//   Linhas 2+ = um respondente por linha; a célula da coluna "Q1." tem
//               a resposta de múltipla escolha como texto ("Avon", "Eudora"...).
//
// Pra MVP suportamos a PRIMEIRA pergunta encontrada (header começa com
// /^Q\d+\./). VideoAsk geralmente tem 1 pergunta por survey. Respostas
// vazias (respondente gravou áudio/vídeo livre em vez de escolher opção)
// são ignoradas — só contam respostas categóricas.
//
// Lib: usamos `xlsx` (sheetjs) em vez de `read-excel-file` porque o último
// é estrito demais com inline strings vazias que o VideoAsk emite (`<c
// r="G2" t="inlineStr"></c>` em colunas opcionais como Tags) e quebra na
// hora de parsear o arquivo real.

import { read, utils } from "xlsx";

const QUESTION_HEADER_RE = /^Q\d+\./;

/**
 * Lê um File (de <input type="file">) e devolve as contagens da 1ª pergunta
 * de múltipla escolha.
 *
 * @param {File} file
 * @returns {Promise<{question: string, counts: Record<string, number>, total: number, firstAt: string|null, lastAt: string|null}>}
 */
export async function parseVideoaskFile(file) {
  if (!file) throw new Error("Nenhum arquivo selecionado");
  let rows;
  try {
    const buffer = await file.arrayBuffer();
    const wb = read(buffer, { type: "array", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new Error("Arquivo sem planilhas");
    rows = utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  } catch (e) {
    throw new Error(`Não consegui ler o arquivo (${e?.message || "erro desconhecido"})`);
  }
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error("Arquivo vazio ou sem respostas");
  }
  const header = rows[0] || [];
  // Acha coluna de pergunta (header começa com "Q1.", "Q2.", etc).
  // Em VideoAsks com múltiplas perguntas, ficamos com a primeira.
  let qIdx = -1;
  let qLabel = "";
  for (let i = 0; i < header.length; i++) {
    const cell = String(header[i] ?? "").trim();
    if (QUESTION_HEADER_RE.test(cell)) {
      qIdx = i;
      qLabel = cell;
      break;
    }
  }
  if (qIdx < 0) {
    throw new Error("Não encontrei coluna de pergunta (Q1., Q2., …) no header do arquivo");
  }

  // Acha coluna de data pra extrair primeiro/último timestamp (informativo
  // pro admin). Header padrão é "Date/Time" na coluna A.
  let dateIdx = -1;
  for (let i = 0; i < header.length; i++) {
    const cell = String(header[i] ?? "").trim().toLowerCase();
    if (cell === "date/time" || cell === "submitted at" || cell === "submitted_at") {
      dateIdx = i;
      break;
    }
  }

  const counts = {};
  let total = 0;
  let firstAt = null;
  let lastAt = null;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const raw = row[qIdx];
    if (raw == null) continue;
    const key = String(raw).trim();
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
    total++;

    if (dateIdx >= 0) {
      const dRaw = row[dateIdx];
      if (dRaw != null) {
        // cellDates: true faz o sheetjs devolver Date objects; fallback
        // pra string só por garantia.
        let iso = null;
        if (dRaw instanceof Date && !isNaN(dRaw.getTime())) {
          iso = dRaw.toISOString();
        } else if (typeof dRaw === "string") {
          const t = Date.parse(dRaw);
          if (!Number.isNaN(t)) iso = new Date(t).toISOString();
        }
        if (iso) {
          if (!firstAt || iso < firstAt) firstAt = iso;
          if (!lastAt || iso > lastAt) lastAt = iso;
        }
      }
    }
  }

  if (total === 0) {
    throw new Error("Nenhuma resposta categórica encontrada no arquivo (talvez só tenha vídeos/áudios livres?)");
  }

  return { question: qLabel, counts, total, firstAt, lastAt };
}
