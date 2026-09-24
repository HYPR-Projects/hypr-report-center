"""
Casamento peça Max Attention ↔ criativo da DSP — funções PURAS.

Por que existe (o RC não confia só na nota da Platform)
-------------------------------------------------------
A busca da Platform descarta candidato sem motivo, e o motivo "nome parecido"
é Jaccard ≥ 0,6 sobre os tokens dos dois nomes. O nome da DSP carrega ruído
que a peça não tem — prefixo da casa, tamanho, cliente, campanha:

    DSP  : HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300x600
    peça : MobLand Carrossel

dá 0,2 e a peça some, mesmo sendo exatamente ela (caso Paramount/MobLand:
todos os formatos eram Max Attention e o modal dizia "nenhuma sugestão").

Aqui a comparação é outra:

1. Linha criativa, não nome cru: o tamanho sai (mesma regra do
   `getCreativeLineKey` do front), então os N tamanhos de um criativo viram
   UMA linha — e o vínculo pré-marca todos eles, não só o primeiro.
2. Tokens informativos: sem prefixo da casa, tamanho, número, sigla de 1–2
   letras e jargão genérico; sinônimos PT/EN ("carrossel" = "carousel").
3. Tokens de CAMPANHA (cliente, nome da campanha, o que aparece na maioria
   das linhas) identificam a campanha, não a peça. A peça casa com a linha
   pelo que sobra — "carousel", "reveal tiros" — e a campanha vira um motivo
   à parte ("nome da campanha").
4. Similaridade por sobreposição (|A∩B| / min), com tolerância a erro de
   digitação e a palavra colada ("tom hardy" × "TOMHARDY").

A decisão continua do admin: isto só ordena e explica sugestões.
"""

import re
import unicodedata

# Mesmo recorte de dimensão do front (aggregations.js: getCreativeLineKey).
_SIZE_RE = re.compile(r"(?<![\dx])\d{2,4}\s*[x×]\s*\d{2,4}(?![\dx])", re.I)
_SEP_RE = re.compile(r"[-_| ]{2,}")
_EDGE_RE = re.compile(r"^[-_| ]+|[-_| ]+$")

# Não distinguem peça nenhuma: prefixo da casa, mídia, DSP, versão, idioma.
STOPWORDS = frozenset("""
    hypr display video banner static estatico html html5 rich media midia
    dv360 xandr stackadapt yahoo adbolt dsp creative criativo criativos peca
    pecas final new novo nova versao version copy copia teste test ptbr
    mobile desktop tag tags formato format max attention the and com para
""".split())

# Grafias do mesmo formato/palavra (PT/EN, erro comum). Chave → canônico.
SYNONYMS = {
    "carrossel": "carousel", "carrosel": "carousel", "carousell": "carousel",
    "slider": "carousel", "revelar": "reveal", "revela": "reveal",
    "raspadinha": "scratch", "raspar": "scratch", "mapa": "map",
    "videos": "video", "jogo": "game", "quiz": "survey", "pesquisa": "survey",
}

# Similaridade mínima peça × linha para o motivo "nome".
NAME_THRESHOLD = 0.55
# Token presente em pelo menos esta fração das linhas vira "de campanha".
COMMON_LINE_SHARE = 0.5
MIN_LINES_FOR_COMMON = 3


def fold(s) -> str:
    """Sem acento, minúsculo."""
    s = unicodedata.normalize("NFKD", str(s or ""))
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def creative_line(name, size=None) -> str:
    """Linha criativa de um nome de criativo da DSP: sem o tamanho, em
    maiúsculas. Espelha `getCreativeLineKey` — o front agrupa igual."""
    raw = str(name or "").strip()
    if not raw:
        return ""
    out = raw
    if size:
        out = re.sub(r"(?<!\d)" + re.escape(str(size)) + r"(?!\d)", "", out, flags=re.I)
    out = _SIZE_RE.sub("", out)
    out = _EDGE_RE.sub("", _SEP_RE.sub("_", out))
    return (out or raw).upper()


def tokens(s) -> list:
    """Tokens informativos, na ordem, sem repetir."""
    out = []
    for t in re.split(r"[^a-z0-9]+", _SIZE_RE.sub(" ", fold(s))):
        if len(t) < 3 or t.isdigit() or t in STOPWORDS:
            continue
        # "v2", "br1", "s02": versão/sequência, não conteúdo.
        if re.fullmatch(r"[a-z]{1,2}\d{1,3}", t):
            continue
        t = SYNONYMS.get(t, t)
        if t not in out:
            out.append(t)
    return out


def _lev_le(a: str, b: str, k: int) -> bool:
    """Distância de edição ≤ k (banda curta, nomes curtos)."""
    if abs(len(a) - len(b)) > k:
        return False
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        if min(cur) > k:
            return False
        prev = cur
    return prev[-1] <= k


def token_hit(t: str, others) -> bool:
    """`t` aparece em `others`: igual, com erro de digitação, ou colado numa
    palavra maior ("hardy" em "tomhardy")."""
    for o in others:
        if t == o:
            return True
        if len(t) >= 5 and len(o) >= 5 and _lev_le(t, o, 1 if min(len(t), len(o)) < 8 else 2):
            return True
        if len(t) >= 4 and len(o) > len(t) and (o.startswith(t) or o.endswith(t)):
            return True
        if len(o) >= 4 and len(t) > len(o) and (t.startswith(o) or t.endswith(o)):
            return True
    return False


def _hits(a, b) -> int:
    return sum(1 for t in a if token_hit(t, b))


def strip_common(toks, common) -> list:
    """Tira os tokens de campanha, inclusive grafados diferente ("Mob Land"
    contra MOBLAND, "Paramont" contra PARAMOUNT)."""
    if not common:
        return list(toks)
    out = []
    for i, t in enumerate(toks):
        joined = {t + toks[i + 1]} if i + 1 < len(toks) else set()
        if i > 0:
            joined.add(toks[i - 1] + t)
        if token_hit(t, common) or joined & set(common):
            continue
        out.append(t)
    return out


def _merge_joined(a, b) -> list:
    """Funde pares vizinhos de `a` que, colados, são um token de `b`
    ("tom" + "hardy" → "tomhardy" quando a DSP escreve TOMHARDY)."""
    bs = set(b)
    out, i = [], 0
    while i < len(a):
        if i + 1 < len(a) and a[i] + a[i + 1] in bs:
            out.append(a[i] + a[i + 1])
            i += 2
        else:
            out.append(a[i])
            i += 1
    return out


def similarity(piece_tokens, line_tokens, common=frozenset(), strict=False) -> float:
    """Quanto a peça É esta linha, em [0, 1]. Compara só o que distingue a
    linha dentro da campanha (tokens de campanha fora); se a linha só tem
    tokens de campanha (campanha de linha única), compara tudo.

    `strict` (peça sem nada da campanha no nome): a sobreposição tem de
    valer nos DOIS sentidos — "Top Gun Carousel" do mesmo cliente não vira a
    linha CAROUSEL de MobLand só pela palavra do formato."""
    p = strip_common(piece_tokens, common)
    l_ = [t for t in line_tokens if t not in common]
    if not l_:
        p, l_ = list(piece_tokens), list(line_tokens)
    if not p or not l_:
        return 0.0
    p, l_ = _merge_joined(p, l_), _merge_joined(l_, p)
    h = min(_hits(p, l_), len(p), len(l_))
    if h == 0:
        return 0.0
    if strict and h / max(len(p), len(l_)) < 0.6:
        return 0.0
    overlap = h / min(len(p), len(l_))
    jac = h / (len(set(p) | set(l_)))
    return round(0.75 * overlap + 0.25 * jac, 3)


def dsp_lines(detail_rows, limit=80) -> list:
    """Linhas criativas da campanha a partir do `detail` do report:
    [{line, names, impressions}] por impressão desc. `names` são os nomes
    crus (um por tamanho) — é o que o vínculo guarda e o que a camada Mídia
    do front casa com o detail."""
    acc = {}
    for r in detail_rows or []:
        name = str((r or {}).get("creative_name") or "").strip()
        if not name:
            continue
        line = creative_line(name, r.get("creative_size"))
        e = acc.setdefault(line, {"line": line, "names": [], "impressions": 0.0})
        if name not in e["names"]:
            e["names"].append(name)
        try:
            e["impressions"] += float(r.get("impressions") or 0)
        except (TypeError, ValueError):
            pass
    out = sorted(acc.values(), key=lambda e: (-e["impressions"], e["line"]))[:limit]
    for e in out:
        e["names"] = sorted(e["names"])[:50]
        e["impressions"] = int(round(e["impressions"]))
    return out


def campaign_tokens(lines, client=None, campaign_name=None) -> dict:
    """Tokens que identificam a CAMPANHA (não a peça): do cliente, do nome
    da campanha e os que aparecem na maioria das linhas. `terms` são os que
    valem uma busca por texto na Platform (mais distintivos primeiro)."""
    client_t = set(tokens(client))
    camp_t = [t for t in tokens(campaign_name) if t not in client_t]
    freq = {}
    for e in lines or []:
        for t in set(tokens(e.get("line"))):
            freq[t] = freq.get(t, 0) + 1
    n = len(lines or [])
    frequent = []
    if n >= MIN_LINES_FOR_COMMON:
        frequent = [t for t, c in sorted(freq.items(), key=lambda kv: (-kv[1], kv[0])) if c / n >= COMMON_LINE_SHARE]
    common = set(client_t) | set(camp_t) | set(frequent)
    # Busca: nome da campanha e tokens frequentes primeiro (acham a peça
    # desta campanha), cliente por último (acha as do cliente todo).
    terms = []
    for t in camp_t + [t for t in frequent if t not in client_t] + sorted(client_t):
        if len(t) >= 4 and t not in terms:
            terms.append(t)
    return {"common": frozenset(common), "campaign": frozenset(set(camp_t) | (set(frequent) - client_t)),
            "client": frozenset(client_t), "terms": terms[:3]}


def client_key(name) -> str:
    return re.sub(r"[^a-z0-9]", "", fold(name))


def same_client(a, b) -> bool:
    """Mesmo anunciante: igual pela chave frouxa, ou um contém o outro
    quando o menor tem 4+ caracteres ("Paramount" ⊂ "Paramount+ Brasil")."""
    ka, kb = client_key(a), client_key(b)
    if not ka or not kb:
        return False
    if ka == kb:
        return True
    short, long_ = sorted((ka, kb), key=len)
    return len(short) >= 4 and short in long_


def query_matches(name, q) -> bool:
    """Busca digitada: todos os termos aparecem no nome (tolerando erro de
    digitação), ou o texto inteiro contido no nome."""
    if not q:
        return False
    if fold(q).strip() and fold(q).strip() in fold(name):
        return True
    qt = tokens(q) or [t for t in re.split(r"[^a-z0-9]+", fold(q)) if t]
    nt = tokens(name) or [t for t in re.split(r"[^a-z0-9]+", fold(name)) if t]
    return bool(qt) and all(token_hit(t, nt) for t in qt)


# Pesos da nota local (somam). Nome vale NAME × similaridade.
WEIGHTS = {"adbolt": 100, "token": 80, "name": 90, "campaign": 40, "client": 20, "query": 60}
REASON_ORDER = ("adbolt", "token", "name", "campaign", "client", "query")


def rank(candidates, *, lines, ctx, client=None, q=None) -> list:
    """Pontua os candidatos (dicts do `ma_report.search_creatives`, com os
    motivos que a Platform deu) contra as linhas da DSP.

    Cada linha vai para a(s) peça(s) de MAIOR similaridade: com "Reveal
    Tiros" e "Reveal Grafite" na Platform, cada linha REVEAL cai na sua; com
    uma peça "Reveal" só, as duas caem nela. Devolve os candidatos com
    `reasons`, `score`, `dsp_lines` (linhas casadas, melhor primeiro) e
    `dsp_creative_names` (nomes crus dessas linhas, pro vínculo)."""
    line_tok = [(e, tokens(e["line"])) for e in lines or []]
    common = ctx.get("common") or frozenset()
    camp = ctx.get("campaign") or frozenset()
    client_t = ctx.get("client") or frozenset()

    def campaign_hit(pt):
        return bool(camp) and any(token_hit(t, camp) for t in pt) or bool(
            set(a + b for a, b in zip(pt, pt[1:])) & set(camp))

    sims = []
    for c in candidates:
        pt = tokens(c.get("name"))
        strict = bool(camp) and not campaign_hit(pt)
        sims.append({e["line"]: similarity(pt, lt, common, strict) for e, lt in line_tok})

    by_line = {e["line"]: e for e, _ in line_tok}
    best_for_line = {}
    for s in sims:
        for line, v in s.items():
            if v >= NAME_THRESHOLD and v > best_for_line.get(line, 0):
                best_for_line[line] = v

    out = []
    for c, s in zip(candidates, sims):
        pt = tokens(c.get("name"))
        reasons = set(r for r in c.get("platform_reasons") or [] if r in ("adbolt", "token", "client"))
        matched = sorted(
            (line for line, v in s.items() if v >= NAME_THRESHOLD and v >= best_for_line.get(line, 1) - 1e-9),
            key=lambda line: -s[line],
        )
        # Fallback: a Platform casou pelo nome e nós não — respeita a dela.
        if not matched and c.get("platform_match_name"):
            pl = creative_line(c["platform_match_name"])
            if any(e["line"] == pl for e, _ in line_tok):
                matched = [pl]
        name_sim = max((s[line] for line in matched if line in s), default=None)
        if matched:
            reasons.add("name")
        if campaign_hit(pt):
            reasons.add("campaign")
        if client and (same_client(c.get("client_name"), client) or (client_t and any(token_hit(t, pt) for t in client_t))):
            reasons.add("client")
        if q and (c.get("user_query") or query_matches(c.get("name"), q)):
            reasons.add("query")
        if not reasons:
            continue
        score = sum(WEIGHTS[r] for r in reasons if r != "name") + (WEIGHTS["name"] * (name_sim or 0.6) if "name" in reasons else 0)
        names = []
        for line in matched:
            for n in by_line.get(line, {}).get("names", []):
                if n not in names:
                    names.append(n)
        out.append({
            **{k: v for k, v in c.items() if k not in ("platform_reasons", "platform_match_name", "user_query")},
            "reasons": [r for r in REASON_ORDER if r in reasons],
            "score": round(score, 2),
            "dsp_lines": matched[:10],
            "dsp_creative_names": names[:50],
            "match_name": matched[0] if matched else None,
            "match_similarity": name_sim,
        })
    # Nota desc; empate: editada mais recentemente primeiro (sort estável).
    out.sort(key=lambda it: str(it.get("updated_at") or ""), reverse=True)
    out.sort(key=lambda it: -it["score"])
    return out
