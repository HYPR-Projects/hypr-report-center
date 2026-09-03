// src/v2/admin/lib/pmpTokens.js
//
// N checklists do Hypr Command por line (deal de pagamento).
//
// Modelo (espelha backend/pmp_lines.py + pmp_lines_enriched.sql):
//   • `short_token`        → token PRINCIPAL (é o `code` da line no Xandr)
//   • `extra_short_tokens` → demais tokens vinculados (só BQ)
//   • `linked_tokens`      → a lista já normalizada que a enriched devolve
//                            (principal primeiro). Preferida quando existe.
//   • `linked_checklists`  → breakdown por token: { short_token, found,
//                            client, campaign_name, agency, investment, ... }
//   • `command_pi_total`   → soma dos investments (antes do override)
//   • `pi_brl`             → override manual > soma dos checklists
//
// Tudo aqui é puro e tolerante a backend antigo (sem os campos novos): cai
// pra `short_token` sozinho, e a UI continua igual à de antes.

/** Formato aceito (mesmo regex do backend): alfanumérico, 2–40 chars, com
 *  `-`/`_` no meio. Já normalizado (UPPER/TRIM). */
export const TOKEN_RE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

export function normalizeToken(raw) {
  return String(raw ?? "").trim().toUpperCase();
}

export function isValidToken(raw) {
  return TOKEN_RE.test(normalizeToken(raw));
}

/** Dedupe preservando a ordem, ignorando vazios. Não valida formato. */
export function dedupeTokens(tokens) {
  const out = [];
  const seen = new Set();
  for (const raw of tokens || []) {
    const t = normalizeToken(raw);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Lista de tokens da line, principal primeiro. */
export function lineTokens(line) {
  if (!line) return [];
  if (Array.isArray(line.linked_tokens) && line.linked_tokens.length > 0) {
    return dedupeTokens(line.linked_tokens);
  }
  return dedupeTokens([line.short_token, ...(line.extra_short_tokens || [])]);
}

export function primaryToken(line) {
  return lineTokens(line)[0] || null;
}

/** Quantos tokens além do principal. É o "+N" dos chips da lista. */
export function extraTokenCount(line) {
  return Math.max(0, lineTokens(line).length - 1);
}

/** "NO2015 + NO2016" — pra export e title/tooltip. */
export function tokensLabel(line, sep = " + ") {
  return lineTokens(line).join(sep);
}

const toNum = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Breakdown por checklist, sempre alinhado com `lineTokens(line)`.
 *  Com backend novo vem de `linked_checklists`; com antigo, sintetiza uma
 *  entrada por token — a do principal herda os campos planos da line
 *  (campaign_name/agency/pi_brl) quando ela tem checklist casado. */
export function lineChecklists(line) {
  const tokens = lineTokens(line);
  if (tokens.length === 0) return [];
  const byToken = new Map();
  for (const c of (Array.isArray(line?.linked_checklists) ? line.linked_checklists : [])) {
    const t = normalizeToken(c?.short_token);
    if (t && !byToken.has(t)) byToken.set(t, c);
  }
  return tokens.map((t, i) => {
    const c = byToken.get(t);
    if (c) {
      return {
        short_token: t,
        found: c.found != null ? !!c.found : (c.checklist_id != null || c.investment != null),
        client: c.client ?? null,
        campaign_name: c.campaign_name ?? null,
        agency: c.agency ?? null,
        investment: toNum(c.investment),
        start_date: c.start_date ?? null,
        end_date: c.end_date ?? null,
        cp_name: c.cp_name ?? null,
        cs_name: c.cs_name ?? null,
        primary: i === 0,
      };
    }
    // Backend antigo: só o principal tem informação (nos campos planos).
    const legacyPrimary = i === 0 && line?.checklist_id != null;
    return {
      short_token: t,
      found: legacyPrimary ? true : null,   // null = desconhecido
      client: legacyPrimary ? (line.customer ?? null) : null,
      campaign_name: legacyPrimary ? (line.campaign_name ?? null) : null,
      agency: legacyPrimary ? (line.agency ?? null) : null,
      investment: legacyPrimary && !line.pi_overridden ? toNum(line.pi_brl) : null,
      start_date: legacyPrimary ? (line.command_start_date ?? null) : null,
      end_date: legacyPrimary ? (line.command_end_date ?? null) : null,
      cp_name: legacyPrimary ? (line.cp_name ?? null) : null,
      cs_name: legacyPrimary ? (line.cs_name ?? null) : null,
      primary: i === 0,
    };
  });
}

/** Soma dos investments dos checklists (o que o Command dá, antes do
 *  override). null quando nenhum checklist casou. */
export function commandPiTotal(line) {
  if (!line) return null;
  const direct = toNum(line.command_pi_total);
  if (direct != null) return direct;
  const found = lineChecklists(line).filter((c) => c.investment != null);
  if (found.length > 0) return found.reduce((acc, c) => acc + c.investment, 0);
  // Backend antigo sem override: pi_brl É o valor do Command.
  if (!line.pi_overridden) return toNum(line.pi_brl);
  return null;
}

/** Quantos tokens casaram com checklist de verdade (found=true). */
export function matchedChecklistCount(line) {
  const n = toNum(line?.linked_checklist_count);
  if (n != null) return n;
  return lineChecklists(line).filter((c) => c.found === true).length;
}

/** Tokens não encontrados no espelho do Command (typo / checklist novo). */
export function missingTokens(line) {
  return lineChecklists(line).filter((c) => c.found === false).map((c) => c.short_token);
}

// ── Operações sobre a lista (imutáveis) ─────────────────────────────────────
export function withToken(tokens, raw) {
  const t = normalizeToken(raw);
  if (!t) return dedupeTokens(tokens);
  return dedupeTokens([...(tokens || []), t]);
}

export function withoutToken(tokens, raw) {
  const t = normalizeToken(raw);
  return dedupeTokens(tokens).filter((x) => x !== t);
}

/** Torna `raw` o principal (vai pro `code` da line no Xandr). */
export function asPrimary(tokens, raw) {
  const t = normalizeToken(raw);
  const rest = dedupeTokens(tokens).filter((x) => x !== t);
  return t ? [t, ...rest] : rest;
}

/** Duas listas de tokens são a mesma vinculação? (ordem importa: o 1º é o
 *  principal.) */
export function sameTokens(a, b) {
  const x = dedupeTokens(a), y = dedupeTokens(b);
  return x.length === y.length && x.every((t, i) => t === y[i]);
}
