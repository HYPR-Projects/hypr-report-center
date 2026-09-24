"""
Casamento peça Max Attention ↔ linha criativa da DSP (ma_matching). O caso
de referência é Paramount/MobLand: todos os formatos eram Max Attention e o
modal não sugeria nenhuma peça.
"""
import ma_matching as m

MOBLAND = [
    ("HYPR_MOBLAND_PARAMOUNT_CAROUSEL", 4162472),
    ("HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS", 2202258),
    ("HYPR_MOBLAND_PARAMOUNT_REVEAL_GRAFITE", 2036772),
    ("P+_KA_SAFE_MOBLAND_S2_FF_BR_HERO", 543598),
    ("P+_KA_SAFE_MOBLAND_S2_FF_BR-1_TOMHARDY", 15702),
]


def _detail(sizes=("300x250", "300x600", "320x480")):
    rows = []
    for name, imp in MOBLAND:
        for sz in sizes:
            rows.append({"creative_name": f"{name}_{sz}", "creative_size": sz, "impressions": imp / len(sizes)})
    return rows


def _rank(names, client="Paramount"):
    lines = m.dsp_lines(_detail())
    ctx = m.campaign_tokens(lines, client=client, campaign_name="MobLand")
    cands = [{"creative_id": str(i), "name": n, "client_name": c} for i, (n, c) in enumerate(names)]
    return {it["name"]: it for it in m.rank(cands, lines=lines, ctx=ctx, client=client)}


def test_creative_line_tira_tamanho_como_o_front():
    assert m.creative_line("HYPR_MOBLAND_CAROUSEL_300x600", "300x600") == "HYPR_MOBLAND_CAROUSEL"
    assert m.creative_line("hypr_x_728x90_v1") == "HYPR_X_V1"
    assert m.creative_line("300x250") == "300X250"


def test_dsp_lines_junta_tamanhos_e_ordena_por_impressao():
    lines = m.dsp_lines(_detail())
    assert [e["line"] for e in lines] == [n for n, _ in MOBLAND]
    assert len(lines[0]["names"]) == 3
    assert lines[0]["impressions"] == 4162472


def test_tokens_sem_ruido_e_com_sinonimo():
    assert m.tokens("HYPR_MobLand_Carrossel_300x600_v2") == ["mobland", "carousel"]
    assert m.tokens("P+_KA_SAFE_MOBLAND_S2_FF_BR-1_TOMHARDY") == ["safe", "mobland", "tomhardy"]


def test_termos_de_campanha():
    ctx = m.campaign_tokens(m.dsp_lines(_detail()), client="Paramount", campaign_name="MobLand")
    assert ctx["terms"] == ["mobland", "paramount"]
    assert {"mobland", "paramount"} <= ctx["common"]


def test_cada_peca_cai_na_sua_linha():
    got = _rank([
        ("MobLand - Carrossel", "Paramount+"),
        ("Mobland Reveal Tiros", None),
        ("Mobland Reveal Grafite", None),
        ("MobLand Tom Hardy", None),
        ("Mobland Hero", None),
    ])
    assert got["MobLand - Carrossel"]["dsp_lines"] == ["HYPR_MOBLAND_PARAMOUNT_CAROUSEL"]
    assert got["Mobland Reveal Tiros"]["dsp_lines"] == ["HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS"]
    assert got["Mobland Reveal Grafite"]["dsp_lines"] == ["HYPR_MOBLAND_PARAMOUNT_REVEAL_GRAFITE"]
    assert got["MobLand Tom Hardy"]["dsp_lines"] == ["P+_KA_SAFE_MOBLAND_S2_FF_BR-1_TOMHARDY"]
    assert got["Mobland Hero"]["dsp_lines"] == ["P+_KA_SAFE_MOBLAND_S2_FF_BR_HERO"]
    # Vínculo leva todos os tamanhos da linha.
    assert len(got["MobLand - Carrossel"]["dsp_creative_names"]) == 3
    assert got["MobLand - Carrossel"]["reasons"] == ["name", "campaign", "client"]


def test_peca_generica_fica_com_as_duas_linhas_do_formato():
    got = _rank([("Mob Land Revelar", None)])
    assert got["Mob Land Revelar"]["dsp_lines"] == [
        "HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS", "HYPR_MOBLAND_PARAMOUNT_REVEAL_GRAFITE",
    ]


def test_peca_de_outra_campanha_do_cliente_nao_rouba_a_linha():
    got = _rank([("Paramount Top Gun Carousel", "Paramount"), ("Nintendo Carousel", "Nintendo")])
    assert got["Paramount Top Gun Carousel"]["reasons"] == ["client"]
    assert got["Paramount Top Gun Carousel"]["dsp_lines"] == []
    assert "Nintendo Carousel" not in got


def test_erro_de_digitacao_e_palavra_colada():
    assert m.token_hit("paramont", ["paramount"])
    assert m.token_hit("hardy", ["tomhardy"])
    assert not m.token_hit("gun", ["carousel"])


def test_same_client_tolerante():
    assert m.same_client("Paramount", "Paramount+")
    assert m.same_client("L'Oréal", "LOREAL")
    assert not m.same_client("VW", "VWX Brasil")


def test_query_matches_palavras_em_qualquer_ordem():
    assert m.query_matches("MobLand - Carrossel", "carrossel mobland")
    assert m.query_matches("MobLand - Carrossel", "mobland")
    assert not m.query_matches("MobLand - Carrossel", "reveal")


# Dados reais da O3HI21 (MobLand, set/26): na Platform é uma peça POR
# TAMANHO, com o mesmo nome do criativo da DSP (só a caixa muda).
REAL_DSP = [
    ("HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300X250", "300x250", 3124427),
    ("HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300X600", "300x600", 2569311),
    ("HYPR_MOBLAND_PARAMOUNT_CAROUSEL_970X250", "970x250", 843234),
    ("HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS_300X250", "300x250", 1623312),
    ("HYPR_MOBLAND_PARAMOUNT_REVEAL_GRAFITE_300X250", "300x250", 1789839),
    ("P+_KA_SAFE_MOBLAND_S2_FF_320X50_BR_HERO", "320x50", 337369),
    ("P+_KA_SAFE_MOBLAND_S2_FF_728X90_BR_HERO", "728x90", 138892),
]


def _real_rank(pieces):
    lines = m.dsp_lines([{"creative_name": n, "creative_size": z, "impressions": i} for n, z, i in REAL_DSP])
    ctx = m.campaign_tokens(lines, client="PARAMOUNT", campaign_name="MobLand")
    cands = [{"creative_id": str(i), "name": n, "client_name": "Paramount", "platform_reasons": r}
             for i, (n, r) in enumerate(pieces)]
    return {it["name"]: it for it in m.rank(cands, lines=lines, ctx=ctx, client="PARAMOUNT")}


def test_peca_por_tamanho_leva_so_o_criativo_do_mesmo_tamanho():
    got = _real_rank([
        ("HYPR_Mobland_Paramount_Carousel_300x250", []),
        ("HYPR_Mobland_Paramount_Carousel_300x600", []),
        ("HYPR_Mobland_Paramount_Carousel_970x250", []),
        ("HYPR_Mobland_Paramount_Reveal_Tiros_300x250", []),
    ])
    assert got["HYPR_Mobland_Paramount_Carousel_300x250"]["dsp_creative_names"] == ["HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300X250"]
    assert got["HYPR_Mobland_Paramount_Carousel_970x250"]["dsp_creative_names"] == ["HYPR_MOBLAND_PARAMOUNT_CAROUSEL_970X250"]
    assert got["HYPR_Mobland_Paramount_Reveal_Tiros_300x250"]["dsp_creative_names"] == ["HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS_300X250"]
    assert got["HYPR_Mobland_Paramount_Carousel_300x600"]["reasons"] == ["name", "campaign", "client"]


def test_tamanho_que_nao_rodou_nao_casa_a_linha():
    got = _real_rank([("HYPR_Teste_Paramount_Carousel_300x2500 (cópia)", [])])
    it = got["HYPR_Teste_Paramount_Carousel_300x2500 (cópia)"]
    assert it["dsp_creative_names"] == [] and "name" not in it["reasons"]


def test_survey_da_campanha_nao_ganha_criativo_da_dsp():
    got = _real_rank([("HYPR_O3HI21_Survey_Paramount_Mobland_Controle_Awareness_Set-26", ["token"])])
    it = got["HYPR_O3HI21_Survey_Paramount_Mobland_Controle_Awareness_Set-26"]
    assert "token" in it["reasons"] and it["dsp_creative_names"] == []
