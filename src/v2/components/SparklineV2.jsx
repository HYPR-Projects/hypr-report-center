// src/v2/components/SparklineV2.jsx
//
// Sparkline SVG inline. Recebe array de números, plota linha suave
// preenchendo o viewBox proporcionalmente. Sem dependência do Recharts
// — sparkline em SVG manual é mais leve e renderiza ~10x mais rápido
// pra <30 pontos (caso típico de série diária <30 dias).
//
// API:
//   <SparklineV2 values={[10, 12, 15, 11, 18, 22]} stroke="#3397B9" />
//
// Mantém viewport fixo (preserveAspectRatio="none") pra escalar
// horizontalmente sem distorcer espessura visual da linha.

export function SparklineV2({
  values,
  stroke = "var(--color-signature)",
  strokeWidth = 1.8,
  width = 200,
  height = 28,
  className,
  ariaLabel,
}) {
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

  const min = Math.min(...values);
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

  const path = points
    .map(([x, y], i) => (i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`))
    .join(" ");

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
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
