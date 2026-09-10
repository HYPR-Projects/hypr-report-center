#!/usr/bin/env python3
"""
Sonda da API da PubMatic — o que ela DEVOLVE, cru, pros últimos dias.

Roda no runner do GitHub (workflow `pmp-pubmatic-probe`), que alcança
api.pubmatic.com e o Secret Manager. O container de dev não alcança nenhum
dos dois, e a Cloud Function só devolve o que já foi parseado — quando a base
"não atualiza" e o ledger diz `api_last_day` parado, a pergunta que sobra é:
a API está devolvendo ZERO pros dias que faltam, ou está devolvendo algo que o
parser descarta? Isto responde olhando a resposta literal.

Também mede latência por request, porque "The read operation timed out"
apareceu 3 vezes em 3 dias nas sondagens horárias.

Credenciais via env (PUBMATIC_USER / PUBMATIC_PASS). Nunca são impressas.
Gera 1 Bearer por execução (limite da PubMatic: 200 gerações em 20 min).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

BASE = "https://api.pubmatic.com"
ACCOUNT = os.environ.get("PUBMATIC_ACCOUNT_ID", "74689")
DAYS = int(os.environ.get("PROBE_DAYS", "6"))
TIMEOUT = int(os.environ.get("PROBE_TIMEOUT", "240"))
# PROBE_FULL=0 → só o request do conector + resumo por dia (1 request).
FULL = os.environ.get("PROBE_FULL", "1") != "0"
BRT = timezone(timedelta(hours=-3))


def now_brt():
    return datetime.now(BRT).strftime("%d/%m %H:%M BRT")


def token(user, pwd):
    body = json.dumps({"apiProduct": "PUBLISHER", "userName": user, "password": pwd}).encode()
    req = urllib.request.Request(BASE + "/v1/developer-integrations/developer/token",
                                 data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=60) as r:
        payload = json.loads(r.read())
    print(f"[auth] Bearer emitido em {time.time()-t0:.1f}s (chaves: {sorted(payload)})")
    return payload["accessToken"]


def get(path, params, tok, timeout=TIMEOUT):
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, method="GET")
    req.add_header("accept", "application/json")
    req.add_header("authorization", f"Bearer {tok}")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return 200, json.loads(raw), time.time() - t0, len(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore")
        return e.code, raw[:600], time.time() - t0, len(raw)
    except Exception as e:  # noqa: BLE001 — sonda: qualquer falha é dado
        return 0, f"{type(e).__name__}: {e}", time.time() - t0, 0


def show(title, code, payload, dt, size, max_rows=60):
    print(f"\n=== {title} → HTTP {code} em {dt:.1f}s ({size} bytes)")
    if code != 200:
        print("   ", payload)
        return None
    cols = payload.get("columns") or []
    rows = payload.get("rows") or []
    print(f"    keys={sorted(payload)} columns={cols} rows={len(rows)}")
    extra = {k: v for k, v in payload.items() if k not in ("columns", "rows", "displayValue")}
    if extra:
        print("    extra:", json.dumps(extra, ensure_ascii=False)[:600])
    dv = payload.get("displayValue") or {}
    if dv:
        print("    displayValue:", json.dumps(dv, ensure_ascii=False)[:800])
    if "date" in cols:
        di = cols.index("date")
        rows = sorted(rows, key=lambda r: str(r[di]), reverse=True)
    for r in rows[:max_rows]:
        print("     ", r)
    if len(rows) > max_rows:
        print(f"      … +{len(rows)-max_rows} rows")
    return payload


def main():
    user, pwd = os.environ.get("PUBMATIC_USER"), os.environ.get("PUBMATIC_PASS")
    if not (user and pwd):
        print("::error::PUBMATIC_USER/PASS ausentes no ambiente"); sys.exit(2)
    print(f"Sonda PubMatic · conta {ACCOUNT} · {now_brt()} · janela {DAYS} dias · timeout {TIMEOUT}s")
    tok = token(user, pwd)

    today = datetime.now(BRT).date()
    start = today - timedelta(days=DAYS)
    base = f"/v1/analytics/data/dataprovider/{ACCOUNT}"
    std_metrics = "paidImpressions,spend,transactionRevenue,dataRevenue,clicks"

    # 1. Exatamente o request do conector (janela curta) — o que o sync vê.
    p = show("A · request do conector (dealMetaId,date)",
             *get(base, {"dimensions": "dealMetaId,date", "metrics": std_metrics,
                         "fromDate": start.isoformat(), "toDate": today.isoformat(),
                         "dateUnit": "date"}, tok), max_rows=0 if not FULL else 60)
    if not FULL:
        summary(p, today, start)
        print(f"\nFim · {now_brt()}")
        return

    # 2. Só por dia (sem deal): se o total da conta tem dado em D-1/D-2 e o
    #    recorte por deal não, a atribuição por deal é que está atrasada.
    show("B · só por date (total da conta)",
         *get(base, {"dimensions": "date", "metrics": std_metrics,
                     "fromDate": start.isoformat(), "toDate": today.isoformat(),
                     "dateUnit": "date"}, tok))

    # 3. Mesma janela, métricas mínimas: latência muda?
    show("C · dealMetaId,date só com paidImpressions,spend",
         *get(base, {"dimensions": "dealMetaId,date", "metrics": "paidImpressions,spend",
                     "fromDate": start.isoformat(), "toDate": today.isoformat(),
                     "dateUnit": "date"}, tok))

    # 4. Janela de 21 dias — a do sync em produção. É esta que estoura?
    show("D · janela de 21 dias (a do sync em produção)",
         *get(base, {"dimensions": "dealMetaId,date", "metrics": std_metrics,
                     "fromDate": (today - timedelta(days=21)).isoformat(),
                     "toDate": today.isoformat(), "dateUnit": "date"}, tok), max_rows=8)

    # 5. Outras dimensões que podem revelar por onde o dado entra (deal id
    #    textual, publisher, DSP). 400 aqui é resposta válida: diz o que a API
    #    aceita.
    for dims in ("publisherDealId,date", "dspId,date", "publisherId,date",
                 "dealMetaId,dspId,date"):
        show(f"E · dimensions={dims}",
             *get(base, {"dimensions": dims, "metrics": "paidImpressions,spend",
                         "fromDate": (today - timedelta(days=3)).isoformat(),
                         "toDate": today.isoformat(), "dateUnit": "date"}, tok), max_rows=30)

    # 6. Granularidade horária pra ontem e hoje — se existir, mostra até que
    #    hora a PubMatic já processou.
    for du in ("hour", "hourly"):
        show(f"F · dateUnit={du} (ontem→hoje)",
             *get(base, {"dimensions": "date", "metrics": "paidImpressions,spend",
                         "fromDate": (today - timedelta(days=1)).isoformat(),
                         "toDate": today.isoformat(), "dateUnit": du}, tok), max_rows=50)

    # 7. Outros produtos de analytics na mesma conta. HYPR é curadora
    #    (Auction Packages); o report que consumimos é o de data provider.
    for path in (f"/v1/analytics/data/curator/{ACCOUNT}",
                 f"/v1/analytics/data/auctionpackage/{ACCOUNT}",
                 f"/v1/analytics/data/buyer/{ACCOUNT}",
                 f"/v1/analytics/data/publisher/{ACCOUNT}",
                 f"/v1/analytics/data/demandpartner/{ACCOUNT}"):
        show(f"G · {path}",
             *get(path, {"dimensions": "date", "metrics": "paidImpressions,spend",
                         "fromDate": (today - timedelta(days=3)).isoformat(),
                         "toDate": today.isoformat(), "dateUnit": "date"}, tok, timeout=90),
             max_rows=10)

    summary(p, today, start)
    print(f"\nFim · {now_brt()}")


WEEKDAYS = ("seg", "ter", "qua", "qui", "sex", "sáb", "dom")


def summary(p, today, start):
    """Resumo por dia e por deal do request A: zero explícito × dia ausente,
    com o dia da semana — é o que mostra se o zero segue um padrão semanal
    (flight/dayparting do comprador) ou é buraco de reporting."""
    if not p:
        return
    cols = p["columns"]; di = cols.index("date"); ki = cols.index("dealMetaId")
    ii = cols.index("paidImpressions"); si = cols.index("spend")
    names = ((p.get("displayValue") or {}).get("dealMetaId")) or {}
    by_day = {}
    for r in p.get("rows") or []:
        d = str(r[di])[:10]
        agg = by_day.setdefault(d, {})
        agg[str(r[ki])] = (int(float(r[ii] or 0)), float(r[si] or 0))
    deals = sorted({str(r[ki]) for r in p.get("rows") or []})
    print("\n=== Resumo por dia (request A) ===")
    for k in deals:
        print(f"    deal {k} = {names.get(k)}")
    print("    dia          sem  " + "  ".join(f"{k:>24}" for k in deals))
    d = today
    while d >= start:
        k = d.isoformat()
        wd = WEEKDAYS[d.weekday()]
        if k in by_day:
            cells = []
            for deal in deals:
                v = by_day[k].get(deal)
                if v is None:
                    cells.append(f"{'(sem row)':>24}")
                elif v[0] == 0 and v[1] == 0:
                    cells.append(f"{'ZERO':>24}")
                else:
                    cells.append(f"{v[0]:>10,} / R$ {v[1]:>9,.0f}")
            print(f"    {k}   {wd}  " + "  ".join(cells))
        else:
            print(f"    {k}   {wd}  — dia AUSENTE da resposta")
        d -= timedelta(days=1)


if __name__ == "__main__":
    main()
