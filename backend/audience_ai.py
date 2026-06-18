"""
Camada de IA (Claude) da unificação de audiências (Portal · Analytics) — Fase 2.

A heurística (audience_normalize.group_audiences) já colapsa plural/acento/caixa
+ um seed de sinônimos comuns. Esta camada generaliza o seed: pega os rótulos
canônicos que a heurística produziu e pede pro Claude fundir SINÔNIMOS de verdade
("Mercado" + "Atacadão" + "Hipermercado" → "Supermercados") e dar um nome canônico
limpo, sem precisar manter uma lista manual.

Por que é seguro/barato:
  - Roda só sobre os REPRESENTANTES dos clusters heurísticos (lista pequena, ~dezenas).
  - Cacheado pelo CONJUNTO de rótulos (mesma entrada → mesma saída, sem nova chamada):
    determinístico na prática e custo ~zero (roda ~1× por mudança de rótulos).
  - Degrada gracioso: sem ANTHROPIC_API_KEY, sem a lib, ou qualquer erro → devolve
    mapeamento identidade (a heurística fica de pé sozinha).
  - Modelo barato/rápido por padrão (claude-haiku-4-5, $1/$5 por MTok); a tarefa é
    clusterizar strings curtas. Override por env AUDIENCE_AI_MODEL.
"""

import json
import logging
import os

logger = logging.getLogger(__name__)

_DEFAULT_MODEL = "claude-haiku-4-5"
_ai_cache = {}  # chave estável (rótulos ordenados) -> {display: display_final}

_SYSTEM = (
    "Você unifica rótulos de AUDIÊNCIAS de campanhas de mídia (pt-BR). Recebe uma "
    "lista de rótulos já parcialmente normalizados e agrupa os que representam O MESMO "
    "público — incluindo SINÔNIMOS e termos do mesmo segmento de varejo "
    "(ex.: 'Mercado', 'Atacadão', 'Hipermercado', 'Mercadinho' → 'Supermercados'). "
    "Regras: (1) só funda rótulos que são claramente o mesmo conceito; na dúvida, "
    "deixe separado. (2) Escolha um nome canônico curto, em português, Title Case, "
    "preferindo o plural natural do segmento ('Supermercados', 'Farmácias'). "
    "(3) TODO rótulo de entrada deve aparecer em exatamente um grupo. "
    "(4) Não invente audiências que não estão na entrada."
)

_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "groups": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "canonical": {"type": "string"},
                    "members": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["canonical", "members"],
            },
        }
    },
    "required": ["groups"],
}


def refine_groups_with_ai(displays):
    """Recebe os rótulos canônicos da heurística (lista de strings) e devolve
    {display: display_final} fundindo sinônimos. Identidade no fallback.

    Mapeia só o que a IA mexeu — rótulos não citados na resposta caem na
    identidade, então o resultado nunca "perde" uma audiência.
    """
    uniq = sorted({(d or "").strip() for d in (displays or []) if (d or "").strip()})
    if len(uniq) < 2:
        return {d: d for d in uniq}  # nada pra fundir

    cache_key = "|".join(uniq)
    if cache_key in _ai_cache:
        return dict(_ai_cache[cache_key])

    identity = {d: d for d in uniq}
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return identity

    try:
        from anthropic import Anthropic
    except Exception:
        return identity

    try:
        client = Anthropic()
        model = os.environ.get("AUDIENCE_AI_MODEL") or _DEFAULT_MODEL
        user = (
            "Agrupe estes rótulos de audiência, fundindo sinônimos/segmentos iguais:\n"
            + "\n".join(f"- {d}" for d in uniq)
        )
        resp = client.messages.create(
            model=model,
            max_tokens=1500,
            system=_SYSTEM,
            output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
        data = json.loads(text)
    except Exception as e:
        logger.warning(f"[WARN audience_ai] fallback p/ heurística: {e}")
        return identity

    # Constrói display->canonical só pros membros que a IA reconheceu (case-insensitive).
    by_lower = {d.lower(): d for d in uniq}
    mapping = dict(identity)
    for g in (data.get("groups") or []):
        canonical = (g.get("canonical") or "").strip()
        members = g.get("members") or []
        if not canonical or not isinstance(members, list):
            continue
        for m in members:
            orig = by_lower.get((m or "").strip().lower())
            if orig:
                mapping[orig] = canonical

    _ai_cache[cache_key] = dict(mapping)
    return mapping
