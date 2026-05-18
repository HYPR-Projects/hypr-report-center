"""
Backfill do report_audit_log a partir do estado atual das mutations.

Quando rodar
------------
Uma vez, depois do deploy do tracking. Cada execução é idempotente
(checa por event_id na tabela alvo antes de inserir) — pode rodar
novamente sem duplicar entradas.

Como rodar
----------
Da raiz do repo, com as creds da SA configuradas:

    python -m backend.scripts.backfill_audit_log

Ou com `--dry-run` pra ver o que seria inserido sem gravar nada.

O que faz
---------
Varre cada tabela de estado (campaign_closures, campaign_pauses,
campaign_early_ends, campaign_merges, report_owners_overrides,
campaign_surveys, campaign_looms, client_logos, rmnd_data, pdooh_data)
e gera uma entry synthetic=true por linha encontrada.

Limitações
----------
- Timestamps: usa o campo `updated_at`/`closed_at`/`paused_at` da tabela
  quando existe. Pra tabelas sem timestamp granular (loom/logo legados),
  usa CURRENT_TIMESTAMP como aproximação — o frontend marca isso como
  "(retroativo)" pra deixar claro que é estimativa.
- Actor: usa o campo `*_by` da tabela alvo quando existe (closed_by,
  paused_by, updated_by). Quando ausente, o actor fica NULL.
"""

import argparse
import logging
import os
import sys
import uuid
from datetime import datetime, timezone

from google.cloud import bigquery

# Permite rodar como módulo `backend.scripts.backfill_audit_log` ou
# direto via path absoluto.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import audit_log  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("backfill_audit_log")

bq = bigquery.Client()

PROJECT_ID     = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET_ASSETS = "prod_assets"
# Uploads (RMND/PDOOH) vivem em dev_assets, não prod_assets — divergência
# histórica preservada no save_upload do main.py. Backfill respeita o
# mesmo path pra encontrar os dados.
DATASET_UPLOADS = "dev_assets"


def _ref(table: str) -> str:
    return f"`{PROJECT_ID}.{DATASET_ASSETS}.{table}`"


def _ref_uploads(table: str) -> str:
    return f"`{PROJECT_ID}.{DATASET_UPLOADS}.{table}`"


def _existing_synthetic_keys() -> set:
    """Conjunto de (short_token, event_type) já presentes como synthetic.

    Usado pra idempotência: na 2ª execução, pulamos eventos que já foram
    inseridos no passe anterior — evita inflar o log com duplicatas.
    """
    sql = f"""
        SELECT DISTINCT short_token, event_type
        FROM {_ref('report_audit_log')}
        WHERE synthetic = TRUE
    """
    try:
        rows = bq.query(sql).result()
        return {(r["short_token"], r["event_type"]) for r in rows}
    except Exception as e:
        # Tabela pode não existir ainda na primeira execução — caller
        # garante criação via audit_log.ensure_table_exists().
        logger.warning(f"Não consegui ler synthetic keys existentes: {e}")
        return set()


def _query_or_empty(sql: str) -> list:
    """Roda uma query e devolve lista vazia se a tabela não existe.

    Várias tabelas-fonte são opcionais (cliente pode nunca ter usado
    RMND/PDOOH, por exemplo). Não falhar em 404 deixa o script rodar
    end-to-end mesmo em ambientes incompletos.
    """
    try:
        return list(bq.query(sql).result())
    except Exception as e:
        logger.warning(f"Skip query (provável tabela ausente): {e}")
        return []


# ─── Sources ──────────────────────────────────────────────────────────

def _from_closures():
    """campaign_closures → campaign_closed."""
    sql = f"""
        SELECT short_token, closed_at, closed_by
        FROM {_ref('campaign_closures')}
    """
    out = []
    for r in _query_or_empty(sql):
        out.append({
            "short_token": r["short_token"],
            "event_type":  "campaign_closed",
            "actor_email": r["closed_by"],
            "message":     "marcou a campanha como encerrada",
            "when":        r["closed_at"],
        })
    return out


def _from_pauses():
    sql = f"""
        SELECT short_token, paused_at, paused_by, reason
        FROM {_ref('campaign_pauses')}
    """
    out = []
    for r in _query_or_empty(sql):
        reason = r.get("reason") if isinstance(r, dict) else r["reason"]
        msg = "pausou a campanha"
        if reason:
            msg += f" — {reason}"
        out.append({
            "short_token": r["short_token"],
            "event_type":  "campaign_paused",
            "actor_email": r["paused_by"],
            "message":     msg,
            "when":        r["paused_at"],
            "payload":     {"reason": reason} if reason else None,
        })
    return out


def _from_early_ends():
    sql = f"""
        SELECT short_token, early_end_date, reason, ended_by, updated_at
        FROM {_ref('campaign_early_ends')}
    """
    out = []
    for r in _query_or_empty(sql):
        msg = f"encerrou antecipadamente em {r['early_end_date']}"
        if r["reason"]:
            msg += f" — {r['reason']}"
        out.append({
            "short_token": r["short_token"],
            "event_type":  "campaign_early_ended",
            "actor_email": r["ended_by"],
            "message":     msg,
            "when":        r["updated_at"],
            "payload":     {
                "early_end_date": str(r["early_end_date"]),
                "reason":         r["reason"],
            },
        })
    return out


def _from_merges():
    """campaign_merge_groups é normalizada (1 row por token). Pra cada
    grupo, gera 1 entry por membro listando os outros como peers."""
    sql = f"""
        SELECT short_token, merge_id, created_by, created_at
        FROM {_ref('campaign_merge_groups')}
    """
    rows = _query_or_empty(sql)
    by_group: dict[str, list] = {}
    for r in rows:
        by_group.setdefault(r["merge_id"], []).append(r)
    out = []
    for merge_id, members in by_group.items():
        tokens = [m["short_token"] for m in members]
        for m in members:
            peers = [t for t in tokens if t != m["short_token"]]
            msg = f"agrupado com {', '.join(peers)}" if peers else "incluído num grupo"
            out.append({
                "short_token": m["short_token"],
                "event_type":  "merge_linked",
                "actor_email": m["created_by"],
                "message":     msg,
                "when":        m["created_at"],
                "payload":     {"merge_id": merge_id, "peers": peers},
            })
    return out


def _from_owner_overrides():
    sql = f"""
        SELECT short_token, cp_email, cs_email, updated_by, updated_at
        FROM {_ref('report_owners_overrides')}
    """
    out = []
    for r in _query_or_empty(sql):
        parts = []
        if r["cp_email"]: parts.append(f"CP={r['cp_email']}")
        if r["cs_email"]: parts.append(f"CS={r['cs_email']}")
        msg = f"owner override ({', '.join(parts) or 'limpo'})"
        out.append({
            "short_token": r["short_token"],
            "event_type":  "owner_changed",
            "actor_email": r["updated_by"],
            "message":     msg,
            "when":        r["updated_at"],
            "payload":     {
                "cp_email": r["cp_email"] or None,
                "cs_email": r["cs_email"] or None,
            },
        })
    return out


def _from_surveys():
    sql = f"""
        SELECT short_token, updated_at
        FROM {_ref('campaign_surveys')}
    """
    out = []
    for r in _query_or_empty(sql):
        out.append({
            "short_token": r["short_token"],
            "event_type":  "survey_created",
            "actor_email": None,
            "message":     "Survey configurada",
            "when":        r["updated_at"],
        })
    return out


def _from_looms():
    sql = f"""
        SELECT short_token, updated_at
        FROM {_ref('campaign_looms')}
    """
    out = []
    for r in _query_or_empty(sql):
        out.append({
            "short_token": r["short_token"],
            "event_type":  "loom_added",
            "actor_email": None,
            "message":     "adicionou um vídeo Loom",
            "when":        r["updated_at"],
        })
    return out


def _from_logos():
    sql = f"""
        SELECT short_token, updated_at
        FROM {_ref('client_logos')}
    """
    out = []
    for r in _query_or_empty(sql):
        out.append({
            "short_token": r["short_token"],
            "event_type":  "logo_changed",
            "actor_email": None,
            "message":     "trocou o logo do cliente",
            "when":        r["updated_at"],
        })
    return out


def _from_uploads(table: str, event_type: str, msg: str):
    """rmnd_data e pdooh_data vivem em dev_assets (não prod_assets) e a
    coluna de timestamp é `updated_at` (não `uploaded_at`). Save_upload
    no main.py confirma essas decisões."""
    sql = f"""
        SELECT short_token, MAX(updated_at) AS updated_at
        FROM {_ref_uploads(table)}
        GROUP BY short_token
    """
    out = []
    for r in _query_or_empty(sql):
        out.append({
            "short_token": r["short_token"],
            "event_type":  event_type,
            "actor_email": None,
            "message":     msg,
            "when":        r["updated_at"],
        })
    return out


# ─── Main ─────────────────────────────────────────────────────────────

def gather_all() -> list[dict]:
    """Junta eventos sintéticos de todas as fontes."""
    events: list[dict] = []
    events.extend(_from_closures())
    events.extend(_from_pauses())
    events.extend(_from_early_ends())
    events.extend(_from_merges())
    events.extend(_from_owner_overrides())
    events.extend(_from_surveys())
    events.extend(_from_looms())
    events.extend(_from_logos())
    events.extend(_from_uploads("rmnd_data",  "rmnd_uploaded",  "subiu CSV do Amazon Ads"))
    events.extend(_from_uploads("pdooh_data", "pdooh_uploaded", "subiu relatório PDOOH"))
    return events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Não escreve nada; só lista")
    args = ap.parse_args()

    # Garante que a tabela existe antes de qualquer leitura/escrita
    audit_log.ensure_table_exists()

    seen = _existing_synthetic_keys()
    logger.info(f"Synthetic keys já existentes: {len(seen)}")

    all_events = gather_all()
    logger.info(f"Eventos candidatos: {len(all_events)}")

    skipped = 0
    inserted = 0
    failed = 0
    for ev in all_events:
        key = (ev["short_token"], ev["event_type"])
        if key in seen:
            skipped += 1
            continue
        if args.dry_run:
            logger.info(f"[DRY] {ev['short_token']} {ev['event_type']} — {ev['message']}")
            inserted += 1
            continue
        try:
            # write_event retorna event_id em caso de sucesso, None em
            # caso de falha (não propaga exceção). Contador deve checar
            # retorno — antes ficava sempre "inserted=N" mesmo quando
            # 100% das inserções falhavam no streaming.
            result = audit_log.write_event(
                short_token=ev["short_token"],
                event_type=ev["event_type"],
                actor_email=ev.get("actor_email"),
                message=ev.get("message"),
                payload=ev.get("payload"),
                synthetic=True,
                when=ev.get("when") or datetime.now(timezone.utc),
            )
            if result:
                inserted += 1
                seen.add(key)
            else:
                failed += 1
        except Exception as e:
            logger.error(f"Falha em {ev['short_token']}/{ev['event_type']}: {e}")
            failed += 1

    logger.info(f"Done — inserted={inserted} skipped_dupe={skipped} failed={failed}")


if __name__ == "__main__":
    main()
