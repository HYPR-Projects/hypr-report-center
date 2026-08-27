"""
Cache de resultados do typeform_proxy — a invariante é NÃO CACHEAR ERRO.

O endpoint pagina as respostas do Typeform (1000 por página) com um token
compartilhado por todo o Report Center, e passou a ser chamado em ciclo pela
aba Survey, que recarrega sozinha. Daí o cache.

Mas cache de resposta de erro seria pior que cache nenhum: um 502 transitório
do Typeform (rate limit, timeout) ficaria SERVIDO por 5 minutos pra todos os
leitores do report, e o retry que resolveria em 1s não aconteceria. Erro tem
que passar direto e a próxima chamada tentar de novo.

Teste estrutural via AST, no espírito do test_pool_isolation: a regressão aqui
é invisível em review (uma linha de `_cache_set` movida pra dentro de um
`except` parece inofensiva) e só aparece em produção como "o report ficou
preso no erro".
"""
import ast
import os

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_PY = os.path.join(BACKEND_DIR, "main.py")

CACHE_NAME = "_typeform_results_cache"


def _tree():
    with open(MAIN_PY, encoding="utf-8") as f:
        return ast.parse(f.read())


def _cache_set_calls(node):
    """Chamadas `_cache_set(_typeform_results_cache, ...)` dentro de `node`."""
    found = []
    for sub in ast.walk(node):
        if not isinstance(sub, ast.Call):
            continue
        func = sub.func
        if not (isinstance(func, ast.Name) and func.id == "_cache_set"):
            continue
        if sub.args and isinstance(sub.args[0], ast.Name) and sub.args[0].id == CACHE_NAME:
            found.append(sub)
    return found


def test_o_cache_do_typeform_existe():
    """Guarda contra o cache simplesmente desaparecer num refactor: sem ele, o
    ciclo de auto-refresh da aba Survey vira paginação nova na API do
    Typeform a cada volta."""
    assert _cache_set_calls(_tree()), (
        f"nenhum _cache_set({CACHE_NAME}, ...) em main.py — o typeform_proxy "
        "voltou a paginar a API do Typeform em toda chamada"
    )


def test_erro_do_typeform_nunca_entra_no_cache():
    tree = _tree()
    total = len(_cache_set_calls(tree))

    dentro_de_except = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.ExceptHandler):
            dentro_de_except += len(_cache_set_calls(node))

    assert total > 0, "pré-condição: o cache tem que existir (ver teste acima)"
    assert dentro_de_except == 0, (
        f"{dentro_de_except} de {total} chamadas de _cache_set({CACHE_NAME}) "
        "estão dentro de um `except`. Resposta de erro cacheada fica servida "
        "por _TYPEFORM_RESULTS_TTL pra TODOS os leitores do report, e o retry "
        "que resolveria na hora não acontece."
    )
