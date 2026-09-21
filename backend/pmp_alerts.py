"""
Alerta por email quando o sync PMP (Xandr Curate / PubMatic) está quebrado ou
com a base velha.

Por que existe
──────────────
O ledger `pmp_sync_runs` (21/08/2026) matou o silêncio no BANCO: toda execução
grava uma row, sucesso ou falha, e o painel de frescor do /admin/pmp lê de lá.
O que ele nunca resolveu é que **alguém precisa abrir o painel**.

Em 18–21/09/2026 a senha de API da Xandr expirou. O cron das 04h bateu nos três
dias, o ledger registrou os três 401, o painel ficou vermelho os três dias — e
a descoberta veio de alguém abrindo a tela na quarta manhã. Três dias de
entrega fora do hub e da planilha de faturamento porque o alarme estava certo e
mudo. Foi o MESMO desfecho do 401 da PubMatic de agosto, que é literalmente o
incidente que fez o ledger existir.

O `sheets_alerts` já resolve essa classe pras integrações de Google Sheets
(stale → email pro CS dono às 09h). Aqui é o mesmo padrão aplicado ao ledger do
PMP, que não tem dono por linha: vai pra uma lista fixa (`PMP_ALERT_TO`).

O que dispara (e o que NÃO dispara)
───────────────────────────────────
A régua é a mesma que o painel usa pra pintar **vermelho**. Amarelo não vira
email — alerta que toca no estado normal da manhã é alerta que vira filtro:

  • último run com status 'error'            → sim (e diz se é credencial)
  • último run 'skipped' (sem credencial)    → sim
  • nenhuma execução nas últimas 26h         → sim (cron morto)
  • run ok, mas a fonte está ≥2 dias atrás   → sim
  • run ok com a fonte 1 dia atrás           → NÃO (é a manhã antes de a fonte
                                               fechar D-1; ver pmpFreshness.js)
  • dias que faltam vieram como zero explícito → NÃO (fonte fechou o dia, a
                                               line é que não entregou)

Dedup
─────
Não tem, igual ao `sheets_alerts`. O cron roda 1x/dia, então uma quebra que
dura uma semana manda sete emails — que é o comportamento desejado: enquanto
está quebrado, continua doendo. Disparo manual no mesmo dia duplica o email.

Envvars
───────
PMP_ALERT_TO   — destinatários separados por vírgula.
                 Default: SHEETS_ALERT_FROM (platform@hypr.mobi).
SENDGRID_API_KEY / SHEETS_ALERT_FROM — reaproveitados do sheets_alerts.
"""

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

import pmp_sync_runs
# Reaproveita o remetente do sheets_alerts em vez de repetir o payload do
# SendGrid: é a mesma conta, o mesmo from verificado e o mesmo tratamento de
# erro. Duplicar isso significaria dois lugares pra consertar quando a key
# rotacionar.
from sheets_alerts import _send_email_via_sendgrid

logger = logging.getLogger(__name__)


PMP_ALERT_TO = os.environ.get(
    "PMP_ALERT_TO", os.environ.get("SHEETS_ALERT_FROM", "platform@hypr.mobi"))

# Sem execução nenhuma nesse tempo = o Cloud Scheduler parou. 26h cobre o cron
# diário das 04h com folga pra um deploy atravessado, mesmo racional do
# STALE_THRESHOLD_HOURS do sheets_alerts.
NO_RUN_THRESHOLD_HOURS = 26

# Atraso de DADO a partir do qual vira email. 1 dia é o estado normal da manhã
# (a fonte ainda não fechou D-1) e o painel pinta de amarelo; 2 é o que ele
# pinta de vermelho.
DATA_LAG_ALERT_DAYS = 2

SOURCE_LABELS = {"xandr": "Xandr Curate", "pubmatic": "PubMatic"}

# Mesmas assinaturas do `isCredentialError` do painel (pmpFreshness.js). Erro
# de credencial ganha destaque próprio no email porque é o único caso em que a
# ação é nossa, imediata e não passa sozinha no próximo run.
_CREDENTIAL_MARKERS = (
    "password has expired", "must be reset", "invalid username",
    "invalid password", "auth_failed", "authentication failed",
    "account is locked", "no_auth", "401", "403",
)

PANEL_URL = "https://report.hypr.mobi/admin/pmp/lista"


def _label(source: str) -> str:
    return SOURCE_LABELS.get(source, source)


def is_credential_error(error: Optional[str]) -> bool:
    if not error:
        return False
    low = str(error).lower()
    return any(m in low for m in _CREDENTIAL_MARKERS)


def _parse_ts(value) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value


def find_problems(runs: List[Dict], now: Optional[datetime] = None) -> List[Dict]:
    """Classifica o `latest_by_source()` do ledger em problemas que merecem email.

    Função pura (sem I/O) de propósito: a régua de quando alarmar é a parte que
    erra, e errar aqui significa ou email diário no estado normal ou silêncio na
    quebra — os dois já aconteceram neste pipeline.

    Devolve [{source, label, kind, headline, detail, error, credential}], onde
    `kind` ∈ {'credential','error','skipped','no_run','stale_data'}.
    """
    now = now or datetime.now(timezone.utc)
    problems = []

    for run in runs:
        source = run.get("source") or "xandr"
        label = _label(source)
        status = run.get("last_run_status")
        error = run.get("last_error")
        last_run_at = _parse_ts(run.get("last_run_at"))

        if status == "error":
            credential = is_credential_error(error)
            problems.append({
                "source": source, "label": label,
                "kind": "credential" if credential else "error",
                "credential": credential,
                "headline": (f"{label}: credencial recusada pela fonte"
                             if credential else f"{label}: sync falhando"),
                "detail": (
                    "A senha/credencial de API foi rejeitada. Isto NÃO se "
                    "resolve sozinho no próximo run: resetar no console da "
                    "fonte, atualizar o secret e redeployar."
                    if credential else
                    "A última execução terminou em erro. Se repetir no "
                    "próximo run, é falha real e não sondagem que estourou."),
                "error": error,
            })
            continue

        if status == "skipped":
            problems.append({
                "source": source, "label": label, "kind": "skipped",
                "credential": True,
                "headline": f"{label}: sync não executado — credencial ausente",
                "detail": ("Não há credencial desta fonte no ambiente, então o "
                           "bloco inteiro foi pulado. Conferir os secrets e o "
                           "último deploy."),
                "error": error,
            })
            continue

        # Sem row nenhuma, ou row velha demais: o Cloud Scheduler parou de
        # disparar. É o estado que o painel mostra igual a "fonte parada" e
        # que pede o conserto oposto (ver pmp_sync_runs.missing_probe_slots).
        if last_run_at is None or \
                (now - last_run_at) > timedelta(hours=NO_RUN_THRESHOLD_HOURS):
            quando = (f"a última foi {last_run_at.astimezone(pmp_sync_runs.BRT):%d/%m %H:%M} BRT"
                      if last_run_at else "nunca houve execução registrada")
            problems.append({
                "source": source, "label": label, "kind": "no_run",
                "credential": False,
                "headline": f"{label}: sem execução nas últimas "
                            f"{NO_RUN_THRESHOLD_HOURS}h",
                "detail": f"O Cloud Scheduler pode ter parado de disparar — {quando}.",
                "error": error,
            })
            continue

        # Job saudável, base velha. O estado que passou semanas invisível na
        # PubMatic: "Sync rodou hoje" em verde com o dado 2 dias atrás.
        lag = run.get("lag_days")
        if lag is None:
            continue
        zeros = run.get("trailing_zero_days")
        # Dias que faltam devolvidos como ZERO explícito = a fonte fechou o dia
        # e a line não entregou. Não é atraso de ninguém.
        if zeros is not None and zeros >= lag:
            continue
        if lag >= DATA_LAG_ALERT_DAYS:
            problems.append({
                "source": source, "label": label, "kind": "stale_data",
                "credential": False,
                "headline": f"{label}: sync ok, mas a base está {lag} dias atrás",
                "detail": (f"A API só tem dado até {run.get('api_last_day')}. "
                           "O job rodou sem erro — o atraso é da fonte ou da "
                           "hora da coleta, não do cron."),
                "error": None,
            })

    return problems


def build_email(problems: List[Dict]) -> Dict[str, str]:
    """Monta assunto/texto/html. Pura, pra dar pra cravar o texto em teste."""
    credential = [p for p in problems if p.get("credential")]
    labels = ", ".join(sorted({p["label"] for p in problems}))

    if credential:
        subject = f"[HYPR Report Hub] Credencial recusada — {labels}"
    elif len(problems) == 1:
        subject = f"[HYPR Report Hub] {problems[0]['headline']}"
    else:
        subject = f"[HYPR Report Hub] Sync PMP com problema — {labels}"

    linhas = []
    for p in problems:
        linhas.append(f"• {p['headline']}")
        linhas.append(f"  {p['detail']}")
        if p.get("error"):
            linhas.append(f"  Erro: {str(p['error'])[:300]}")
        linhas.append("")

    text = (
        "O sync do PMP Deals está com problema.\n\n"
        + "\n".join(linhas)
        + f"\nPainel: {PANEL_URL}\n"
        "\nEste email sai do ledger pmp_sync_runs, 1x/dia, enquanto o problema "
        "existir.\n"
    )

    itens = []
    for p in problems:
        erro = (f'<div style="font-family:monospace;font-size:11px;color:#b91c1c;'
                f'background:#fef2f2;padding:6px 8px;border-radius:4px;'
                f'margin-top:6px;word-break:break-word">{_escape(str(p["error"])[:300])}</div>'
                if p.get("error") else "")
        itens.append(
            f'<li style="margin-bottom:14px">'
            f'<strong>{_escape(p["headline"])}</strong><br>'
            f'<span style="color:#475569">{_escape(p["detail"])}</span>'
            f'{erro}</li>'
        )

    html = (
        '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;'
        'line-height:1.5;color:#0f172a">'
        '<p>O sync do <strong>PMP Deals</strong> está com problema.</p>'
        f'<ul style="padding-left:18px">{"".join(itens)}</ul>'
        f'<p><a href="{PANEL_URL}">Abrir o painel</a></p>'
        '<p style="color:#64748b;font-size:12px">Este email sai do ledger '
        '<code>pmp_sync_runs</code>, 1x/dia, enquanto o problema existir.</p>'
        '</div>'
    )
    return {"subject": subject, "text": text, "html": html}


def _escape(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def recipients() -> List[str]:
    return [e.strip() for e in PMP_ALERT_TO.split(",") if e.strip()]


def alert_pmp_sync() -> Dict:
    """Lê o ledger, classifica e manda 1 email por destinatário. Sumário no fim.

    Falha de envio pra UM destinatário não impede os outros; se todas falharem,
    a última exceção sobe pro endpoint, que devolve 5xx — aí o alert policy do
    GCP toca, que é o alarme de último recurso (alerta que falha calado é o
    problema que este módulo existe pra resolver, entrando por outra porta).
    """
    summary: Dict = {"problems": [], "emails_sent": 0, "failures": []}

    runs = pmp_sync_runs.latest_by_source(days=30)
    problems = find_problems(runs)
    summary["problems"] = [
        {"source": p["source"], "kind": p["kind"], "headline": p["headline"]}
        for p in problems
    ]
    if not problems:
        logger.info("[pmp_alert] nenhuma fonte com problema")
        return summary

    body = build_email(problems)
    last_exc = None
    for to in recipients():
        try:
            _send_email_via_sendgrid(to_email=to, subject=body["subject"],
                                     text=body["text"], html=body["html"])
            summary["emails_sent"] += 1
            logger.info("[pmp_alert] enviado pra %s (%d problema(s))", to, len(problems))
        except Exception as e:  # noqa: BLE001
            last_exc = e
            summary["failures"].append({"to": to, "error": str(e)[:300]})
            logger.error("[ERROR pmp_alert %s] %s", to, e)

    if summary["emails_sent"] == 0 and last_exc is not None:
        raise last_exc
    return summary
