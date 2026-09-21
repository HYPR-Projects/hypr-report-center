// Textos e decisões pro estado da LISTA de criativos do Max Attention no
// modal de survey — fora do componente pra serem testáveis em Node puro.
//
// O problema que isto resolve: a listagem por campanha pode sair vazia por
// três motivos com três responsáveis diferentes, e o admin via só "Nenhum
// criativo encontrado" pra todos eles (caso real: PPV8JF, set/2026). O
// backend passou a devolver `diagnostics` junto com a lista; aqui a razão
// vira uma frase que diz o que aconteceu e o que fazer, e decide se vale
// oferecer a busca ampla ("todos os criativos recentes").
//
// Contrato de entrada (`listMaxAttentionCreatives`):
//   { creatives, scope: "campaign"|"all", short_token, days,
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

/**
 * Explica uma lista vazia. Devolve null quando a lista NÃO está vazia.
 *
 *   { title, detail, hint, canBrowseAll, reason }
 *
 * `canBrowseAll` diz se oferecer "buscar em todos os criativos recentes":
 * faz sentido quando a peça pode existir com outro nome (nome fora da
 * convenção, dimensão atrasada) e não faz quando já estamos olhando tudo.
 */
export function describeMaEmptyList(payload, { shortToken = "" } = {}) {
  const creatives = payload?.creatives || [];
  if (creatives.length > 0) return null;

  const scope = payload?.scope || (shortToken ? "campaign" : "all");
  const days = Number(payload?.days) || null;
  const janela = days ? `nos últimos ${days} dias` : "na janela de listagem";
  const token = shortToken || payload?.short_token || "";
  const diag = payload?.diagnostics || null;

  if (scope === "all") {
    return {
      reason: "all_empty",
      title: `Nenhum criativo do Max Attention registrou resposta de survey ${janela}.`,
      detail:
        "Isso não depende da campanha: é a coleta. Ou nenhuma peça de Tap to Choose com " +
        "etapa de survey está veiculando, ou o evento survey_answer não está chegando ao lake.",
      hint: "Confira a coleta na plataforma antes de mexer no report.",
      canBrowseAll: false,
    };
  }

  const tokenTxt = token ? `«${token}»` : "desta campanha";

  if (diag?.reason === MA_EMPTY_REASONS.DIM_EMPTY) {
    return {
      reason: diag.reason,
      title: "A lista de criativos da plataforma ainda não carregou.",
      detail:
        `Sem ela não há como saber quais peças são ${tokenTxt}. Quem a popula é o cron ` +
        "rollup-creative-events do o2o-platform, cerca de uma vez por hora.",
      hint: "Tente de novo em alguns minutos — ou busque em todos os criativos recentes e vincule pelo nome.",
      canBrowseAll: true,
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
      title: `Nenhum criativo com ${tokenTxt} no nome.`,
      detail:
        `A campanha é reconhecida pela convenção ID-${token || "TOKEN"}_..._CONTROLE / _EXPOSTO. ${estado} ` +
        "Ou o nome saiu da convenção, ou a peça foi criada depois da última carga.",
      hint: "Busque em todos os criativos recentes e vincule pelo nome — ou renomeie a peça na plataforma pra que o vínculo seja automático.",
      canBrowseAll: true,
    };
  }

  if (diag?.reason === MA_EMPTY_REASONS.NO_RESPONSES) {
    const n = Number(diag.dim_matched) || 0;
    const names = Array.isArray(diag.dim_names) ? diag.dim_names.filter(Boolean) : [];
    return {
      reason: diag.reason,
      title:
        `${n} criativo${n === 1 ? "" : "s"} ${tokenTxt} na plataforma, ` +
        `mas nenhum registrou resposta de survey ${janela}.`,
      detail: names.length
        ? `Peças encontradas: ${names.join(" · ")}.`
        : "A plataforma conhece as peças, mas o lake não tem survey_answer delas.",
      hint:
        "Confira se a peça é Tap to Choose com etapa de survey e se está veiculando. " +
        "Se a resposta está em outra peça, busque em todos os criativos recentes.",
      canBrowseAll: true,
    };
  }

  // Backend antigo (sem diagnostics) ou razão desconhecida: ainda assim não
  // deixamos o admin sem saída.
  return {
    reason: diag?.reason || "unknown",
    title: `Nenhum criativo ${tokenTxt} com resposta de survey ${janela}.`,
    detail: "O backend não disse o motivo — pode estar numa versão anterior a este diagnóstico.",
    hint: "Busque em todos os criativos recentes e vincule pelo nome.",
    canBrowseAll: true,
  };
}

/**
 * Aviso pra quando a lista veio da busca AMPLA (sem campanha): o admin está
 * vendo peças de outras campanhas e precisa conferir o nome antes de vincular.
 */
export function describeMaBrowseAll(payload, { shortToken = "" } = {}) {
  if ((payload?.scope || "campaign") !== "all") return null;
  const days = Number(payload?.days) || null;
  const n = (payload?.creatives || []).length;
  const janela = days ? `dos últimos ${days} dias` : "recentes";
  return {
    title: `Mostrando ${n.toLocaleString("pt-BR")} criativo${n === 1 ? "" : "s"} com resposta ${janela}` +
      (shortToken ? `, de todas as campanhas — não só de «${shortToken}».` : "."),
    hint: "Confira o nome antes de vincular: aqui a campanha não é filtrada.",
  };
}
