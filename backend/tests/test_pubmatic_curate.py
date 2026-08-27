"""Testes do conector PubMatic (pubmatic_curate.py).

Foco: as regras que fizeram a base ficar 2 dias atrás com o job verde, e as
defesas que nasceram disso. Nada aqui faz I/O — a resposta da API é fixture e o
BigQuery só aparece na auditoria, com stub.

O que cada bloco crava
──────────────────────
  corte D-1        em horário de BRASÍLIA (era `date.today()` = UTC: entre 21h
                   e 24h BRT o dia CORRENTE brasileiro vazava pra dentro da
                   base como dia fechado, com número parcial)
  dias zerados     continuam descartados (dia zerado gravado viraria
                   last_delivery_day e o deal apareceria "no ar" sem entrega),
                   mas agora CONTABILIZADOS: api_last_day/lag_days/
                   trailing_zero_days são o que transforma "a fonte atrasou"
                   de pergunta no Slack em alarme no painel
  chain            fallback de credencial na AUTH e — novo — no REPORT (401/403
                   com a credencial já autenticada)
  auditoria        diff API × BQ classificando missing_in_bq / value_mismatch /
                   extra_in_bq
"""
import sys
import types
from datetime import date, datetime, timedelta, timezone

import pytest

import pubmatic_curate as pm


# ─── Fixture: resposta do Data Provider Analytics ────────────────────────────
def _payload(rows, names=None, columns=None):
    """Monta o shape que a API devolve. `rows` = tuplas na ordem de `columns`."""
    return {
        "columns": columns or ["dealMetaId", "publisherDealId", "date",
                               "paidImpressions", "spend", "transactionRevenue",
                               "dataRevenue", "clicks"],
        "rows": rows,
        "displayValue": {"dealMetaId": names or {}},
    }


def _row(deal_id, day, imps, spend, margin, pub_deal="PM-ZZCX-5733"):
    return [deal_id, pub_deal, day, imps, spend, margin, 0, 0]


@pytest.fixture
def fixed_today(monkeypatch):
    """Congela "hoje BRT" em 2026-08-24 (a data do incidente do TIM)."""
    monkeypatch.setattr(pm, "today_brt", lambda: date(2026, 8, 24))
    return date(2026, 8, 24)


@pytest.fixture
def api(monkeypatch):
    """Injeta a resposta da API. Devolve um setter."""
    box = {}
    monkeypatch.setattr(pm, "_report_get", lambda params, **kw: box["payload"])
    return lambda payload: box.__setitem__("payload", payload)


# ─── Corte D-1 em BRT ────────────────────────────────────────────────────────
def test_hoje_brt_nao_e_utc_no_fim_do_dia():
    """21h BRT já é o dia seguinte em UTC. `today_brt` tem que dizer 24, não 25
    — era exatamente por isso que o dia corrente vazava pro banco."""
    class _FakeDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            # 2026-08-25 01:00 UTC == 2026-08-24 22:00 BRT
            return datetime(2026, 8, 25, 1, 0, tzinfo=timezone.utc).astimezone(tz)

    import unittest.mock as mock
    with mock.patch.object(pm, "datetime", _FakeDatetime):
        assert pm.today_brt() == date(2026, 8, 24)


def test_dia_corrente_brt_e_descartado(api, fixed_today):
    api(_payload([
        _row(735537, "2026-08-23", 369_336, 12_480.53, 10_608.45),
        _row(735537, "2026-08-24", 4_000, 120.00, 102.00),   # hoje, parcial
    ]))
    rows, _, stats = pm.fetch_delivery_rows(date(2026, 8, 17), fixed_today)

    assert [r["day"] for r in rows] == [date(2026, 8, 23)]
    assert stats["rows_skipped_today"] == 1


# ─── Dias zerados: descartados, mas contabilizados ──────────────────────────
def test_dia_zerado_nao_vira_row_de_entrega(api, fixed_today):
    """A regra que estava certa e continua: dia zerado gravado viraria
    last_delivery_day e o deal apareceria "no ar" sem ter entregue nada."""
    api(_payload([
        _row(735537, "2026-08-21", 100_000, 3_000.0, 2_550.0),
        _row(735537, "2026-08-22", 0, 0.0, 0.0),
        _row(735537, "2026-08-23", 0, 0.0, 0.0),
    ]))
    rows, _, stats = pm.fetch_delivery_rows(date(2026, 8, 17), fixed_today)

    assert [r["day"] for r in rows] == [date(2026, 8, 21)]
    assert stats["rows_skipped_empty"] == 2


def test_lag_da_fonte_e_medido_e_nao_so_logado(api, fixed_today):
    """O caso do TIM: a API devolve D-1 e D-2 zerados porque ainda não fechou.
    Antes isso era um logger.info; agora tem que sair number-shaped, senão o
    painel não tem como alarmar e a base fica velha em silêncio."""
    api(_payload([
        _row(735537, "2026-08-21", 100_000, 3_000.0, 2_550.0),
        _row(735537, "2026-08-22", 0, 0.0, 0.0),
        _row(735537, "2026-08-23", 0, 0.0, 0.0),
    ]))
    _, _, stats = pm.fetch_delivery_rows(date(2026, 8, 17), fixed_today)

    assert stats["api_last_day"] == "2026-08-21"
    assert stats["expected_last_day"] == "2026-08-23"      # D-1
    assert stats["lag_days"] == 2
    assert stats["trailing_zero_days"] == 2


def test_fonte_em_dia_reporta_lag_zero(api, fixed_today):
    api(_payload([_row(735537, "2026-08-23", 369_336, 12_480.53, 10_608.45)]))
    _, _, stats = pm.fetch_delivery_rows(date(2026, 8, 17), fixed_today)

    assert stats["api_last_day"] == "2026-08-23"
    assert stats["lag_days"] == 0
    assert stats["trailing_zero_days"] == 0


def test_zerado_no_meio_da_janela_nao_conta_como_atraso(api, fixed_today):
    """Deal pausado no meio do flight ≠ fonte atrasada. Só zerado NO FIM é
    assinatura de lag de reporting — confundir os dois é o falso alarme que
    faria o painel virar ruído e ser ignorado de novo."""
    api(_payload([
        _row(735537, "2026-08-20", 50_000, 1_000.0, 850.0),
        _row(735537, "2026-08-21", 0, 0.0, 0.0),
        _row(735537, "2026-08-22", 0, 0.0, 0.0),
        _row(735537, "2026-08-23", 80_000, 2_000.0, 1_700.0),
    ]))
    _, _, stats = pm.fetch_delivery_rows(date(2026, 8, 17), fixed_today)

    assert stats["lag_days"] == 0
    assert stats["trailing_zero_days"] == 0
    assert stats["rows_skipped_empty"] == 2


def test_janela_sem_dado_nenhum_nao_afirma_lag(api, fixed_today):
    """Conta sem entrega nenhuma: api_last_day None e lag None. Não é atraso —
    e afirmar atraso aqui ressuscitaria o falso alarme de deal encerrado."""
    api(_payload([]))
    rows, deal_meta, stats = pm.fetch_delivery_rows(date(2026, 8, 17), fixed_today)

    assert rows == [] and deal_meta == {}
    assert stats["api_last_day"] is None
    assert stats["lag_days"] is None


# ─── Mapeamento de métricas e masters ───────────────────────────────────────
def test_mapeamento_de_metricas_para_colunas_curator(api, fixed_today):
    api(_payload([_row(735537, "2026-08-23", 369_336, 12_480.53, 10_608.45)]))
    rows, deal_meta, _ = pm.fetch_delivery_rows(date(2026, 8, 17), fixed_today)

    r = rows[0]
    assert r["source"] == "pubmatic"
    assert r["line_id"] == 735537
    assert r["imps"] == 369_336
    assert r["curator_revenue"] == 12_480.53     # spend = bruto do comprador
    assert r["curator_margin"] == 10_608.45      # transactionRevenue = líquido
    assert r["billing_exchange_rate"] == 1.0     # já é BRL
    assert r["curator_total_cost"] is None       # sem custo separado
    # 85% é a margem configurada no setup do deal; derivamos da entrega.
    assert deal_meta[735537]["margin_pct"] == 85.0


def test_start_date_do_deal_e_o_primeiro_dia_da_janela_com_entrega(api, fixed_today):
    api(_payload([
        _row(735537, "2026-08-23", 10, 1.0, 0.85),
        _row(735537, "2026-08-19", 10, 1.0, 0.85),
        _row(735537, "2026-08-21", 10, 1.0, 0.85),
    ]))
    _, deal_meta, _ = pm.fetch_delivery_rows(date(2026, 8, 17), fixed_today)
    assert deal_meta[735537]["first_day"] == date(2026, 8, 19)


@pytest.mark.parametrize("raw,expected", [
    ("PM-ZZCX-5733", "PM-ZZCX-5733"),
    ("Name is not available (735537)", None),   # placeholder de deal novo
    ("", None),
    (None, None),
])
def test_deal_id_placeholder_nao_polui_external_deal_id(raw, expected):
    assert pm._clean_deal_id(raw) == expected


# ─── Cliente extraído do nome do deal ───────────────────────────────────────
#
# `_customer_from_deal_name` tem DOIS caminhos, e a versão anterior deste teste
# só exercitava um — sem saber:
#
#     try:
#         import pmp_deals
#         if key in pmp_deals.CUSTOMER_DISPLAY:
#             return pmp_deals.CUSTOMER_DISPLAY[key]     # canônico
#     except Exception:
#         pass                                          # engole o ImportError
#     return t.replace("-", " ").title()                # fallback
#
# `pmp_deals` constrói o client do BigQuery no import, então sem ADC o import
# ESTOURA, o `except` engole e a função cai no `.title()`. O teste antigo
# afirmava exatamente esse fallback ("Tim", "Nestle") — e passava em todo
# laptop sem credencial, porque nunca chegava no caminho canônico.
#
# Com credencial (o CI, a partir do primeiro run que de fato autenticou) o
# import funciona e a função devolve "TIM" e "Nestlé", que são as grafias
# CERTAS das marcas. Ou seja: o teste estava errado, não a função — e o
# resultado dele dependia de ter credencial na máquina, que é o pior tipo de
# teste: verde por acidente.
#
# A correção é parar de depender do ambiente. Injetamos um `pmp_deals` falso em
# `sys.modules` (a função faz `import pmp_deals` a cada chamada, então pega o
# nosso) e afirmamos os DOIS caminhos explicitamente.
@pytest.fixture
def customer_display(monkeypatch):
    """Injeta um `pmp_deals` com o CUSTOMER_DISPLAY que o teste quiser."""
    def _set(mapping):
        fake = types.ModuleType("pmp_deals")
        fake.CUSTOMER_DISPLAY = mapping
        monkeypatch.setitem(sys.modules, "pmp_deals", fake)
    return _set


@pytest.mark.parametrize("deal_name,expected", [
    ("HYPR_TIM_DV360_BETC_ROCK-IN-RIO_DEAL_FLEX-BID_VIDEO_PUBMATIC_AGO-26", "TIM"),
    ("HYPR_NESTLE_AMAZON-DSP_WPP_KITKAT-F1_FIXED-BID_DEAL_DISPLAY", "Nestlé"),
])
def test_cliente_usa_a_grafia_canonica_da_marca(customer_display, deal_name, expected):
    """Com o mapa disponível, vale a grafia da marca — não o title case.
    "TIM" é maiúsculo e "Nestlé" tem acento; `.title()` erraria os dois."""
    customer_display({"TIM": "TIM", "NESTLE": "Nestlé"})
    assert pm._customer_from_deal_name(deal_name) == expected


@pytest.mark.parametrize("deal_name,expected", [
    ("HYPR_TIM_DV360_BETC_ROCK-IN-RIO_DEAL_FLEX-BID_VIDEO_PUBMATIC_AGO-26", "Tim"),
    ("HYPR_NESTLE_AMAZON-DSP_WPP_KITKAT-F1_FIXED-BID_DEAL_DISPLAY", "Nestle"),
    ("HYPR_ACME-CORP_DV360_DEAL_DISPLAY", "Acme Corp"),
])
def test_cliente_cai_no_title_case_quando_a_marca_nao_esta_no_mapa(
    customer_display, deal_name, expected
):
    """Marca desconhecida ainda rende um nome legível — é o que o admin vê
    antes de vincular o deal na mão."""
    customer_display({})
    assert pm._customer_from_deal_name(deal_name) == expected


@pytest.mark.parametrize("deal_name", [
    "HYPR_PMP_DV360",   # só tokens de ruído
    "",
])
def test_cliente_e_none_quando_nao_sobra_token_util(customer_display, deal_name):
    """None é deliberado: admin resolve no link manual. Independe do mapa."""
    customer_display({"TIM": "TIM"})
    assert pm._customer_from_deal_name(deal_name) is None


# ─── Colunas obrigatórias ───────────────────────────────────────────────────
def test_report_sem_coluna_obrigatoria_falha_alto(api, fixed_today):
    """Mudança de contrato da API tem que estourar, não devolver base vazia em
    silêncio — base vazia é indistinguível de "ninguém entregou"."""
    api(_payload([], columns=["dealMetaId", "date", "paidImpressions"]))
    with pytest.raises(pm.PubMaticError, match="sem colunas esperadas"):
        pm.fetch_delivery_rows(date(2026, 8, 17), fixed_today)


# ─── Chain de credenciais: AUTH ─────────────────────────────────────────────
@pytest.fixture(autouse=True)
def _reset_token_cache(monkeypatch):
    monkeypatch.setattr(pm, "_cached_token", None)
    monkeypatch.setattr(pm, "_cached_token_exp_ms", 0.0)
    monkeypatch.setattr(pm, "_cached_cred_label", None)


@pytest.fixture
def creds(monkeypatch):
    monkeypatch.setenv("PUBMATIC_USER", "primary@hypr")
    monkeypatch.setenv("PUBMATIC_PASS", "p1")
    monkeypatch.setenv("PUBMATIC_USER_ALT", "alt@hypr")
    monkeypatch.setenv("PUBMATIC_PASS_ALT", "p2")


def test_auth_cai_pro_alt_quando_primario_e_revogado(monkeypatch, creds):
    """O incidente de 19/08: a primária começou a devolver 401 AUTH_FAILED sem
    mudança nossa. Com a chain isso custa um WARNING, não 3 dias de base
    congelada."""
    def fake(user, password):
        if user == "primary@hypr":
            raise pm.PubMaticError("HTTP 401 ...: AUTH_FAILED")
        return "bearer-alt"
    monkeypatch.setattr(pm, "_request_token", fake)

    assert pm.get_token() == "bearer-alt"
    # O rótulo vai pro ledger: é o que faz o painel avisar em amarelo que a
    # primária precisa ser reativada no seat.
    assert pm.credential_label() == "alt"


def test_auth_com_todas_as_credenciais_ruins_lista_cada_uma(monkeypatch, creds):
    monkeypatch.setattr(pm, "_request_token",
                        lambda u, p: (_ for _ in ()).throw(pm.PubMaticError("AUTH_FAILED")))
    with pytest.raises(pm.PubMaticError) as e:
        pm.get_token()
    # Ver só o erro da última credencial faz o operador concluir que existe uma
    # credencial só e procurar no lugar errado.
    assert "primary@hypr" in str(e.value) and "alt@hypr" in str(e.value)


def test_sem_credencial_o_erro_diz_o_que_configurar(monkeypatch):
    monkeypatch.delenv("PUBMATIC_USER", raising=False)
    monkeypatch.delenv("PUBMATIC_PASS", raising=False)
    monkeypatch.delenv("PUBMATIC_USER_ALT", raising=False)
    monkeypatch.delenv("PUBMATIC_PASS_ALT", raising=False)
    assert pm.is_configured() is False
    with pytest.raises(pm.PubMaticError, match="Secret Manager"):
        pm.get_token()


def test_token_e_cacheado_entre_chamadas(monkeypatch, creds):
    """O limite de 200 gerações em 20min DESABILITA a conta — o cache é
    requisito, não otimização."""
    calls = []
    monkeypatch.setattr(pm, "_request_token",
                        lambda u, p: (calls.append(u), "bearer")[1])
    pm.get_token()
    pm.get_token()
    pm.get_token()
    assert len(calls) == 1


def test_skip_labels_pula_credencial_recusada(monkeypatch, creds):
    monkeypatch.setattr(pm, "_request_token",
                        lambda u, p: f"bearer-{u.split('@')[0]}")
    assert pm.get_token() == "bearer-primary"
    assert pm.get_token(skip_labels=("primary",)) == "bearer-alt"


# ─── Chain de credenciais: REPORT (o degrau que não existia) ─────────────────
def _http_error(code):
    import io as _io
    import urllib.error
    return urllib.error.HTTPError("u", code, "err", {},
                                  _io.BytesIO(b'{"error":"forbidden"}'))


def test_report_403_avanca_a_chain(monkeypatch, creds):
    """Credencial que AUTENTICA e só então descobre que perdeu acesso ao Data
    Provider Analytics. A chain do get_token não cobria isso — ela só troca de
    par quando a auth falha — então o sync morria com a ALT parada ao lado."""
    monkeypatch.setattr(pm, "_request_token",
                        lambda u, p: f"bearer-{u.split('@')[0]}")
    seen = []

    def fake_once(url, token, timeout):
        seen.append(token)
        if token == "bearer-primary":
            raise pm._ReportAuthError(403, "forbidden")
        return {"columns": [], "rows": []}
    monkeypatch.setattr(pm, "_report_get_once", fake_once)

    assert pm._report_get({"x": 1}) == {"columns": [], "rows": []}
    assert seen[-1] == "bearer-alt"
    assert pm.credential_label() == "alt"


def test_report_401_transitorio_resolve_com_bearer_novo(monkeypatch, creds):
    """Token velho numa instância antiga: 1 retry com Bearer novo do MESMO par
    resolve, sem queimar a chain."""
    monkeypatch.setattr(pm, "_request_token", lambda u, p: "bearer-primary")
    calls = {"n": 0}

    def fake_once(url, token, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            raise pm._ReportAuthError(401, "expired")
        return {"columns": [], "rows": []}
    monkeypatch.setattr(pm, "_report_get_once", fake_once)

    assert pm._report_get({"x": 1}) == {"columns": [], "rows": []}
    assert pm.credential_label() == "primary"


def test_report_rejeitando_todas_lista_cada_credencial(monkeypatch, creds):
    monkeypatch.setattr(pm, "_request_token",
                        lambda u, p: f"bearer-{u.split('@')[0]}")
    monkeypatch.setattr(pm, "_report_get_once",
                        lambda url, token, timeout: (_ for _ in ()).throw(
                            pm._ReportAuthError(403, "forbidden")))
    with pytest.raises(pm.PubMaticError) as e:
        pm._report_get({"x": 1})
    msg = str(e.value)
    assert "primary" in msg and "alt" in msg


def test_erro_nao_de_auth_no_report_nao_re_tenta(monkeypatch, creds):
    """400 de combinação inválida de dimensions/metrics é bug nosso — re-tentar
    com outra credencial só esconde a mensagem que diagnostica."""
    monkeypatch.setattr(pm, "_request_token", lambda u, p: "bearer")
    calls = {"n": 0}

    def fake_once(url, token, timeout):
        calls["n"] += 1
        raise pm.PubMaticError("HTTP 400 GET dataprovider: invalid dateUnit")
    monkeypatch.setattr(pm, "_report_get_once", fake_once)

    with pytest.raises(pm.PubMaticError, match="invalid dateUnit"):
        pm._report_get({"x": 1})
    assert calls["n"] == 1


def test_report_once_classifica_401_403_como_re_tentavel(monkeypatch):
    import urllib.request
    for code, exc in ((401, pm._ReportAuthError), (403, pm._ReportAuthError),
                      (400, pm.PubMaticError), (500, pm.PubMaticError)):
        monkeypatch.setattr(urllib.request, "urlopen",
                            lambda *a, **k: (_ for _ in ()).throw(_http_error(code)))
        with pytest.raises(exc):
            pm._report_get_once("http://x", "t", 5)


# ─── sync_delivery: os stats sobem pro ledger ───────────────────────────────
def test_sync_delivery_propaga_frescor_no_resultado(monkeypatch, api, fixed_today):
    """`api_last_day`/`lag_days` no retorno é o que o main.py grava no ledger e
    o painel lê. Sem isso, "rodou com sucesso" volta a ser a única coisa que a
    tela sabe — e a base fica velha em silêncio de novo."""
    api(_payload([
        _row(735537, "2026-08-21", 100_000, 3_000.0, 2_550.0),
        _row(735537, "2026-08-22", 0, 0.0, 0.0),
        _row(735537, "2026-08-23", 0, 0.0, 0.0),
    ]))
    monkeypatch.setattr(pm, "_ensure_masters", lambda dm: len(dm))
    monkeypatch.setattr(pm, "_upsert_via_staging",
                        lambda **kw: {"merged": len(kw.get("rows") or [])})
    monkeypatch.setattr(pm, "credential_label", lambda: "primary")

    res = pm.sync_delivery(lookback_days=7)

    assert res["rows_processed"] == 1
    assert res["api_last_day"] == "2026-08-21"
    assert res["lag_days"] == 2
    assert res["credential"] == "primary"


# ─── Auditoria API × BQ ─────────────────────────────────────────────────────
def _audit(monkeypatch, api_rows, bq_rows, today=date(2026, 8, 24)):
    """Roda a auditoria com a API e o BQ stubados.

    O stub do BQ RESPEITA a janela [start, end] que recebe, porque a query real
    filtra por `day BETWEEN @start AND @end` — um stub que devolvesse tudo
    testaria o stub, não o corte que a auditoria faz.
    """
    monkeypatch.setattr(pm, "today_brt", lambda: today)
    monkeypatch.setattr(pm, "_report_get", lambda params, **kw: _payload(api_rows))
    monkeypatch.setattr(
        pm, "_delivery_from_bq",
        lambda s, e: {k: v for k, v in bq_rows.items()
                      if s.isoformat() <= k[1] <= e.isoformat()},
    )
    return pm.audit_window(lookback_days=7)


def test_auditoria_limpa_quando_api_e_bq_batem(monkeypatch):
    res = _audit(
        monkeypatch,
        [_row(735537, "2026-08-23", 369_336, 12_480.53, 10_608.45)],
        {(735537, "2026-08-23"): {"imps": 369_336, "revenue": 12_480.53,
                                  "margin": 10_608.45}},
    )
    assert res["clean"] is True
    assert res["findings"] == []


def test_auditoria_acha_dia_que_a_coleta_perdeu(monkeypatch):
    """`missing_in_bq` é a assinatura exata do bug do TIM: a API tem a entrega
    do dia e nós não temos a row."""
    res = _audit(
        monkeypatch,
        [_row(735537, "2026-08-23", 369_336, 12_480.53, 10_608.45)],
        {},
    )
    assert res["clean"] is False
    assert res["findings_by_kind"] == {"missing_in_bq": 1}
    f = res["findings"][0]
    assert f["day"] == "2026-08-23"
    assert f["api_revenue"] == 12_480.53
    assert f["bq_revenue"] is None
    assert f["deal"] == "PM-ZZCX-5733"      # id legível, não o dealMetaId cru


def test_auditoria_acha_divergencia_de_valor(monkeypatch):
    res = _audit(
        monkeypatch,
        [_row(735537, "2026-08-23", 369_336, 12_480.53, 10_608.45)],
        {(735537, "2026-08-23"): {"imps": 369_336, "revenue": 9_000.00,
                                  "margin": 7_650.00}},
    )
    assert res["findings_by_kind"] == {"value_mismatch": 1}


def test_auditoria_tolera_arredondamento_de_numeric(monkeypatch):
    """Gravamos NUMERIC arredondado; a API devolve float. Marcar isso como
    divergência encheria o relatório de ruído e o tornaria inútil."""
    res = _audit(
        monkeypatch,
        [_row(735537, "2026-08-23", 369_336, 12_480.5312, 10_608.4515)],
        {(735537, "2026-08-23"): {"imps": 369_336, "revenue": 12_480.5300,
                                  "margin": 10_608.4500}},
    )
    assert res["clean"] is True


def test_auditoria_acha_row_orfa_no_bq(monkeypatch):
    """`extra_in_bq`: a fonte restatou o dia pra zero e o MERGE não apaga."""
    res = _audit(
        monkeypatch, [],
        {(735537, "2026-08-20"): {"imps": 5_000, "revenue": 100.0, "margin": 85.0}},
    )
    assert res["findings_by_kind"] == {"extra_in_bq": 1}


def test_auditoria_nao_compara_o_dia_corrente(monkeypatch):
    """A janela da API é cortada em D-1, então o lado do BQ tem que parar em D-1
    também. Sem isso, a entrega parcial de hoje — que a API ainda não reporta —
    apareceria como extra_in_bq: um alarme falso por dia, todo dia, que é como
    um relatório de auditoria vira ruído e para de ser lido."""
    res = _audit(
        monkeypatch, [],
        {(735537, "2026-08-24"): {"imps": 1, "revenue": 1.0, "margin": 0.85}},
    )
    assert res["clean"] is True
    assert res["window"].endswith("2026-08-23")


def test_auditoria_pede_ao_bq_exatamente_a_janela_cortada(monkeypatch):
    """Crava o contrato que o teste acima depende: o fim da janela passada pro
    BQ é D-1, não hoje."""
    seen = {}
    monkeypatch.setattr(pm, "today_brt", lambda: date(2026, 8, 24))
    monkeypatch.setattr(pm, "_report_get", lambda params, **kw: _payload([]))
    monkeypatch.setattr(pm, "_delivery_from_bq",
                        lambda s, e: seen.update(start=s, end=e) or {})
    pm.audit_window(lookback_days=7)

    assert seen["start"] == date(2026, 8, 17)
    assert seen["end"] == date(2026, 8, 23)     # D-1, não 24


def test_auditoria_trunca_lista_gigante_mas_conta_tudo(monkeypatch):
    """Base recém-quebrada pode ter milhares de rows; a resposta serve pra
    diagnosticar (o padrão aparece nas primeiras), não pra ser a lista de
    conserto — mas o total não pode mentir."""
    base = date(2026, 8, 24)
    api_rows = [
        _row(735537, (base - timedelta(days=d)).isoformat(), 10, 1.0, 0.85)
        for d in range(1, 6)
    ]
    monkeypatch.setattr(pm, "today_brt", lambda: base)
    monkeypatch.setattr(pm, "_report_get", lambda params, **kw: _payload(api_rows))
    monkeypatch.setattr(pm, "_delivery_from_bq", lambda s, e: {})
    res = pm.audit_window(lookback_days=7, max_findings=2)

    assert len(res["findings"]) == 2
    assert res["findings_truncated"] == 3
    assert res["findings_by_kind"]["missing_in_bq"] == 5


# ─── Janela explícita (backfill) ────────────────────────────────────────────
def test_backfill_de_janela_antiga_nao_reporta_atraso_falso(api, fixed_today):
    """Sincronizar um intervalo antigo de propósito não é fonte atrasada. Sem o
    `min` contra o fim da janela, o ledger gravaria semanas de lag e o alarme
    do painel viraria ruído — que é como um alerta morre."""
    api(_payload([_row(735537, "2026-07-05", 10_000, 500.0, 425.0)]))
    _, _, stats = pm.fetch_delivery_rows(date(2026, 7, 1), date(2026, 7, 5))

    assert stats["expected_last_day"] == "2026-07-05"
    assert stats["lag_days"] == 0
