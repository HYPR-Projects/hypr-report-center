"""Testes do write path do sync de Google Sheets (`_write_base_de_dados`).

Cobrem os bugs encontrados/corrigidos no incidente do 502 (jun/2026):
  - write-first: ESCREVE antes de limpar, pra falha não esvaziar a sheet;
  - tail-clear best-effort: 400 "exceeds grid limits" é benigno e ignorado;
  - classificação de erro: 403/404 → revoked; 5xx/429 transiente preserva o
    status; demais 4xx → error.

O `sheets_svc` e o `_update_status` (que toca BQ) são mockados — nenhum teste
faz I/O real.
"""
import pytest
from unittest.mock import MagicMock
from googleapiclient.errors import HttpError

import sheets_integration as si


# ─── Helpers ──────────────────────────────────────────────────────────────────
class _Resp:
    """httplib2.Response-like mínimo pro HttpError (precisa de status/reason)."""
    def __init__(self, status):
        self.status = status
        self.reason = "test-error"

    def get(self, key, default=None):
        return default


def _http_error(status):
    return HttpError(_Resp(status), b'{"error": {"message": "boom"}}')


def _make_sheets_svc():
    """Mock expondo spreadsheets().values().update()/clear().execute()."""
    svc = MagicMock()
    values = svc.spreadsheets.return_value.values.return_value
    return svc, values


@pytest.fixture
def update_status(monkeypatch):
    """Mocka _update_status (que escreveria no BQ) e devolve o mock."""
    m = MagicMock()
    monkeypatch.setattr(si, "_update_status", m)
    return m


# ─── Write-first ────────────────────────────────────────────────────────────
def test_write_happens_before_clear(update_status):
    svc, values = _make_sheets_svc()
    order = []
    values.update.return_value.execute.side_effect = lambda **k: order.append("update")
    values.clear.return_value.execute.side_effect = lambda **k: order.append("clear")

    si._write_base_de_dados(svc, "SID", [["h"], ["a"]], "tok", si.TARGET_TOKEN)

    assert order == ["update", "clear"], "write tem que vir ANTES do clear"
    update_status.assert_not_called()


def test_update_writes_from_a1_and_clear_below_payload(update_status):
    svc, values = _make_sheets_svc()
    # payload com 3 linhas → limpa a partir da linha 4
    si._write_base_de_dados(svc, "SID", [["h"], ["1"], ["2"]], "tok", si.TARGET_TOKEN)

    _, ukwargs = values.update.call_args
    assert ukwargs["range"] == "Base de Dados!A1"
    assert ukwargs["valueInputOption"] == "RAW"

    _, ckwargs = values.clear.call_args
    assert ckwargs["range"] == "Base de Dados!A4:Z"


# ─── Tail-clear best-effort ──────────────────────────────────────────────────
def test_tail_clear_400_grid_limit_is_swallowed(update_status):
    svc, values = _make_sheets_svc()
    values.update.return_value.execute.return_value = {}
    # 400 "exceeds grid limits" no clear do rabo — benigno
    values.clear.return_value.execute.side_effect = _http_error(400)

    # NÃO deve levantar: o dado já foi escrito no passo 1
    si._write_base_de_dados(svc, "SID", [["h"]], "tok", si.TARGET_TOKEN)

    update_status.assert_not_called()


# ─── Classificação de erro no write (passo crítico) ──────────────────────────
def test_transient_5xx_preserves_status(update_status):
    svc, values = _make_sheets_svc()
    values.update.return_value.execute.side_effect = _http_error(502)

    with pytest.raises(HttpError):
        si._write_base_de_dados(svc, "SID", [["h"]], "mid", si.TARGET_MERGE)

    # 502 transiente: registra last_error mas NÃO muda o status (preserva)
    assert update_status.call_count == 1
    _, kwargs = update_status.call_args
    assert kwargs.get("status") is None, "5xx transiente não deve mexer no status"
    assert kwargs.get("last_error")


@pytest.mark.parametrize("status", [403, 404])
def test_permanent_403_404_marks_revoked(update_status, status):
    svc, values = _make_sheets_svc()
    values.update.return_value.execute.side_effect = _http_error(status)

    with pytest.raises(HttpError):
        si._write_base_de_dados(svc, "SID", [["h"]], "tok", si.TARGET_TOKEN)

    _, kwargs = update_status.call_args
    assert kwargs.get("status") == "revoked"


def test_other_4xx_marks_error(update_status):
    svc, values = _make_sheets_svc()
    values.update.return_value.execute.side_effect = _http_error(400)

    with pytest.raises(HttpError):
        si._write_base_de_dados(svc, "SID", [["h"]], "tok", si.TARGET_TOKEN)

    _, kwargs = update_status.call_args
    assert kwargs.get("status") == "error"
