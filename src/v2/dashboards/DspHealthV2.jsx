// src/v2/dashboards/DspHealthV2.jsx
//
// Aba interna "DSPs" — admin-only (nunca renderizada pra cliente; o gate
// está no ClientDashboardV2 via isAdmin, e o endpoint é admin-gated no
// backend). Central de controle da entrega POR FONTE (DV360 / Xandr /
// Amazon / StackAdapt / Yahoo) da campanha: cards de saúde por DSP,
// série diária empilhada e tabela dia × fonte.
//
// Fonte de dados: action=dsp_breakdown (unified_daily_performance_metrics,
// única base com a coluna `source`). O custo aqui é o total_cost CRU do
// unified (custo de mídia por fonte) — régua diferente do custo efetivo
// do report; o rótulo do card deixa explícito pra não confundir.

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { cn } from "../../ui/cn";
import { getDspBreakdown } from "../../lib/api";
import { SparklineV2 } from "../components/SparklineV2";
import { ChartCardV2 } from "../components/ChartCardV2";
import { useThemeColors } from "../hooks/useThemeColors";
import { formatBRL } from "../admin/lib/format";

// Cores fixas por DSP (literais: recharts/SVG não leem CSS var em prop).
// Hues escolhidos pra funcionarem em dark e light e serem distinguíveis
// entre si num gráfico empilhado.
const DSP_COLORS = {
  DV360: "#4285F4",
  XANDR: "#8B5CF6",
  AMAZON: "#FF9900",
  STACKADAPT: "#14B8A6",
  YAHOO: "#D946EF",
};
const dspColor = (source) =>
  DSP_COLORS[String(source || "").toUpperCase()] || "#3397B9";

const DSP_LABELS = {
  DV360: "DV360",
  XANDR: "Xandr",
  AMAZON: "Amazon",
  STACKADAPT: "StackAdapt",
  YAHOO: "Yahoo",
};
const dspLabel = (source) =>
  DSP_LABELS[String(source || "").toUpperCase()] || source;

const TONE = {
  ok: { dot: "bg-success", text: "text-success", label: "Entregando" },
  warn: { dot: "bg-warning", text: "text-warning", label: "Atraso" },
  danger: { dot: "bg-danger", text: "text-danger", label: "Parada" },
  neutral: { dot: "bg-fg-subtle", text: "text-fg-subtle", label: "—" },
};

const fmtInt = new Intl.NumberFormat("pt-BR");
const fmtBrDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}` : iso || "—";
};

export default function DspHealthV2({ token, data, isAdmin, adminJwt }) {
  // Resultado carimbado com o token que o produziu: "loading" e "stale" são
  // DERIVADOS (res.token !== token) em vez de resetados via setState síncrono
  // no effect — anti-padrão React 19 que o lint do repo barra.
  const [res, setRes] = useState(null); // { token, payload, error }
  const colors = useThemeColors();

  useEffect(() => {
    let cancelled = false;
    getDspBreakdown(token, adminJwt)
      .then((payload) => {
        if (!cancelled) setRes({ token, payload, error: null });
      })
      .catch((error) => {
        if (!cancelled) setRes({ token, payload: null, error });
      });
    return () => {
      cancelled = true;
    };
  }, [token, adminJwt]);

  const current = res && res.token === token ? res : null;
  const state = {
    loading: !current,
    error: current?.error || null,
    payload: current?.payload || null,
  };

  const campaignEnded = useMemo(() => {
    const end = data?.campaign?.early_end_date || data?.campaign?.end_date;
    if (!end) return false;
    return new Date(`${String(end).slice(0, 10)}T23:59:59`) < new Date();
  }, [data]);

  const model = useMemo(
    () => buildModel(state.payload, campaignEnded),
    [state.payload, campaignEnded],
  );

  if (!isAdmin) return null;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-bold text-fg">Entrega por DSP</h2>
        <p className="text-sm text-fg-muted">
          Aba interna (admin) — saúde da entrega desta campanha quebrada por
          plataforma, direto do consolidado diário. Custo aqui é o custo de
          mídia por fonte, não o custo efetivo faturável do report.
        </p>
      </header>

      {state.loading && (
        <div className="rounded-xl border border-border bg-surface p-6 text-sm text-fg-subtle italic">
          Consultando entrega por DSP…
        </div>
      )}
      {state.error && (
        <div className="rounded-xl border border-danger/40 bg-danger/5 p-6 text-sm text-danger">
          Não foi possível carregar a entrega por DSP. Recarregue a página ou
          tente novamente em instantes.
        </div>
      )}

      {model && model.sources.length === 0 && !state.loading && !state.error && (
        <div className="rounded-xl border border-border bg-surface p-6 text-sm text-fg-subtle">
          Nenhuma entrega registrada no consolidado para este token.
        </div>
      )}

      {model && model.sources.length > 0 && (
        <>
          {/* Cards de saúde por DSP */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {model.sources.map((s) => {
              const tone = TONE[s.tone];
              return (
                <div
                  key={s.source}
                  className="rounded-xl border border-border bg-surface p-4 space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="size-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: dspColor(s.source) }}
                        aria-hidden
                      />
                      <span className="font-bold text-fg truncate">
                        {dspLabel(s.source)}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-[11px] font-semibold",
                        tone.text,
                      )}
                    >
                      <span className={cn("size-1.5 rounded-full", tone.dot)} />
                      {campaignEnded ? "Encerrada" : tone.label}
                    </span>
                  </div>

                  <div className="flex items-end justify-between gap-2">
                    <div>
                      <div className="text-[10.5px] uppercase tracking-wider text-fg-subtle">
                        Última entrega
                      </div>
                      <div
                        className={cn(
                          "text-sm font-semibold font-mono tabular-nums",
                          s.tone === "danger" && !campaignEnded
                            ? "text-danger"
                            : "text-fg",
                        )}
                      >
                        {fmtBrDay(s.lastDate)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10.5px] uppercase tracking-wider text-fg-subtle">
                        Share da entrega
                      </div>
                      <div className="text-sm font-semibold text-fg tabular-nums">
                        {s.sharePct}%
                      </div>
                    </div>
                  </div>

                  <SparklineV2
                    values={s.spark}
                    stroke={dspColor(s.source)}
                    fillOpacity={0.15}
                    minValue={0}
                    width={220}
                    height={30}
                    className="w-full"
                    ariaLabel={`Entrega diária ${dspLabel(s.source)} (14 dias)`}
                  />

                  <dl className="grid grid-cols-3 gap-2 text-[11px]">
                    <div>
                      <dt className="text-fg-subtle">Impressões</dt>
                      <dd className="font-semibold text-fg tabular-nums">
                        {fmtInt.format(s.impressions)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-fg-subtle">eCPM mídia</dt>
                      <dd className="font-semibold text-fg tabular-nums">
                        {s.ecpm != null ? formatBRL(s.ecpm) : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-fg-subtle">CTR</dt>
                      <dd className="font-semibold text-fg tabular-nums">
                        {s.ctr != null ? `${s.ctr}%` : "—"}
                      </dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>

          {/* Série diária empilhada por fonte */}
          <ChartCardV2 title="Impressões por dia · por DSP" downloadable={isAdmin} filename={`dsp-diario-${token}`}>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={model.chart} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={colors?.border || "#333"} vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: colors?.["fg-subtle"] || "#888" }}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: colors?.["fg-subtle"] || "#888" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => fmtInt.format(v)}
                    width={70}
                  />
                  <Tooltip
                    formatter={(value, name) => [fmtInt.format(value), dspLabel(name)]}
                    contentStyle={{
                      backgroundColor: colors?.["canvas-elevated"] || "#1a1a1a",
                      border: `1px solid ${colors?.border || "#333"}`,
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: colors?.["fg-muted"] || "#aaa" }}
                  />
                  <Legend
                    formatter={(v) => (
                      <span style={{ color: colors?.["fg-muted"] || "#aaa", fontSize: 12 }}>
                        {dspLabel(v)}
                      </span>
                    )}
                  />
                  {model.sourceKeys.map((source) => (
                    <Bar
                      key={source}
                      dataKey={source}
                      stackId="dsp"
                      fill={dspColor(source)}
                      radius={[0, 0, 0, 0]}
                      maxBarSize={28}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCardV2>

          {/* Tabela diária dia × fonte */}
          <div className="rounded-xl border border-border bg-surface p-4 md:p-5">
            <div className="text-[11px] font-bold uppercase tracking-widest text-signature mb-3">
              Base diária · por DSP
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] tabular-nums">
                <thead>
                  <tr className="text-left text-fg-subtle border-b border-border">
                    <th className="py-2 pr-4 font-medium">Dia</th>
                    {model.sourceKeys.map((source) => (
                      <th key={source} className="py-2 pr-4 font-medium text-right">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="size-1.5 rounded-full"
                            style={{ backgroundColor: dspColor(source) }}
                          />
                          {dspLabel(source)}
                        </span>
                      </th>
                    ))}
                    <th className="py-2 pr-4 font-medium text-right">Total imps</th>
                    <th className="py-2 font-medium text-right">Custo mídia</th>
                  </tr>
                </thead>
                <tbody>
                  {model.table.map((row) => (
                    <tr key={row.date} className="border-b border-border/50 last:border-0">
                      <td className="py-1.5 pr-4 font-mono text-fg-muted">{fmtBrDay(row.date)}</td>
                      {model.sourceKeys.map((source) => (
                        <td
                          key={source}
                          className={cn(
                            "py-1.5 pr-4 text-right",
                            row[source] ? "text-fg" : "text-fg-subtle/50",
                          )}
                        >
                          {row[source] ? fmtInt.format(row[source]) : "·"}
                        </td>
                      ))}
                      <td className="py-1.5 pr-4 text-right font-semibold text-fg">
                        {fmtInt.format(row.total)}
                      </td>
                      <td className="py-1.5 text-right text-fg-muted">
                        {formatBRL(row.cost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Modelagem ───────────────────────────────────────────────────────────

function buildModel(payload, campaignEnded) {
  if (!payload) return null;
  const daily = Array.isArray(payload.daily) ? payload.daily : [];
  const dates = [...new Set(daily.map((r) => r.date))].sort();
  const maxDate = dates[dates.length - 1] || null;
  const totalImps = daily.reduce((a, r) => a + (r.impressions || 0), 0);

  // agrega por (source, date) — o daily vem por media_type também
  const bySourceDate = new Map();
  for (const r of daily) {
    const key = `${r.source}|${r.date}`;
    const cur = bySourceDate.get(key) || { impressions: 0, cost: 0 };
    cur.impressions += r.impressions || 0;
    cur.cost += r.total_cost || 0;
    bySourceDate.set(key, cur);
  }

  const sourceKeys = [...new Set(daily.map((r) => r.source))].sort(
    (a, b) =>
      sumFor(daily, b, "impressions") - sumFor(daily, a, "impressions"),
  );

  const sources = sourceKeys.map((source) => {
    const rows = daily.filter((r) => r.source === source);
    const imps = rows.reduce((a, r) => a + (r.impressions || 0), 0);
    const clicks = rows.reduce((a, r) => a + (r.clicks || 0), 0);
    const cost = rows.reduce((a, r) => a + (r.total_cost || 0), 0);
    const lastDate = rows.map((r) => r.date).sort().at(-1) || null;
    const daysBehind =
      maxDate && lastDate
        ? Math.round(
            (new Date(`${maxDate}T00:00:00Z`) - new Date(`${lastDate}T00:00:00Z`)) /
              86_400_000,
          )
        : null;
    const tone = campaignEnded
      ? "neutral"
      : daysBehind == null
        ? "neutral"
        : daysBehind <= 1
          ? "ok"
          : daysBehind <= 3
            ? "warn"
            : "danger";
    // sparkline: últimos 14 dias do flight (0 nos dias sem entrega da fonte)
    const last14 = dates.slice(-14);
    const spark = last14.map(
      (d) => bySourceDate.get(`${source}|${d}`)?.impressions || 0,
    );
    return {
      source,
      impressions: imps,
      lastDate,
      tone,
      sharePct: totalImps ? Math.round((imps / totalImps) * 100) : 0,
      ecpm: imps && cost ? (cost / imps) * 1000 : null,
      ctr: imps ? Math.round((clicks / imps) * 10000) / 100 : null,
      spark,
    };
  });

  // chart + tabela: uma linha por dia, uma chave por fonte
  const chart = dates.map((d) => {
    const row = { date: d, label: fmtBrDay(d) };
    for (const source of sourceKeys) {
      row[source] = bySourceDate.get(`${source}|${d}`)?.impressions || 0;
    }
    return row;
  });
  const table = [...dates].reverse().map((d) => {
    const row = { date: d, total: 0, cost: 0 };
    for (const source of sourceKeys) {
      const cell = bySourceDate.get(`${source}|${d}`);
      row[source] = cell?.impressions || 0;
      row.total += cell?.impressions || 0;
      row.cost += cell?.cost || 0;
    }
    return row;
  });

  return { sources, sourceKeys, chart, table };
}

function sumFor(daily, source, field) {
  return daily
    .filter((r) => r.source === source)
    .reduce((a, r) => a + (r[field] || 0), 0);
}
