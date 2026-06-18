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


def test_extract_audience_both_conventions():
    # Kenvue-V2: MÍDIA_FRENTE_AUDIÊNCIA → público é o ÚLTIMO segmento
    assert an.extract_audience("ID-X_HYPR_K_CPG_LISTERINE_ABS_DISPLAY_O2O_MARKETS-&-FARMACIAS") == "MARKETS-&-FARMACIAS"
    assert an.extract_audience("ID-X_HYPR_K_SEMPRE-LIVRE_ABS_DISPLAY_O2O_STUDENTS") == "STUDENTS"
    assert an.extract_audience("ID-X_HYPR_K_LISTERINE_ABS_DISPLAY_RMNF_FAIXA-2") == "FAIXA-2"
    # convenção antiga: FRENTE_AUDIÊNCIA_MÍDIA → público é o PENÚLTIMO
    assert an.extract_audience("camp_O2O_Supermercados_DISPLAY") == "Supermercados"
    assert an.extract_audience("semsep") == ""


def test_extract_audience_ignores_line_item_tiers():
    # tier de line item no fim (LI-1/PREMIUM/...) NÃO é audiência: pega o anterior
    assert an.extract_audience("ID-X_HYPR_K_BABY_ABS_DISPLAY_O2O_MARKETS_LI-1") == "MARKETS"
    assert an.extract_audience("ID-X_HYPR_K_FORTNITE_ABS_DISPLAY_O2O_LUXURY_LI-TOP-PERFORMANCE") == "LUXURY"
    assert an.extract_audience("ID-X_HYPR_K_LISTERINE_DISPLAY_O2O_BAR_LI-PREMIUM-LIST") == "BAR"
    assert an.extract_audience("ID-X_HYPR_K_BABY_ABS_DISPLAY_O2O_MARKETS_PREMIUM") == "MARKETS"
    assert an.extract_audience("ID-X_HYPR_K_NEUTROGENA_DISPLAY_OOH_REDE-2_LI-STANDARD") == "REDE-2"


def test_extract_audience_front_fallback_when_no_public():
    # Line sem público próprio (só frente+mídia / genérico) → rotula pela FRENTE,
    # nunca pela mídia.
    assert an.extract_audience("ID-X_..._SEMPRE-LIVRE_ABS_DISPLAY_OOH") == "OOH"
    assert an.extract_audience("ID-X_..._BABY-PROMO_DISPLAY_GROUNDFLOW_LI-STANDARD") == "GROUNDFLOW"
    assert an.extract_audience("ID-X_..._SAO-JOAO_VIDEO_OOH_LI-STANDARD") == "OOH"


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


def test_ignores_media_but_keeps_fronts():
    """Mídia (Display/Vídeo/PDOOH) nunca é audiência; frentes (Groundflow/RMNF)
    podem aparecer como rótulo de fallback e NÃO são filtradas."""
    weights = {"DISPLAY": 200, "VIDEO": 50, "PDOOH": 30,
               "Supermercados": 500, "Groundflow": 120}
    res = an.group_audiences(weights)
    assert set(res["groups"].keys()) == {"Supermercados", "Groundflow"}


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


# ── Seed overrides (ponte Report Center → IA do hub) ──────────────────────────
# O override de nome do Report Center entra como SEED em group_audiences: agrupa
# os rótulos crus sob o nome do admin e tem prioridade sobre SEED_GROUPS.

def test_seed_override_merges_variants_under_admin_name():
    weights = {"SPORTS-STORE": 100, "sports store": 50, "BARES": 30}
    seed = {an.normalize_key("SPORTS-STORE"): "Lojas de Esporte",
            an.normalize_key("sports store"): "Lojas de Esporte"}
    out = an.group_audiences(weights, seed_overrides=seed)
    m = out["mapping"]
    assert m["SPORTS-STORE"] == "Lojas de Esporte"
    assert m["sports store"] == "Lojas de Esporte"
    # BARES não foi tocado → prettify normal
    assert m["BARES"] == "Bares"
    # os dois variantes colapsam num grupo só
    assert sorted(out["groups"]["Lojas de Esporte"]) == ["SPORTS-STORE", "sports store"]


def test_seed_override_wins_over_seed_groups():
    # "mercado" cairia em "Supermercados" pelo SEED_GROUPS; o admin força outro nome.
    weights = {"mercado": 10}
    seed = {an.normalize_key("mercado"): "Mercadinhos do Bairro"}
    out = an.group_audiences(weights, seed_overrides=seed)
    assert out["mapping"]["mercado"] == "Mercadinhos do Bairro"


def test_group_audiences_seed_none_is_backward_compatible():
    weights = {"mercado": 10, "atacadao": 5}
    base = an.group_audiences(weights)
    assert an.group_audiences(weights, seed_overrides=None) == base
    assert an.group_audiences(weights, seed_overrides={}) == base
