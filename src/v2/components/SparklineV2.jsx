// src/v2/components/SparklineV2.jsx
//
// Sparkline SVG inline. Recebe array de números, plota linha suave
// preenchendo o viewBox proporcionalmente. Sem dependência do Recharts
// — sparkline em SVG manual é mais leve e renderiza ~10x mais rápido
// pra <30 pontos (caso típico de série diária <30 dias).
//
// API:
//   <SparklineV2 values={[10, 12, 15, 11, 18, 22]} stroke="#3397B9" />
//   <SparklineV2 values={...} fillOpacity={0.18} />
//      └── área sob a linha com gradiente vertical (top: fillOpacity → bottom: 0)
//
// Mantém viewport fixo (preserveAspectRatio="none") pra escalar
// horizontalmente sem distorcer espessura visual da linha.

import { useId } from "react";

export function SparklineV2({
  values,
  stroke = "var(--color-signature)",
  strokeWidth = 1.8,
  // Opacidade no TOPO da área. Bottom sempre 0 (gradiente vertical).
  // 0 = só linha (sem área).
  fillOpacity = 0,
  // Força um piso fixo no eixo Y. Default null = usa min(values) (escala
  // dinâmica, bom pra sparklines de tendência onde só importa a forma).
  // Passar 0 alinha o "fundo" do gráfico com a baseline zero — necessário
  // quando o gráfico tem eixo Y rotulado com 0 (senão a linha fica solta
  // do label "0"). Sem efeito quando todos os valores são iguais.
  minValue = null,
  width = 200,
  height = 28,
  className,
  ariaLabel,
}) {
  // ID único por instância (importante: vários sparklines na mesma
  // tela compartilhariam o mesmo <linearGradient> sem isso, e o
  // primeiro a renderizar "ganharia" a cor).
  const reactId = useId();
  const gradId = `spark-grad-${reactId.replace(/:/g, "")}`;

  if (!values || values.length < 2) {
    // Placeholder reservado pra evitar layout shift.
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={className}
        aria-hidden="true"
      />
    );
  }

  const computedMin = Math.min(...values);
  const min = minValue != null ? Math.min(minValue, computedMin) : computedMin;
  const max = Math.max(...values);
  const range = max - min || 1; // evita divisão por zero quando série é flat

  // Padding vertical pra linha não tocar bordas do viewBox
  const padY = 2;
  const usableH = height - padY * 2;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = padY + usableH - ((v - min) / range) * usableH;
    return [x, y];
  });

  const linePath = points
    .map(([x, y], i) => (i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`))
    .join(" ");

  // Área fechada sob a linha: sobe do bottom-left do primeiro ponto, segue
  // a linha, desce ao bottom-right do último ponto, fecha. Usa height como
  // baseline (não padY+usableH) pra área ir até a borda do viewBox.
  const x0 = points[0][0].toFixed(1);
  const xN = points[points.length - 1][0].toFixed(1);
  const areaPath = fillOpacity > 0
    ? `M${x0},${height} ` +
      points.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(" ") +
      ` L${xN},${height} Z`
    : null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={!ariaLabel}
    >
      {areaPath && (
        <>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              {/* Topo: cor da linha em fillOpacity. Fundo: 0 (transparente).
                * Vertical (x1=x2=0, y1=0→y2=1) — fade puro de cima pra baixo. */}
              <stop offset="0%"   stopColor={stroke} stopOpacity={fillOpacity} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />
        </>
      )}
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
