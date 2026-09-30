// src/v2/admin/components/BlockingTrendsChart.jsx
//
// "Blocking Trends" do Pinnacle na seção DoubleVerify: taxa de bloqueio por
// dia (total e por motivo) e o volume de Requests, no período e nos filtros
// de Brand/Campaign da página.
//
// O Pinnacle desenha tudo num gráfico só com dois eixos (% à esquerda,
// Requests à direita). Aqui são dois gráficos empilhados com o mesmo eixo de
// datas: dois eixos Y num mesmo plano fazem o leitor comparar alturas que não
// têm relação nenhuma (a escala da direita é arbitrária). O tooltip é
// sincronizado entre os dois, então um hover mostra o dia inteiro.
//
// Cores: Block Rate (o total) na cor do texto — é o agregado, não mais um
// motivo; os três motivos nos três primeiros slots da paleta categórica
// (validados par a par, CVD e visão normal, nos dois temas). No tema claro
// dois deles ficam abaixo de 3:1 contra o fundo, por isso cada linha leva o
// último valor como rótulo direto na ponta, além da legenda.

import { useMemo } from "react";
import {
  ComposedChart, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer,
} from "recharts";
import { useTheme } from "../../hooks/useTheme";
import { useThemeColors, useChartNeutral } from "../../hooks/useThemeColors";
import { useUniformTicks } from "../../hooks/useUniformTicks";
import { BLOCKING_DEFS, BLOCKING_MIN_REQUESTS, formatRate, formatCompact } from "../lib/dvQuality";

const SERIES = {
  dark:  { brand_rate: "#3987e5", fraud_rate: "#d95926", geo_rate: "#199e70" },
  light: { brand_rate: "#2a78d6", fraud_rate: "#eb6834", geo_rate: "#1baf7a" },
};
const nf = new Intl.NumberFormat("pt-BR");
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const Y_W = 44;
const LINE_H = 220;
const LINE_PLOT_H = LINE_H - 8 - 4; // margem de cima + faixa do eixo X oculto
const LABEL_GAP = 12;
const Y_STEPS = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25];
const RIGHT_PAD = 64; // espaço dos rótulos diretos na ponta das linhas

function dayLabel(iso) {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MESES[Number(m) - 1]}`;
}

export function BlockingTrendsChart({ points }) {
  const [theme] = useTheme();
  const hypr = useThemeColors();
  const neutral = useChartNeutral();
  const palette = SERIES[theme === "light" ? "light" : "dark"];
  const color = (key) => (key === "block_rate" ? hypr.fg : palette[key]);

  const data = useMemo(() => points.map((p) => ({ ...p, label: dayLabel(p.day) })), [points]);
  const [plotRef, xTicks] = useUniformTicks(data.map((d) => d.label), { reservedPx: Y_W + RIGHT_PAD + 20 });

  // Motivo sem nenhum bloqueio no período some da legenda e do gráfico — uma
  // linha colada no zero é peso morto (ex.: conta sem geo targeting na DV).
  const series = BLOCKING_DEFS.filter(
    (d) => d.key === "block_rate" || data.some((p) => (p[d.key] || 0) > 0),
  );
  const lastIdx = (key) => {
    for (let i = data.length - 1; i >= 0; i--) if (data[i][key] != null) return i;
    return -1;
  };
  const hasRequests = data.some((p) => p.requests > 0);

  // Eixo Y com passo "redondo" (1, 2, 2,5, 5, 10, 20, 25%) e no máximo 5
  // intervalos acima de zero; o topo é o múltiplo do passo que cobre o pico.
  const maxRate = Math.max(0, ...data.flatMap((p) => series.map((s) => p[s.key] || 0)));
  const yStep = Y_STEPS.find((st) => Math.ceil(maxRate / st) <= 5) || 0.25;
  const yMax = Math.min(1, Math.max(yStep, Math.ceil(maxRate / yStep - 1e-9) * yStep));
  const yTicks = Array.from({ length: Math.round(yMax / yStep) + 1 }, (_, i) => +(i * yStep).toFixed(4));

  // Rótulos diretos: quando as linhas terminam perto umas das outras (o
  // comum — todas perto de 0%), empurra os rótulos pra não se sobreporem.
  const labelShift = useMemo(() => {
    const ends = series
      .map((s) => {
        const i = lastIdx(s.key);
        return i < 0 ? null : { key: s.key, y: (1 - data[i][s.key] / yMax) * LINE_PLOT_H };
      })
      .filter(Boolean)
      .sort((a, b) => a.y - b.y);
    const out = {};
    let prev = -Infinity;
    for (const e of ends) {
      const y = Math.max(e.y, prev + LABEL_GAP);
      out[e.key] = y - e.y;
      prev = y;
    }
    // Se o empurrão passou do chão do gráfico, sobe o bloco inteiro.
    const overflow = prev - LINE_PLOT_H;
    if (overflow > 0) for (const k of Object.keys(out)) out[k] -= overflow;
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, yMax, series.map((s) => s.key).join()]);

  if (!hasRequests) {
    return (
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-bold text-fg">Blocking Trends</h2>
        <p className="mt-3 text-xs text-fg-subtle">
          Sem requests avaliados no período — o bloqueio pre-bid da DV não atuou nas campanhas do recorte.
        </p>
      </section>
    );
  }

  const tooltip = (p) => <BlockingTooltip {...p} series={series} color={color} hypr={hypr} />;
  const xAxisProps = {
    dataKey: "label", ticks: xTicks, interval: 0, tickLine: false,
    axisLine: { stroke: neutral.grid }, padding: { left: 10, right: 10 },
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 mb-3">
        <h2 className="text-sm font-bold text-fg">Blocking Trends</h2>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-muted">
          {series.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-[3px] w-3.5 rounded-full" style={{ background: color(s.key) }} />
              {s.label}
            </li>
          ))}
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2.5 rounded-[2px] bg-fg-subtle/60" />
            Requests
          </li>
        </ul>
      </div>

      <div ref={plotRef}>
        <ResponsiveContainer width="100%" height={LINE_H}>
          <ComposedChart data={data} syncId="dv-blocking" margin={{ top: 8, right: RIGHT_PAD, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={neutral.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis {...xAxisProps} tick={false} height={4} />
            <YAxis
              domain={[0, yMax]}
              ticks={yTicks}
              tickFormatter={(v) => `${+(v * 100).toFixed(1)}%`}
              tick={{ fill: neutral.label, fontSize: 10 }} tickLine={false} axisLine={false} width={Y_W}
            />
            <RTooltip content={tooltip} cursor={{ stroke: neutral.grid }} />
            {series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="monotone"
                stroke={color(s.key)}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: hypr.canvas }}
                connectNulls={false}
                isAnimationActive={false}
                label={<EndLabel lastIndex={lastIdx(s.key)} color={color(s.key)} shift={labelShift[s.key] || 0} />}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
        <ResponsiveContainer width="100%" height={96}>
          <BarChart data={data} syncId="dv-blocking" margin={{ top: 6, right: RIGHT_PAD, left: 0, bottom: 0 }}>
            <XAxis {...xAxisProps} tick={{ fill: neutral.label, fontSize: 10 }} />
            <YAxis
              tickFormatter={formatCompact} tickCount={3}
              tick={{ fill: neutral.label, fontSize: 10 }} tickLine={false} axisLine={false} width={Y_W}
            />
            {/* O tooltip do dia sai só no gráfico de cima (syncId leva o hover
                daqui pra lá); aqui fica só o destaque da barra. */}
            <RTooltip content={() => null} cursor={{ fill: hypr.surfaceStrong }} />
            <Bar dataKey="requests" name="Requests" fill={neutral.axis} radius={[3, 3, 0, 0]} maxBarSize={36} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-[11px] text-fg-subtle">
        Taxas sobre Requests (pre-bid). Barras: Requests avaliados por dia.
        Dias com menos de {BLOCKING_MIN_REQUESTS} requests ficam sem taxa.
      </p>
    </section>
  );
}

// Rótulo direto só no último ponto com dado de cada linha.
function EndLabel({ x, y, index, value, lastIndex, color, shift }) {
  if (index !== lastIndex || value == null) return null;
  return (
    <text x={x + 8} y={y + shift} dy={3.5} fill={color} fontSize={10.5} fontWeight={700} style={{ fontVariantNumeric: "tabular-nums" }}>
      {formatRate(value)}
    </text>
  );
}

function BlockingTooltip({ active, payload, series, color, hypr }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const [y, m, d] = p.day.split("-");
  return (
    <div style={{
      background: hypr.canvasElevated, border: `1px solid ${hypr.borderStrong}`,
      borderRadius: 8, padding: "8px 10px", fontSize: 12, color: hypr.fg, minWidth: 220,
    }}>
      <div style={{ color: hypr.fgMuted, fontWeight: 600, marginBottom: 4 }}>{`${d}/${m}/${y}`}</div>
      {series.map((s) => (
        <div key={s.key} style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: hypr.fgMuted }}>
            <span style={{ width: 10, height: 3, borderRadius: 2, background: color(s.key), display: "inline-block" }} />
            {s.label}
          </span>
          <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatRate(p[s.key])}</span>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginTop: 4, paddingTop: 4, borderTop: `1px solid ${hypr.border}` }}>
        <span style={{ color: hypr.fgMuted }}>Requests</span>
        <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{nf.format(p.requests)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <span style={{ color: hypr.fgMuted }}>Blocks</span>
        <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{nf.format(p.blocks)}</span>
      </div>
    </div>
  );
}
