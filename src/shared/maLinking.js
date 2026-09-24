// src/shared/maLinking.js
//
// Lógica pura do modal de vínculo Max Attention (MaLinksModalV2): quais
// linhas criativas da DSP já têm peça, qual peça a Platform sugere para cada
// uma e o que buscar quando não sugere nada. O casamento em si é do backend
// (ma_matching.py); aqui só se cruza o resultado com o que está vinculado.

const normName = (s) => String(s || "").trim().toUpperCase();

/** Nomes crus da DSP já usados por alguma peça vinculada (normalizados). */
export function takenNames(links, exceptId = null) {
  const out = new Set();
  for (const l of links || []) {
    if (exceptId && l.creative_id === exceptId) continue;
    for (const n of l.dsp_creative_names || []) out.add(normName(n));
  }
  return out;
}

/**
 * Situação de cada linha criativa da DSP:
 *   { line, names, impressions, linked: [peça], suggested: [sugestão] }
 * `linked` = peças vinculadas que usam algum nome da linha; `suggested` =
 * sugestões (ainda não vinculadas) cujo casamento inclui a linha, melhor
 * primeiro. Mesma ordem das linhas (impressão desc, vinda do backend).
 */
export function lineCoverage(lines, links, suggestions) {
  const linkedIds = new Set((links || []).map((l) => l.creative_id));
  return (lines || []).map((e) => {
    const names = new Set((e.names || []).map(normName));
    const linked = (links || []).filter((l) => (l.dsp_creative_names || []).some((n) => names.has(normName(n))));
    const suggested = (suggestions || []).filter(
      (s) => !linkedIds.has(String(s.creative_id).toLowerCase()) && (s.dsp_lines || []).includes(e.line),
    );
    return { ...e, linked, suggested };
  });
}

/**
 * Nomes da DSP que a sugestão leva ao ser vinculada: os das linhas casadas,
 * menos os que outra peça já usa (a impressão da DSP não conta duas vezes).
 */
export function namesToLink(item, links) {
  const taken = takenNames(links);
  const base = Array.isArray(item?.dsp_creative_names)
    ? item.dsp_creative_names
    : item?.match_name
      ? [item.match_name]
      : [];
  return base.filter((n) => !taken.has(normName(n)));
}

/** Sugestões que dá para vincular de uma vez: casaram com linha da DSP que
 *  ainda está sem peça (ou por AdBolt/token, sinais fortes). Uma por linha. */
export function strongSuggestions(coverage, suggestions) {
  const picked = new Map();
  for (const row of coverage || []) {
    if (row.linked.length || !row.suggested.length) continue;
    const best = row.suggested[0];
    picked.set(String(best.creative_id).toLowerCase(), best);
  }
  for (const s of suggestions || []) {
    const r = s.reasons || [];
    if (r.includes("adbolt") || r.includes("token")) picked.set(String(s.creative_id).toLowerCase(), s);
  }
  return [...picked.values()];
}

const NOISE = new Set(["hypr", "display", "video", "banner", "static", "html5", "dv360", "xandr", "stackadapt", "yahoo"]);

/** Texto de busca para uma linha sem sugestão: o que distingue a linha
 *  dentro da campanha ("reveal tiros"), sem prefixo, tamanho e os termos
 *  de campanha que a busca automática já usou. */
export function lineSearchQuery(line, terms = []) {
  const skip = new Set((terms || []).map((t) => String(t).toLowerCase()));
  const toks = String(line || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !/^\d+x\d+$/.test(t) && !NOISE.has(t) && !skip.has(t));
  return (toks.length ? toks.slice(0, 2) : [...skip].slice(0, 1)).join(" ");
}
