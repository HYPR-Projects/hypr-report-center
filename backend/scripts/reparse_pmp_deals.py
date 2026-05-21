"""
Re-aplica `pmp_deals.parse_deal_name` em todos os deals que ainda não
foram editados manualmente. Útil quando o parser ganha melhorias e
queremos atualizar customer/campaign_name/agency/flight_quarter/flight_month
no histórico sem perder edições que o admin já fez via UI.

Critério "automático" (pode sobrescrever):
  updated_by IN ('migration@hypr.mobi', 'backfill@hypr.mobi',
                  'xandr-sync', 'scheduler', 'system')

Qualquer outro updated_by = edit manual via UI → NÃO TOCA.

Como rodar
----------
  python -m backend.scripts.reparse_pmp_deals --dry-run   # mostra diffs
  python -m backend.scripts.reparse_pmp_deals             # aplica
"""

import argparse
import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pmp_deals  # noqa: E402


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reparse")


AUTO_UPDATERS = {
    "migration@hypr.mobi",
    "backfill@hypr.mobi",
    "xandr-sync",
    "scheduler",
    "system",
    None,  # nunca foi gravado updated_by (registros legados)
    "",
}

# Campos que o parser populates — re-parse só toca esses.
PARSED_FIELDS = ["customer", "campaign_name", "agency", "flight_quarter", "flight_month"]


def fetch_deals():
    sql = f"""
        SELECT deal_id, curated_deal_name, updated_by,
               customer, campaign_name, agency, flight_quarter, flight_month
        FROM {pmp_deals._full(pmp_deals.TABLE_DEALS)}
    """
    return list(pmp_deals.bq.query(sql).result())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--updated-by", default="reparse@hypr.mobi",
                     help="email gravado em updated_by ao atualizar (default: reparse@hypr.mobi)")
    args = ap.parse_args()

    rows = fetch_deals()
    log.info(f"{len(rows)} deals no total")

    candidates = []
    for r in rows:
        if r.get("updated_by") not in AUTO_UPDATERS:
            continue
        candidates.append(r)
    log.info(f"{len(candidates)} candidatos (updated_by automático)")

    diffs = []
    for r in candidates:
        parsed = pmp_deals.parse_deal_name(r["curated_deal_name"] or "")
        changes = {}
        for f in PARSED_FIELDS:
            new_val = parsed.get(f)
            old_val = r.get(f)
            # Só sobrescreve se o NOVO valor não é None E é diferente do antigo.
            # (Se o parser não conseguiu extrair, mantém o que tinha — sem
            # apagar dados acidentalmente.)
            if new_val is not None and new_val != old_val:
                changes[f] = (old_val, new_val)
        if changes:
            diffs.append((r["deal_id"], r["curated_deal_name"], changes))

    log.info(f"{len(diffs)} deals teriam mudanças")
    for deal_id, name, changes in diffs:
        log.info(f"  {deal_id} {name[:60]}")
        for f, (old, new) in changes.items():
            log.info(f"    {f:>14}: {old!r:>30}  →  {new!r}")

    if args.dry_run:
        log.info("--dry-run: nada gravado.")
        return

    log.info("Aplicando updates...")
    written = 0
    for deal_id, _, changes in diffs:
        fields = {f: v[1] for f, v in changes.items()}
        try:
            pmp_deals.save_deal(deal_id, fields, updated_by=args.updated_by)
            written += 1
        except Exception as e:
            log.warning(f"  {deal_id} falhou: {e}")
    log.info(f"Pronto. {written} deals atualizados.")


if __name__ == "__main__":
    main()
