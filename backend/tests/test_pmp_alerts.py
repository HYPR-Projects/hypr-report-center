"""Régua do alerta diário do sync PMP (pmp_alerts.find_problems / build_email).

O que se crava aqui é o limiar: o que vira email e o que NÃO vira. Errar para
um lado é o silêncio de 18–21/09/2026 (senha da Xandr expirada, painel vermelho
três dias, ninguém avisado); errar para o outro é email diário no estado normal
da manhã, que em duas semanas vira regra de filtro no Gmail — e aí o silêncio
volta pela porta dos fundos.

A régua espelha a do painel (`pmpFreshness.js`): só o que ele pinta de VERMELHO
manda email. Amarelo (a fonte ainda não fechou D-1) não manda.

Sem I/O: `find_problems` e `build_email` são puras e recebem o `now`.
"""
import sys
import types
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture(scope="module")
def alerts():
    """Importa pmp_alerts com bq_client stubado (pmp_sync_runs cria o client no
    import) e sem tocar no SendGrid."""
    stub = types.ModuleType("bq_client")
    stub.get_client = lambda: object()
    saved = sys.modules.get("bq_client")
    sys.modules["bq_client"] = stub
    for m in ("pmp_sync_runs", "pmp_alerts"):
        sys.modules.pop(m, None)
    import importlib
    mod = importlib.import_module("pmp_alerts")
    yield mod
    if saved is not None:
        sys.modules["bq_client"] = saved
    else:
        sys.modules.pop("bq_client", None)


NOW = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)


def _run(source="xandr", status="ok", **over):
    run = {
        "source": source,
        "last_run_status": status,
        "last_run_at": (NOW - timedelta(hours=8)).isoformat(),
        "last_error": None,
        "api_last_day": "2026-09-20",
        "lag_days": 0,
        "trailing_zero_days": 0,
    }
    run.update(over)
    return run


# ─── O que DISPARA ───────────────────────────────────────────────────────────
def test_senha_expirada_vira_alerta_de_credencial(alerts):
    """O caso literal: 401 da Xandr com a senha expirada."""
    p = alerts.find_problems([_run(
        status="error",
        last_error="HTTP 401 POST /auth: Your password has expired and must be reset",
    )], NOW)
    assert len(p) == 1
    assert p[0]["kind"] == "credential"
    assert p[0]["credential"] is True
    assert "credencial recusada" in p[0]["headline"].lower()
    # O texto precisa dizer que isto NÃO passa sozinho — é o que separa desta
    # falha de um timeout, e era o que faltava no painel.
    assert "não se resolve sozinho" in p[0]["detail"].lower() \
        or "nao se resolve sozinho" in p[0]["detail"].lower()


def test_erro_generico_alerta_mas_nao_como_credencial(alerts):
    p = alerts.find_problems([_run(
        status="error", last_error="The read operation timed out")], NOW)
    assert len(p) == 1
    assert p[0]["kind"] == "error"
    assert p[0]["credential"] is False


def test_skipped_alerta(alerts):
    """Sem credencial no ambiente o bloco inteiro é pulado — o silêncio que o
    status 'skipped' nasceu pra matar."""
    p = alerts.find_problems([_run(source="pubmatic", status="skipped")], NOW)
    assert len(p) == 1
    assert p[0]["kind"] == "skipped"


def test_cron_morto_alerta(alerts):
    """Sem execução em 26h+: o Scheduler parou. Buraco na grade = infra, e o
    conserto é oposto ao de 'a fonte parou'."""
    p = alerts.find_problems(
        [_run(last_run_at=(NOW - timedelta(hours=30)).isoformat())], NOW)
    assert len(p) == 1
    assert p[0]["kind"] == "no_run"


def test_sem_execucao_nenhuma_alerta(alerts):
    p = alerts.find_problems([_run(last_run_at=None)], NOW)
    assert p[0]["kind"] == "no_run"
    assert "nunca houve execução" in p[0]["detail"]


def test_job_verde_com_base_velha_alerta(alerts):
    """O estado que passou semanas invisível na PubMatic: 'Sync rodou hoje' em
    verde com o dado 2 dias atrás."""
    p = alerts.find_problems(
        [_run(lag_days=2, api_last_day="2026-09-18", trailing_zero_days=0)], NOW)
    assert len(p) == 1
    assert p[0]["kind"] == "stale_data"
    assert "2 dias atrás" in p[0]["headline"]


# ─── O que NÃO dispara ───────────────────────────────────────────────────────
def test_tudo_ok_nao_alerta(alerts):
    assert alerts.find_problems([_run(), _run(source="pubmatic")], NOW) == []


def test_atraso_de_1_dia_nao_alerta(alerts):
    """É o estado normal da manhã (a fonte ainda não fechou D-1) e o painel
    pinta de amarelo. Email aqui tocaria todo dia."""
    assert alerts.find_problems(
        [_run(lag_days=1, api_last_day="2026-09-19")], NOW) == []


def test_zero_explicito_nao_alerta(alerts):
    """Dias que faltam vieram como zero explícito = a fonte fechou o dia e a
    line é que não entregou. Não é atraso de ninguém."""
    assert alerts.find_problems(
        [_run(lag_days=3, api_last_day="2026-09-17", trailing_zero_days=3)], NOW) == []


def test_sem_frescor_medido_nao_inventa_atraso(alerts):
    """lag_days NULL = a fonte não mede (ou o run é antigo). 'Não sei' não vira
    alerta — agir sobre desconhecimento é como este pipeline já errou antes."""
    assert alerts.find_problems(
        [_run(lag_days=None, api_last_day=None)], NOW) == []


# ─── Email ───────────────────────────────────────────────────────────────────
def test_assunto_destaca_credencial(alerts):
    p = alerts.find_problems([_run(
        status="error",
        last_error="HTTP 401 POST /auth: Your password has expired and must be reset",
    )], NOW)
    body = alerts.build_email(p)
    assert "Credencial recusada" in body["subject"]
    assert "Xandr Curate" in body["subject"]
    # O erro cru vai no corpo: é o que responde "por que parou?" sem abrir o
    # Cloud Logging.
    assert "password has expired" in body["text"]
    assert "/admin/pmp" in body["text"]


def test_html_escapa_o_erro_da_api(alerts):
    """O erro vem da API e entra no HTML do email; não pode carregar tag."""
    p = alerts.find_problems([_run(
        status="error", last_error="<script>alert(1)</script> falhou")], NOW)
    body = alerts.build_email(p)
    assert "<script>" not in body["html"]
    assert "&lt;script&gt;" in body["html"]


def test_duas_fontes_num_email_so(alerts):
    p = alerts.find_problems([
        _run(status="error", last_error="HTTP 401 POST /auth: expired"),
        _run(source="pubmatic", lag_days=4, api_last_day="2026-09-16"),
    ], NOW)
    assert len(p) == 2
    body = alerts.build_email(p)
    assert "Xandr Curate" in body["text"] and "PubMatic" in body["text"]


def test_destinatarios_separados_por_virgula(alerts, monkeypatch):
    monkeypatch.setattr(alerts, "PMP_ALERT_TO", "a@hypr.mobi, b@hypr.mobi ")
    assert alerts.recipients() == ["a@hypr.mobi", "b@hypr.mobi"]
