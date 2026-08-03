"""Testes da sanitização das notas internas de campanha.

Só a lógica pura (`sanitize_body`) — o resto do módulo é DML no BigQuery e
não tem o que testar sem cliente.

O contrato que importa: nota vazia (ou só espaço/enter) NÃO pode virar row,
porque o composer manda o que estiver no textarea e uma bolha em branco na
thread não significa nada pra quem lê depois.
"""

import campaign_notes as cn


def test_blank_bodies_collapse_to_empty():
    # O handler recusa com 400 quando sanitize devolve "" — por isso todos
    # esses casos precisam colapsar.
    assert cn.sanitize_body("") == ""
    assert cn.sanitize_body("   ") == ""
    assert cn.sanitize_body("\n\n\n") == ""
    assert cn.sanitize_body(None) == ""
    assert cn.sanitize_body(123) == ""


def test_trims_and_normalizes_line_breaks():
    assert cn.sanitize_body("  pausei no DV360  ") == "pausei no DV360"
    # CRLF do paste de Windows/Sheets vira \n
    assert cn.sanitize_body("linha 1\r\nlinha 2") == "linha 1\nlinha 2"
    # Rajada de linhas em branco colapsa em UMA linha em branco (mantém o
    # parágrafo, mata o scroll infinito dentro da bolha)
    assert cn.sanitize_body("a\n\n\n\n\nb") == "a\n\nb"


def test_truncates_at_max_len():
    body = cn.sanitize_body("x" * (cn.MAX_BODY_LEN + 500))
    assert len(body) == cn.MAX_BODY_LEN


def test_keeps_internal_single_newline_and_content():
    raw = "Cliente pediu pausa até quinta.\nRetomo 09h com criativo novo."
    assert cn.sanitize_body(raw) == raw
