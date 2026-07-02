"""Testes do port Python de buildCompplanRows (compplan_sheet.py).

A fonte da verdade da regra é src/v2/admin/lib/compplanExport.js — estes
testes cravam o comportamento esperado do espelho backend: colapso de grupo
no PI compartilhado, PI líquido, faixas do Compp (0,75% ≥99% / 0,25%),
status em inglês, filtros (archived/cancelado) e ordenação cronológica.

Funções puras sobre dicts — nenhum teste faz I/O.
"""
from decimal import Decimal

import compplan_sheet as cs


def _line(**over):
    base = {
        "line_id": 1,
        "group_id": None,
        "group_name": None,
        "customer": "ACME",
        "campaign_name": "ACME Always-On",
        "deal_ids": ["D-1"],
        "start_date": "2026-05-06",
        "status": "Andamento",
        "delivery_status": "running",
        "is_archived": False,
        "pi_brl": 100000,
        "imps": 1_000_000,
        "curator_total_cost": 40000,
        "curator_revenue": 99500,
        "curator_margin": 59500,
    }
    base.update(over)
    return base


# ─── effective_status / quarter_label ────────────────────────────────────────
def test_effective_status_override_manual_ganha():
    assert cs.effective_status({"status": "Revisão", "delivery_status": "ended"}) == "Revisão"


def test_effective_status_pendente_deriva_do_delivery():
    assert cs.effective_status({"status": "Pendente", "delivery_status": "live"}) == "Andamento"
    assert cs.effective_status({"status": None, "delivery_status": "slowing"}) == "Pausado"
    assert cs.effective_status({"status": "Pendente", "delivery_status": "ended"}) == "Finalizado"
    assert cs.effective_status({"status": None, "delivery_status": "scheduled"}) == "Pendente"


def test_quarter_label():
    assert cs.quarter_label("2026-05-06") == "Q2 - 26"
    assert cs.quarter_label("2025-12-31") == "Q4 - 25"
    assert cs.quarter_label(None) == ""
    assert cs.quarter_label("") == ""


# ─── build_compplan_rows ─────────────────────────────────────────────────────
def test_row_basica_calculos():
    [row] = cs.build_compplan_rows([_line()])
    assert row["Customer"] == "ACME"
    assert row["Deal ID"] == "D-1"
    assert row["Flight Date"] == "Q2 - 26"
    assert row["Client PI Negotiation"] == 100000
    assert row["Client PI Net"] == round(100000 * cs.PI_NET_FACTOR, 2)
    assert row["Status"] == "Running"
    # 99500/100000 = 99.5% ≥ 99% → faixa cheia 0,75% do PI líquido
    assert row["Compp"] == round(83470.0 * cs.COMPP_FULL_RATE, 2)
    assert row["% Delivery Rev."] == 99500 / 100000
    assert row["eCPM"] == round(99500 * 1000 / 1_000_000, 2)


def test_compp_zerado_abaixo_de_99():
    # Regra 2026-07-02: abaixo de 99% de %Delivery Rev não há comp nenhum
    # (a faixa parcial de 0,25% deixou de existir) → célula em branco.
    [row] = cs.build_compplan_rows([_line(curator_revenue=90000)])
    assert row["Compp"] == ""


def test_compp_em_branco_sem_delivery_ou_sem_pi():
    [not_started] = cs.build_compplan_rows([_line(curator_revenue=0, curator_margin=0)])
    assert not_started["Compp"] == ""
    [sem_pi] = cs.build_compplan_rows([_line(pi_brl=None)])
    assert sem_pi["Compp"] == ""
    assert sem_pi["Client PI Negotiation"] == ""


def test_grupo_colapsa_com_pi_compartilhado():
    a = _line(line_id=1, group_id="g1", group_name="ACME Q2 (Fixed+Flex)",
              pi_brl=None, deal_ids=["D-1"], imps=600_000,
              curator_revenue=60000, curator_margin=35000, curator_total_cost=25000)
    b = _line(line_id=2, group_id="g1", group_name="ACME Q2 (Fixed+Flex)",
              pi_brl=Decimal("120000"), deal_ids=["D-2", "D-1"], imps=400_000,
              curator_revenue=59000, curator_margin=34000, curator_total_cost=25000,
              start_date="2026-04-20")
    [row] = cs.build_compplan_rows([a, b])
    # PI do grupo = primeiro membro com pi_brl>0 (não cegar no members[0])
    assert row["Client PI Negotiation"] == 120000.0
    assert row["Campaign Total"] == "ACME Q2 (Fixed+Flex)"
    assert row["Impressions"] == 1_000_000
    assert row["Curator Revenue"] == 119000
    # deal_ids dedupe preservando ordem
    assert row["Deal ID"] == "D-1, D-2"
    # start = mais antiga do grupo
    assert row["Flight Date"] == "Q2 - 26"
    # 119000/120000 = 99.17% ≥ 99% → faixa cheia
    assert row["Compp"] == round(round(120000 * cs.PI_NET_FACTOR, 2) * cs.COMPP_FULL_RATE, 2)


def test_status_do_grupo_mais_vivo_ganha():
    a = _line(line_id=1, group_id="g1", status="Finalizado", delivery_status="ended")
    b = _line(line_id=2, group_id="g1", status="Andamento", delivery_status="running")
    [row] = cs.build_compplan_rows([a, b])
    assert row["Status"] == "Running"


def test_filtra_archived_e_cancelado():
    rows = cs.build_compplan_rows([
        _line(line_id=1, is_archived=True),
        _line(line_id=2, status="Cancelado"),
        _line(line_id=3),
    ])
    assert len(rows) == 1


def test_ordenacao_cronologica_sem_data_por_ultimo():
    rows = cs.build_compplan_rows([
        _line(line_id=1, start_date="2026-06-01", customer="B"),
        _line(line_id=2, start_date=None, customer="C"),
        _line(line_id=3, start_date="2026-01-15", customer="A"),
    ])
    assert [r["Customer"] for r in rows] == ["A", "B", "C"]


def test_coercao_numeric_decimal_do_bq():
    [row] = cs.build_compplan_rows([_line(
        pi_brl=Decimal("100000.00"),
        curator_revenue=Decimal("99500.50"),
        curator_margin=Decimal("59500.25"),
        curator_total_cost=Decimal("40000.25"),
    )])
    assert isinstance(row["Client PI Negotiation"], float)
    assert row["Curator Revenue"] == 99500.5


def test_formulas_auditaveis_f_e_p():
    # Client PI Net referencia o PI da própria linha com o fator
    assert cs.pi_net_formula(13) == '=IF(E13="","",ROUND(E13*0.8347,2))'
    # Compp: só paga 0,75% com %Delivery Rev ≥ 0.99; abaixo (ou sem PI/
    # delivery) fica em branco
    assert cs.compp_formula(13) == (
        '=IF(OR(F13="",I13<=0,M13<0.99),"",ROUND(F13*0.0075,2))'
    )


def test_payload_header_e_vazios():
    payload = cs.build_payload(cs.build_compplan_rows([_line(pi_brl=None)]))
    assert payload[0] == cs.COMPPLAN_COLUMNS
    header, row = payload
    assert len(row) == len(header)
    # sem PI → células de PI/percentuais em branco (string vazia)
    assert row[header.index("Client PI Negotiation")] == ""
    assert row[header.index("% Delivery Rev.")] == ""
