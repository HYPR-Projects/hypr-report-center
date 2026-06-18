"""Testes da unificação de audiências (Portal · Analytics).

Foco no contrato que o João pediu: variações de plural/acento/caixa colapsam,
e sinônimos comuns de varejo caem num grupo canônico só ("Supermercados").
"""

import audience_normalize as an


def test_normalize_key_strips_accent_case_punct():
    assert an.normalize_key("Supermercádo!") == "supermercado"
    assert an.normalize_key("  FARMÁCIA  ") == "farmacia"
    assert an.normalize_key("Casa de Carnes") == "casa de carnes"


def test_singularize_common_plurals():
    assert an.singularize_key("supermercados") == "supermercado"
    assert an.singularize_key("lojas") == "loja"
    assert an.singularize_key("hoteis") == "hotel"
    assert an.singularize_key("leoes") == "leao"
    # token curto não é mexido
    assert an.singularize_key("as") == "as"


def test_extract_audience_penultimate_segment():
    assert an.extract_audience("camp_O2O_Supermercados_DISPLAY") == "Supermercados"
    assert an.extract_audience("semsep") == ""


def test_plural_accent_case_collapse_to_one_group():
    weights = {
        "Supermercado": 100,
        "supermercados": 300,
        "SUPERMERCADO": 50,
        "Supermercádo": 10,
    }
    res = an.group_audiences(weights)
    # tudo num grupo só
    displays = set(res["mapping"].values())
    assert len(displays) == 1
    assert next(iter(displays)) == "Supermercados"


def test_synonyms_merge_into_supermercados():
    """O caso clássico: supermercado / supermercados / mercado → Supermercados."""
    weights = {"supermercado": 500, "supermercados": 300, "mercado": 120, "atacadão": 80}
    res = an.group_audiences(weights)
    assert set(res["mapping"].values()) == {"Supermercados"}
    assert sorted(res["groups"]["Supermercados"]) == sorted(
        ["supermercado", "supermercados", "mercado", "atacadão"]
    )


def test_typo_merges_via_fuzzy():
    weights = {"supermercado": 500, "supermecado": 20}  # typo
    res = an.group_audiences(weights)
    assert set(res["mapping"].values()) == {"Supermercados"}


def test_distinct_audiences_stay_separate():
    weights = {"Farmácias": 200, "Supermercados": 300, "Restaurantes": 150}
    res = an.group_audiences(weights)
    assert len(res["groups"]) == 3


def test_no_false_merge_short_unrelated():
    """Tokens curtos/não relacionados não devem colar por substring."""
    weights = {"Casa": 100, "Carro": 100}
    res = an.group_audiences(weights)
    assert len(res["groups"]) == 2


def test_ignores_survey_and_na():
    weights = {"SURVEY_Exposto": 100, "N/A": 50, "Supermercados": 200, "": 10}
    res = an.group_audiences(weights)
    assert set(res["groups"].keys()) == {"Supermercados"}


def test_display_picks_heaviest_representative():
    """Sem seed, o display vem do representante de maior peso, prettificado."""
    weights = {"publico jovem": 50, "Público Jovem": 400}
    res = an.group_audiences(weights)
    assert set(res["mapping"].values()) == {"Público Jovem"}


def test_empty_input():
    assert an.group_audiences({}) == {"mapping": {}, "groups": {}}
    assert an.group_audiences(None) == {"mapping": {}, "groups": {}}


# ── apply_overrides (Fase 2 — precedência do admin) ─────────────────────────
def test_override_by_raw_label():
    mapping = {"mercado central": "Mercado Central", "shopping": "Shopping Centers"}
    out = an.apply_overrides(mapping, {"Mercado Central": "Supermercados"})
    assert out["mercado central"] == "Supermercados"
    assert out["shopping"] == "Shopping Centers"


def test_override_by_display_merges_group():
    # Dois rótulos crus no mesmo display; override por display remapeia ambos.
    mapping = {"superm a": "Supermercados Pequenos", "superm b": "Supermercados Pequenos"}
    out = an.apply_overrides(mapping, {"Supermercados Pequenos": "Supermercados"})
    assert set(out.values()) == {"Supermercados"}


def test_override_is_accent_case_insensitive():
    mapping = {"farmacia x": "Farmácias"}
    out = an.apply_overrides(mapping, {"farmacias": "Drogarias"})
    assert out["farmacia x"] == "Drogarias"


def test_override_empty_is_noop():
    mapping = {"a": "A", "b": "B"}
    assert an.apply_overrides(mapping, None) == mapping
    assert an.apply_overrides(mapping, {}) == mapping
