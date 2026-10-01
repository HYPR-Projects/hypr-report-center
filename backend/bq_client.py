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

import taxonomy

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


def _map_table(ref):
    """Leva um identificador de tabela pro nome físico da taxonomia
    (BQ_TABLE_LAYOUT=taxonomy, ver taxonomy.py). Aceita "p.d.t", "p:d.t",
    "d.t" (com ou sem decorator $partição), TableReference e Table. Fora do mapa,
    ou com a variável desligada, devolve o mesmo objeto."""
    if isinstance(ref, str):
        base, sep, deco = ref.partition("$")
        sep_proj = ":" if ":" in base else "."
        parts = base.replace(":", ".").split(".")
        if len(parts) < 2:
            return ref
        d, t = taxonomy.loc(parts[-2], parts[-1])
        if (d, t) == (parts[-2], parts[-1]):
            return ref
        head = parts[:-2]
        if head and sep_proj == ":":
            return f"{'.'.join(head)}:{d}.{t}{sep}{deco}"
        return ".".join(head + [d, t]) + sep + deco
    if isinstance(ref, bigquery.TableReference):
        base, sep, deco = ref.table_id.partition("$")
        d, t = taxonomy.loc(ref.dataset_id, base)
        if (d, t) == (ref.dataset_id, base):
            return ref
        return bigquery.TableReference(bigquery.DatasetReference(ref.project, d), t + sep + deco)
    if isinstance(ref, bigquery.Table):
        tr = ref._properties.get("tableReference") or {}
        d, t = taxonomy.loc(tr.get("datasetId", ""), tr.get("tableId", ""))
        if (d, t) != (tr.get("datasetId"), tr.get("tableId")):
            tr["datasetId"], tr["tableId"] = d, t
        return ref
    return ref


class TimeoutBQClient:
    """Proxy de bigquery.Client que força timeout em toda query.

    Também é o ponto único da taxonomia: com BQ_TABLE_LAYOUT=taxonomy, SQL e
    identificadores de tabela que citam um nome antigo do Report Center vão
    pro nome novo (taxonomy.py). Sem a variável é passagem direta."""

    def __init__(self, client):
        self._client = client

    def query(self, sql, *args, **kwargs):
        job_config = kwargs.get("job_config") or bigquery.QueryJobConfig()
        if getattr(job_config, "job_timeout_ms", None) is None:
            job_config.job_timeout_ms = BQ_JOB_TIMEOUT_MS
        if getattr(job_config, "destination", None) is not None:
            job_config.destination = _map_table(job_config.destination)
        kwargs["job_config"] = job_config
        return _TimeoutQueryJob(self._client.query(taxonomy.fq_sql(sql), *args, **kwargs))

    # ── métodos cujo 1º argumento é a tabela ──
    def get_table(self, table, *a, **k):         return self._client.get_table(_map_table(table), *a, **k)
    def delete_table(self, table, *a, **k):      return self._client.delete_table(_map_table(table), *a, **k)
    def create_table(self, table, *a, **k):      return self._client.create_table(_map_table(table), *a, **k)
    def update_table(self, table, *a, **k):      return self._client.update_table(_map_table(table), *a, **k)
    def list_rows(self, table, *a, **k):         return self._client.list_rows(_map_table(table), *a, **k)
    def insert_rows(self, table, *a, **k):       return self._client.insert_rows(_map_table(table), *a, **k)
    def insert_rows_json(self, table, *a, **k):  return self._client.insert_rows_json(_map_table(table), *a, **k)

    # ── loads: a tabela é o 2º argumento (destination) ──
    def _load(self, meth, source, destination, *a, **k):
        return getattr(self._client, meth)(source, _map_table(destination), *a, **k)
    def load_table_from_json(self, rows, destination, *a, **k):      return self._load("load_table_from_json", rows, destination, *a, **k)
    def load_table_from_dataframe(self, df, destination, *a, **k):   return self._load("load_table_from_dataframe", df, destination, *a, **k)
    def load_table_from_file(self, f, destination, *a, **k):         return self._load("load_table_from_file", f, destination, *a, **k)
    def load_table_from_uri(self, uris, destination, *a, **k):       return self._load("load_table_from_uri", uris, destination, *a, **k)

    def copy_table(self, sources, destination, *a, **k):
        srcs = [_map_table(x) for x in sources] if isinstance(sources, (list, tuple)) else _map_table(sources)
        return self._client.copy_table(srcs, _map_table(destination), *a, **k)

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
