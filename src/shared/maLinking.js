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
 *   { line, names, impressions, linked: [peça], covered, suggested: [sugestão] }
 * `linked` = peças vinculadas que usam algum nome da linha; `covered` =
 * quantos nomes (tamanhos) da linha já têm peça; `suggested` = sugestões
 * ainda não vinculadas que casaram com a linha e trazem algum tamanho
 * descoberto, melhor primeiro. Na Platform é comum uma peça por tamanho,
 * então uma linha pode ter várias sugestões, cada uma com o seu nome.
 */
export function lineCoverage(lines, links, suggestions) {
  const linkedIds = new Set((links || []).map((l) => l.creative_id));
  const taken = takenNames(links);
  return (lines || []).map((e) => {
    const names = new Set((e.names || []).map(normName));
    const linked = (links || []).filter((l) => (l.dsp_creative_names || []).some((n) => names.has(normName(n))));
    const covered = [...names].filter((n) => taken.has(n)).length;
    const suggested = (suggestions || []).filter((s) => {
      if (linkedIds.has(String(s.creative_id).toLowerCase()) || !(s.dsp_lines || []).includes(e.line)) return false;
      const own = (s.dsp_creative_names || []).map(normName).filter((n) => names.has(n));
      return own.length === 0 ? covered === 0 : own.some((n) => !taken.has(n));
    });
    return { ...e, linked, covered, suggested };
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

/** Sugestões de uma linha que dá para vincular juntas: a melhor de cada
 *  tamanho descoberto, sem duas peças disputando o mesmo nome da DSP. */
export function rowPicks(row, used = new Set()) {
  const picks = [];
  const mine = new Set((row.names || []).map(normName));
  for (const s of row.suggested || []) {
    const own = (s.dsp_creative_names || []).map(normName).filter((n) => mine.has(n));
    if (own.some((n) => used.has(n))) continue;
    if (!own.length && picks.length) continue; // sem tamanho próprio: só se for a única
    own.forEach((n) => used.add(n));
    picks.push(s);
    if (!own.length) break;
  }
  return picks;
}

/** Tudo que dá para vincular de uma vez: as escolhas de cada linha com
 *  tamanho descoberto, mais o que casou pela tag da DSP (AdBolt). Token no
 *  nome sozinho fica de fora — pega a survey da campanha, que tem aba própria. */
export function strongSuggestions(coverage, suggestions) {
  const used = new Set();
  const picked = new Map();
  for (const row of coverage || []) {
    if (row.covered >= (row.names || []).length) continue;
    for (const s of rowPicks(row, used)) picked.set(String(s.creative_id).toLowerCase(), s);
  }
  for (const s of suggestions || []) {
    if ((s.reasons || []).includes("adbolt")) picked.set(String(s.creative_id).toLowerCase(), s);
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
