"""
Report owners — quem é responsável por cada report.

Modelo
------
Cada report tem dois owners HYPR:
  • CP (Commercial Person) — vendedor da conta.
  • CS (Customer Success)  — operador do report.

Os owners vêm de duas fontes, na ordem de precedência:

  1. Override manual (tabela `prod_assets.report_owners_overrides`)
     — admin clicou "Gerenciar Owner" no card e definiu manualmente.

  2. Lookup automático (external table `prod_assets.report_owners_lookup`,
     apontando para a aba "Sheet1" da planilha de De-Para Comercial).
     — match por `client_name` (case-insensitive). Se houver múltiplos
     registros para o mesmo cliente (mesma cliente atendida por agências
     diferentes), o lookup retorna os emails apenas se forem TODOS iguais
     entre as linhas; do contrário, retorna NULL e cabe ao admin definir
     manualmente o override.

A tabela `prod_assets.team_members_lookup` (aba "Sheet2" da planilha)
expõe a lista oficial de membros HYPR (CPs e CSs com emails) para
popular dropdowns no frontend.

Privacidade
-----------
Owners são dados internos da HYPR. Os endpoints expostos para clientes
(/report/<token>) NUNCA retornam emails de owner. Apenas o endpoint
admin `?list=true` (já protegido por JWT) traz essa informação.
"""

import os
from google.cloud import bigquery

PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET    = "prod_assets"
SHEET_ID   = "1nd6UtJJ5fA81D9VZRiH2ZJGHYsiiv28LPzXhNRtd2aM"

# Nomes das tabelas no BQ
TABLE_LOOKUP    = "report_owners_lookup"        # external — Sheet1
TABLE_TEAM      = "team_members_lookup"          # external — Sheet2
TABLE_OVERRIDES = "report_owners_overrides"      # física

bq = bigquery.Client()


def _full(table_name: str) -> str:
    return f"`{PROJECT_ID}.{DATASET}.{table_name}`"


# ─── Setup de schema (idempotente) ───────────────────────────────────────────
def setup_schema() -> dict:
    """Cria/atualiza as 3 tabelas necessárias.

    External tables (lookup, team) são CREATE OR REPLACE — sempre redefinem
    o schema apontado para a planilha. Ajustes nas colunas da planilha
    exigem nova chamada de setup.

    A tabela física de overrides é CREATE IF NOT EXISTS para preservar
    dados existentes entre setups.

    Retorna o status de cada operação.
    """
    sheets_uri = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"
    results = {}

    # 1) Sheet1 → report_owners_lookup
    #    Header (linha 1): Agência | Cliente | CP ATUAL | Email CP | CS Atual | Email CS
    sql_lookup = f"""
        CREATE OR REPLACE EXTERNAL TABLE {_full(TABLE_LOOKUP)} (
            agency      STRING,
            client      STRING,
            cp_name     STRING,
            cp_email    STRING,
            cs_name     STRING,
            cs_email    STRING
        )
        OPTIONS (
            format = 'GOOGLE_SHEETS',
            uris   = ['{sheets_uri}'],
            sheet_range = 'Sheet1!A:F',
            skip_leading_rows = 1
        )
    """
    bq.query(sql_lookup).result()
    results["lookup"] = "ok"

    # 2) Sheet2 → team_members_lookup
    #    Header: CP | Email | CS | Email | (vazio) | (vazio) | Cliente | ...
    #    Pegamos só as 4 primeiras colunas — CP/Email CP e CS/Email CS.
    sql_team = f"""
        CREATE OR REPLACE EXTERNAL TABLE {_full(TABLE_TEAM)} (
            cp_name   STRING,
            cp_email  STRING,
            cs_name   STRING,
            cs_email  STRING
        )
        OPTIONS (
            format = 'GOOGLE_SHEETS',
            uris   = ['{sheets_uri}'],
            sheet_range = 'Sheet2!A:D',
            skip_leading_rows = 1
        )
    """
    bq.query(sql_team).result()
    results["team"] = "ok"

    # 3) Tabela física de overrides — preserva dados existentes
    sql_overrides = f"""
        CREATE TABLE IF NOT EXISTS {_full(TABLE_OVERRIDES)} (
            short_token  STRING NOT NULL,
            cp_email     STRING,
            cs_email     STRING,
            updated_by   STRING,
            updated_at   TIMESTAMP
        )
    """
    bq.query(sql_overrides).result()
    results["overrides"] = "ok"

    return results


# ─── Queries de leitura ──────────────────────────────────────────────────────
def list_team_members() -> dict:
    """Lê a aba Sheet2 e devolve as listas únicas de CPs e CSs.

    Linhas inválidas (sem email, "Greenfield", "#N/A") são filtradas — não
    fazem sentido como atribuíveis. Greenfield é registrado como conta sem
    CP/CS designado e não é uma pessoa que possa "ser owner".

    Retorna: {"cps": [{name, email}], "css": [{name, email}]}
    """
    sql = f"""
        WITH cps AS (
            SELECT DISTINCT cp_name AS name, LOWER(cp_email) AS email
            FROM {_full(TABLE_TEAM)}
            WHERE cp_email IS NOT NULL
              AND cp_email LIKE '%@hypr.mobi'
        ),
        css AS (
            SELECT DISTINCT cs_name AS name, LOWER(cs_email) AS email
            FROM {_full(TABLE_TEAM)}
            WHERE cs_email IS NOT NULL
              AND cs_email LIKE '%@hypr.mobi'
        )
        SELECT 'cp' AS role, name, email FROM cps
        UNION ALL
        SELECT 'cs' AS role, name, email FROM css
        ORDER BY role, name
    """
    rows = list(bq.query(sql).result())
    cps = [{"name": r["name"], "email": r["email"]}
           for r in rows if r["role"] == "cp"]
    css = [{"name": r["name"], "email": r["email"]}
           for r in rows if r["role"] == "cs"]
    return {"cps": cps, "css": css}


def resolved_owners_subquery() -> str:
    """SQL subquery que devolve (short_token, cp_email, cs_email) já
    com override aplicado em cima do lookup.

    Lógica do match no lookup:
      - Match por LOWER(client_name) entre `campaign_results` e a aba Sheet1.
      - Se múltiplos registros (mesmo cliente em agências diferentes),
        agregamos com ANY_VALUE só quando todos os emails forem iguais.
        Quando há divergência, retornamos NULL — o admin precisa definir
        o override manualmente. Isso evita atribuir owner errado.

    Pode ser embutida em outras queries via WITH owners AS (...).
    """
    return f"""
        SELECT
            base.short_token,
            COALESCE(ov.cp_email, lk.cp_email) AS cp_email,
            COALESCE(ov.cs_email, lk.cs_email) AS cs_email
        FROM (
            SELECT DISTINCT short_token, LOWER(client_name) AS client_lc
            FROM `{PROJECT_ID}.prod_prod_hypr_reporthub.campaign_results`
        ) base
        LEFT JOIN (
            -- Lookup agregado: só usa email se todas as linhas do cliente
            -- concordarem. Senão, deixa NULL pro admin decidir.
            SELECT
                LOWER(client) AS client_lc,
                CASE WHEN COUNT(DISTINCT cp_email) = 1
                     THEN ANY_VALUE(cp_email) END AS cp_email,
                CASE WHEN COUNT(DISTINCT cs_email) = 1
                     THEN ANY_VALUE(cs_email) END AS cs_email
            FROM {_full(TABLE_LOOKUP)}
            WHERE client IS NOT NULL
              AND cp_email LIKE '%@hypr.mobi'
            GROUP BY client_lc
        ) lk USING (client_lc)
        LEFT JOIN {_full(TABLE_OVERRIDES)} ov USING (short_token)
    """


# ─── Mutations (admin write) ─────────────────────────────────────────────────
def save_owner_override(short_token: str, cp_email: str, cs_email: str,
                         updated_by: str) -> None:
    """Upsert no override. cp_email ou cs_email vazios são tratados como
    "remover override deste campo" — quando ambos vazios e o registro
    já existe, deletamos a linha pra cair de volta no lookup automático.
    """
    cp = cp_email.strip().lower() if cp_email else None
    cs = cs_email.strip().lower() if cs_email else None

    if not cp and not cs:
        # Limpar override → próxima leitura pega lookup
        sql = f"""
            DELETE FROM {_full(TABLE_OVERRIDES)}
            WHERE short_token = @t
        """
        bq.query(sql, job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("t", "STRING", short_token),
            ]
        )).result()
        return

    sql = f"""
        MERGE {_full(TABLE_OVERRIDES)} T
        USING (SELECT @t AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN UPDATE SET
            cp_email   = @cp,
            cs_email   = @cs,
            updated_by = @by,
            updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (short_token, cp_email, cs_email, updated_by, updated_at)
            VALUES (@t, @cp, @cs, @by, CURRENT_TIMESTAMP())
    """
    bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("t",  "STRING", short_token),
            bigquery.ScalarQueryParameter("cp", "STRING", cp),
            bigquery.ScalarQueryParameter("cs", "STRING", cs),
            bigquery.ScalarQueryParameter("by", "STRING", updated_by),
        ]
    )).result()
