// src/v2/dashboards/QualityV2.jsx
//
// Aba "Quality" do report: verificação DoubleVerify das campanhas DV
// conectadas a esta campanha, no período escolhido pelo admin. Mostra os
// KQIs do Pinnacle (Viewable, Authentic Viewable, Authentic, Brand Suitable,
// Fraud/SIVT Free, In Geo), Blocks/Incidents e, com mais de uma campanha DV,
// a quebra por campanha.
//
// O período é o da CONEXÃO, não o filtro de datas do report: é o admin quem
// define qual janela da DV representa a campanha (a DV não conhece o token
// nem as datas do HYPR). Admin conecta pelo botão no topo da aba.

import { useEffect, useMemo, useState } from "react";
import { getQualityReport } from "../../lib/api";
import {
  KQI_DEFS, formatRate, formatCompact, summarizeQuality,
} from "../../shared/dvQualityReport";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/Skeleton";
import { KqiRing } from "../components/dv/KqiRing";
import { QualityLinksModalV2 } from "../components/dv/QualityLinksModalV2";
import { PoweredByDV } from "../components/dv/PoweredByDV";

const nf = new Intl.NumberFormat("pt-BR");

function fmtDay(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function monthLabel(ymdStr) {
  const [y, m] = String(ymdStr || "").split("-").map(Number);
  if (!y || !m) return null;
  const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${MESES[m - 1]}/${String(y).slice(-2)}`;
}

// Cache do payload por visão + conexão: trocar de aba e voltar não refaz o
// relatório (o backend já guarda 1h, mas a ida até lá custa 5-15s a frio).
const cache = new Map();

export default function QualityV2({ token, view = null, data, isAdmin = false, adminJwt = null, onLinksChanged }) {
  const quality = data?.quality || { linked: false };
  const camp = data?.campaign || {};
  const linkKey = quality.linked
    ? `${token}|${view || ""}|${(quality.campaigns || []).join("§")}|${quality.date_from}|${quality.date_to}`
    : null;

  const [state, setState] = useState(() => ({
    status: linkKey && cache.has(linkKey) ? "ready" : "idle",
    payload: linkKey ? cache.get(linkKey) || null : null,
    error: null,
  }));
  const [reloadKey, setReloadKey] = useState(0);
  const [refresh, setRefresh] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);

  useEffect(() => {
    if (!linkKey) return undefined;
    if (!refresh && cache.has(linkKey)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sincroniza com o cache
      setState({ status: "ready", payload: cache.get(linkKey), error: null });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ ...s, status: s.payload ? "refreshing" : "loading", error: null }));
    getQualityReport({ token, view, refresh, adminJwt })
      .then((payload) => {
        if (cancelled) return;
        cache.set(linkKey, payload);
        setState({ status: "ready", payload, error: null });
      })
      .catch((error) => { if (!cancelled) setState((s) => ({ ...s, status: "error", error })); })
      .finally(() => { if (!cancelled) setRefresh(false); });
    return () => { cancelled = true; };
  }, [linkKey, token, view, adminJwt, reloadKey, refresh]);

  const summary = useMemo(
    () => (state.payload?.rows ? summarizeQuality(state.payload) : null),
    [state.payload],
  );

  // Alvo da conexão: em report agrupado, o admin escolhe o mês.
  const members = data?.merge_meta?.members || [];
  const targets = members.length
    ? members.map((m) => ({ token: m.short_token, label: `${monthLabel(m.start_date) || m.short_token} · ${m.short_token}` }))
    : [{ token, label: token }];
  const defaultTarget = !members.length
    ? token
    : view && members.some((m) => m.short_token === view)
      ? view
      : data?.merge_meta?.active_token || members[0].short_token;

  const onSaved = async () => {
    cache.clear();
    await onLinksChanged?.();
    setReloadKey((k) => k + 1);
  };

  const periodLabel = state.payload?.from
    ? `${fmtDay(state.payload.from)} → ${fmtDay(state.payload.to)}`
    : quality.date_from
      ? `${fmtDay(quality.date_from)} → ${fmtDay(quality.date_to)}`
      : null;

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <h2 className="text-lg font-bold text-fg leading-tight">Quality</h2>
          <span aria-hidden="true" className="h-4 w-px bg-border-strong" />
          <PoweredByDV />
        </div>
        <p className="text-[12px] text-fg-subtle mt-1">
          Verificação de mídia
          {periodLabel ? ` · ${periodLabel}` : ""}
          {summary?.dayCount ? ` · ${summary.dayCount} ${summary.dayCount === 1 ? "dia" : "dias"} com dado` : ""}
        </p>
      </div>
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          {quality.has_abs === false && (
            <span className="text-[11px] text-fg-subtle" title="Nenhum sinal de ABS (DV pre-bid no DV360, DV/IAS no Xandr ou marcação manual) nesta campanha">
              Sem ABS detectado
            </span>
          )}
          {quality.linked && (
            <Button variant="ghost" size="sm" onClick={() => setRefresh(true)} disabled={state.status === "loading" || state.status === "refreshing"}>
              Atualizar dados
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setLinksOpen(true)}>
            {quality.linked ? "Gerenciar conexão" : "Conectar DoubleVerify"}
          </Button>
        </div>
      )}
    </div>
  );

  const modal = isAdmin && linksOpen ? (
    <QualityLinksModalV2
      open={linksOpen}
      onOpenChange={setLinksOpen}
      targets={targets}
      defaultTarget={defaultTarget}
      adminJwt={adminJwt}
      campaignHint={`${camp.client_name || ""} ${camp.campaign_name || ""}`}
      defaultFrom={camp.start_date || ""}
      defaultTo={camp.early_end_date || camp.end_date || ""}
      onSaved={onSaved}
    />
  ) : null;

  if (!quality.linked) {
    return (
      <div className="space-y-5">
        {header}
        <EmptyState
          title="Nenhuma campanha DoubleVerify conectada"
          body={isAdmin
            ? "Conecte as campanhas da DoubleVerify que correspondem a esta campanha e escolha o período. A aba aparece para o cliente assim que você salvar."
            : "A verificação de qualidade desta campanha aparece aqui assim que for conectada."}
          action={isAdmin ? <Button size="sm" onClick={() => setLinksOpen(true)}>Conectar DoubleVerify</Button> : null}
        />
        {modal}
      </div>
    );
  }

  let body;
  if (state.status === "loading" || state.status === "idle") {
    body = (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-[230px] rounded-xl" />
        <Skeleton className="h-[110px] rounded-xl" />
        <p className="text-xs text-fg-subtle">Buscando os dados na DoubleVerify — a primeira carga leva alguns segundos.</p>
      </div>
    );
  } else if (state.status === "error" && !state.payload) {
    body = (
      <EmptyState
        title="Não foi possível carregar a verificação agora"
        body={state.error?.message || "Tente novamente em alguns minutos."}
        action={<Button size="sm" variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>Tentar de novo</Button>}
      />
    );
  } else if (state.payload?.pending) {
    body = (
      <EmptyState
        title="O período da análise ainda não começou"
        body={`Os dados aparecem a partir de ${fmtDay(quality.date_from)}, conforme a DoubleVerify fecha cada dia.`}
      />
    );
  } else if (!summary || (summary.totals.monitored_ads === 0 && summary.totals.requests === 0)) {
    body = (
      <EmptyState
        title="Sem dados da DoubleVerify no período"
        body={isAdmin
          ? "A DV não devolveu entrega para as campanhas conectadas nesse período. Confira as campanhas e as datas em “Gerenciar conexão”."
          : "Ainda não há dados de verificação para o período desta campanha."}
      />
    );
  } else {
    body = <QualityBody summary={summary} />;
  }

  return (
    <div className={state.status === "refreshing" ? "space-y-5 opacity-70 transition-opacity" : "space-y-5"}>
      {header}
      {body}
      {modal}
    </div>
  );
}

function QualityBody({ summary }) {
  const { totals, rates, campaigns } = summary;
  const stats = [
    { label: "Monitored Ads", value: formatCompact(totals.monitored_ads), title: nf.format(totals.monitored_ads) },
    { label: "Measured Impressions", value: formatCompact(totals.measured_impressions), title: nf.format(totals.measured_impressions) },
    {
      label: "Blocks",
      value: rates.blocks == null ? "N/A" : formatRate(rates.blocks),
      sub: totals.requests ? `${formatCompact(totals.blocks)} de ${formatCompact(totals.requests)} requests` : "Sem requests no período",
    },
    {
      label: "Incidents",
      value: rates.incidents == null ? "N/A" : formatRate(rates.incidents),
      sub: totals.monitored_ads ? `${formatCompact(totals.unique_incidents)} de ${formatCompact(totals.monitored_ads)} ads` : "",
    },
  ];
  return (
    <>
      <section className="rounded-xl border border-border bg-surface p-5">
        <h3 className="text-sm font-bold text-fg mb-4">Key Quality Indicators</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-x-3 gap-y-5">
          {KQI_DEFS.map((k) => (
            <KqiRing
              key={k.key}
              label={k.label}
              rate={rates[k.key]}
              num={totals[k.num] || 0}
              den={totals[k.den] || 0}
              denLabel={k.den === "measured_impressions" ? "Measured Impressions" : "Monitored Ads"}
            />
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-border bg-surface px-4 py-3">
            <div className="text-xs text-fg-muted">{s.label}</div>
            <div className="text-xl font-extrabold tabular-nums text-fg" title={s.title}>{s.value}</div>
            {s.sub && <div className="text-[11px] text-fg-subtle tabular-nums">{s.sub}</div>}
          </div>
        ))}
      </section>

      {campaigns.length > 1 && <CampaignTable campaigns={campaigns} />}

      <p className="text-[11px] text-fg-subtle">
        Dados até o último dia fechado pela DoubleVerify (D-1).
        Viewable e Authentic Viewable sobre Measured Impressions; demais taxas sobre Monitored Ads.
      </p>
    </>
  );
}

const COLS = [
  { key: "monitored_ads", label: "Monitored Ads", kind: "count" },
  ...KQI_DEFS.map((k) => ({ key: k.key, label: k.label, kind: "rate" })),
];

function CampaignTable({ campaigns }) {
  return (
    <section className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-5 py-3 border-b border-border">
        <h3 className="text-sm font-bold text-fg">Por campanha DoubleVerify</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left text-fg-muted">
              <th className="px-4 py-2 font-semibold min-w-[220px]">Campanha</th>
              {COLS.map((c) => (
                <th key={c.key} className="px-3 py-2 font-semibold text-right whitespace-nowrap">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {campaigns.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-4 py-2 font-semibold text-fg break-all">{r.name}</td>
                {COLS.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-right text-fg whitespace-nowrap">
                    {c.kind === "count" ? formatCompact(r.totals[c.key]) : formatRate(r.rates[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EmptyState({ title, body, action }) {
  return (
    <div className="rounded-xl border border-dashed border-border-strong bg-surface px-6 py-10 text-center">
      <div className="mx-auto max-w-[560px]">
        <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">{body}</p>
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}
