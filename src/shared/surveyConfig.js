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
//   4. v4 (multi-fonte por lado) — cada lado pode declarar `ctrlParts` /
//      `expParts`: um ARRAY de fontes que são somadas entre si. Nasceu da
//      pesquisa nativa do Max Attention (etapa de survey do Tap to Choose),
//      que roda em paralelo ao Typeform com a mesma pergunta e as mesmas
//      opções — o cliente quer um número só. Cada parte é
//      `{source, ...campos daquela fonte}`; a reconciliação de rótulos e a
//      soma ficam em `surveySources.js`.
//
//      Os campos de fonte única (`ctrlSource`/`ctrlUrl`/`ctrlCounts`…)
//      continuam sendo escritos espelhando a PRIMEIRA parte, pra que um
//      leitor anterior a v4 ainda renderize algo correto (uma base em vez
//      de todas) em vez de quebrar.
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

// Source ("tipo") por LADO da pergunta — "typeform" ou "videoask".
// Schema novo (v3.1) usa campos `ctrlSource`/`expSource` independentes,
// permitindo pareamentos mistos (ex: Typeform Controle × VideoAsk Exposto).
// Legacy:
//   - `tipo: "videoask"` → ambos lados videoask
//   - sem `tipo` → ambos lados typeform
// Sem campo *Source nem tipo, default = "typeform".
export function getSideSource(q, side) {
  if (!q) return "typeform";
  const parts = side === "ctrl" ? q.ctrlParts : q.expParts;
  if (Array.isArray(parts) && parts.length && parts[0]?.source) return parts[0].source;
  const field = side === "ctrl" ? "ctrlSource" : "expSource";
  if (q[field] === "typeform" || q[field] === "videoask") return q[field];
  if (q.tipo === "videoask") return "videoask";
  return "typeform";
}

// Diz se UMA parte (uma fonte de um lado) tem dado utilizável.
// Fontes com contagens embutidas (videoask, maxattention manual) precisam
// de contagem > 0; fontes de API (typeform, maxattention por criativo)
// precisam do identificador.
export function partHasData(part) {
  if (!part) return false;
  if (sumCounts(part.counts) > 0) return true;
  if (part.source === "typeform") return !!(part.formId || part.url);
  if (part.source === "maxattention") return !!(part.creativeId || part.lineId);
  return false;
}

// Fontes de um lado, sempre como ARRAY, na ordem em que somam.
//
// Schema v4 lê `ctrlParts`/`expParts`. Schemas anteriores (fonte única por
// lado) são projetados numa lista de 1 elemento, então todo chamador pode
// assumir array e o resto do pipeline não precisa saber qual versão gerou
// o blob.
export function getSideParts(q, side) {
  if (!q) return [];
  const raw = side === "ctrl" ? q.ctrlParts : q.expParts;
  if (Array.isArray(raw) && raw.length) {
    return raw
      .map((p) => (p && typeof p === "object" ? { ...p, source: p.source || "typeform" } : null))
      .filter((p) => partHasData(p));
  }

  const source = getSideSource(q, side);
  const pick = (ctrlKey, expKey) => (side === "ctrl" ? q[ctrlKey] : q[expKey]);

  if (source === "videoask") {
    const counts = pick("ctrlCounts", "expCounts");
    const part = {
      source: "videoask",
      counts: counts || {},
      total: sumCounts(counts),
      fileName: pick("ctrlFileName", "expFileName") || "",
      question: pick("ctrlQuestion", "expQuestion") || "",
      firstAt: pick("ctrlFirstAt", "expFirstAt") || null,
      lastAt: pick("ctrlLastAt", "expLastAt") || null,
    };
    return partHasData(part) ? [part] : [];
  }

  const part = {
    source: "typeform",
    url: pick("ctrlUrl", "expUrl") || "",
    formId: pick("ctrlFormId", "expFormId") || "",
  };
  return partHasData(part) ? [part] : [];
}

// Diz se o lado tem dado utilizável pra renderizar — em qualquer uma das
// suas fontes. Permite lados opcionais: pergunta com só Controle, ou só
// Exposto, ainda é válida (sem cálculo de lift).
export function hasSideData(q, side) {
  return getSideParts(q, side).length > 0;
}

// Pergunta renderizável: pelo menos UM lado preenchido. Com os dois lados
// há cálculo de lift; com apenas um, mostra distribuição daquele grupo
// sem comparativo.
export function isQuestionRenderable(q) {
  if (!q) return false;
  return hasSideData(q, "ctrl") || hasSideData(q, "exp");
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
