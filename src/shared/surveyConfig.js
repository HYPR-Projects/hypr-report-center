// Parser unificado do `survey_data` salvo no BigQuery. O blob é uma
// string JSON com 3 formas históricas possíveis:
//
//   1. Legacy CSV — objeto único `{ nome, control_total, exposed_total,
//      questions: [{label, control, exposed}] }`. Pré-Typeform, mantido
//      pra retrocompat (demo report ainda usa).
//
//   2. v1 (Typeform sem range) — array `[{nome, ctrlUrl, expUrl,
//      ctrlFormId?, expFormId?, focusRow?}]`. Foi o formato padrão até
//      a introdução do `clientRange`.
//
//   3. v2 (Typeform com clientRange) — objeto
//      `{ version: 2, questions: [...itens v1...], clientRange: {from,to}|null }`.
//      Permite o admin escolher um período pra exibir ao cliente sem
//      afetar a visão de inspeção interna.
//
// Dentro de `questions[i]` cada item agora aceita também `tipo: "videoask"`
// com `ctrlCounts`/`expCounts` embutidos (contagens já parseadas do XLSX
// exportado da plataforma, sem chamada de API em runtime). Quando `tipo`
// está ausente, assume `"typeform"` por retrocompat.
//
// Esta função normaliza pra `{ questions, clientRange, isLegacyCsv,
// legacyObject }` — chamadores não precisam saber o shape original.
//
// Devolve `null` se o JSON for inválido ou estiver vazio.

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeRange(r) {
  if (!r || typeof r !== "object") return null;
  const from = typeof r.from === "string" && YMD_RE.test(r.from) ? r.from : null;
  const to = typeof r.to === "string" && YMD_RE.test(r.to) ? r.to : null;
  if (!from || !to) return null;
  // from > to é inconsistente — descarta o range em vez de propagar erro
  if (from > to) return null;
  return { from, to };
}

export function parseSurveyConfig(jsonString) {
  if (!jsonString) return null;
  let parsed;
  try {
    parsed = typeof jsonString === "string" ? JSON.parse(jsonString) : jsonString;
  } catch {
    return null;
  }
  if (!parsed) return null;

  // v2: objeto com `version: 2` + questions array
  if (
    !Array.isArray(parsed) &&
    parsed.version === 2 &&
    Array.isArray(parsed.questions)
  ) {
    return {
      questions: parsed.questions,
      clientRange: normalizeRange(parsed.clientRange),
      isLegacyCsv: false,
      legacyObject: null,
    };
  }

  // v1: array de questions Typeform
  if (Array.isArray(parsed)) {
    return {
      questions: parsed,
      clientRange: null,
      isLegacyCsv: false,
      legacyObject: null,
    };
  }

  // Legacy CSV (objeto único com .questions de label/control/exposed)
  if (parsed && Array.isArray(parsed.questions)) {
    return {
      questions: null,
      clientRange: null,
      isLegacyCsv: true,
      legacyObject: parsed,
    };
  }

  return null;
}

// Serializa de volta pro storage. Se há clientRange válido, salva em v2;
// senão salva em v1 (array puro) pra preservar compat com qualquer leitor
// antigo que ainda assuma array.
export function serializeSurveyConfig(questions, clientRange) {
  const range = normalizeRange(clientRange);
  if (range) {
    return JSON.stringify({ version: 2, questions, clientRange: range });
  }
  return JSON.stringify(questions);
}

// Tipo da pergunta: "typeform" (padrão histórico) ou "videoask".
// Ausência do campo = "typeform" pra retrocompat com surveys salvos antes
// da v3. Caller usa pra rotear render path (fetch via proxy vs. counts
// embutidos) e pra rotular badge no relatório.
export function getQuestionTipo(q) {
  return q?.tipo === "videoask" ? "videoask" : "typeform";
}

// Soma valores de um dicionário {label: count} para totais agregados.
// Aceita counts numéricos ou strings numéricas (defensivo contra JSON
// que veio serializado com tipos misturados).
export function sumCounts(counts) {
  if (!counts || typeof counts !== "object") return 0;
  let total = 0;
  for (const v of Object.values(counts)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

// Pergunta videoask é renderizável se tem contagens válidas em AMBOS
// lados (controle E exposto) — sem ambos, não dá pra calcular lift.
export function isVideoaskQuestionRenderable(q) {
  if (!q || q.tipo !== "videoask") return false;
  return sumCounts(q.ctrlCounts) > 0 && sumCounts(q.expCounts) > 0;
}

// Formata um clientRange pra exibição compacta em PT-BR.
// "2026-04-01" + "2026-04-30" → "01/04 a 30/04/2026" (mesmo ano) ou
// "01/04/2026 a 30/04/2027" (anos diferentes). "" se range inválido.
export function fmtClientRange(r) {
  if (!r?.from || !r?.to) return "";
  const [yf, mf, df] = r.from.split("-");
  const [yt, mt, dt] = r.to.split("-");
  if (yf === yt) return `${df}/${mf} a ${dt}/${mt}/${yt}`;
  return `${df}/${mf}/${yf} a ${dt}/${mt}/${yt}`;
}
