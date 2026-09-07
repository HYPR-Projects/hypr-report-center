// src/v2/admin/lib/pmpFreshness.js
//
// Régua do painel "Sync das fontes" do /admin/pmp — a parte PURA, sem React.
// Vivia dentro de PmpFreshnessIndicator.jsx, sem teste; saiu de lá em 07/09
// porque a régua ganhou uma terceira dimensão (a HORA em que a fonte fecha
// D-1) e três ajustes seguidos em duas semanas sem cobertura é como o falso
// alarme da manhã passou batido. Agora cada estado tem um teste com a hora
// congelada (`now` é parâmetro).
//
// DUAS perguntas independentes por fonte:
//   1. O JOB rodou?    → ledger pmp_sync_runs (lastRunAt/lastRunStatus/lastError)
//   2. O DADO chegou?  → apiLastDay/lagDays do ledger, com latestDeliveryDay
//                        das lines como fallback
//
// Régua do JOB (hora-local America/Sao_Paulo), aplicada por fonte:
//   • Último run com status de erro                  → vermelho (mostra o erro)
//   • Último run 'skipped' (sem credencial)          → vermelho (não rodou)
//   • Run bem-sucedido com data BR == hoje           → verde (ok)
//   • Antes do cutoff 05h e sem run de hoje          → cinza (aguardando)
//   • Após cutoff, último run OK = ontem             → amarelo (warn)
//   • Após cutoff, último run OK ≥ 2 dias atrás      → vermelho (error)
//
// Régua do DADO (só quando `expectsDelivery`), aplicada sobre o mesmo dot:
//   • dado até D-1                                   → não mexe (em dia)
//   • dado em D-2 antes da hora em que a fonte fecha → cinza (aguardando a fonte)
//   • dado em D-2 depois dessa hora                  → amarelo
//   • dado em D-3 ou mais velho                      → vermelho
//
// Sobre a hora em que a fonte fecha: medido no ledger (`d1_close_hours` do
// ?action=pmp_sync_status), 24/08–06/09/2026, a API da PubMatic libera o dia
// anterior entre 08h e 10h BRT, todo dia. Antes disso, "dado até anteontem"
// é o horário da fonte, não atraso — e era pintado de amarelo justamente na
// hora em que o hub é aberto de manhã ("a PubMatic não atualizou de novo",
// três dias seguidos, com 61 execuções do cron, 0 erros e auditoria limpa).

export const TZ_BR = "America/Sao_Paulo";
export const CUTOFF_HOUR_BR = 5;

// Atraso de DADO, em dias atrás de D-1, a partir do qual o dot muda. 1 dia =
// amarelo porque foi exatamente em D-2 que a base da PubMatic ficou parada por
// semanas sem ninguém ver.
export const DATA_LAG_WARN_DAYS = 1;

// Hora (BRT) até a qual é NORMAL a fonte ainda não ter fechado D-1. Só a
// PubMatic tem medida; fonte sem entrada aqui não ganha tolerância. Se a
// PubMatic mudar de horário, `d1_close_hours` mostra e o número se ajusta aqui.
export const SOURCE_CLOSE_HOUR_BRT = { pubmatic: 11 };
export const SOURCE_CLOSE_WINDOW_LABEL = { pubmatic: "entre 08h e 10h" };

export function brDateString(iso, now) {
  const d = iso ? new Date(iso) : (now || new Date());
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ_BR, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

export function brHour(date) {
  const d = date ? new Date(date) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_BR, hour: "2-digit", hour12: false,
  }).formatToParts(d);
  // "24" aparece em alguns runtimes pra meia-noite com hour12:false.
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
}

export function fmtBrDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ_BR, day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(d);
}

export function fmtBrDate(iso) {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[3]}/${m[2]}` : String(iso);
}

// "24/08 14h" — dia e hora BRT, que é a granularidade em que se enxerga se as
// sondagens horárias dispararam.
export function fmtBrDayHour(iso) {
  if (!iso) return "—";
  const p = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ_BR, day: "2-digit", month: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}/${g("month")} ${g("hour")}h`;
}

export function daysBetweenBr(fromIso, toDate) {
  const a = new Date(`${brDateString(fromIso)}T00:00:00Z`);
  const b = new Date(`${brDateString(null, toDate)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// Dia BR de hoje como "YYYY-MM-DD", pra comparar com as datas DATE que o
// backend manda (api_last_day, last_delivery_day) sem passar por Date/UTC —
// que é onde essa comparação erra por um dia.
export function brToday(now) {
  return brDateString(null, now);
}

export function addDaysIso(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Distância em dias entre duas datas "YYYY-MM-DD" (b − a).
export function daysBetweenIso(a, b) {
  return Math.round(
    (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

// ATRASO DE DADO. Quantos dias o dado mais recente está atrás de D-1 (o dia que
// a fonte já deveria ter fechado). Retorna null quando não há como afirmar.
//
// `apiLastDay` (do ledger) é a medida boa: é o último dia em que a API TINHA
// dado, medido no próprio sync. `latestDeliveryDay` (das lines) é o fallback
// pra quando o backend ainda não reporta frescor — pior, porque não distingue
// "a fonte não fechou o dia" de "os deals pararam de entregar".
//
// Por isso só roda com `expectsDelivery`: sem a garantia de que existe deal que
// DEVERIA estar entregando, este número mede fim de campanha, não atraso — e
// era justamente esse falso alarme que o ledger tinha acabado de matar.
export function deriveDataLag(src, now = new Date()) {
  if (!src.expectsDelivery) return null;

  // Caminho bom: frescor medido pelo próprio sync, contra a resposta da API.
  if (src.lagDays != null && src.apiLastDay) {
    return { days: Math.max(0, src.lagDays), day: src.apiLastDay, measured: true };
  }
  // O ledger reportou frescor e não achou NENHUM dia com dado na janela toda.
  // Não é atraso — é conta sem entrega nenhuma acontecendo. Nada a afirmar.
  if (src.hasFreshness) return null;

  // Backend sem frescor no ledger: cai no last_delivery_day das lines. Pior
  // sinal (não separa "fonte atrasou" de "os deals pararam"), mas melhor que
  // não ter nenhum.
  if (!src.latestDeliveryDay) return null;
  const expected = addDaysIso(brToday(now), -1);   // D-1
  return {
    days: Math.max(0, daysBetweenIso(src.latestDeliveryDay, expected)),
    day: src.latestDeliveryDay,
    measured: false,
  };
}

// `src` = { key, lastRunAt, lastRunStatus, lastOkAt, lastSyncedAt, apiLastDay,
//           lagDays, hasFreshness, latestDeliveryDay, expectsDelivery }.
// Devolve { tone, summary, waitingSourceClose? }.
// A falha do último run domina qualquer régua de data: um sync que rodou hoje
// e ESTOUROU não é "base atualizada hoje".
export function deriveStatus(src, now = new Date()) {
  const { lastRunAt, lastRunStatus, lastOkAt } = src;

  if (lastRunStatus === "error") {
    const behind = lastOkAt ? daysBetweenBr(lastOkAt, now) : null;
    return {
      tone: "error",
      summary: behind == null
        ? "Sync falhando — nunca completou"
        : `Sync falhando há ${behind} ${behind === 1 ? "dia" : "dias"}`,
    };
  }

  // 'skipped' = o sync nem foi tentado (sem credencial no ambiente). Antes isso
  // não gerava row nenhuma e a fonte simplesmente não tinha status.
  if (lastRunStatus === "skipped") {
    return { tone: "error", summary: "Sync não executado — credencial ausente" };
  }

  // Sem ledger: fallback pro sinal antigo (synced_at das linhas de entrega).
  const ref = lastOkAt || lastRunAt || src.lastSyncedAt;
  if (!ref) return { tone: "neutral", summary: "Sem dados de sync" };

  const daysBehind = daysBetweenBr(ref, now);
  if (daysBehind > 0) {
    if (brHour(now) < CUTOFF_HOUR_BR) {
      return { tone: "neutral", summary: "Aguardando sync matinal" };
    }
    if (daysBehind === 1) {
      return { tone: "warn", summary: "Último sync foi ontem — cron pode ter falhado" };
    }
    return { tone: "error", summary: `Sem sync há ${daysBehind} dias` };
  }

  // O job está em dia. Falta a outra metade: o DADO chegou?
  // Este é o estado que passou semanas invisível — "Sync rodou hoje" em verde
  // com a base 2 dias atrás. Um job saudável não é evidência de base fresca.
  const lag = deriveDataLag(src, now);
  if (lag && lag.days >= DATA_LAG_WARN_DAYS) {
    const d = fmtBrDate(lag.day);
    // 1 dia atrás ANTES da hora em que a fonte costuma fechar D-1 é o estado
    // normal da manhã, não um alerta. As sondagens de hora em hora pegam o dia
    // assim que a fonte liberar (ver SOURCE_CLOSE_HOUR_BRT). Só vale com o
    // atraso MEDIDO contra a API — o fallback das lines não sabe se a fonte
    // fechou ou se o deal parou.
    const closeHour = SOURCE_CLOSE_HOUR_BRT[src.key];
    if (lag.measured && lag.days === DATA_LAG_WARN_DAYS && closeHour != null
        && brHour(now) < closeHour) {
      return {
        tone: "neutral",
        summary: `Sync ok · aguardando a fonte fechar ontem (costuma liberar ${SOURCE_CLOSE_WINDOW_LABEL[src.key]})`,
        waitingSourceClose: true,
      };
    }
    // Quando o atraso foi MEDIDO contra a resposta da API, o texto diz de
    // quem é o atraso. "O dado para em X" lia como "a base não atualizou" —
    // e em 03/09 a base estava idêntica à API (auditoria limpa): era a
    // PubMatic que ainda não tinha reportado 01–02/09.
    const who = lag.measured ? "a API da PubMatic só tem dado até" : "o dado para em";
    const tail = lag.days === DATA_LAG_WARN_DAYS ? "1 dia atrás" : `${lag.days} dias atrás`;
    return {
      tone: lag.days === DATA_LAG_WARN_DAYS ? "warn" : "error",
      summary: `Sync ok, mas ${who} ${d} (${tail})`,
    };
  }
  // "dado em dia" só quando o atraso foi MEDIDO e deu zero. Sem medida — fonte
  // que não reporta frescor (Xandr), ou ledger ainda sem as colunas — o painel
  // afirma só o que sabe: que o job rodou.
  return lag
    ? { tone: "ok", summary: "Sync rodou hoje · dado em dia" }
    : { tone: "ok", summary: "Sync rodou hoje" };
}

// Prioridade pro dot agregado do gatilho: qualquer fonte em alerta ganha do
// resto; "aguardando" (neutral) ainda vem antes de "ok" pra não esconder uma
// fonte que não sincronizou.
export const TONE_PRIORITY = ["error", "warn", "neutral", "ok"];

export function worstTone(tones) {
  for (const t of TONE_PRIORITY) if (tones.includes(t)) return t;
  return "neutral";
}
