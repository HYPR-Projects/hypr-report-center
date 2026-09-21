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
//     diagnostics: null | { reason, dim_rows, dim_synced_at, dim_matched, dim_names } }

export const MA_EMPTY_REASONS = Object.freeze({
  DIM_EMPTY: "dim_empty",        // dimensão de criativos nunca carregou (cron da plataforma)
  NO_DIM_MATCH: "no_dim_match",  // dimensão ok, mas nenhuma peça leva o token no nome
  NO_RESPONSES: "no_responses",  // peças da campanha existem, ninguém respondeu na janela
});

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
          "; nenhum leva esse token."
        : "Nenhum criativo conhecido leva esse token.";
    return {
      reason: diag.reason,
      title: `Nenhuma peça com ${tokenTxt} no nome.`,
      detail:
        `A campanha é reconhecida pela convenção ID-${token || "TOKEN"}_..._CONTROLE / _EXPOSTO. ${estado} ` +
        "Ou o nome saiu da convenção, ou a peça foi criada depois da última carga, ou ainda não foi criada.",
      hint:
        "Busque a peça pelo nome na lista abaixo e vincule manualmente — ou renomeie na plataforma " +
        "pra que o vínculo (e o 'Conectar automaticamente') volte a ser automático.",
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

  // Backend antigo: lista era só da campanha.
  return explainDiagnostics(payload?.diagnostics, { token, days });
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
      ", de todas as campanhas — confira o nome antes de vincular.",
  };
}
