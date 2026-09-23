// src/shared/explorer.js
//
// Agrupamentos do Explorador de entrega (abas Display e Vídeo) que não
// existiam em aggregations.js: quebra por line_name. Mesmo shape dos
// groupBy* de lá ({[key], [num], [den], [rate]}), para a tabela de
// distribuição consumir igual.

export function groupByLine(rows, numeratorKey, denomKey, rateKey) {
  const acc = new Map();
  for (const r of rows || []) {
    const k = r?.line_name || "N/A";
    const e = acc.get(k) || { line_name: k, [numeratorKey]: 0, [denomKey]: 0 };
    e[numeratorKey] += Number(r[numeratorKey]) || 0;
    e[denomKey] += Number(r[denomKey]) || 0;
    acc.set(k, e);
  }
  return [...acc.values()].map((e) => ({
    ...e,
    [rateKey]: e[denomKey] > 0 ? (e[numeratorKey] / e[denomKey]) * 100 : 0,
  }));
}

/** Quantos valores distintos a dimensão tem no recorte (para desligar a aba de 1 valor). */
export function distinctCount(rows, keyFn) {
  const s = new Set();
  for (const r of rows || []) s.add(keyFn(r));
  return s.size;
}
