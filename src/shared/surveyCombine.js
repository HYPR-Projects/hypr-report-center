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
//
// Há DOIS eixos de agregação, e eles são independentes:
//
//   • entre FONTES do mesmo lado (Typeform + Max Attention + VideoAsk na
//     mesma pergunta, mesmo mês) — resolvido em `loadSurveyQuestions` via
//     `poolSideParts`, com reconciliação de rótulos;
//   • entre MESES (o mesmo lado, meses diferentes) — resolvido aqui.
//
// Os dois usam o mesmo reconciliador (`surveySources.js`), então "Sim" de
// abril soma com "sim" de maio pelo mesmo critério que faz o Typeform
// somar com o Max Attention. Um eixo não sabe do outro.

import { fetchTypeformViaProxy } from "../lib/api";
import {
  parseSurveyConfig,
  sumCounts,
  getSideParts,
  hasSideData,
} from "./surveyConfig";
import { poolSideParts, poolChoiceParts, poolMatrixParts, SOURCE_LABELS } from "./surveySources";

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
    // Busca UMA fonte. Typeform vai na API (via proxy); fontes com
    // contagens embutidas (VideoAsk, e Max Attention quando as respostas
    // já foram gravadas na config) resolvem local, sem rede.
    const fetchPart = async (part) => {
      if (part.source === "typeform") {
        const data = await fetchTypeformData(part.url || part.formId);
        return data ? { ...data, source: "typeform", label: SOURCE_LABELS.typeform } : null;
      }
      const counts = part.counts || {};
      const total = Number(part.total);
      return {
        type: "choice",
        source: part.source,
        label: part.creativeName || part.fileName || SOURCE_LABELS[part.source] || "",
        counts,
        total: Number.isFinite(total) && total > 0 ? total : sumCounts(counts),
        firstAt: part.firstAt || null,
        lastAt: part.lastAt || null,
      };
    };

    // Um lado = N fontes somadas. Falha de UMA fonte não derruba o lado:
    // o report mostra o que respondeu e registra a base que faltou, em vez
    // de sumir com a pergunta inteira por causa de um 502 do Typeform.
    const fetchSide = async (q, side) => {
      const parts = getSideParts(q, side);
      if (!parts.length) return null;
      const settled = await Promise.allSettled(parts.map(fetchPart));
      const ok = [];
      const failed = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value) ok.push(r.value);
        else failed.push({ source: parts[i].source, error: r.reason?.message || "falha ao buscar" });
      });
      if (!ok.length) {
        if (failed.length) throw new Error(failed[0].error);
        return null;
      }
      const pooled = poolSideParts(ok);
      if (pooled && failed.length) pooled.reconciliation.failed = failed;
      return pooled;
    };

    return Promise.all(
      config.questions.map(async (q) => {
        const [ctrlData, expData] = await Promise.all([
          fetchSide(q, "ctrl"),
          fetchSide(q, "exp"),
        ]);
        // `sources` é sempre ARRAY por lado — com multi-fonte, um lado pode
        // ter mais de uma origem ao mesmo tempo.
        const sources = {
          ctrl: ctrlData?.sources || null,
          exp: expData?.sources || null,
        };
        const bases = { ctrl: ctrlData?.bases || null, exp: expData?.bases || null };
        const reconciliation = {
          ctrl: ctrlData?.reconciliation || null,
          exp: expData?.reconciliation || null,
        };
        const isMatrix =
          ctrlData?.type === "matrix" && expData?.type === "matrix";
        if (isMatrix) {
          return {
            nome: q.nome,
            type: "matrix",
            sources,
            bases,
            reconciliation,
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
          bases,
          reconciliation,
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

// Fontes de um lado, sempre como array e sem repetição, preservando a
// ordem de aparição. Aceita o formato antigo (string única) porque um
// report pode estar sendo montado a partir de dado já em memória.
function toSourceList(v) {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

function unionSources(list, side) {
  const out = [];
  for (const q of list) {
    for (const s of toSourceList(q.sources?.[side])) {
      if (!out.includes(s)) out.push(s);
    }
  }
  return out.length ? out : null;
}

// Bases (fonte × volume) de todos os meses, concatenadas — o admin
// consegue ver de onde veio cada pedaço do total combinado.
function concatBases(list, side) {
  const out = [];
  for (const q of list) {
    for (const b of q.bases?.[side] || []) out.push(b);
  }
  return out.length ? out : null;
}

// Pooling de uma pergunta tipo choice através dos meses. Usa o MESMO
// reconciliador da agregação entre fontes, então "Sim" de abril soma com
// "sim" de maio — antes isso virava duas linhas no gráfico.
function poolChoice(nome, list) {
  const partsFor = (side) => {
    const key = side === "ctrl" ? "ctrl" : "exp";
    const totalKey = side === "ctrl" ? "control_total" : "exposed_total";
    return list
      .filter((q) => q[key] && Object.keys(q[key]).length)
      .map((q, i) => ({
        source: `mes-${i}`,
        counts: q[key],
        total: q[totalKey] ?? undefined,
      }));
  };

  const ctrlPooled = poolChoiceParts(partsFor("ctrl"));
  const expPooled = poolChoiceParts(partsFor("exp"));
  const focusRow = list.find((q) => q.focusRow)?.focusRow || null;

  return {
    nome,
    type: "choice",
    sources: {
      ctrl: ctrlPooled ? unionSources(list, "ctrl") : null,
      exp: expPooled ? unionSources(list, "exp") : null,
    },
    bases: { ctrl: concatBases(list, "ctrl"), exp: concatBases(list, "exp") },
    reconciliation: {
      ctrl: ctrlPooled?.reconciliation || null,
      exp: expPooled?.reconciliation || null,
    },
    focusRow,
    control_total: ctrlPooled ? ctrlPooled.total : null,
    exposed_total: expPooled ? expPooled.total : null,
    ctrl: ctrlPooled ? ctrlPooled.counts : null,
    exp: expPooled ? expPooled.counts : null,
  };
}

// Pooling de uma pergunta matrix: união das marcas, somando counts por
// nota e totais — cada marca agrega só os meses que a contêm, e marcas
// escritas diferente entre meses ("Vichy" × "vichy") caem na mesma linha.
function poolMatrix(nome, list) {
  const partsFor = (rowsKey, totalKey) =>
    list
      .filter((q) => q[rowsKey] && Object.keys(q[rowsKey]).length)
      .map((q, i) => ({
        source: `mes-${i}`,
        rows: q[rowsKey],
        total: q[totalKey] ?? undefined,
      }));

  const ctrlPooled = poolMatrixParts(partsFor("ctrlRows", "control_total"));
  const expPooled = poolMatrixParts(partsFor("expRows", "exposed_total"));

  return {
    nome,
    type: "matrix",
    sources: { ctrl: unionSources(list, "ctrl"), exp: unionSources(list, "exp") },
    bases: { ctrl: concatBases(list, "ctrl"), exp: concatBases(list, "exp") },
    reconciliation: {
      ctrl: ctrlPooled?.reconciliation || null,
      exp: expPooled?.reconciliation || null,
    },
    focusRow: list.find((q) => q.focusRow)?.focusRow || null,
    control_total: ctrlPooled?.total || 0,
    exposed_total: expPooled?.total || 0,
    ctrlRows: ctrlPooled?.rows || {},
    expRows: expPooled?.rows || {},
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
