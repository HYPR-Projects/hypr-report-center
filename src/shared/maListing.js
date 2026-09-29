// Textos e decisões pro estado da LISTA de criativos do Max Attention no
// modal de survey — fora do componente pra serem testáveis em Node puro.
//
// A lista é AMPLA, como a do Typeform: todas as peças com resposta de survey
// recente, com as da campanha (token no nome) no topo e marcadas. O que
// isto resolve é o caso em que NENHUMA peça foi marcada como da campanha:
// pode ser dimensão que não carregou, nome fora da convenção ou peça sem
// resposta — três causas com três responsáveis, e o admin via só "Nenhum
// criativo encontrado" pra todas (caso real: PPV8JF, set/2026). O backend
// devolve `diagnostics` com a razão; aqui ela vira uma frase que diz o que
// aconteceu e o que fazer.
//
// Contrato de entrada (`listMaxAttentionCreatives`):
//   { creatives, scope: "campaign"|"all", short_token, days, recent_days,
//     includes_recent, campaign_count,
//     diagnostics: null | { reason, dim_rows, dim_synced_at, dim_matched, dim_names },
//     window_covered: bool,   // a tabela copiada cobre a janela listada?
//     sync: null | { synced_through, covered_from, complete, error } }
//
// `window_covered === false` muda o sentido do vazio: não é "ninguém
// respondeu", é "a cópia lake → Report Center ainda não chegou lá". Dizer
// "confira a coleta" nesse caso mandou o admin investigar a coisa errada
// (PPV8JF, 29/09/2026, com a peça recebendo respostas).

export const MA_EMPTY_REASONS = Object.freeze({
  DIM_EMPTY: "dim_empty",        // dimensão de criativos nunca carregou (cron da plataforma)
  NO_DIM_MATCH: "no_dim_match",  // dimensão ok, mas nenhuma peça leva o token no nome
  NO_RESPONSES: "no_responses",  // peças da campanha existem, ninguém respondeu na janela
  SYNC_PENDING: "sync_pending",  // a cópia do lake ainda não cobre a janela: o vazio é da cópia
});

/**
 * Aviso de cópia em andamento. null quando a janela está coberta (ou backend
 * antigo, sem o campo). Vale pra lista vazia E pra lista parcial.
 */
export function describeMaSyncPending(payload) {
  if (payload?.window_covered !== false) return null;
  const sync = payload?.sync || {};
  const from = formatSyncedAt(sync.covered_from);
  const to = formatSyncedAt(sync.synced_through);
  const cobertura = from && to ? ` Já copiado: de ${from} a ${to}.` : "";
  const erro = sync.error ? ` Última falha da cópia: ${sync.error}` : "";
  return {
    reason: MA_EMPTY_REASONS.SYNC_PENDING,
    title: "Ainda copiando as respostas do Max Attention pro Report Center.",
    detail:
      "As respostas existem no lake; a cópia anda do mais recente pro mais antigo e " +
      "a lista pode estar incompleta até ela terminar." + cobertura + erro,
    hint: "O modal tenta de novo sozinho. Não é problema de coleta.",
  };
}

export function formatSyncedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(d).replace(",", "");
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

// A razão do diagnóstico em frases (título / detalhe / o que fazer).
function explainDiagnostics(diag, { token, days }) {
  const tokenTxt = token ? `«${token}»` : "desta campanha";
  const janela = days ? `nos últimos ${days} dias` : "na janela de listagem";

  if (diag?.reason === MA_EMPTY_REASONS.DIM_EMPTY) {
    return {
      reason: diag.reason,
      title: "A lista de criativos da plataforma ainda não carregou.",
      detail:
        `Sem ela não há como saber quais peças são ${tokenTxt}. Quem a popula é o cron ` +
        "rollup-creative-events do o2o-platform, cerca de uma vez por hora.",
      hint: "Tente 'Atualizar lista' em alguns minutos — ou busque a peça pelo nome e vincule manualmente.",
    };
  }

  if (diag?.reason === MA_EMPTY_REASONS.NO_DIM_MATCH) {
    const n = Number(diag.dim_rows);
    const synced = formatSyncedAt(diag.dim_synced_at);
    const estado =
      Number.isFinite(n) && n > 0
        ? `A plataforma conhece ${n.toLocaleString("pt-BR")} criativos` +
          (synced ? ` (última carga ${synced})` : "") +
          "; nenhum leva esse token nem é desse cliente."
        : "Nenhum criativo conhecido leva esse token nem é desse cliente.";
    return {
      reason: diag.reason,
      title: `Nenhuma peça ${tokenTxt} na plataforma.`,
      detail:
        `A campanha é reconhecida pelo token no nome da peça (ID-${token || "TOKEN"}_..._CONTROLE / _EXPOSTO) ` +
        "ou pelo cliente da campanha. " + estado +
        " Ou a peça está sob outro cliente, ou foi criada depois da última carga, ou ainda não foi criada.",
      hint:
        "Busque a peça pelo nome na lista abaixo e vincule manualmente — ou renomeie na plataforma " +
        "pra que o vínculo (e o 'Conectar automaticamente') volte a ser automático.",
    };
  }

  if (diag?.reason === MA_EMPTY_REASONS.SYNC_PENDING) {
    const n = Number(diag.dim_matched) || 0;
    return {
      reason: diag.reason,
      title: `${n} peça${n === 1 ? "" : "s"} ${tokenTxt} na plataforma; as respostas ainda estão sendo copiadas.`,
      detail: "A cópia do lake ainda não cobre a janela da campanha, então a falta de resposta aqui não diz nada sobre a coleta.",
      hint: "O modal tenta de novo sozinho em alguns segundos.",
    };
  }

  if (diag?.reason === MA_EMPTY_REASONS.NO_RESPONSES) {
    const n = Number(diag.dim_matched) || 0;
    const names = Array.isArray(diag.dim_names) ? diag.dim_names.filter(Boolean) : [];
    return {
      reason: diag.reason,
      title:
        `${n} peça${n === 1 ? "" : "s"} ${tokenTxt} na plataforma, ` +
        `mas nenhuma registrou resposta de survey ${janela}.`,
      detail: names.length
        ? `Peças encontradas: ${names.join(" · ")}.`
        : "A plataforma conhece as peças, mas o lake não tem survey_answer delas.",
      hint:
        "Confira se a peça é Tap to Choose com etapa de survey e se está veiculando. " +
        "Sem resposta, não há o que vincular ainda.",
    };
  }

  return {
    reason: diag?.reason || "unknown",
    title: `Nenhuma peça ${tokenTxt} com resposta de survey ${janela}.`,
    detail: "O backend não disse o motivo — pode estar numa versão anterior a este diagnóstico.",
    hint: "Busque a peça pelo nome na lista e vincule manualmente.",
  };
}

/**
 * Explica uma lista VAZIA (nenhuma peça, de campanha nenhuma). Devolve null
 * quando há qualquer criativo na lista.
 *
 *   { title, detail, hint, reason }
 */
export function describeMaEmptyList(payload, { shortToken = "" } = {}) {
  const creatives = payload?.creatives || [];
  if (creatives.length > 0) return null;

  // Antes de tudo: vazio de cópia incompleta não é vazio de coleta.
  const pending = describeMaSyncPending(payload);
  if (pending) return pending;

  const token = shortToken || payload?.short_token || "";
  const recentDays = Number(payload?.recent_days) || null;
  const days = Number(payload?.days) || null;
  const broad = payload?.includes_recent === true || (payload?.scope || (token ? "campaign" : "all")) === "all";

  if (broad) {
    const janela = recentDays ? `nos últimos ${recentDays} dias` : days ? `nos últimos ${days} dias` : "na janela de listagem";
    const camp = payload?.diagnostics ? explainDiagnostics(payload.diagnostics, { token, days }) : null;
    return {
      reason: "all_empty",
      title: `Nenhum criativo do Max Attention registrou resposta de survey ${janela}, em campanha nenhuma.`,
      detail:
        "Isso não depende da campanha: é a coleta. Ou nenhuma peça de Tap to Choose com " +
        "etapa de survey está veiculando, ou o evento survey_answer não está chegando ao lake." +
        (camp ? ` Sobre ${token ? `«${token}»` : "esta campanha"}: ${camp.title}` : ""),
      hint: "Confira a coleta na plataforma antes de mexer no report.",
    };
  }

  // Lista só da campanha: backend antigo, ou ramo amplo deixado de fora.
  const base = explainDiagnostics(payload?.diagnostics, { token, days });
  return { ...base, detail: base.detail + describeRecentSkipped(payload) };
}

/**
 * Aviso quando a lista TEM peças, mas nenhuma foi marcada como desta
 * campanha. Devolve null quando a lista está vazia (é caso do
 * `describeMaEmptyList`), quando não há diagnóstico, ou quando há peça da
 * campanha na lista.
 *
 *   { title, detail, hint, reason, shown }   shown = quantas peças estão na lista
 */
export function describeMaCampaignNote(payload, { shortToken = "" } = {}) {
  const creatives = payload?.creatives || [];
  if (creatives.length === 0) return null;
  const diag = payload?.diagnostics;
  if (!diag) return null;
  const campaignCount = Number(payload?.campaign_count);
  if (Number.isFinite(campaignCount) && campaignCount > 0) return null;
  if (creatives.some((c) => c?.match)) return null;
  const pending = describeMaSyncPending(payload);
  if (pending) return { ...pending, shown: creatives.length };

  const token = shortToken || payload?.short_token || "";
  const days = Number(payload?.days) || null;
  const recentDays = Number(payload?.recent_days) || null;
  const base = explainDiagnostics(diag, { token, days });
  const n = creatives.length;
  return {
    ...base,
    shown: n,
    detail:
      `${base.detail} A lista abaixo mostra ${n.toLocaleString("pt-BR")} peça${n === 1 ? "" : "s"} com resposta` +
      (recentDays ? ` nos últimos ${recentDays} dias` : "") +
      ", de todas as campanhas — confira o nome antes de vincular." +
      describeRecentSkipped(payload),
  };
}

/**
 * Frase extra quando o backend deixou o ramo AMPLO de fora (`recent_skipped`),
 * pra que "só tem peça da campanha na lista" não pareça bug. Vazia quando
 * o ramo veio normalmente.
 */
export function describeRecentSkipped(payload) {
  if (payload?.includes_recent !== false || !payload?.recent_skipped) return "";
  if (payload.recent_skipped === "bytes_limit") {
    return (
      " A busca ampla (todas as campanhas) ficou de fora desta vez: a query estourou o teto " +
      "de custo do BigQuery. A lista tem só as peças desta campanha."
    );
  }
  return " A busca ampla (todas as campanhas) ficou de fora desta vez; a lista tem só as peças desta campanha.";
}
