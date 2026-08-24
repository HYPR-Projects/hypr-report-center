// src/shared/surveySources.js
//
// Reconciliação e agregação de MÚLTIPLAS FONTES dentro de um mesmo lado
// (Controle ou Exposto) de uma pergunta.
//
// Contexto
// --------
// Até aqui cada lado tinha exatamente UMA fonte: um form do Typeform, ou
// as contagens de um XLSX do VideoAsk. Com a pesquisa nativa do Max
// Attention (etapa de survey do Tap to Choose) a mesma pergunta passa a
// ser coletada em mais de uma base ao mesmo tempo — mesmo título, mesmas
// opções de resposta — e o cliente quer UM número só, somado.
//
// Somar é trivial; o difícil é decidir O QUE soma com o quê. As bases
// escrevem o mesmo rótulo de formas ligeiramente diferentes:
//
//     Typeform        Max Attention     VideoAsk
//     "Sim"           "sim"             "Sim "
//     "Não"           "Nao"             "b) Não"
//     "Talvez"        "Talvez 🤔"       "Talvez"
//
// Aqui isso vira um pipeline explícito de 3 camadas, do mais seguro ao
// menos seguro, e NADA é fundido em silêncio quando a confiança cai:
//
//   1. canônico    — mesma string depois de normalizar (acento, caixa,
//                    pontuação, emoji, enumerador "a)" / "1."). Funde
//                    sem ruído: é o mesmo rótulo escrito diferente.
//   2. fuzzy       — Levenshtein/token-set acima do limiar, com o melhor
//                    candidato folgado em relação ao segundo. Funde, mas
//                    REGISTRA em `reconciliation.fuzzy` pra UI mostrar.
//   3. órfão       — não casou (ou casou de forma ambígua). NÃO funde:
//                    vira bucket próprio e entra em `reconciliation.orphans`
//                    / `.ambiguous` como aviso visível.
//
// E acima disso um veredito estrutural: se a maior parte do volume das
// fontes adicionais caiu em órfão, `status = "mismatch"` — sinal de que
// as bases não são a mesma pergunta e somá-las seria mentira. O chamador
// decide (a UI avisa em vez de exibir um total inventado).
//
// Este módulo é agnóstico de fonte de propósito: recebe partes já no
// formato `{source, counts, total}` (ou `{source, rows, total}` no caso
// matrix) e não sabe se vieram de API, XLSX ou BigQuery.

// Fontes conhecidas. `maxattention` = etapa de pesquisa do Tap to Choose
// (Max Attention), coletada via mídia da própria HYPR.
export const SOURCE_KINDS = ["typeform", "videoask", "maxattention"];

export const SOURCE_LABELS = {
  typeform: "Standard Survey",
  videoask: "Video Survey",
  maxattention: "Max Attention",
};

export const SOURCE_TINTS = {
  typeform:     { fg: "#3397B9", bg: "#3397B918", bd: "#3397B940" },
  videoask:     { fg: "#8E44AD", bg: "#8E44AD18", bd: "#8E44AD40" },
  maxattention: { fg: "#E08A1E", bg: "#E08A1E18", bd: "#E08A1E40" },
};

export const isSourceKind = (s) => SOURCE_KINDS.includes(s);

// Limiar de similaridade pra fusão fuzzy. 0.86 aceita "talvez"/"talvez!"
// e erros de digitação de 1 char em rótulos médios, e recusa pares
// semanticamente distintos como "nenhuma"/"nenhuma das opções" (~0.4) —
// esses caem em órfão e aparecem como aviso, que é o comportamento certo:
// quem decide fundir significado é o humano, não o Levenshtein.
export const FUZZY_THRESHOLD = 0.86;

// Folga mínima entre o melhor e o segundo melhor candidato. Sem isso, um
// rótulo "Marca A" no meio de "Marca B"/"Marca C" cairia no primeiro que
// aparecesse — com a folga, vira "ambíguo" e não funde.
const AMBIGUITY_MARGIN = 0.05;

// Rótulos curtos são frágeis pra fuzzy (em "sim"/"nim" a distância 1 já dá
// 0.67, mas em "ok"/"no" ela dá 0.5 com significados opostos). Abaixo
// disso, só casamento canônico.
const MIN_FUZZY_LEN = 4;

// Variantes ortográficas conhecidas do vocabulário de survey em PT-BR que
// o fuzzy NÃO pega por serem frases diferentes com o mesmo sentido. Tabela
// deliberadamente curta e explícita: cada entrada é uma decisão editorial,
// não uma heurística. Chave e valor já em forma canônica.
export const LABEL_SYNONYMS = {
  "nenhuma": "nenhuma das opcoes",
  "nenhum": "nenhuma das opcoes",
  "nenhuma delas": "nenhuma das opcoes",
  "nenhum deles": "nenhuma das opcoes",
  "nenhuma das alternativas": "nenhuma das opcoes",
  "nenhuma das anteriores": "nenhuma das opcoes",
  "n/a": "nao se aplica",
  "nao aplica": "nao se aplica",
  "nao respondeu": "sem resposta",
  "em branco": "sem resposta",
  "prefiro nao responder": "prefiro nao dizer",
};

// Enumerador de alternativa no começo do rótulo: "a) ", "1. ", "2 - ".
// Exige pontuação depois do índice pra não comer o começo de rótulos que
// legitimamente abrem com número ("3 ou mais vezes").
const ENUM_PREFIX_RE = /^\s*[a-z0-9]{1,2}\s*[)\].:\-–]\s+/;

// Emoji / dingbats / variation selectors — vêm de rótulos escritos na
// plataforma ("Talvez 🤔") e não carregam informação de agrupamento.
// Variation selectors saem numa passada separada: dentro da mesma classe
// eles contariam como caractere combinado (no-misleading-character-class).
const VARIATION_RE = /[\u{FE00}-\u{FE0F}]/gu;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * Forma canônica de um rótulo de resposta. Duas strings com a mesma forma
 * canônica são o MESMO rótulo escrito diferente — fusão segura.
 */
export function canonicalLabel(raw) {
  let s = String(raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(VARIATION_RE, "")
    .replace(EMOJI_RE, " ")
    .toLowerCase();

  // Enumerador só sai se sobrar conteúdo não-numérico — protege faixas
  // tipo "9 - 10" (NPS), onde tirar o prefixo mudaria o sentido.
  const stripped = s.replace(ENUM_PREFIX_RE, "");
  if (stripped !== s && /[a-z]/.test(stripped)) s = stripped;

  s = s
    .replace(/[.,;:!?"'`´“”’()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return LABEL_SYNONYMS[s] || s;
}

// Levenshtein iterativo com duas linhas. Rótulos de survey são curtos —
// custo irrelevante.
export function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  let prev = new Array(bl + 1);
  let cur = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[bl];
}

// Jaccard sobre conjuntos de palavras — cobre diferença de ordem
// ("lembro sim" × "sim lembro") que o Levenshtein pune demais.
function tokenSetSimilarity(a, b) {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

/** Similaridade 0..1 entre dois rótulos JÁ canonizados. */
export function similarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 0;
  const charSim = 1 - levenshtein(a, b) / maxLen;
  // O token-set entra levemente descontado: ele é mais permissivo, então
  // não deve sozinho empurrar um par marginal por cima do limiar.
  return Math.max(charSim, tokenSetSimilarity(a, b) * 0.98);
}

// Tolerância de edições absoluta, além da razão. Um typo de 1 char em
// "talvez" dá razão 0.857 — abaixo do limiar, mas é obviamente o mesmo
// rótulo. Espelha a tolerância já usada na detecção de controle/exposto
// do modal: 1 edit em rótulos médios, 2 em rótulos longos.
function editTolerance(len) {
  if (len < MIN_FUZZY_LEN) return 0;
  return len >= 9 ? 2 : 1;
}

function acceptable(a, b, ratio) {
  if (ratio >= FUZZY_THRESHOLD) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < MIN_FUZZY_LEN) return false;
  return levenshtein(a, b) <= editTolerance(maxLen);
}

// Procura o melhor bucket pra um rótulo canônico, ignorando buckets já
// reivindicados pela fonte atual (`claimed`) — duas opções da MESMA base
// são opções distintas por construção e não podem colapsar uma na outra.
// Devolve { match: "exact"|"fuzzy"|"ambiguous"|"none", key, score, runnerUp }.
function findBucket(canon, buckets, claimed) {
  if (buckets.has(canon) && !claimed.has(canon)) {
    return { match: "exact", key: canon, score: 1 };
  }
  if (canon.length < MIN_FUZZY_LEN) return { match: "none" };

  let bestKey = null;
  let best = 0;
  let second = 0;
  let secondKey = null;
  for (const key of buckets.keys()) {
    if (claimed.has(key) || key.length < MIN_FUZZY_LEN) continue;
    const s = similarity(canon, key);
    if (s > best) { second = best; secondKey = bestKey; best = s; bestKey = key; }
    else if (s > second) { second = s; secondKey = key; }
  }
  if (!bestKey || !acceptable(canon, bestKey, best)) return { match: "none" };
  // O 2º só desqualifica o 1º se ele TAMBÉM seria aceito — senão não há
  // dúvida real, só um vizinho distante.
  if (
    secondKey &&
    acceptable(canon, secondKey, second) &&
    best - second < AMBIGUITY_MARGIN
  ) {
    return { match: "ambiguous", key: bestKey, score: best, runnerUp: second };
  }
  return { match: "fuzzy", key: bestKey, score: best };
}

// Escolhe o rótulo de exibição do bucket entre as variantes vistas.
// Critério: a variante que representa mais respostas; empate desempata
// pela mais longa (costuma ser a mais bem escrita, com acento) e depois
// alfabeticamente pra ser determinístico.
function pickDisplay(variants) {
  let best = null;
  for (const v of variants.values()) {
    if (
      !best ||
      v.weight > best.weight ||
      (v.weight === best.weight && v.label.length > best.label.length) ||
      (v.weight === best.weight && v.label.length === best.label.length && v.label < best.label)
    ) {
      best = v;
    }
  }
  return best ? best.label : "";
}

function emptyReconciliation() {
  return {
    status: "single",
    fuzzy: [],
    orphans: [],
    ambiguous: [],
    shared: [],
    coverage: 1,
  };
}

// Núcleo do alinhamento. Recebe [{source, counts}] e devolve buckets
// ordenados pela primeira aparição, com a trilha de decisões.
//
// Duas passadas por fonte, de propósito:
//   (a) agrega a fonte nela mesma, só por forma canônica. Dentro da mesma
//       base, dois rótulos diferentes são opções diferentes — aproximar
//       aqui fundiria "Marca AA" com "Marca AC".
//   (b) casa o resultado contra os buckets das fontes anteriores, aí sim
//       com aproximação, e sem deixar duas opções da mesma base caírem
//       no mesmo bucket.
function alignCountsParts(parts) {
  // key canônica -> { display, variants: Map<label,{label,weight}>,
  //                   canons: Set, counts, bySource, order }
  const buckets = new Map();
  const rec = emptyReconciliation();
  let order = 0;

  // Volume das fontes NÃO-primárias e quanto dele encontrou par. É essa
  // razão que diz se as bases realmente falam da mesma pergunta.
  let secondaryVolume = 0;
  let secondaryMatched = 0;

  parts.forEach((part, partIdx) => {
    const source = part.source || "typeform";

    // (a) agregação interna da fonte, por forma canônica
    const local = new Map(); // canon -> Map<labelCru, n>
    for (const [rawLabel, rawCount] of Object.entries(part.counts || {})) {
      const n = Number(rawCount);
      if (!Number.isFinite(n) || n < 0) continue;
      const label = String(rawLabel).trim();
      if (!label) continue;
      const canon = canonicalLabel(label);
      if (!canon) continue;
      if (!local.has(canon)) local.set(canon, new Map());
      const variants = local.get(canon);
      variants.set(label, (variants.get(label) || 0) + n);
    }

    // (b) cruzamento com o que já existe
    const claimed = new Set();
    for (const [canon, variants] of local) {
      let n = 0;
      for (const v of variants.values()) n += v;
      const primaryLabel = [...variants.entries()].sort((a, b) => b[1] - a[1])[0][0];

      if (partIdx > 0) secondaryVolume += n;

      const hit = findBucket(canon, buckets, claimed);
      let key;

      if (hit.match === "exact" || hit.match === "fuzzy") {
        key = hit.key;
        if (partIdx > 0) secondaryMatched += n;
        if (hit.match === "fuzzy") {
          rec.fuzzy.push({
            source,
            from: primaryLabel,
            into: buckets.get(key).display,
            score: Number(hit.score.toFixed(3)),
            count: n,
          });
        }
      } else {
        // Ambíguo e órfão têm o mesmo efeito prático — bucket próprio, sem
        // fusão — mas motivos diferentes, e a UI diz qual foi.
        key = buckets.has(canon) ? `${canon}#${partIdx}` : canon;
        if (hit.match === "ambiguous") {
          rec.ambiguous.push({
            source,
            label: primaryLabel,
            candidate: buckets.get(hit.key)?.display || hit.key,
            score: Number(hit.score.toFixed(3)),
            runnerUp: Number((hit.runnerUp ?? 0).toFixed(3)),
            count: n,
          });
        } else if (partIdx > 0) {
          rec.orphans.push({ source, label: primaryLabel, count: n });
        }
      }

      claimed.add(key);
      if (!buckets.has(key)) {
        buckets.set(key, {
          display: primaryLabel,
          variants: new Map(),
          canons: new Set(),
          counts: {},
          bySource: {},
          order: order++,
        });
      }
      const b = buckets.get(key);
      b.canons.add(canon);
      for (const [label, weight] of variants) {
        const variant = b.variants.get(label) || { label, weight: 0 };
        variant.weight += weight;
        b.variants.set(label, variant);
        b.counts[label] = (b.counts[label] || 0) + weight;
      }
      b.bySource[source] = (b.bySource[source] || 0) + n;
      b.display = pickDisplay(b.variants);
    }
  });

  rec.coverage = secondaryVolume > 0 ? secondaryMatched / secondaryVolume : 1;

  for (const b of buckets.values()) {
    const srcs = Object.keys(b.bySource);
    if (srcs.length > 1) {
      rec.shared.push({
        label: b.display,
        sources: srcs,
        bySource: { ...b.bySource },
      });
    }
  }

  if (parts.length < 2) rec.status = "single";
  else if (rec.coverage < 0.5) rec.status = "mismatch";
  else if (rec.orphans.length || rec.ambiguous.length) rec.status = "partial";
  else rec.status = "ok";

  return { buckets, rec };
}

// Normaliza a lista de partes: descarta vazias e devolve [] se não sobrar
// nada utilizável.
function usableParts(parts) {
  return (parts || []).filter((p) => p && (p.counts || p.rows));
}

function baseOf(part, sum) {
  return {
    source: part.source || "typeform",
    label: part.label || SOURCE_LABELS[part.source] || "",
    total: Number.isFinite(Number(part.total)) ? Number(part.total) : sum,
    sum,
    firstAt: part.firstAt || null,
    lastAt: part.lastAt || null,
  };
}

/**
 * Agrega N fontes de tipo `choice` num único conjunto de contagens.
 *
 * @param {Array<{source,counts,total?,label?,firstAt?,lastAt?}>} parts
 * @returns {{type:"choice", counts, total, bases, sources, reconciliation}|null}
 */
export function poolChoiceParts(parts) {
  const list = usableParts(parts).filter((p) => p.counts);
  if (!list.length) return null;

  const { buckets, rec } = alignCountsParts(list);

  const ordered = [...buckets.values()].sort((a, b) => a.order - b.order);
  const counts = {};
  for (const b of ordered) {
    let n = 0;
    for (const v of Object.values(b.counts)) n += v;
    counts[b.display] = (counts[b.display] || 0) + n;
  }

  const bases = list.map((p) => {
    let sum = 0;
    for (const v of Object.values(p.counts || {})) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) sum += n;
    }
    return baseOf(p, sum);
  });

  // `total` = soma dos totais declarados por fonte. No Typeform o total é
  // "respostas completas" e pode passar da soma das contagens (pergunta
  // pulada); manter o declarado preserva a semântica que o report já usa.
  const total = bases.reduce((acc, b) => acc + (b.total || 0), 0);

  return {
    type: "choice",
    counts,
    total,
    bases,
    sources: bases.map((b) => b.source),
    reconciliation: rec,
  };
}

/**
 * Agrega N fontes de tipo `matrix`. Alinha primeiro os rótulos de LINHA
 * (marcas) entre as bases e, dentro de cada linha, os rótulos de nota —
 * o mesmo pipeline de 3 camadas, aplicado nos dois eixos.
 */
export function poolMatrixParts(parts) {
  const list = usableParts(parts).filter((p) => p.rows);
  if (!list.length) return null;

  // Eixo 1: linhas. Reusa o alinhador tratando "linha → total" como counts.
  const rowParts = list.map((p) => ({
    source: p.source,
    counts: Object.fromEntries(
      Object.entries(p.rows || {}).map(([row, data]) => [row, Number(data?.total) || 0]),
    ),
  }));
  const { buckets: rowBuckets, rec } = alignCountsParts(rowParts);

  // Mapa rótulo-cru -> display do bucket, pra reagrupar as contagens.
  const rowDisplayFor = new Map();
  for (const b of rowBuckets.values()) {
    for (const canon of b.canons) rowDisplayFor.set(canon, b.display);
  }

  // Eixo 2: por linha agregada, junta as partes de nota e alinha de novo.
  const perRowParts = new Map();
  for (const p of list) {
    for (const [rawRow, data] of Object.entries(p.rows || {})) {
      const display = rowDisplayFor.get(canonicalLabel(rawRow)) || String(rawRow).trim();
      if (!perRowParts.has(display)) perRowParts.set(display, []);
      perRowParts.get(display).push({
        source: p.source,
        counts: data?.counts || {},
        total: Number(data?.total) || 0,
      });
    }
  }

  const rows = {};
  const ordered = [...rowBuckets.values()].sort((a, b) => a.order - b.order);
  for (const b of ordered) {
    const pooled = poolChoiceParts(perRowParts.get(b.display) || []);
    if (!pooled) continue;
    rows[b.display] = { counts: pooled.counts, total: pooled.total };
    // Nuance de nota dentro da linha também vira aviso do bloco.
    rec.fuzzy.push(...pooled.reconciliation.fuzzy.map((f) => ({ ...f, row: b.display })));
    rec.orphans.push(...pooled.reconciliation.orphans.map((o) => ({ ...o, row: b.display })));
    rec.ambiguous.push(...pooled.reconciliation.ambiguous.map((a) => ({ ...a, row: b.display })));
  }

  const bases = list.map((p) => {
    let sum = 0;
    for (const data of Object.values(p.rows || {})) sum += Number(data?.total) || 0;
    return baseOf(p, sum);
  });

  return {
    type: "matrix",
    rows,
    total: bases.reduce((acc, b) => acc + (b.total || 0), 0),
    bases,
    sources: bases.map((b) => b.source),
    reconciliation: rec,
  };
}

/**
 * Dispatch por tipo. Partes matrix e choice não se misturam — se vierem
 * as duas, vence matrix (é o formato mais rico) e as partes choice são
 * descartadas com aviso, em vez de virarem soma sem semântica.
 */
export function poolSideParts(parts) {
  const list = usableParts(parts);
  if (!list.length) return null;
  if (list.length === 1) {
    const only = list[0];
    const pooled = only.rows ? poolMatrixParts(list) : poolChoiceParts(list);
    return pooled;
  }

  const matrixParts = list.filter((p) => p.rows);
  const choiceParts = list.filter((p) => !p.rows);

  if (matrixParts.length && choiceParts.length) {
    const pooled = poolMatrixParts(matrixParts);
    if (pooled) {
      pooled.reconciliation.status = "partial";
      pooled.reconciliation.dropped = choiceParts.map((p) => ({
        source: p.source,
        reason: "formato incompatível (choice × matrix)",
      }));
    }
    return pooled;
  }

  return matrixParts.length ? poolMatrixParts(matrixParts) : poolChoiceParts(choiceParts);
}

/**
 * Resumo curto em PT-BR do que a reconciliação fez — pra badge/tooltip.
 * Devolve "" quando não há nada que o usuário precise saber.
 */
export function reconciliationSummary(rec) {
  if (!rec || rec.status === "single") return "";
  const bits = [];
  if (rec.shared?.length) bits.push(`${rec.shared.length} resposta(s) somada(s) entre bases`);
  if (rec.fuzzy?.length) bits.push(`${rec.fuzzy.length} rótulo(s) casado(s) por aproximação`);
  if (rec.ambiguous?.length) bits.push(`${rec.ambiguous.length} ambíguo(s), mantido(s) separado(s)`);
  if (rec.orphans?.length) bits.push(`${rec.orphans.length} sem par, mantido(s) separado(s)`);
  if (rec.status === "mismatch") {
    bits.unshift("bases divergentes — confira se são a mesma pergunta");
  }
  return bits.join(" · ");
}
