"""Guardrail Camada 3 — coerência do contrato (volumetria stale do Command).

Ver diagnóstico em memory project_command_volume_stale_derived_ui:
o Command grava volumetria stale (ex: investimento reduzido sem recomputar o
volume), a Visão Geral lê o campo dinheiro (correto) e a aba Display lê o volume
(errado). `_compute_totals` calcula o budget contratado IMPLÍCITO (Σ volume ×
tarifa) e `_emit_contract_consistency` flagra quando ele EXCEDE o declarado —
único caso inequívoco (contrato entregável > investimento total = impossível).
"""
from datetime import date

import main


def _check(o2o_display_imps, cpm=11.54):
    """Checklist mínimo (só O2O display) pra isolar a matemática do guardrail."""
    return dict(
        cpm_amount=cpm, cpcv_amount=0.0,
        contracted_o2o_display_impressions=o2o_display_imps,
        contracted_ooh_display_impressions=0,
        contracted_o2o_video_completions=0, contracted_ooh_video_completions=0,
        bonus_o2o_display_impressions=0, bonus_ooh_display_impressions=0,
        bonus_o2o_video_completions=0, bonus_ooh_video_completions=0,
    )


def _info(budget_contracted):
    return dict(
        _start_date_raw=date(2026, 7, 7), _end_date_raw=date(2026, 7, 31),
        budget_contracted=budget_contracted,
    )


def test_stash_implied_contract_budget():
    """_compute_totals grava o implícito mesmo sem entrega (perf_rows vazio)."""
    info = _info(13236.03)
    main._compute_totals([], _check(2485101), info)
    # 2.485.101 × 11,54 / 1000 = 28.678,07
    assert info["_implied_contract_budget"] == 28678.07


def test_flags_itau_stale_volume():
    """Caso REAL Itaú I278RG: volume gravado (2.485.101) implica R$28.678 mas o
    investimento é R$13.236 → incoerência sinalizada (~+117%)."""
    info = _info(13236.03)
    main._compute_totals([], _check(2485101), info)
    main._emit_contract_consistency(info)
    flag = info.get("contract_inconsistency")
    assert flag is not None
    assert flag["declared_budget"] == 13236.03
    assert flag["implied_budget"] == 28678.07
    assert 116 < flag["pct"] < 118
    # chave privada consumida, não vaza no payload
    assert "_implied_contract_budget" not in info


def test_no_flag_when_coherent():
    """Volume coerente com o investimento (1.146.970 × 11,54 = 13.236) → sem flag."""
    info = _info(13236.03)
    main._compute_totals([], _check(1146970), info)
    main._emit_contract_consistency(info)
    assert "contract_inconsistency" not in info


def test_no_flag_when_implied_below_declared():
    """Implícito < declarado é split multi-produto legítimo (features/survey/RMND
    têm budget no investimento mas não em contracted_*) → NÃO sinalizar."""
    info = _info(13236.03)
    main._compute_totals([], _check(500000), info)  # implica só R$5.770
    main._emit_contract_consistency(info)
    assert "contract_inconsistency" not in info


def test_no_flag_within_tolerance():
    """Ruído de centavos (<2%) não é incoerência."""
    info = _info(13236.03)
    # +1% acima → dentro da tolerância
    main._compute_totals([], _check(round(13236.03 * 1.01 / 11.54 * 1000)), info)
    main._emit_contract_consistency(info)
    assert "contract_inconsistency" not in info


def test_emit_is_noop_without_stash():
    """Sem _implied_contract_budget (ex: token sem checklist) → não quebra."""
    info = _info(13236.03)
    main._emit_contract_consistency(info)  # não deve levantar
    assert "contract_inconsistency" not in info


def _kerastase_check(total_value):
    """Caso REAL Kérastase 8SGU8O (30/09): Force editado pra R$180k (6,25M imp
    × R$14,40 + 250k views × R$0,36) depois do build diário da campaign_results,
    que ficou com o investimento antigo (R$150k)."""
    return dict(
        cpm_amount=14.40, cpcv_amount=0.36,
        contracted_o2o_display_impressions=6250000,
        contracted_ooh_display_impressions=0,
        contracted_o2o_video_completions=250000, contracted_ooh_video_completions=0,
        bonus_o2o_display_impressions=0, bonus_ooh_display_impressions=0,
        bonus_o2o_video_completions=208333, bonus_ooh_video_completions=0,
        total_value=total_value,
    )


def test_live_budget_from_force_kills_stale_false_positive():
    """Investimento lido do checklist ao vivo (R$180k) substitui o da
    campaign_results defasada (R$150k) → budget certo e sem falso positivo."""
    info = _info(150000.0)
    check = _kerastase_check(180000.0)
    main._apply_live_budget(info, check)
    main._compute_totals([], check, info)
    main._emit_contract_consistency(info)
    assert info["budget_contracted"] == 180000.0
    assert "contract_inconsistency" not in info


def test_live_budget_keeps_fallback_without_total_value():
    """Checklist sem total_value (None/0) → mantém o campaign_results."""
    for tv in (None, 0):
        info = _info(150000.0)
        main._apply_live_budget(info, _kerastase_check(tv))
        assert info["budget_contracted"] == 150000.0


def test_live_budget_still_flags_incoherent_force_checklist():
    """Incoerência DENTRO do Force (volume × tarifa > investimento) segue
    sinalizada: 6,25M × 14,40 + 250k × 0,36 = R$180k contra R$150k."""
    info = _info(180000.0)
    check = _kerastase_check(150000.0)
    main._apply_live_budget(info, check)
    main._compute_totals([], check, info)
    main._emit_contract_consistency(info)
    flag = info["contract_inconsistency"]
    assert flag["declared_budget"] == 150000.0
    assert flag["implied_budget"] == 180000.0
