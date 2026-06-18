"""
Normalização e unificação de audiências (Portal do Cliente · aba Analytics).

Por que existe
--------------
A audiência de uma campanha é o penúltimo segmento do `line_name`
(convenção HYPR: `campanha_O2O_Supermercados_DISPLAY` → "Supermercados"),
exatamente como `extractAudience` no front (src/shared/aggregations.js).

O problema: o mesmo público é cadastrado mês a mês com pequenas variações
("Supermercado", "supermercados", "SUPERMERCADO", "Supermercádo") e às vezes
com sinônimos ("mercado", "atacadão"). Sem unificar, a quebra por audiência
do portal vira uma lista gigante de quase-duplicatas.

Estratégia (Fase 1 — determinística, sem IA)
---------------------------------------------
1. `normalize_key`: caixa baixa, remove acento, colapsa separador/espaço,
   tira pontuação → chave de comparação estável.
2. Singularização PT simples (plural → singular): "supermercados" →
   "supermercado". Resolve o caso mais comum (plural/caixa/acento) de graça.
3. Seed de grupos canônicos (`SEED_GROUPS`): mapa enxuto e EXTENSÍVEL de
   sinônimos comuns de varejo/segmento ("mercado"/"atacadão"/"hipermercado"
   → "Supermercados"). É o que cobre o exemplo clássico do João de forma
   100% previsível. A Fase 2 (Claude) generaliza isso sem lista manual.
4. Merge fuzzy (Levenshtein) entre o que sobrou, p/ typos e quase-iguais.
5. Nome canônico de exibição = representante de maior peso (impressões),
   "Title Case" com stopwords PT em minúscula — a não ser que um seed
   defina o display.

Tudo aqui é função pura (mesmo input → mesmo output), testável sem BigQuery.
A Fase 2 vai plugar uma camada de IA + override do admin ANTES do retorno,
sem reescrever esta base (a heurística vira fallback gracioso).
"""

import re
import unicodedata

# Stopwords PT que ficam minúsculas no display ("Casa de Carnes").
_PT_STOPWORDS = {"de", "da", "do", "das", "dos", "e", "a", "o", "as", "os", "em", "para", "por"}

# ─────────────────────────────────────────────────────────────────────────────
# Seed de grupos canônicos. Mapa { display_canônico : [palavras-chave norm] }.
# As palavras-chave são comparadas contra a chave normalizada+singularizada da
# audiência (match por token inteiro OU substring com fronteira de palavra).
# Mantido enxuto de propósito — é uma rede de segurança p/ sinônimos comuns,
# não uma taxonomia completa. Adicione conforme aparecer no uso real.
# ─────────────────────────────────────────────────────────────────────────────
SEED_GROUPS = {
    "Supermercados": [
        "supermercado", "hipermercado", "minimercado", "mercadinho", "mercado",
        "atacado", "atacadao", "atacarejo", "varejo alimentar",
    ],
    "Farmácias": ["farmacia", "drogaria", "drogosaria"],
    "Restaurantes": ["restaurante", "lanchonete", "fast food", "food service"],
    "Postos de Combustível": ["posto", "combustivel", "gasolina"],
    "Shopping Centers": ["shopping", "shopping center"],
    "Lojas de Conveniência": ["conveniencia"],
    "Pet Shops": ["pet shop", "petshop", "pet"],
}


def strip_accents(s):
    """Remove diacríticos (NFKD): 'Supermercádo' → 'Supermercado'."""
    nfkd = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def normalize_key(label):
    """Chave de comparação: minúscula, sem acento, sem pontuação, espaço único."""
    s = strip_accents(str(label or "")).lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _singularize_token(tok):
    """Singularização PT pragmática (cobre os plurais regulares comuns).

    Regras na ordem (primeira que casa vence). Conservadora — só mexe em
    palavras com >=4 letras p/ não destruir tokens curtos ('ses', 'as')."""
    if len(tok) < 4:
        return tok
    # leões → leão, mãos → mão, pães → pão (ões/ães/ãos → ão)
    if tok.endswith("oes") or tok.endswith("aes"):
        return tok[:-3] + "ao"
    if tok.endswith("aos"):
        return tok[:-3] + "ao"
    # animais → animal, hotéis → hotel (ais/eis/ois/uis → al/el/ol/ul)
    if re.search(r"(a|e|o|u)is$", tok):
        return tok[:-2] + "l"
    # rapazes → rapaz, luzes → luz (es após r/z/s)
    if tok.endswith("es") and len(tok) > 4 and tok[-3] in "rzs":
        return tok[:-2]
    # supermercados → supermercado, lojas → loja (plural regular em s)
    if tok.endswith("s") and not tok.endswith("ss"):
        return tok[:-1]
    return tok


def singularize_key(key):
    """Aplica singularização token a token sobre uma chave normalizada."""
    return " ".join(_singularize_token(t) for t in key.split(" ") if t)


def _levenshtein(a, b):
    """Distância de edição (DP O(len(a)*len(b))). Sem dependência externa."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _similar(a, b, threshold=0.86):
    """True se a/b são quase-iguais (ratio de similaridade >= threshold).
    Usado p/ colar typos ('supermecado' ~ 'supermercado')."""
    if not a or not b:
        return False
    dist = _levenshtein(a, b)
    ratio = 1 - dist / max(len(a), len(b))
    return ratio >= threshold


def _seed_canonical(sing_key):
    """Display canônico do seed p/ uma chave singularizada, ou None.
    Match por token inteiro (prioridade) ou substring (fallback)."""
    tokens = set(sing_key.split(" "))
    # 1) token inteiro bate uma keyword (singularizada) → mais confiável
    for display, keywords in SEED_GROUPS.items():
        for kw in keywords:
            kw_sing = singularize_key(normalize_key(kw))
            if kw_sing in tokens or kw_sing == sing_key:
                return display
    # 2) substring (ex.: 'supermercado' contém keyword 'mercado')
    for display, keywords in SEED_GROUPS.items():
        for kw in keywords:
            kw_sing = singularize_key(normalize_key(kw))
            if len(kw_sing) >= 4 and kw_sing in sing_key:
                return display
    return None


def prettify(label):
    """Nome de exibição: Title Case com stopwords PT minúsculas.
    Preserva tokens já tudo-maiúsculo (siglas: 'CRM', 'B2B')."""
    raw = re.sub(r"\s+", " ", str(label or "").strip())
    if not raw:
        return ""
    out = []
    for i, tok in enumerate(raw.split(" ")):
        low = strip_accents(tok).lower()
        if tok.isupper() and len(tok) <= 4:
            out.append(tok)  # sigla
        elif i > 0 and low in _PT_STOPWORDS:
            out.append(low)
        else:
            out.append(tok[:1].upper() + tok[1:].lower())
    return " ".join(out)


def extract_audience(line_name):
    """Porte Python de extractAudience (src/shared/aggregations.js): penúltimo
    segmento '_-separado' do line_name. 'camp_O2O_Supermercados_DISPLAY' →
    'Supermercados'. Retorna '' quando não há padrão reconhecível."""
    parts = str(line_name or "").split("_")
    return parts[-2] if len(parts) >= 2 else ""


# Tokens ESTRUTURAIS que não são audiência — vazam pra cá quando o line_name é
# curto e o penúltimo segmento cai numa frente/mídia/feature em vez do público
# (ex.: "camp_O2O_DISPLAY" → penúltimo "O2O"). Nunca são públicos reais.
_NON_AUDIENCE = {
    "o2o", "ooh", "groundflow", "rmnf", "rmnd", "display", "video",
    "pdooh", "dooh", "pos venda", "pos", "control", "controle", "exposto",
}


def _is_ignorable(label):
    """Audiências que não entram na quebra (survey, vazias, N/A, estruturais)."""
    if not label:
        return True
    k = normalize_key(label)
    return k in ("", "na", "n a") or "survey" in k or k in _NON_AUDIENCE


def group_audiences(weights):
    """Unifica audiências cruas em grupos canônicos (Fase 1 determinística).

    Args:
        weights: dict {raw_label: peso} — o peso (ex.: impressões visíveis)
                 decide o representante de cada cluster. Pode ser {label: 1}
                 se não houver peso.

    Returns:
        {
          "mapping": {raw_label: display_canônico},   # todo raw → seu grupo
          "groups":  {display_canônico: [raw_label,...]},  # p/ transparência
        }
    """
    labels = [l for l in (weights or {}) if not _is_ignorable(l)]
    if not labels:
        return {"mapping": {}, "groups": {}}

    # union-find simples
    parent = {l: l for l in labels}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    info = {}
    for l in labels:
        nk = normalize_key(l)
        sk = singularize_key(nk)
        info[l] = {"norm": nk, "sing": sk, "seed": _seed_canonical(sk)}

    # 1) une por chave singularizada idêntica (plural/acento/caixa)
    by_sing = {}
    for l in labels:
        by_sing.setdefault(info[l]["sing"], []).append(l)
    for group in by_sing.values():
        for other in group[1:]:
            union(group[0], other)

    # 2) une tudo que caiu no mesmo seed canônico
    by_seed = {}
    for l in labels:
        seed = info[l]["seed"]
        if seed:
            by_seed.setdefault(seed, []).append(l)
    for group in by_seed.values():
        for other in group[1:]:
            union(group[0], other)

    # 3) merge fuzzy entre representantes singularizados distintos (typos)
    reps = list({find(l): l for l in labels}.values())
    for i in range(len(reps)):
        for j in range(i + 1, len(reps)):
            a, b = reps[i], reps[j]
            if find(a) == find(b):
                continue
            # não cola se ambos têm seeds diferentes (intenção explícita)
            sa, sb = info[a]["seed"], info[b]["seed"]
            if sa and sb and sa != sb:
                continue
            if _similar(info[a]["sing"], info[b]["sing"]):
                union(a, b)

    # monta clusters e escolhe display
    clusters = {}
    for l in labels:
        clusters.setdefault(find(l), []).append(l)

    mapping, groups = {}, {}
    for members in clusters.values():
        # seed do cluster (se algum membro tiver) tem prioridade no display
        seed = next((info[m]["seed"] for m in members if info[m]["seed"]), None)
        if seed:
            display = seed
        else:
            rep = max(members, key=lambda m: (weights.get(m, 0), len(m)))
            display = prettify(rep)
        for m in members:
            mapping[m] = display
        groups.setdefault(display, []).extend(members)

    return {"mapping": mapping, "groups": groups}


def apply_overrides(mapping, overrides):
    """Aplica overrides do admin SOBRE um mapeamento {rótulo_cru: display},
    com precedência FINAL (vence heurística e IA). Fase 2.

    Args:
        mapping:   {rótulo_cru: display_canônico}.
        overrides: {de: para} de texto livre. `de` casa (por normalize_key)
                   tanto contra o rótulo cru quanto contra o display atual —
                   então o admin pode forçar "Mercado → Supermercados" (cru)
                   ou "Supermercados SP → Supermercados" (display).

    Returns:
        Novo {rótulo_cru: display} com os overrides aplicados.
    """
    if not overrides:
        return dict(mapping or {})
    ov = {normalize_key(k): v for k, v in overrides.items() if k and v}
    out = {}
    for raw, display in (mapping or {}).items():
        target = ov.get(normalize_key(raw)) or ov.get(normalize_key(display))
        out[raw] = target if target else display
    return out
