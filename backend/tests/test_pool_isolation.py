"""
Guarda da invariante que causou o incidente de 04/08.

REGRA: nenhuma task submetida ao `_query_pool` pode bloquear esperando outra
task do `_query_pool`. Quebrar isso trava a instância PERMANENTEMENTE (os
workers ficam todos esperando por sub-tasks que nunca serão agendadas) e, com
`--min-instances=1`, o Cloud Run mantém a instância morta recebendo tráfego —
foi assim que o Report Center serviu 504 em tudo por 16h.

Os testes aqui são estruturais de propósito. Reproduzir o deadlock de verdade
exigiria saturar o pool com I/O real, e um teste que trava é pior que teste
nenhum. O que dá pra garantir barato — e é onde a regressão realmente
aconteceria — é que os call sites conhecidos continuem no pool certo.
"""

import ast
import os
import re

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_PY = os.path.join(BACKEND_DIR, "main.py")


def _source():
    with open(MAIN_PY, encoding="utf-8") as f:
        return f.read()


def _function_source(tree, source, name):
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return ast.get_source_segment(source, node) or ""
    raise AssertionError(f"função {name}() não encontrada em main.py")


def test_fanout_de_merge_nao_usa_query_pool():
    """`compose_merged_report` e `_get_merge_meta_only` rodam um report INTEIRO
    por membro do grupo — cada task bloqueia em folhas do `_query_pool`. Elas
    têm que viver no `_fanout_pool`, senão o aninhamento volta."""
    source = _source()
    tree = ast.parse(source)
    for fn in ("compose_merged_report", "_get_merge_meta_only"):
        body = _function_source(tree, source, fn)
        assert "_fanout_pool.submit(_get_report_cached" in body, (
            f"{fn}() deve despachar o fan-out no _fanout_pool"
        )
        assert "_query_pool.submit(_get_report_cached" not in body, (
            f"{fn}() voltou a usar o _query_pool pro fan-out — isso recria o "
            "deadlock de 04/08 (ver o bloco de pools em main.py)"
        )


def test_query_totals_nao_e_submetida_ao_pool():
    """`query_totals` submete duas queries ao `_query_pool` e bloqueia nelas.
    Rodando ela mesma como task, vira um nível de aninhamento."""
    source = _source()
    assert "_query_pool.submit(query_totals" not in source, (
        "query_totals voltou a ser submetida ao _query_pool — ela bloqueia em "
        "sub-tasks do mesmo pool. Deve rodar inline na thread do caller."
    )


def test_todo_result_de_future_tem_timeout():
    """Um `.result()` sem timeout transforma qualquer trava de upstream em
    thread perdida pra sempre. Vale pros futures de pool em main.py."""
    lines = _source().splitlines()
    offenders = []
    for i, line in enumerate(lines, start=1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        # futures nomeados (fut_x.result()) ou colhidos de dict/compreensão
        if not re.search(r"\b(fut[a-z_]*|f)\.result\(\)", stripped):
            continue
        # Exceção legítima: dentro de `as_completed(...)` o future JÁ terminou,
        # então .result() retorna na hora — não tem como pendurar. O timeout
        # ali é o do próprio as_completed.
        window = "\n".join(lines[max(0, i - 6):i])
        if "as_completed(" in window:
            continue
        offenders.append(f"main.py:{i}: {stripped}")
    assert not offenders, (
        "future.result() sem timeout encontrado:\n  " + "\n  ".join(offenders)
    )


def test_pools_sao_executores_distintos():
    source = _source()
    assert 'ThreadPoolExecutor(max_workers=16, thread_name_prefix="bq-fetch")' in source
    assert 'ThreadPoolExecutor(max_workers=4, thread_name_prefix="merge-fanout")' in source


def test_healthz_responde_antes_de_qualquer_auth():
    """A liveness probe do Cloud Run bate sem credencial. Se o handler de
    healthz cair depois de algum `authenticate_admin`, a probe passa a falhar
    sempre e o Cloud Run recicla a instância em loop."""
    source = _source()
    handler_at = source.index("def report_data(request):")
    healthz_at = source.index('request.args.get("action") == "healthz"')
    first_auth_at = source.index("authenticate_admin(request)", handler_at)
    assert handler_at < healthz_at < first_auth_at, (
        "o handler de healthz precisa vir antes do primeiro authenticate_admin"
    )
