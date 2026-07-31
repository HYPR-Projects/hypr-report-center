"""Testes do write path do sync de Google Sheets (`_write_base_de_dados`).

Cobrem os bugs encontrados/corrigidos no incidente do 502 (jun/2026):
  - write-first: ESCREVE antes de limpar, pra falha não esvaziar a sheet;
  - tail-clear best-effort: 400 "exceeds grid limits" é benigno e ignorado;
  - classificação de erro: 403/404 → revoked; 5xx/429 transiente preserva o
    status; demais 4xx → error.

E o rename de aba (jul/2026): renomear a aba de dados quebrava o sync com
400 "Unable to parse range" e as duas recuperações da UI eram inúteis
("Tentar de novo" falhava igual, "Reconectar" criava planilha nova). Agora
o write reencontra a aba por gid/header e memoriza o novo título.

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


def _parse_range_error(title="Base de Dados"):
    """400 que a Sheets API devolve quando a aba do range não existe
    (título renomeado/apagado)."""
    return HttpError(
        _Resp(400),
        ('{"error": {"message": "Unable to parse range: %s!A1"}}' % title).encode(),
    )


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
    assert ukwargs["range"] == "'Base de Dados'!A1"
    assert ukwargs["valueInputOption"] == "RAW"

    _, ckwargs = values.clear.call_args
    assert ckwargs["range"] == "'Base de Dados'!A4:Z"


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


# ─── Rename da aba de dados ──────────────────────────────────────────────────
HEADER = ["Data", "Campanha", "Line"]


@pytest.fixture
def remember(monkeypatch):
    """Mocka _remember_data_tab (que escreveria no BQ)."""
    m = MagicMock()
    monkeypatch.setattr(si, "_remember_data_tab", m)
    return m


def _svc_with_tabs(tabs, *, missing_title="Base de Dados", header_by_title=None):
    """Mock onde o write no `missing_title` dá 400 parse-range e os outros
    títulos escrevem normalmente. `tabs` = [(gid, title)].
    """
    svc, values = _make_sheets_svc()
    ranges_written = []

    def _update(**kw):
        ranges_written.append(kw["range"])
        m = MagicMock()
        if kw["range"] == f"'{missing_title}'!A1":
            m.execute.side_effect = _parse_range_error(missing_title)
        else:
            m.execute.return_value = {}
        return m

    values.update.side_effect = _update
    svc.spreadsheets.return_value.get.return_value.execute.return_value = {
        "sheets": [{"properties": {"sheetId": g, "title": t}} for g, t in tabs]
    }

    def _batch_get(**kw):
        hb = header_by_title or {}
        m = MagicMock()
        m.execute.return_value = {
            "valueRanges": [
                {"values": [hb.get(r.split("'")[1], [])]} for r in kw["ranges"]
            ]
        }
        return m

    values.batchGet.side_effect = _batch_get
    return svc, values, ranges_written


def test_renamed_tab_found_by_gid(update_status, remember):
    """gid salvo é a âncora: acha a aba mesmo com título novo."""
    svc, values, written = _svc_with_tabs([(7, "README"), (42, "Base de Dados HYPR")])

    si._write_base_de_dados(
        svc, "SID", [HEADER, ["a", "b", "c"]], "tok", si.TARGET_TOKEN, base_gid=42,
    )

    assert written == ["'Base de Dados'!A1", "'Base de Dados HYPR'!A1"]
    remember.assert_called_once_with("tok", si.TARGET_TOKEN, 42, "Base de Dados HYPR")
    # o rabo é limpo na aba certa, e nada é marcado como erro
    _, ckwargs = values.clear.call_args
    assert ckwargs["range"] == "'Base de Dados HYPR'!A3:Z"
    update_status.assert_not_called()


def test_renamed_tab_found_by_header_when_gid_unknown(update_status, remember):
    """Row legacy (sem gid): desempata pelo header, não pela ordem das abas."""
    svc, values, written = _svc_with_tabs(
        [(7, "README"), (1, "Base de Dados Diageo"), (2, "Base de Dados HYPR")],
        header_by_title={
            # aba do cliente: outro template, header diferente
            "Base de Dados Diageo": ["DAT_REFERENCIA", "NOM_CAMPANHA"],
            "Base de Dados HYPR":   HEADER,
        },
    )

    si._write_base_de_dados(svc, "SID", [HEADER], "tok", si.TARGET_TOKEN)

    assert written[-1] == "'Base de Dados HYPR'!A1"
    remember.assert_called_once_with("tok", si.TARGET_TOKEN, 2, "Base de Dados HYPR")
    update_status.assert_not_called()


def test_no_data_tab_marks_error_and_does_not_touch_other_tabs(update_status, remember):
    """Aba apagada/planilha repurposed: erro acionável, sem escrever em aba
    aleatória do cliente."""
    svc, values, written = _svc_with_tabs(
        [(9, "Sitelist")], header_by_title={"Sitelist": ["Site", "Imps"]},
    )

    with pytest.raises(HttpError):
        si._write_base_de_dados(svc, "SID", [HEADER], "tok", si.TARGET_TOKEN)

    assert written == ["'Base de Dados'!A1"], "não deve escrever em outra aba"
    _, kwargs = update_status.call_args
    assert kwargs.get("status") == "error"
    assert "aba de dados não encontrada" in kwargs.get("last_error", "")
    remember.assert_not_called()
