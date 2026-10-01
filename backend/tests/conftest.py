"""Coloca o diretório `backend/` no sys.path pra os testes importarem os
módulos (`sheets_integration`, `sheets_alerts`, ...) sem precisar de pacote."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


import pytest


@pytest.fixture(autouse=True)
def _no_real_service_account(monkeypatch):
    """O CI roda com credencial GCP de verdade. Sem isso, um teste que passe
    pelo sync/criação de planilha chamaria a Sheets/Drive API como a SA.
    Testes que exercitam o caminho da SA sobrescrevem estes stubs."""
    try:
        import sheets_integration as si
    except Exception:
        return

    def _sa_disabled():
        raise RuntimeError("SA desabilitada em teste")

    monkeypatch.setattr(si, "_build_sa_sheets_client", _sa_disabled)
    monkeypatch.setattr(si, "_service_account_email", lambda: "sa@test.iam.gserviceaccount.com")
    monkeypatch.setattr(si, "_build_drive_client", lambda at: _sa_disabled())
