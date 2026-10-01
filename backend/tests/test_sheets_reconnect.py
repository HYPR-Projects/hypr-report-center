"""Testes do caminho de token/reconexão do Google Sheets.

Incidente de set/2026 (PPV8JF): o token da integração morreu no 1º cron
(invalid_grant) e o card ficou vermelho. Três problemas em volta disso:
  - um único invalid_grant já marcava `revoked`, sem 2ª tentativa;
  - `revoked`/`error` saíam do cron pra sempre — nada se auto-curava;
  - "Reconectar" sempre criava planilha nova, deixando o link que o
    cliente já tinha parado.

Nenhum teste faz I/O real: urlopen, BQ, KMS e Sheets API são mockados.
"""
import io
import json
import urllib.error

import pytest
from unittest.mock import MagicMock
from googleapiclient.errors import HttpError

import sheets_integration as si


class _Resp:
    def __init__(self, status):
        self.status = status
        self.reason = "test-error"

    def get(self, key, default=None):
        return default


def _invalid_grant(desc="Token has been expired or revoked."):
    body = json.dumps({"error": "invalid_grant", "error_description": desc}).encode()
    return urllib.error.HTTPError(si.GOOGLE_TOKEN_URL, 400, "Bad Request", {}, io.BytesIO(body))


class _OkResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _ok(token="AT"):
    return _OkResp(json.dumps({"access_token": token}).encode())


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(si.time, "sleep", lambda s: None)


# ─── invalid_grant ───────────────────────────────────────────────────────────
def test_invalid_grant_blip_recovers_on_retry(monkeypatch):
    calls = iter([_invalid_grant(), _ok("AT2")])

    def fake_urlopen(req, timeout=None):
        r = next(calls)
        if isinstance(r, Exception):
            raise r
        return r

    monkeypatch.setattr(si.urllib.request, "urlopen", fake_urlopen)
    assert si._refresh_access_token("RT") == "AT2"


def test_invalid_grant_twice_raises_with_google_reason(monkeypatch):
    n = {"calls": 0}

    def fake_urlopen(req, timeout=None):
        n["calls"] += 1
        raise _invalid_grant()

    monkeypatch.setattr(si.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(PermissionError) as exc:
        si._refresh_access_token("RT")
    assert n["calls"] == 2, "confirma numa 2ª tentativa antes de desistir"
    assert "Token has been expired or revoked." in str(exc.value)


def test_other_http_error_is_not_retried(monkeypatch):
    n = {"calls": 0}

    def fake_urlopen(req, timeout=None):
        n["calls"] += 1
        raise urllib.error.HTTPError(
            si.GOOGLE_TOKEN_URL, 401, "Unauthorized", {},
            io.BytesIO(b'{"error": "invalid_client"}'),
        )

    monkeypatch.setattr(si.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError):
        si._refresh_access_token("RT")
    assert n["calls"] == 1


def test_exchange_or_mark_records_google_reason(monkeypatch):
    def boom(rt):
        raise PermissionError("invalid_grant: Token has been expired or revoked.")

    update = MagicMock()
    monkeypatch.setattr(si, "_refresh_access_token", boom)
    monkeypatch.setattr(si, "_update_status", update)

    with pytest.raises(PermissionError):
        si._exchange_or_mark("RT", "TOK", si.TARGET_TOKEN)
    _, kwargs = update.call_args
    assert kwargs["status"] == "revoked"
    assert "Token has been expired or revoked." in kwargs["last_error"]


# ─── Cron re-tenta error/revoked ─────────────────────────────────────────────
def test_cron_selects_error_and_revoked_for_retry(monkeypatch):
    bq = MagicMock()
    bq.query.return_value.result.return_value = []
    monkeypatch.setattr(si, "_bq_client", lambda: bq)
    monkeypatch.setattr(si, "ensure_table_exists", lambda: None)

    si.list_active_integrations()

    sql = bq.query.call_args[0][0]
    assert "status IN ('active', 'error', 'revoked')" in sql
    assert "sync_until >= CURRENT_DATE" in sql, "fora da janela continua fora"


# ─── Reconexão mantém a planilha ─────────────────────────────────────────────
@pytest.fixture
def reattach_env(monkeypatch):
    bq = MagicMock()
    monkeypatch.setattr(si, "_bq_client", lambda: bq)
    monkeypatch.setattr(si, "_encrypt", lambda s: b"enc:" + s.encode())
    monkeypatch.setattr(si, "_refresh_access_token", lambda rt: "AT")
    svc = MagicMock()
    monkeypatch.setattr(si, "_build_sheets_client", lambda at: svc)
    monkeypatch.setattr(
        si, "get_integration",
        lambda target_id, target_type=None: {
            "spreadsheet_id": "OLD", "spreadsheet_url": "https://sheet/OLD",
        },
    )
    return bq, svc


def test_reattach_keeps_existing_sheet(reattach_env):
    bq, svc = reattach_env

    out = si.reattach_existing_sheet("TOK", si.TARGET_TOKEN, "NEW_RT", "cs@hypr.mobi")

    assert out == {"spreadsheet_id": "OLD", "spreadsheet_url": "https://sheet/OLD"}
    sql = bq.query.call_args[0][0]
    assert "UPDATE" in sql and "status            = 'active'" in sql
    params = {p.name: p.value for p in bq.query.call_args[1]["job_config"].query_parameters}
    assert params["refresh_token_enc"] == b"enc:NEW_RT"
    assert params["created_by_email"] == "cs@hypr.mobi"


@pytest.mark.parametrize("status", [403, 404])
def test_reattach_falls_back_when_sheet_inaccessible(reattach_env, status):
    bq, svc = reattach_env
    svc.spreadsheets.return_value.get.return_value.execute.side_effect = HttpError(
        _Resp(status), b'{"error": {"message": "nope"}}',
    )

    assert si.reattach_existing_sheet("TOK", si.TARGET_TOKEN, "RT", "cs@hypr.mobi") is None
    bq.query.assert_not_called()


def test_reattach_propagates_transient_errors(reattach_env):
    bq, svc = reattach_env
    svc.spreadsheets.return_value.get.return_value.execute.side_effect = HttpError(
        _Resp(503), b'{"error": {"message": "unavailable"}}',
    )

    with pytest.raises(HttpError):
        si.reattach_existing_sheet("TOK", si.TARGET_TOKEN, "RT", "cs@hypr.mobi")
    bq.query.assert_not_called()


def test_reattach_without_previous_sheet_returns_none(monkeypatch):
    monkeypatch.setattr(si, "get_integration", lambda target_id, target_type=None: None)
    assert si.reattach_existing_sheet("TOK", si.TARGET_TOKEN, "RT", "cs@hypr.mobi") is None


# ─── invalid_rapt (2º incidente PPV8JF, out/2026) ────────────────────────────
def test_invalid_rapt_reason_is_kept(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise _invalid_grant("reauth related error (invalid_rapt)")

    monkeypatch.setattr(si.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(PermissionError) as exc:
        si._refresh_access_token("RT")
    assert "invalid_rapt" in str(exc.value)


# ─── SA escreve o sync ───────────────────────────────────────────────────────
def test_sync_client_prefers_service_account(monkeypatch):
    sa_svc = MagicMock()
    monkeypatch.setattr(si, "_build_sa_sheets_client", lambda: sa_svc)

    def token_must_not_be_used(*a):
        raise AssertionError("token do membro não deveria ser tocado")

    monkeypatch.setattr(si, "_resolve_refresh_token", token_must_not_be_used)
    monkeypatch.setattr(si, "_exchange_or_mark", token_must_not_be_used)

    svc = si._sheets_client_for_sync({"spreadsheet_id": "S1"}, "TOK", si.TARGET_TOKEN)
    assert svc is sa_svc


@pytest.mark.parametrize("status", [403, 404])
def test_sync_client_falls_back_to_member_and_shares(monkeypatch, status):
    sa_svc = MagicMock()
    sa_svc.spreadsheets.return_value.get.return_value.execute.side_effect = HttpError(
        _Resp(status), b'{"error": {"message": "no access"}}',
    )
    monkeypatch.setattr(si, "_build_sa_sheets_client", lambda: sa_svc)
    monkeypatch.setattr(si, "_resolve_refresh_token", lambda *a: "RT")
    monkeypatch.setattr(si, "_exchange_or_mark", lambda *a: "AT")
    user_svc = MagicMock()
    monkeypatch.setattr(si, "_build_sheets_client", lambda at: user_svc)
    share = MagicMock(return_value=True)
    monkeypatch.setattr(si, "_share_with_service_account", share)

    svc = si._sheets_client_for_sync({"spreadsheet_id": "S1"}, "TOK", si.TARGET_TOKEN)
    assert svc is user_svc
    share.assert_called_once_with("S1", "AT")


def test_sync_client_dead_token_without_sa_still_revokes(monkeypatch):
    # SA sem credencial/acesso (stub do conftest) + token morto → revoked.
    monkeypatch.setattr(si, "_resolve_refresh_token", lambda *a: "RT")

    def dead(*a):
        raise PermissionError("invalid_grant: reauth related error (invalid_rapt)")

    monkeypatch.setattr(si, "_exchange_or_mark", dead)
    with pytest.raises(PermissionError):
        si._sheets_client_for_sync({"spreadsheet_id": "S1"}, "TOK", si.TARGET_TOKEN)


def test_share_with_service_account_grants_writer(monkeypatch):
    drive = MagicMock()
    monkeypatch.setattr(si, "_build_drive_client", lambda at: drive)

    assert si._share_with_service_account("S1", "AT") is True
    _, kwargs = drive.permissions.return_value.create.call_args
    assert kwargs["fileId"] == "S1"
    assert kwargs["body"] == {
        "role": "writer", "type": "user",
        "emailAddress": "sa@test.iam.gserviceaccount.com",
    }
    assert kwargs["sendNotificationEmail"] is False


def test_share_with_service_account_is_best_effort(monkeypatch):
    drive = MagicMock()
    drive.permissions.return_value.create.return_value.execute.side_effect = HttpError(
        _Resp(403), b'{"error": {"message": "sharing restricted"}}',
    )
    monkeypatch.setattr(si, "_build_drive_client", lambda at: drive)
    assert si._share_with_service_account("S1", "AT") is False


def test_reattach_shares_old_sheet_with_sa(reattach_env, monkeypatch):
    share = MagicMock(return_value=True)
    monkeypatch.setattr(si, "_share_with_service_account", share)

    si.reattach_existing_sheet("TOK", si.TARGET_TOKEN, "NEW_RT", "cs@hypr.mobi")
    share.assert_called_once_with("OLD", "AT")


def test_reattach_by_other_account_keeps_sheet_when_sa_has_access(reattach_env, monkeypatch):
    bq, svc = reattach_env
    svc.spreadsheets.return_value.get.return_value.execute.side_effect = HttpError(
        _Resp(404), b'{"error": {"message": "not found"}}',
    )
    monkeypatch.setattr(si, "_build_sa_sheets_client", lambda: MagicMock())

    out = si.reattach_existing_sheet("TOK", si.TARGET_TOKEN, "RT_OUTRA_CONTA", "outro@hypr.mobi")
    assert out == {"spreadsheet_id": "OLD", "spreadsheet_url": "https://sheet/OLD"}
    params = {p.name: p.value for p in bq.query.call_args[1]["job_config"].query_parameters}
    assert params["refresh_token_enc"] == b"enc:RT_OUTRA_CONTA"


@pytest.mark.parametrize("status,body,unusable", [
    (403, b'{"error": {"message": "forbidden"}}', True),
    (404, b'{"error": {"message": "not found"}}', True),
    (400, b'{"error": {"message": "Unable to parse range: Base"}}', True),
    (400, b'{"error": {"message": "Invalid value"}}', False),
    (502, b'{"error": {"message": "bad gateway"}}', False),
])
def test_is_sheet_unusable(status, body, unusable):
    assert si.is_sheet_unusable(HttpError(_Resp(status), body)) is unusable


def test_is_sheet_unusable_ignores_non_http_errors():
    assert si.is_sheet_unusable(PermissionError("invalid_grant")) is False
    assert si.is_sheet_unusable(TimeoutError()) is False


def test_new_sheet_is_shared_with_sa(monkeypatch):
    sheets = MagicMock()
    sheets.spreadsheets.return_value.create.return_value.execute.return_value = {
        "spreadsheetId": "NEW", "spreadsheetUrl": "https://sheet/NEW",
        "sheets": [
            {"properties": {"title": si.README_TAB_TITLE, "sheetId": 1}},
            {"properties": {"title": si.BASE_TAB_TITLE, "sheetId": 2}},
        ],
    }
    monkeypatch.setattr(si, "_build_sheets_client", lambda at: sheets)
    drive = MagicMock()
    monkeypatch.setattr(si, "_build_drive_client", lambda at: drive)
    monkeypatch.setattr(si, "DRIVE_FOLDER_ID", "")

    si._create_spreadsheet_with_payload(title="T", payload=[["Data"]], access_token="AT")

    bodies = [c[1]["body"] for c in drive.permissions.return_value.create.call_args_list]
    assert {"role": "reader", "type": "anyone"} in bodies
    assert {"role": "writer", "type": "user",
            "emailAddress": "sa@test.iam.gserviceaccount.com"} in bodies
