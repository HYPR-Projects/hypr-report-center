// src/v2/components/ma/MaFunnelV2.jsx
//
// Funil da peça em pessoas, no padrão de linha de barra da aba (MaBarRows):
// etapa · pessoas · conversão da etapa anterior, barra embaixo. A maior
// perda depois da visualização fica em destaque na linha e no rodapé; a
// explicação de método vai para o "?" do rodapé, sob demanda.
//
// Escala: do "Viu a peça" para a primeira interação a queda costuma ser de
// 97–99%, e com a mesma régua todas as barras seguintes viram um risco. Nesse
// caso a base aparece inteira (esmaecida, marcada como base) e as demais
// etapas usam a régua da 2ª etapa — o "?" avisa.

import { fmt } from "../../../shared/format";
import { funnelConversions } from "../../../shared/maMetrics";
import { InfoTip, MaBadge, MaBarRows, MaCardFooter } from "./maUi";

const pct = (v) => (v == null ? "—" : `${fmt(v, v < 1 ? 2 : 1)}%`);

// `baseAsPercent`: a base aparece como 100%, sem a contagem. No report do
// cliente o total de pessoas que viram a peça competiria com as impressões
// da DSP (a peça conta tráfego que a DSP filtra); as etapas seguintes são
// comportamento e ficam em pessoas.
export function MaFunnelV2({ steps, subs = [], note = null, unitLabel = "pessoas", baseAsPercent = false, footer = true }) {
  const { rows, biggestDrop } = funnelConversions(steps || []);
  if (!rows.length) return null;
  const base = rows[0].value;
  const second = rows[1]?.value || 0;
  const broken = rows.length > 1 && base > 0 && second / base < 0.2 && second > 0;
  const scale = broken ? second : base;
  const width = (v, i) => (i === 0 ? 100 : scale ? (v / scale) * 100 : 0);
  const last = rows[rows.length - 1]?.value || 0;

  const barRows = [
    ...rows.map((r, i) => ({
      key: r.key || r.label,
      label: r.label,
      hint: r.hint,
      base: i === 0,
      hot: biggestDrop?.index === i,
      valueText: i === 0 && baseAsPercent ? "100%" : fmt(r.value),
      shareText: i === 0 ? "base" : pct(r.conversion),
      shareHint: i === 0 ? "Base do funil" : "Conversão da etapa anterior",
      width: width(r.value, i),
    })),
    ...subs.map((s) => ({
      key: s.key || s.label,
      label: s.label,
      sub: true,
      valueText: fmt(s.value),
      shareText: last > 0 ? pct((s.value / last) * 100) : "—",
      shareHint: "Parcela de quem chegou à última etapa",
      width: width(s.value, 1),
    })),
  ];

  const method = (
    <>
      O percentual de cada etapa é sobre a etapa anterior{subs.length ? "; nos detalhes (↳), sobre a última etapa" : ""}.
      {" "}Todas as etapas contam {unitLabel} (sessões distintas).
      {broken ? " A barra da base está fora de escala; as demais usam a régua da segunda etapa." : ""}
      {note ? ` ${note}` : ""}
    </>
  );

  return (
    <div>
      <MaBarRows rows={barRows} label={`Funil em ${unitLabel}`} />
      {footer && (
        <MaCardFooter>
          {biggestDrop ? (
            <>
              <MaBadge tone="warn">Maior perda</MaBadge>
              <b>{biggestDrop.from} → {biggestDrop.to}</b>
              <span className="tabular-nums">−{fmt(biggestDrop.drop)} {unitLabel}</span>
            </>
          ) : (
            <span>Sem perda relevante entre as etapas.</span>
          )}
          <span className="ml-auto">
            <InfoTip label="Como ler o funil">{method}</InfoTip>
          </span>
        </MaCardFooter>
      )}
    </div>
  );
}
