"""
Alertas por email pra CS responsável quando uma integração Google Sheets está
com sync atrasado (last_synced_at > 26h atrás).

Por que existe
──────────────
Cloud Monitoring cobre o sistêmico ("cron caiu", "5xx no endpoint"). Mas falha
em UMA integração específica (campanha X parou de sincronizar) é granular
demais pra Cloud Monitoring — alertaria o ops, não o dono. Esse módulo
manda 1 email pra cada CS responsável (`created_by_email` da row), agrupando
todas as campanhas dele que estão stale.

Fluxo
─────
Cloud Scheduler invoca POST `/?action=sheets_alert_stale` às 09:00 BRT
(1h depois do sync da manhã, dando tempo do cron rodar). Endpoint chama
`alert_stale_integrations()` aqui.

`alert_stale_integrations` faz:
  1. Query BQ: rows com status='active' AND last_synced_at < (NOW - 26h)
  2. Agrupa por created_by_email
  3. Pra cada email, monta lista das campanhas stale e envia 1 email via
     SendGrid (1 chamada HTTP)

Idempotência
────────────
NÃO tem dedup nativo. Se o cron de stale-alert rodar 2x num dia (manual +
automático), o CS recebe 2 emails. OK por enquanto — alerta por email é
ruído baixo e o caso de duplo-disparo é raro. Se virar problema, adicionar
coluna `last_alerted_at` na tabela e checar > 12h antes de re-alertar.

SendGrid
────────
Usa REST API v3 direto via urllib (sem SDK). Endpoint /v3/mail/send aceita
JSON {personalizations, from, subject, content}. Erros 4xx/5xx levantam
exceção que sobe pro endpoint do main.py — quem chamou (Scheduler) recebe
500 e o alert policy "non-2xx" dispara.

Envvars necessárias
───────────────────
SENDGRID_API_KEY    — key restrita com permissão "Mail Send: Full"
SHEETS_ALERT_FROM   — email do remetente (precisa estar verificado no
                      SendGrid sender authentication)
SHEETS_ALERT_REPLY_TO — opcional. Default: SHEETS_ALERT_FROM
"""

import json
import logging
import os
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from typing import Dict, List, Optional

from google.cloud import bigquery


logger = logging.getLogger(__name__)


# ─── Config ──────────────────────────────────────────────────────────────────
PROJECT_ID     = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET_ASSETS = os.environ.get("SHEETS_DATASET", "prod_prod_hypr_reporthub")
TABLE_NAME     = "sheets_integrations"

SENDGRID_API_KEY      = os.environ.get("SENDGRID_API_KEY", "")
SHEETS_ALERT_FROM     = os.environ.get("SHEETS_ALERT_FROM", "platform@hypr.mobi")
SHEETS_ALERT_REPLY_TO = os.environ.get("SHEETS_ALERT_REPLY_TO", SHEETS_ALERT_FROM)

# Threshold de "stale". Cron roda 2x/dia (08h e 12h BRT). 26h cobre o caso
# "última sync foi 08h de ontem, hoje 09h ainda não rodou nem o de 08h" sem
# disparar falso positivo no horário de transição.
STALE_THRESHOLD_HOURS = 26

SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send"


# ─── Lazy BQ client ──────────────────────────────────────────────────────────
_bq_client_singleton = None


def _bq_client() -> bigquery.Client:
    global _bq_client_singleton
    if _bq_client_singleton is None:
        _bq_client_singleton = bigquery.Client(project=PROJECT_ID)
    return _bq_client_singleton


def _table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.{TABLE_NAME}"


# ─── Query stale integrations ────────────────────────────────────────────────
def find_stale_integrations() -> List[Dict]:
    """
    Retorna integrações ativas cujo último sync com sucesso foi há mais
    de STALE_THRESHOLD_HOURS. Inclui rows que NUNCA sincronizaram
    (last_synced_at IS NULL) — esse caso só acontece se a integração
    falhou logo na criação, mas vale alertar pra reconectar.

    Excluí integrações com status != 'active' (paused/revoked/error já
    são visíveis no card como banner vermelho — não precisam email duplo).
    """
    sql = f"""
    SELECT
        short_token,
        COALESCE(target_type, 'token') AS target_type,
        spreadsheet_url,
        created_by_email,
        last_synced_at,
        last_attempt_at
    FROM `{_table_id()}`
    WHERE status = 'active'
      AND (
        last_synced_at IS NULL
        OR last_synced_at < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {STALE_THRESHOLD_HOURS} HOUR)
      )
      AND created_by_email IS NOT NULL
    ORDER BY created_by_email, last_synced_at NULLS FIRST
    """
    rows = list(_bq_client().query(sql).result())
    return [
        {
            "target_id":        r["short_token"],
            "target_type":      r["target_type"],
            "spreadsheet_url":  r["spreadsheet_url"],
            "created_by_email": r["created_by_email"],
            "last_synced_at":   r["last_synced_at"],
            "last_attempt_at":  r["last_attempt_at"],
        }
        for r in rows
    ]


# ─── Email composition ───────────────────────────────────────────────────────
def _format_relative_time(ts: Optional[datetime]) -> str:
    """'há 2 dias', 'há 30h', 'nunca'."""
    if not ts:
        return "nunca"
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    delta = now - ts
    hours = delta.total_seconds() / 3600
    if hours < 24:
        return f"há {int(hours)}h"
    days = int(hours / 24)
    return f"há {days} dia{'s' if days != 1 else ''}"


def _build_email_body(stale: List[Dict]) -> Dict[str, str]:
    """Monta corpo HTML + texto plano com a lista de integrações stale."""
    lines_text = []
    lines_html = []
    for item in stale:
        when = _format_relative_time(item["last_synced_at"])
        kind = "agregado" if item["target_type"] == "merge" else "campanha"
        target = item["target_id"]
        url = item["spreadsheet_url"] or "(sem URL salva)"
        lines_text.append(f"  • {kind} {target} — última sync {when}")
        lines_text.append(f"    {url}")
        lines_html.append(
            f'<li><b>{kind}</b> <code>{target}</code> '
            f'— última sync <b>{when}</b><br>'
            f'<a href="{url}" style="color:#3397B9">{url}</a></li>'
        )

    text = (
        "Olá,\n\n"
        "Algumas das suas integrações Google Sheets pararam de sincronizar:\n\n"
        + "\n".join(lines_text)
        + "\n\n"
        "O que fazer:\n"
        "  1. Abrir o report no HYPR Report Center\n"
        "  2. No card do Google Sheets, clicar em 'Sincronizar agora'\n"
        "  3. Se voltar erro, reconectar a integração (Excluir → Conectar)\n\n"
        "Esse alerta dispara automaticamente quando a sincronização passa de "
        f"{STALE_THRESHOLD_HOURS}h sem sucesso. Você só recebe email das "
        "integrações que VOCÊ ativou.\n\n"
        "— HYPR Report Hub\n"
    )

    html = f"""<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C262F;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#1C262F;margin:0 0 16px">⚠ Integrações Google Sheets paradas</h2>
  <p>Algumas das suas integrações Google Sheets pararam de sincronizar:</p>
  <ul style="background:#FFF8E1;border-left:4px solid #B8A500;padding:12px 12px 12px 32px;margin:16px 0">
    {''.join(lines_html)}
  </ul>
  <h3 style="margin:24px 0 8px">O que fazer</h3>
  <ol>
    <li>Abrir o report no HYPR Report Center</li>
    <li>No card "Google Sheets conectado", clicar em <b>Sincronizar agora</b></li>
    <li>Se voltar erro, reconectar a integração (Excluir → Conectar)</li>
  </ol>
  <p style="color:#666;font-size:12px;margin-top:32px;border-top:1px solid #ddd;padding-top:12px">
    Esse alerta dispara automaticamente quando a sincronização passa de
    {STALE_THRESHOLD_HOURS}h sem sucesso. Você só recebe email das
    integrações que <b>você</b> ativou.<br>
    — HYPR Report Hub
  </p>
</body>
</html>"""

    subject = (
        f"⚠ {len(stale)} integração{'ões' if len(stale) > 1 else ''} "
        f"Google Sheets parada{'s' if len(stale) > 1 else ''}"
    )
    return {"subject": subject, "text": text, "html": html}


# ─── SendGrid send ───────────────────────────────────────────────────────────
def _send_email_via_sendgrid(
    *,
    to_email: str,
    subject: str,
    text: str,
    html: str,
) -> None:
    """Envia 1 email via SendGrid REST v3. Levanta exceção em erro."""
    if not SENDGRID_API_KEY:
        raise RuntimeError(
            "SENDGRID_API_KEY não configurada. Veja README de setup."
        )
    payload = {
        "personalizations": [{"to": [{"email": to_email}]}],
        "from":     {"email": SHEETS_ALERT_FROM, "name": "HYPR Report Hub"},
        "reply_to": {"email": SHEETS_ALERT_REPLY_TO},
        "subject":  subject,
        "content": [
            {"type": "text/plain", "value": text},
            {"type": "text/html",  "value": html},
        ],
    }
    req = urllib.request.Request(
        SENDGRID_API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {SENDGRID_API_KEY}",
            "Content-Type":  "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            # SendGrid retorna 202 Accepted quando aceita o email pra fila.
            if resp.status not in (200, 202):
                raise RuntimeError(f"SendGrid retornou status {resp.status}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"SendGrid erro {e.code}: {detail[:300]}")


# ─── Orchestrator ────────────────────────────────────────────────────────────
def alert_stale_integrations() -> Dict:
    """
    Encontra integrações stale, agrupa por created_by_email, manda 1 email
    por owner. Retorna sumário.

    Erros individuais (1 owner cuja API call falhou) não interrompem o resto —
    cada falha vira um item em `failures` no sumário, e o endpoint loga mas
    retorna 200 desde que a maioria tenha funcionado. Se TODAS falharem,
    propaga a última exceção pra dispararar o alerta sistêmico (5xx).
    """
    summary = {
        "total_stale":  0,
        "owners":       0,
        "emails_sent":  0,
        "failures":     [],
    }

    stale = find_stale_integrations()
    summary["total_stale"] = len(stale)
    if not stale:
        return summary

    by_owner: Dict[str, List[Dict]] = defaultdict(list)
    for item in stale:
        by_owner[item["created_by_email"]].append(item)
    summary["owners"] = len(by_owner)

    last_exc = None
    for owner_email, items in by_owner.items():
        try:
            body = _build_email_body(items)
            _send_email_via_sendgrid(
                to_email=owner_email,
                subject=body["subject"],
                text=body["text"],
                html=body["html"],
            )
            summary["emails_sent"] += 1
            logger.info(
                f"[INFO sheets_alert] enviado pra {owner_email} "
                f"({len(items)} integrações stale)"
            )
        except Exception as e:
            last_exc = e
            summary["failures"].append({"owner": owner_email, "error": str(e)[:300]})
            logger.error(f"[ERROR sheets_alert {owner_email}] {e}")

    # Se TODAS as tentativas falharam, propaga pra alertar o ops via Cloud
    # Monitoring (5xx no endpoint dispara o alert "cron retornou erro").
    if summary["emails_sent"] == 0 and last_exc is not None:
        raise last_exc

    return summary
