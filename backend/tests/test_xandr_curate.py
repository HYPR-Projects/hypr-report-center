"""Testes do conector Xandr Curate (xandr_curate.py).

Foco: as três coisas que deixaram o sync da Xandr parado 3 dias em silêncio em
18–21/09/2026, e as defesas que nasceram disso.

O que cada bloco crava
──────────────────────
  corte D-1        em horário de BRASÍLIA. Era `date.today()` = UTC, então
                   entre 21h e 24h BRT o dia CORRENTE brasileiro passava pelo
                   filtro e entrava na base como dia fechado, com número
                   parcial. É o MESMO bug que o PubMatic já tinha corrigido
                   (ver `pubmatic_curate.today_brt`); aqui sobreviveu porque o
                   cron roda às 04h — mas o botão "Sincronizar agora" cai na
                   janela, e agora o re-sync noturno também.
  frescor          api_last_day/lag_days/trailing_zero_days. A Xandr gravava
                   NULL nos três desde que o ledger passou a carregá-los
                   (24/08), então para ela o painel nunca teve como dizer se o
                   DADO chegou — só se o job rodou. Xandr verde com API travada
                   em D-5 tinha a mesma cara de Xandr em dia.
  erro de credencial   401 de senha expirada vira XandrAuthError com o
                   procedimento colado, e não o XandrError genérico que lia
                   igual a um timeout no painel.

Sem I/O: o CSV é fixture e o BigQuery nunca é tocado (bq_client stubado no
import, que é o que `pmp_deals` e este módulo resolvem no topo).
"""
import sys
import types
from datetime import date, datetime, timedelta, timezone

import pytest


@pytest.fixture(scope="module")
def xc():
    """Importa xandr_curate com bq_client stubado.

    O módulo (e o pmp_deals que ele importa) resolvia `bigquery.Client()` no
    import, o que exigia credencial default só pra importar e mantinha o
    parsing — função pura — fora de teste.
    """
    stub = types.ModuleType("bq_client")
    stub.get_client = lambda: object()
    saved = sys.modules.get("bq_client")
    sys.modules["bq_client"] = stub
    for m in ("pmp_deals", "xandr_curate"):
        sys.modules.pop(m, None)
    import importlib
    mod = importlib.import_module("xandr_curate")
    yield mod
    if saved is not None:
        sys.modules["bq_client"] = saved
    else:
        sys.modules.pop("bq_client", None)


BRT = timezone(timedelta(hours=-3))

HEADER = ("day,curated_deal_line_item_id,curated_deal_line_item_name,"
          "curated_deal_id,billing_exchange_rate,billing_currency,imps,"
          "viewed_imps,clicks,curator_net_media_cost,curator_tech_fees,"
          "curator_total_cost,curator_revenue,curator_margin")


def _csv(*days, line_id=31787928, imps=1000, cost=500.0):
    """CSV do Curator Analytics com uma row por dia. imps=0 → dia zerado
    (a Xandr devolve o dia com zero em tudo; o parser, ao contrário do
    PubMatic, mantém a row)."""
    rows = [HEADER]
    for d in days:
        i = imps if isinstance(d, str) else d[1]
        day = d if isinstance(d, str) else d[0]
        c = cost if i else 0.0
        rows.append(f"{day},{line_id},Line Teste,PM-1,1.0,BRL,{i},{i},0,"
                    f"{c},0,{c},{c},0")
    return "\n".join(rows) + "\n"


# ─── Corte D-1 em BRT ────────────────────────────────────────────────────────
def test_corte_d1_usa_brt_e_nao_utc(xc, monkeypatch):
    """21/09 22h BRT = 22/09 01h UTC. O dia corrente brasileiro (21/09) é
    parcial e não pode entrar; o UTC diria que 21/09 já fechou."""
    agora = datetime(2026, 9, 22, 1, 0, tzinfo=timezone.utc)

    class _dt(datetime):
        @classmethod
        def now(cls, tz=None):
            return agora.astimezone(tz) if tz else agora

    monkeypatch.setattr(xc, "datetime", _dt)
    assert xc.today_brt() == date(2026, 9, 21)

    rows = xc.parse_csv_line_level(_csv("2026-09-20", "2026-09-21"))
    assert [r["day"] for r in rows] == [date(2026, 9, 20)]


def test_corte_d1_mantem_dias_fechados(xc, monkeypatch):
    agora = datetime(2026, 9, 21, 7, 0, tzinfo=timezone.utc)   # 04h BRT

    class _dt(datetime):
        @classmethod
        def now(cls, tz=None):
            return agora.astimezone(tz) if tz else agora

    monkeypatch.setattr(xc, "datetime", _dt)
    rows = xc.parse_csv_line_level(_csv("2026-09-18", "2026-09-19", "2026-09-20"))
    assert [r["day"] for r in rows] == [date(2026, 9, 18), date(2026, 9, 19),
                                        date(2026, 9, 20)]


# ─── Frescor da fonte ────────────────────────────────────────────────────────
def test_frescor_em_dia(xc):
    rows = [{"day": date(2026, 9, 19), "imps": 10, "curator_total_cost": 1.0},
            {"day": date(2026, 9, 20), "imps": 10, "curator_total_cost": 1.0}]
    f = xc.measure_freshness(rows, expected_last_day=date(2026, 9, 20))
    assert f["api_last_day"] == "2026-09-20"
    assert f["lag_days"] == 0
    assert f["trailing_zero_days"] == 0


def test_frescor_acusa_atraso_da_fonte(xc):
    """Entrega até 17/09 com D-1 = 20/09: é exatamente o estado em que a base
    ficou durante o 401, e o que o ledger da Xandr não sabia dizer."""
    rows = [{"day": date(2026, 9, 17), "imps": 10, "curator_total_cost": 1.0}]
    f = xc.measure_freshness(rows, expected_last_day=date(2026, 9, 20))
    assert f["api_last_day"] == "2026-09-17"
    assert f["lag_days"] == 3
    # A API nem devolveu 18–20: não é "entrega zero", é dia que falta.
    assert f["trailing_zero_days"] == 0


def test_frescor_separa_zero_explicito_de_dia_faltando(xc):
    """Dias zerados NO FIM da janela = fonte fechou o dia, a line é que não
    entregou. `trailing_zero_days == lag_days` é o que diz isso."""
    rows = [{"day": date(2026, 9, 18), "imps": 10, "curator_total_cost": 1.0},
            {"day": date(2026, 9, 19), "imps": 0, "curator_total_cost": 0.0},
            {"day": date(2026, 9, 20), "imps": 0, "curator_total_cost": 0.0}]
    f = xc.measure_freshness(rows, expected_last_day=date(2026, 9, 20))
    assert f["lag_days"] == 2
    assert f["trailing_zero_days"] == 2


def test_frescor_ignora_zero_no_meio_da_janela(xc):
    """Zerado no MEIO é line pausada — não é assinatura de lag de reporting."""
    rows = [{"day": date(2026, 9, 18), "imps": 0, "curator_total_cost": 0.0},
            {"day": date(2026, 9, 19), "imps": 10, "curator_total_cost": 1.0},
            {"day": date(2026, 9, 20), "imps": 10, "curator_total_cost": 1.0}]
    f = xc.measure_freshness(rows, expected_last_day=date(2026, 9, 20))
    assert f["lag_days"] == 0
    assert f["trailing_zero_days"] == 0


def test_frescor_sem_nenhuma_entrega_nao_afirma_atraso(xc):
    """Janela inteira zerada: api_last_day None e lag None. "Não sei" é a
    resposta honesta — o painel trata NULL como "só sei que o job rodou"."""
    rows = [{"day": date(2026, 9, 20), "imps": 0, "curator_total_cost": 0.0}]
    f = xc.measure_freshness(rows, expected_last_day=date(2026, 9, 20))
    assert f["api_last_day"] is None
    assert f["lag_days"] is None


def test_frescor_conta_dia_com_custo_e_zero_imps(xc):
    """Impressão zerada com custo é entrega (make-good, ajuste de billing)."""
    rows = [{"day": date(2026, 9, 20), "imps": 0, "curator_total_cost": 12.5}]
    f = xc.measure_freshness(rows, expected_last_day=date(2026, 9, 20))
    assert f["api_last_day"] == "2026-09-20"
    assert f["lag_days"] == 0


# ─── Classificação do erro de credencial ─────────────────────────────────────
def _auth_falhando(xc, monkeypatch, erro):
    monkeypatch.setenv("XANDR_CURATE_USER", "u")
    monkeypatch.setenv("XANDR_CURATE_PASS", "p")
    monkeypatch.setattr(xc, "_cached_token", None, raising=False)
    monkeypatch.setattr(xc, "_cached_token_exp_ms", 0.0, raising=False)

    def _boom(method, path, **kw):
        raise xc.XandrError(erro)

    monkeypatch.setattr(xc, "_http", _boom)


def test_senha_expirada_vira_erro_de_credencial(xc, monkeypatch):
    """O 401 literal de 18/09/2026."""
    _auth_falhando(xc, monkeypatch,
                   "HTTP 401 POST /auth: Your password has expired and must be reset")
    with pytest.raises(xc.XandrAuthError) as e:
        xc.get_token(force_refresh=True)
    # O procedimento viaja junto com o erro: é o que o ledger guarda e o
    # painel mostra. Sem isso o operador lê "401" e abre um chamado.
    assert "XANDR_CURATE_PASS" in str(e.value)
    assert "Secret Manager" in str(e.value)


def test_erro_de_credencial_cabe_no_popover(xc, monkeypatch):
    """O popover corta em 240 chars — cortar justo na parte acionável seria
    perder o ponto de ter a mensagem."""
    _auth_falhando(xc, monkeypatch,
                   "HTTP 401 POST /auth: Your password has expired and must be reset")
    with pytest.raises(xc.XandrAuthError) as e:
        xc.get_token(force_refresh=True)
    assert len(str(e.value)) <= 240


@pytest.mark.parametrize("erro", [
    "HTTP 401 POST /auth: NOAUTH",
    "HTTP 403 POST /auth: forbidden",
    "HTTP 200 POST /auth: Invalid username or password",
])
def test_outras_falhas_de_credencial(xc, monkeypatch, erro):
    _auth_falhando(xc, monkeypatch, erro)
    with pytest.raises(xc.XandrAuthError):
        xc.get_token(force_refresh=True)


@pytest.mark.parametrize("erro", [
    "HTTP 503 POST /auth: service unavailable",
    "Falha de rede POST /auth: timed out",
])
def test_falha_de_infra_nao_vira_erro_de_credencial(xc, monkeypatch, erro):
    """5xx e timeout passam sozinhos no próximo run; marcá-los como credencial
    mandaria alguém resetar senha à toa."""
    _auth_falhando(xc, monkeypatch, erro)
    with pytest.raises(xc.XandrError) as e:
        xc.get_token(force_refresh=True)
    assert not isinstance(e.value, xc.XandrAuthError)
