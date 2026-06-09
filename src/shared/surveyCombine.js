// src/shared/surveyCombine.js
//
// Normalização + agregação de surveys para reports com múltiplos meses.
//
// `loadSurveyQuestions` extrai a lógica de fetch/normalização que vivia
// inline no SurveyTab — converte UM survey JSON (1 token) no array de
// `questions` que os renderers consomem. Reaproveitada tanto no modo
// "por mês" quanto no combinado.
//
// `combineSurveyQuestions` junta os arrays de N meses num único array,
// SOMANDO as contagens brutas (ctrl/exp por resposta; por nota/marca no
// matrix) antes de qualquer cálculo de pct/lift — que é a forma
// estatisticamente correta de "agregar todos os resultados". O casamento
// entre meses é POR NOME da pergunta; perguntas/marcas órfãs (presentes só
// em alguns meses) são agregadas apenas com os meses que as contêm.

import { fetchTypeformViaProxy } from "../lib/api";
import {
  parseSurveyConfig,
  sumCounts,
  getSideSource,
  hasSideData,
} from "./surveyConfig";

// Normaliza UM survey (1 token) no shape consumido pelos renderers do
// SurveyTab. `rangeParam` ({from,to}|null) filtra as respostas Typeform.
// Devolve [] quando não há pergunta renderável.
export async function loadSurveyQuestions(surveyJson, rangeParam) {
  const config = parseSurveyConfig(surveyJson);
  if (!config) throw new Error("Configuração de survey inválida.");

  const fetchTypeformData = (url) => fetchTypeformViaProxy(url, rangeParam);

  const hasModernQuestion =
    !config.isLegacyCsv &&
    Array.isArray(config.questions) &&
    config.questions.some(
      (q) => q && (hasSideData(q, "ctrl") || hasSideData(q, "exp")),
    );

  if (hasModernQuestion) {
    // Fetcha um lado individual (typeform → API, videoask → counts embutidos).
    const fetchSide = async (q, side) => {
      if (!hasSideData(q, side)) return null;
      const source = getSideSource(q, side);
      if (source === "videoask") {
        const counts = side === "ctrl" ? q.ctrlCounts || {} : q.expCounts || {};
        return { type: "choice", counts, total: sumCounts(counts) };
      }
      const url = side === "ctrl" ? q.ctrlUrl : q.expUrl;
      return fetchTypeformData(url);
    };

    return Promise.all(
      config.questions.map(async (q) => {
        const [ctrlData, expData] = await Promise.all([
          fetchSide(q, "ctrl"),
          fetchSide(q, "exp"),
        ]);
        const ctrlSource = getSideSource(q, "ctrl");
        const expSource = getSideSource(q, "exp");
        const sources = {
          ctrl: ctrlData ? ctrlSource : null,
          exp: expData ? expSource : null,
        };
        const isMatrix =
          ctrlData?.type === "matrix" && expData?.type === "matrix";
        if (isMatrix) {
          return {
            nome: q.nome,
            type: "matrix",
            sources,
            focusRow: q.focusRow || null,
            control_total: ctrlData.total,
            exposed_total: expData.total,
            ctrlRows: ctrlData.rows || {},
            expRows: expData.rows || {},
          };
        }
        return {
          nome: q.nome,
          type: "choice",
          sources,
          focusRow: q.focusRow || null,
          control_total: ctrlData?.total ?? null,
          exposed_total: expData?.total ?? null,
          ctrl: ctrlData?.counts || null,
          exp: expData?.counts || null,
        };
      }),
    );
  }

  if (config.isLegacyCsv) {
    const s = config.legacyObject;
    return [
      {
        nome: s.nome || "Survey",
        type: "legacy",
        control_total: s.control_total,
        exposed_total: s.exposed_total,
        legacy: true,
        questions: s.questions,
      },
    ];
  }

  return [];
}

// Soma maps {label: count} acumulando em `dest` (mutado).
function addCounts(dest, src) {
  if (!src) return;
  for (const [k, v] of Object.entries(src)) {
    const n = Number(v);
    if (Number.isFinite(n)) dest[k] = (dest[k] || 0) + n;
  }
}

// Pooling de uma pergunta tipo choice através dos meses.
function poolChoice(nome, list) {
  const ctrl = {};
  const exp = {};
  let ct = 0;
  let et = 0;
  let hasCtrl = false;
  let hasExp = false;
  let sourcesCtrl = null;
  let sourcesExp = null;
  let focusRow = null;

  for (const q of list) {
    if (q.ctrl && Object.keys(q.ctrl).length) {
      hasCtrl = true;
      addCounts(ctrl, q.ctrl);
    }
    if (q.exp && Object.keys(q.exp).length) {
      hasExp = true;
      addCounts(exp, q.exp);
    }
    if (q.control_total != null) ct += q.control_total;
    if (q.exposed_total != null) et += q.exposed_total;
    if (!sourcesCtrl && q.sources?.ctrl) sourcesCtrl = q.sources.ctrl;
    if (!sourcesExp && q.sources?.exp) sourcesExp = q.sources.exp;
    if (!focusRow && q.focusRow) focusRow = q.focusRow;
  }

  return {
    nome,
    type: "choice",
    sources: { ctrl: hasCtrl ? sourcesCtrl : null, exp: hasExp ? sourcesExp : null },
    focusRow,
    control_total: hasCtrl ? ct : null,
    exposed_total: hasExp ? et : null,
    ctrl: hasCtrl ? ctrl : null,
    exp: hasExp ? exp : null,
  };
}

// Pooling de uma pergunta matrix: união das marcas, somando counts por
// nota e totais — cada marca agrega só os meses que a contêm.
function poolMatrix(nome, list) {
  const ctrlRows = {};
  const expRows = {};
  let ct = 0;
  let et = 0;
  let focusRow = null;
  let sourcesCtrl = null;
  let sourcesExp = null;

  const mergeRows = (dest, src) => {
    for (const [row, data] of Object.entries(src || {})) {
      if (!dest[row]) dest[row] = { counts: {}, total: 0 };
      addCounts(dest[row].counts, data?.counts);
      dest[row].total += Number(data?.total) || 0;
    }
  };

  for (const q of list) {
    mergeRows(ctrlRows, q.ctrlRows);
    mergeRows(expRows, q.expRows);
    ct += q.control_total || 0;
    et += q.exposed_total || 0;
    if (!focusRow && q.focusRow) focusRow = q.focusRow;
    if (!sourcesCtrl && q.sources?.ctrl) sourcesCtrl = q.sources.ctrl;
    if (!sourcesExp && q.sources?.exp) sourcesExp = q.sources.exp;
  }

  return {
    nome,
    type: "matrix",
    sources: { ctrl: sourcesCtrl, exp: sourcesExp },
    focusRow,
    control_total: ct,
    exposed_total: et,
    ctrlRows,
    expRows,
  };
}

// Junta os arrays de questions de N meses num único array agregado.
// `perMonth`: Array<questions[]> (um por mês, na ordem de exibição).
// Casa por nome da pergunta; preserva a ordem da primeira aparição.
// Perguntas legacy (CSV) são ignoradas — agregação só faz sentido pro
// modelo moderno Typeform/VideoAsk.
export function combineSurveyQuestions(perMonth) {
  const order = [];
  const groups = new Map();

  (perMonth || []).forEach((qs) => {
    (qs || []).forEach((q, i) => {
      if (!q || q.legacy) return;
      const key = q.nome || `__pos_${i}`;
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key).push(q);
    });
  });

  return order.map((key) => {
    const list = groups.get(key);
    const nome = list.find((q) => q.nome)?.nome || key;
    // Matrix só quando TODOS os meses que têm essa pergunta são matrix —
    // misturar matrix+choice não tem semântica de pooling clara, então
    // cai pra choice (improvável com forms estáveis).
    const allMatrix = list.every((q) => q.type === "matrix");
    if (allMatrix) return poolMatrix(nome, list);
    return poolChoice(nome, list.filter((q) => q.type !== "matrix"));
  });
}
