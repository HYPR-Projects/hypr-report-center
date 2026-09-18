// src/v2/admin/lib/dspFreshness.js
//
// Régua do indicador "Estado das bases" (rollup diário das DSPs) — a parte
// PURA, sem React. Saiu de DataFreshnessIndicator.jsx em 18/09/2026 pelo mesmo
// motivo que a régua do PMP saiu do PmpFreshnessIndicator em 07/09: três
// estados distintos sendo decididos dentro de um componente, sem um teste
// sequer, e um deles estava errado havia meses.
//
// O incidente que motivou: 18/09/2026, 09h08. A Amazon estava com dado até
// 13/09 (domingo) — 5 dias atrás, 4 runs seguidos sem entregar — e o cabeçalho
// do painel estava AMARELO. A linha da Amazon, essa sim, estava vermelha. Duas
// réguas discordando no mesmo popover: a linha media DIAS, o cabeçalho media
// QUANTIDADE DE FONTES (`blockers.length >= 2 ? error : warn`). Uma fonte só,
// parada há um mês, jamais passava de amarelo; duas fontes atrasadas um dia
// viravam vermelho. Aqui a severidade passa a escalar com DIAS, que é o que
// separa "o export atrasou" de "o connector morreu".
//
// TRÊS perguntas independentes, e é a combinação delas que dá o diagnóstico:
//   1. A DSP entregou?          → `sources` (aterrissagem raw/tratada por fonte)
//   2. A consolidação rodou?    → `unifiedMax` (MAX(date) global no unified)
//   3. A consolidação tem TUDO? → `unifiedBySource` (MAX(date) por fonte lá dentro)
//
// A 3ª é nova e é a que faltava. Em 14–17/09 o build das 06h rodou todo dia,
// o `unifiedMax` ficou em D-1 e a linha "Consolidado (reports)" ficou VERDE —
// enquanto a `unified` não tinha uma linha de Amazon desde 13/09. O painel
// dizia "reports atualizados" sobre uma base à qual faltava uma DSP inteira, e
// os reports de quem roda Amazon DSP saíram subnotificados por 4 dias sem um
// único aviso. Verde com fonte faltando dentro é pior que vermelho: é o alerta
// afirmando o contrário do que está acontecendo.
//
// O backend já calculava esse número (`query_data_freshness()` é um GROUP BY
// source) e jogava fora, colapsando tudo num `max()` antes de responder.

export const TZ_BR = "America/Sao_Paulo";

// Antes disso o rollup das 06h ainda pode estar rodando: julgar aqui geraria
// falso positivo todo dia de manhã.
export const CUTOFF_HOUR_BR = 7;

// D-1 é o esperado; > 1 dia atrás é atraso de verdade.
export const STALE_DAYS = 1;

// A partir daqui a fonte não está atrasada, está PARADA. Dois dias ainda cabe
// em export lento ou feriado; três é connector quebrado até prova em
// contrário, e é o ponto onde o alerta tem que doer. Vale inclusive antes do
// cutoff: "aguardando o rollup das 06h" explica um dia de atraso, nunca três.
export const SOURCE_DOWN_DAYS = 3;

// Labels humanizados pros valores brutos de `source` em BQ. Fonte nova aparece
// com o valor cru até entrar aqui, sem quebrar nada.
export const SOURCE_LABELS = {
  XANDR:      "Xandr",
  DV360:      "DV360",
  STACKADAPT: "StackAdapt",
  AMAZON:     "Amazon",
  YAHOO:      "Yahoo",
};

// Fontes com camada raw ESTÁVEL em `staging` — as únicas que o
// ?action=dsp_landing_audit consegue auditar honestamente. DV360 fica de fora:
// a raw dele é wildcard sobre tabelas efêmeras (o delete_dv360_staging_tables_job
// apaga às 22h), então "dia ausente" é estado normal à noite e a auditoria
// concluiria integração quebrada todo fim de expediente. Espelho de
// _LANDING_AUDIT_SOURCES em backend/main.py.
export const AUDITABLE_SOURCES = new Set(["AMAZON", "STACKADAPT", "YAHOO"]);

export function isAuditable(source) {
  return AUDITABLE_SOURCES.has(String(source || "").toUpperCase());
}

export function humanizeSource(s) {
  if (!s) return "?";
  return SOURCE_LABELS[String(s).toUpperCase()] || s;
}

// "2026-05-18" → "18/05". Aceita TIMESTAMP/DATE ISO; pega só DD/MM.
export function fmtBrDate(iso) {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[3]}/${m[2]}` : String(iso);
}

// Extrai YYYY-MM-DD do `now` UTC convertendo pro fuso BR. `Intl` em "en-CA"
// devolve ISO-compatível direto, evitando reordenação manual de partes.
export function brDateString(utcIso) {
  const d = utcIso ? new Date(utcIso) : new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ_BR, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

export function brHour(utcIso) {
  const d = utcIso ? new Date(utcIso) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_BR, hour: "2-digit", hour12: false,
  }).formatToParts(d);
  // "24" aparece em alguns runtimes pra meia-noite com hour12:false.
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
}

// Diff de dias entre hoje BR e a data ISO. > STALE_DAYS = atrasada.
export function daysBehindBr(maxDateIso, serverNowIso) {
  if (!maxDateIso) return null;
  const today = brDateString(serverNowIso);
  const a = new Date(`${String(maxDateIso).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${today}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// Tom de UMA fonte a partir dos dias de atraso. É a régua que as linhas do
// popover já usavam; agora o cabeçalho usa a MESMA, que é a única forma de os
// dois nunca mais discordarem.
export function toneForDays(days) {
  if (days == null) return "neutral";
  if (days <= STALE_DAYS) return "ok";
  if (days < SOURCE_DOWN_DAYS) return "warn";
  return "error";
}

export const TONE_PRIORITY = ["error", "warn", "neutral", "ok"];

export function worstTone(tones) {
  for (const t of TONE_PRIORITY) if (tones.includes(t)) return t;
  return "neutral";
}

// "Amazon há 5 dias" / "Amazon (5d), DV360 (2d)".
function describeBlockers(blockers) {
  if (blockers.length === 1) {
    const b = blockers[0];
    return `${humanizeSource(b.source)} sem entregar há ${b.days} dias`;
  }
  const parts = blockers.map((b) => `${humanizeSource(b.source)} (${b.days}d)`);
  return `${parts.join(", ")} sem entregar`;
}

/**
 * Frescor do CONSOLIDADO, cruzando o MAX global com o MAX por fonte lá dentro.
 *
 * `unifiedBySource` = [{source, max_date}] do GROUP BY source no unified.
 * `expected` = fontes que o painel acompanha (as mesmas linhas do popover) —
 * uma fonte parada há mais que a janela de 7d do backend SOME do GROUP BY, e
 * sumir tem que contar como faltando, não como "sem dado a afirmar".
 *
 * Devolve { tone, days, missing, label } onde `missing` são as fontes que o
 * consolidado não tem em D-1. Com `missing` não-vazio o consolidado é PARCIAL:
 * fresco na data e incompleto no conteúdo, que é exatamente o estado que
 * ninguém viu entre 14 e 17/09.
 */
export function deriveUnifiedStatus({ unifiedBySource, unifiedMax, expected = [], serverNow } = {}) {
  const days = daysBehindBr(unifiedMax, serverNow);
  const preCutoff = brHour(serverNow) < CUTOFF_HOUR_BR;

  const bySource = new Map(
    (Array.isArray(unifiedBySource) ? unifiedBySource : [])
      .map((r) => [String(r.source || "").toUpperCase(), r.max_date]),
  );

  // Só dá pra afirmar "falta fonte X" quando o backend manda o por-fonte.
  // Versão antiga do backend (sem `unified_by_source`) mantém o comportamento
  // anterior em vez de acusar todas as fontes de faltarem.
  const canCheckSources = bySource.size > 0;
  const missing = !canCheckSources ? [] : expected
    .map((s) => {
      const key = String(s.source || "").toUpperCase();
      const d = bySource.has(key) ? daysBehindBr(bySource.get(key), serverNow) : null;
      return { source: s.source, days: d, absent: !bySource.has(key) };
    })
    // Fonte ausente da janela de 7d, ou presente e atrasada.
    .filter((r) => r.absent || (r.days != null && r.days > STALE_DAYS));

  const tones = [
    preCutoff && days != null && days < SOURCE_DOWN_DAYS ? "neutral" : toneForDays(days),
    ...missing.map((m) => (m.absent ? "error" : toneForDays(m.days))),
  ];

  return {
    tone: worstTone(tones),
    days,
    missing,
    label: missing.length
      ? `parcial — sem ${missing.map((m) => humanizeSource(m.source)).join(", ")}`
      : null,
  };
}

/**
 * Estado geral das bases.
 *
 * `sources` = aterrissagem REAL por DSP (raw da staging com a tratada de piso),
 * que responde "a DSP entregou D-1?" sem depender do build das 06h.
 * `unifiedMax` / `unifiedBySource` = frescor do consolidado que os reports
 * servem, no total e por fonte.
 *
 * Cruzar os três é o que gateia o botão Reconstruir sem dar falsa esperança:
 *   - fonte parada na origem            → upstream; reconstruir NÃO resolve
 *   - fontes prontas, unified atrasado  → consolidação pendente; RESOLVE
 *   - fontes prontas, unified parcial   → a fonte chegou e não entrou; RESOLVE
 */
export function deriveStatus({ sources, unifiedMax, unifiedBySource, serverNow } = {}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return { tone: "neutral", summary: "Sem dados de frescor", blockers: [], rebuildHelps: false, unified: null };
  }

  const withDays = sources.map((s) => ({ ...s, days: daysBehindBr(s.max_date, serverNow) }));
  const blockers = withDays
    .filter((s) => s.days != null && s.days > STALE_DAYS)
    .sort((a, b) => b.days - a.days);

  const unified = deriveUnifiedStatus({ unifiedBySource, unifiedMax, expected: sources, serverNow });

  // Antes das 07h o rollup ainda pode estar rodando, então atraso de 1–2 dias
  // não se julga. Fonte PARADA (>= 3 dias) não tem hora: nenhum rollup das 06h
  // explica isso, e engolir o alerta até as 07h é justamente o que fazia o
  // problema aparecer só quando alguém abria o hub de manhã.
  const preCutoff = brHour(serverNow) < CUTOFF_HOUR_BR;
  const down = blockers.filter((b) => b.days >= SOURCE_DOWN_DAYS);
  if (preCutoff && down.length === 0) {
    return { tone: "neutral", summary: "Aguardando rollup 06h", blockers: [], rebuildHelps: false, unified };
  }

  if (blockers.length > 0) {
    const shown = preCutoff ? down : blockers;
    // Severidade pela PIOR fonte, não pela contagem. Duas fontes atrasadas
    // ainda escalam pra vermelho: uma é problema da DSP, duas é do pipeline.
    const tone = worstTone([
      ...shown.map((b) => toneForDays(b.days)),
      blockers.length >= 2 ? "error" : "ok",
      unified.tone === "error" ? "error" : "ok",
    ]);
    return {
      tone,
      summary: describeBlockers(shown),
      blockers: shown,
      rebuildHelps: false,   // reconstruir não materializa dado que a fonte não mandou
      unified,
    };
  }

  // Fontes todas em dia daqui pra baixo. Dois modos de falha DIFERENTES, e a
  // ordem importa: com o unified atrasado por inteiro, TODA fonte aparece como
  // faltando lá dentro — é o build que não rodou, não uma fonte derrubada.
  if (unified.days != null && unified.days > STALE_DAYS) {
    return {
      tone: unified.tone,
      summary: "Consolidação atrasada — fontes prontas",
      blockers: [],
      rebuildHelps: true,
      unified,
    };
  }

  if (unified.missing.length > 0) {
    // Consolidado fresco na data e sem a fonte dentro: o build RODOU e deixou
    // a DSP de fora. É o estado de 14–17/09, o que o painel jurava estar verde.
    const names = unified.missing.map((m) => humanizeSource(m.source)).join(", ");
    return {
      tone: unified.tone === "ok" ? "warn" : unified.tone,
      summary: `Consolidado sem ${names} — fonte entregou, build não pegou`,
      blockers: [],
      rebuildHelps: true,
      unified,
    };
  }

  return { tone: "ok", summary: "Bases atualizadas", blockers: [], rebuildHelps: false, unified };
}
