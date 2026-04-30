"""
backend/clients.py

Agregação por cliente, worklist e séries temporais para a view "Por
Cliente" do menu admin (CampaignMenu V2).

Decisões arquiteturais
──────────────────────────────────────────────────────────────────────
• A agregação principal (`aggregate_clients_from_campaigns`) opera em
  memória sobre o resultado de `query_campaigns_list()` — não roda
  query BigQuery extra. Isso reusa o cache do endpoint /list?list=true
  (TTL 60s) e mantém o custo BQ idêntico ao admin atual.

• A série temporal pra sparkline (`query_client_timeseries`) é a única
  query BQ adicional. Roda 1x por chamada de /list_clients e é cacheada
  separadamente com TTL 5min — sparkline é informação visual, não
  precisa de freshness segundo-a-segundo.

• Normalização de client_name é defensiva (LOWER + TRIM + slug-safe).
  Se houver casos como "Kenvue" vs "Kenvue Brasil" que devem ser
  considerados o MESMO cliente, isso fica fora deste módulo (ou via
  tabela de aliases manual no futuro). Aqui a regra é: se o nome
  bruto difere após normalização, são clientes distintos.

• Display name: dentre as variações de grafia ("Kenvue", "KENVUE",
  "kenvue"), o display é a versão mais frequente. Tie-break: a
  variação que aparece na campanha mais recente.

• Falha graciosa: timeseries falhando → sparklines vazias mas o resto
  do payload continua válido. Worklist é puramente derivada da lista,
  então não tem ponto de falha próprio.
"""

import re
import unicodedata
from collections import Counter, defaultdict
from datetime import date, timedelta

# ─────────────────────────────────────────────────────────────────────────────
# Normalização
# ─────────────────────────────────────────────────────────────────────────────

def normalize_client_slug(name: str) -> str:
    """
    Converte um client_name em slug estável para agrupamento.

    Regras:
      - lowercase
      - strip de espaços nas pontas
      - remove acentos (NFKD decompose + ascii filter)
      - colapsa espaços/separadores em hífen único
      - remove caracteres não-alfanuméricos (exceto hífen)

    Exemplos:
      "Kenvue"           → "kenvue"
      "KENVUE"           → "kenvue"
      "  kenvue  "       → "kenvue"
      "Volkswagen / VW"  → "volkswagen-vw"
      "L'Oréal"          → "l-oreal"
      ""                 → ""  (preservado para detectar campanhas sem cliente)
    """
    if not name:
        return ""
    s = name.strip().lower()
    # NFKD: decompõe acentos em letra base + diacrítico, depois filtra
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    # Tudo que não for [a-z0-9] vira hífen
    s = re.sub(r"[^a-z0-9]+", "-", s)
    # Colapsa hífens duplicados e remove das pontas
    s = re.sub(r"-+", "-", s).strip("-")
    return s


def _choose_display_name(variants_with_dates):
    """
    Escolhe a melhor grafia de exibição entre variações de um mesmo slug.

    Args:
      variants_with_dates: list[tuple[str, str | None]] — (raw_name, end_date)

    Estratégia:
      1. Conta frequência de cada variação
      2. Se há vencedor único por frequência, retorna ele
      3. Empate: pega a variação que aparece na campanha de end_date mais
         recente (assume que o time refinou a grafia ao longo do tempo)
      4. Sem datas válidas: pega a primeira em ordem alfabética estável
    """
    if not variants_with_dates:
        return ""

    counter = Counter(v[0] for v in variants_with_dates if v[0])
    if not counter:
        return ""

    # Pega o(s) mais frequente(s)
    max_freq = max(counter.values())
    top = [name for name, freq in counter.items() if freq == max_freq]

    if len(top) == 1:
        return top[0]

    # Empate por frequência: usa end_date mais recente
    top_set = set(top)
    candidates = [(n, d) for n, d in variants_with_dates if n in top_set and d]
    if candidates:
        candidates.sort(key=lambda x: x[1], reverse=True)
        return candidates[0][0]

    # Fallback determinístico
    return sorted(top)[0]


# ─────────────────────────────────────────────────────────────────────────────
# Health classification
# ─────────────────────────────────────────────────────────────────────────────

def _classify_pacing_health(pacing_pct):
    """
    Classifica pacing % em uma das 4 faixas operacionais:
      - critical:  < 90%               (vermelho — entregou abaixo do esperado)
      - attention: 90% ≤ pacing < 100% (amarelo — em risco de não bater meta)
      - healthy:   100% ≤ pacing < 125% (verde — dentro do alvo)
      - over:      ≥ 125%              (azul — over delivery; ainda saudável)

    Verde e azul são ambos estados saudáveis. Azul destaca over delivery
    relevante (≥125%) que a operação quer ver com cor distinta — não é
    "ruim", só é "diferente de no alvo".

    Pacing é a métrica principal porque CTR/VTR variam por vertical e
    formato; pacing fora da banda saudável quase sempre exige ação.
    """
    if pacing_pct is None:
        return None
    if pacing_pct < 90:
        return "critical"
    if pacing_pct < 100:
        return "attention"
    if pacing_pct < 125:
        return "healthy"
    return "over"


def _aggregate_health(health_list):
    """
    Saúde agregada do cliente: o pior status entre suas campanhas ativas.
    Cliente sem campanhas ativas → None (não aparece no status dot).

    Ordem de severidade (pior → melhor): critical > attention > healthy > over.
    Verde e azul são ambos saudáveis, mas quando há mistura preferimos a
    leitura conservadora (verde).
    """
    if not health_list:
        return None
    if "critical" in health_list:
        return "critical"
    if "attention" in health_list:
        return "attention"
    if "healthy" in health_list:
        return "healthy"
    if "over" in health_list:
        return "over"
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Agregação principal
# ─────────────────────────────────────────────────────────────────────────────

def aggregate_clients_from_campaigns(campaigns):
    """
    Agrupa a lista de campanhas (vinda de query_campaigns_list) por
    client_slug e retorna a lista de clientes com métricas agregadas.

    Métricas:
      - total_campaigns: count
      - active_campaigns: count com end_date >= hoje
      - avg_pacing: média ponderada por contracted_value (display + video)
                    quando disponível, caso contrário média simples.
                    Apenas campanhas ativas entram na média (campanhas
                    encerradas distorceriam — pacing congelado).
      - avg_ctr / avg_vtr: média simples sobre campanhas ativas que têm
                            a métrica (separado display/video).
      - top_owners: 2 CPs e 2 CSs mais frequentes (por email)
      - last_updated: max(updated_at)
      - health: agregada das campanhas ativas
    """
    today = date.today()
    groups = defaultdict(list)

    for c in campaigns:
        slug = normalize_client_slug(c.get("client_name", ""))
        if not slug:
            continue
        groups[slug].append(c)

    out = []
    for slug, group in groups.items():
        # Display name = variação mais frequente
        variants = [(c.get("client_name", ""), c.get("end_date") or "") for c in group]
        display = _choose_display_name(variants)

        # Active vs total
        active = []
        for c in group:
            end_str = c.get("end_date") or ""
            if not end_str:
                continue
            try:
                end_dt = date.fromisoformat(end_str[:10])
                if end_dt >= today:
                    active.append(c)
            except (ValueError, TypeError):
                continue

        # Pacing médio (display + video, ativas só)
        pacing_values = []
        for c in active:
            dp = c.get("display_pacing")
            vp = c.get("video_pacing")
            # Se ambos existem, considera os dois separadamente na média
            # (uma campanha com display + video conta 2 pontos, refletindo
            # que ela tem 2 dimensões de delivery sendo monitoradas).
            if dp is not None:
                pacing_values.append(float(dp))
            if vp is not None:
                pacing_values.append(float(vp))
        avg_pacing = round(sum(pacing_values) / len(pacing_values), 1) if pacing_values else None

        # CTR/VTR médios (ativas só)
        ctr_values = [float(c["display_ctr"]) for c in active if c.get("display_ctr") is not None]
        vtr_values = [float(c["video_vtr"])   for c in active if c.get("video_vtr")   is not None]
        avg_ctr = round(sum(ctr_values) / len(ctr_values), 2) if ctr_values else None
        avg_vtr = round(sum(vtr_values) / len(vtr_values), 2) if vtr_values else None

        # Top owners (frequência por email, separados CP/CS)
        cp_emails = [c.get("cp_email") for c in group if c.get("cp_email")]
        cs_emails = [c.get("cs_email") for c in group if c.get("cs_email")]
        top_cp = [{"email": e, "count": n} for e, n in Counter(cp_emails).most_common(2)]
        top_cs = [{"email": e, "count": n} for e, n in Counter(cs_emails).most_common(2)]

        # Last updated
        updated_values = [c.get("updated_at", "") for c in group if c.get("updated_at")]
        last_updated = max(updated_values) if updated_values else None

        # Health agregada
        active_healths = [
            _classify_pacing_health(
                # Usa o "pior" pacing entre display e video da campanha
                _worst_pacing(c.get("display_pacing"), c.get("video_pacing"))
            )
            for c in active
        ]
        active_healths = [h for h in active_healths if h]
        health = _aggregate_health(active_healths)

        # Token list (tokens curtos, p/ filtros do worklist sem segundo round-trip)
        active_tokens = [c["short_token"] for c in active if c.get("short_token")]

        out.append({
            "slug":                slug,
            "display_name":        display,
            "total_campaigns":     len(group),
            "active_campaigns":    len(active),
            "avg_pacing":          avg_pacing,
            "avg_ctr":             avg_ctr,
            "avg_vtr":             avg_vtr,
            "top_cp_owners":       top_cp,
            "top_cs_owners":       top_cs,
            "last_updated":        last_updated,
            "health":              health,
            "active_short_tokens": active_tokens,
        })

    # Ordena por nº de campanhas ativas desc, depois total desc, depois display name
    out.sort(key=lambda c: (-c["active_campaigns"], -c["total_campaigns"], c["display_name"]))
    return out


_PACING_TIER_RANK = {"critical": 0, "attention": 1, "healthy": 2, "over": 3}


def _worst_pacing(dp, vp):
    """
    Combina pacing display + video em um único valor representativo
    pra health classification: aquele que cai na PIOR banda de health
    (rank crítico=0 < attention=1 < healthy=2 < over=3).

    Antes usávamos "distância de 100" — não funciona com a régua atual
    onde over (≥125%) é saudável. Hoje, between display=110 e video=130,
    o "pior" é display (healthy < over no rank).

    Ex: display 105% + video 145%  → 105% (healthy é mais conservador que over)
        display 78% + video 102%   → 78%  (critical < healthy)
        display 130% + video 130%  → 130% (ambos over)
    """
    candidates = []
    if dp is not None:
        candidates.append(float(dp))
    if vp is not None:
        candidates.append(float(vp))
    if not candidates:
        return None
    return min(candidates, key=lambda x: _PACING_TIER_RANK[_classify_pacing_health(x)])


# ─────────────────────────────────────────────────────────────────────────────
# Worklist
# ─────────────────────────────────────────────────────────────────────────────

def compute_worklist(campaigns):
    """
    4 buckets de campanhas que precisam de atenção do time.

    Pure-derived (sem query BQ extra) — opera em memória sobre o
    resultado de query_campaigns_list().

    Returns dict com:
      - pacing_critical: count + tokens (pacing < 90% em qualquer média)
      - no_owner: count + tokens (cp_email OU cs_email faltando, em ativas)
      - ending_soon: count + tokens (end_date entre hoje e hoje+7d)
      - reports_not_viewed: placeholder (count=0) — depende de telemetria
                            de visualização que ainda não existe.
                            Bucket fica no schema pra evitar mudança de
                            contrato quando for implementado.
    """
    today = date.today()
    in_seven_days = today + timedelta(days=7)

    pacing_critical = []
    no_owner = []
    ending_soon = []

    for c in campaigns:
        end_str = c.get("end_date") or ""
        try:
            end_dt = date.fromisoformat(end_str[:10]) if end_str else None
        except (ValueError, TypeError):
            end_dt = None

        is_active = end_dt is not None and end_dt >= today
        if not is_active:
            continue

        token = c.get("short_token")
        if not token:
            continue

        # Bucket 1: pacing crítico — qualquer das frentes (DSP ou VID) < 90%.
        # Over delivery (≥125%) saiu desta lista: é saudável pela régua atual.
        worst = _worst_pacing(c.get("display_pacing"), c.get("video_pacing"))
        if _classify_pacing_health(worst) == "critical":
            pacing_critical.append(token)

        # Bucket 2: sem owner (CP ou CS faltando)
        if not c.get("cp_email") or not c.get("cs_email"):
            no_owner.append(token)

        # Bucket 3: encerrando em até 7d
        if end_dt and today <= end_dt <= in_seven_days:
            ending_soon.append(token)

    return {
        "pacing_critical":    {"count": len(pacing_critical), "tokens": pacing_critical},
        "no_owner":           {"count": len(no_owner),        "tokens": no_owner},
        "ending_soon":        {"count": len(ending_soon),     "tokens": ending_soon},
        # Placeholder — telemetria de visualização ainda não existe.
        # Schema preservado para evitar mudança de contrato no front.
        "reports_not_viewed": {"count": 0, "tokens": []},
    }


# ─────────────────────────────────────────────────────────────────────────────
# Série temporal (sparkline)
# ─────────────────────────────────────────────────────────────────────────────

# Singleton de sparklines — popula via inject() pra evitar import circular
# entre clients.py e main.py (main já importa clients, e clients precisa do
# bq client que vive em main).
_bq_client_ref = [None]

def set_bq_client(client):
    """Chamado no boot do main.py após criar o bigquery.Client global."""
    _bq_client_ref[0] = client


def query_client_timeseries(weeks=12):
    """
    Retorna {client_slug: [w1, w2, ..., wN]} com viewable_impressions
    semanais nas últimas `weeks` semanas (mais antiga primeiro).

    Single query BQ. Resultado serve pra sparkline + cálculo de trend
    (últimas 4 semanas vs 4 semanas anteriores).

    Retorna dict vazio em caso de falha, sem propagar exceção — o front
    deve renderizar o card sem sparkline em vez de quebrar a tela.
    """
    bq = _bq_client_ref[0]
    if bq is None:
        return {}

    sql = f"""
        WITH weekly AS (
            SELECT
                client_name,
                DATE_TRUNC(date, WEEK(MONDAY)) AS week_start,
                SUM(viewable_impressions)      AS vi
            FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
            WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL {int(weeks) * 7} DAY)
              AND UPPER(line_name) NOT LIKE '%SURVEY%'
            GROUP BY client_name, week_start
        )
        SELECT client_name, week_start, vi
        FROM weekly
        ORDER BY client_name, week_start
    """

    try:
        rows = list(bq.query(sql).result())
    except Exception as e:
        print(f"[WARN query_client_timeseries] {e}")
        return {}

    # Constrói série completa: precisa de N semanas exatas, com 0 pros gaps
    today = date.today()
    # Encontra a segunda-feira da semana atual
    monday_this_week = today - timedelta(days=today.weekday())
    week_starts = [monday_this_week - timedelta(weeks=(weeks - 1 - i)) for i in range(weeks)]

    by_client = defaultdict(dict)
    for r in rows:
        slug = normalize_client_slug(r["client_name"])
        if not slug:
            continue
        ws = r["week_start"]
        if hasattr(ws, "date"):
            ws = ws.date()
        by_client[slug][ws] = float(r["vi"] or 0)

    result = {}
    for slug, weeks_map in by_client.items():
        series = [int(weeks_map.get(ws, 0)) for ws in week_starts]
        result[slug] = series

    return result


def compute_trend(series, half=4):
    """
    Trend % comparando últimas `half` semanas vs `half` semanas anteriores.

    Returns: dict {pct: float, direction: "up"|"down"|"flat"} ou None se
    não há dados suficientes (precisa de pelo menos 2*half semanas e
    delivery > 0 no período base).

    Direção:
      - "up":   variação ≥ +2%
      - "down": variação ≤ -2%
      - "flat": dentro de ±2% (estagnação/consistência)

    A banda de 2% é uma heurística pra evitar trends ruidosos —
    abaixo disso é dentro da margem de variação semanal natural.
    """
    if not series or len(series) < 2 * half:
        return None
    recent = series[-half:]
    base = series[-2 * half : -half]
    base_sum = sum(base)
    if base_sum <= 0:
        return None
    pct = round(((sum(recent) - base_sum) / base_sum) * 100, 1)
    if pct >= 2:
        direction = "up"
    elif pct <= -2:
        direction = "down"
    else:
        direction = "flat"
    return {"pct": pct, "direction": direction}
