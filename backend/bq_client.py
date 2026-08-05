"""
Client BigQuery único do backend — com timeout obrigatório e pool HTTP
dimensionado pro nível de paralelismo real da Cloud Function.

Por que existe
--------------
Antes, `main.py` tinha o wrapper de timeout (`_TimeoutBQClient`) mas cada um dos
outros 11 módulos (`campaign_notes`, `merges`, `client_portal`, `owners`,
`access_tracking`, `shares`, `pmp_*`, `audit_log`…) fazia `bq = bigquery.Client()`
cru. Resultado:

  1. Só o report path estava blindado. Uma query pendurada em QUALQUER módulo
     fora do main prendia a thread indefinidamente — exatamente o modo de falha
     que derrubou a instância em 04/06 e de novo em 04/08.
  2. Doze clients = doze `requests.Session`, cada uma com pool_maxsize=10
     (default do urllib3). Com 16 threads no `_query_pool` + 10 requests
     concorrentes, os logs viviam cuspindo
     "Connection pool is full, discarding connection: bigquery.googleapis.com" —
     conexão descartada é TLS handshake refeito a cada query, latência à toa
     justamente sob rajada, que é quando dói.

Aqui o client é um só, criado uma vez por instância, e todo módulo pega o mesmo
via `get_client()`.

Contrato
--------
- `.query()` injeta `job_timeout_ms` (BQ aborta server-side) e força `timeout`
  no `.result()` (o cliente para de esperar). Um job pendurado vira exceção
  tratável em vez de deadlock.
- Todo o resto (`get_table`, `insert_rows_json`, `load_table_from_json`…) passa
  direto pro client real via `__getattr__`.
- O tuning do pool é best-effort: se a montagem da sessão autenticada falhar por
  qualquer motivo, caímos no client default. Perda de performance, nunca de
  funcionalidade.
"""

import logging
import threading

import requests
from google.cloud import bigquery

logger = logging.getLogger(__name__)

# BQ aborta a query após 120s; o cliente desiste de esperar em 130s. A folga
# entre os dois é de propósito: o erro que sobe é o do BQ ("job cancelled"),
# mais informativo que um timeout genérico de socket.
BQ_JOB_TIMEOUT_MS   = 120_000
BQ_RESULT_TIMEOUT_S = 130

# Conexões HTTP reutilizáveis por instância. Precisa cobrir os 16 workers do
# _query_pool + as threads de request que consultam o BQ direto, com folga.
_POOL_SIZE = 40


class _TimeoutQueryJob:
    """Proxy de QueryJob que aplica um timeout padrão no .result()."""
    __slots__ = ("_job",)

    def __init__(self, job):
        self._job = job

    def result(self, *args, **kwargs):
        kwargs.setdefault("timeout", BQ_RESULT_TIMEOUT_S)
        return self._job.result(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._job, name)


class TimeoutBQClient:
    """Proxy de bigquery.Client que força timeout em toda query."""

    def __init__(self, client):
        self._client = client

    def query(self, sql, *args, **kwargs):
        job_config = kwargs.get("job_config") or bigquery.QueryJobConfig()
        if getattr(job_config, "job_timeout_ms", None) is None:
            job_config.job_timeout_ms = BQ_JOB_TIMEOUT_MS
        kwargs["job_config"] = job_config
        return _TimeoutQueryJob(self._client.query(sql, *args, **kwargs))

    def __getattr__(self, name):
        return getattr(self._client, name)


def _build_raw_client():
    """bigquery.Client com pool HTTP maior. Falha → client default."""
    try:
        import google.auth
        from google.auth.transport.requests import AuthorizedSession

        credentials, project = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        session = AuthorizedSession(credentials)
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=_POOL_SIZE, pool_maxsize=_POOL_SIZE
        )
        session.mount("https://", adapter)
        return bigquery.Client(credentials=credentials, project=project, _http=session)
    except Exception as e:  # noqa: BLE001 — degradação intencional
        logger.warning(f"[bq_client] pool tunado indisponível ({e}); usando client default")
        return bigquery.Client()


_client = None
_lock = threading.Lock()


def get_client() -> TimeoutBQClient:
    """Singleton por instância da Cloud Function."""
    global _client
    if _client is not None:
        return _client
    with _lock:
        if _client is None:
            _client = TimeoutBQClient(_build_raw_client())
    return _client
