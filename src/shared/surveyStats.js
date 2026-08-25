// src/shared/surveyStats.js
//
// Significância estatística do lift de Brand Lift.
//
// Por que existe
// --------------
// O report mostrava lift sempre com a mesma cara: "+3,2 pp" com 4.000
// respondentes e "+3,2 pp" com 40 saíam idênticos na tela. O segundo é ruído
// e o cliente não tinha como saber — pior, a leitura natural de um número
// verde grande é "funcionou".
//
// Isso ficou mais urgente com a soma de bases (Typeform + Max Attention):
// somar duas bases muda o n, e n é exatamente o que decide se a diferença
// significa alguma coisa. Um número que agora vem de duas fontes merece dizer
// se ele se sustenta.
//
// A régua não é inventada aqui: é a MESMA que a plataforma (o2o-platform,
// `src/modules/adbolt/services/surveyLift.ts`) já usa no brand lift do
// AdBolt — piso de 60 respostas por célula (regra de negócio da HYPR,
// registrada lá com data) e teste z de duas proporções bicaudal a 95%.
// Duas telas da HYPR dizendo coisas diferentes sobre o mesmo estudo seria
// pior que nenhuma das duas dizer.
//
// Contas com CONTAGEM BRUTA, nunca com a porcentagem arredondada que aparece
// na tela: arredondar antes de testar joga fora justamente a precisão que o
// teste mede.

/** Piso de amostra por célula. Abaixo disso não se conclui nada — nem que
 *  deu, nem que não deu. Regra de negócio da HYPR (2026-07-06). */
export const MIN_CELL = 60;

/** z crítico bicaudal para 95% de confiança. */
const Z_95 = 1.959964;

// Aproximação de Abramowitz & Stegun 7.1.26 para a CDF normal — mesma
// implementação da plataforma, pra que os dois lados devolvam o mesmo número.
function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * erf);
}

const finite = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Testa uma resposta entre Controle e Exposto.
 *
 * @param {{ctrlN, ctrlPositive, expN, expPositive}} cells — contagens brutas.
 *   `*N` = respondentes da célula; `*Positive` = quantos escolheram a opção.
 * @returns {{
 *   status: "ok"|"underpowered"|"insufficient",
 *   significant: boolean,
 *   confidence: number|null,   // 0..1
 *   moePts: number|null,       // margem de erro do lift, em pontos percentuais
 *   z: number|null,
 *   minCell: number,
 * }}
 *
 * `insufficient` = alguma célula vazia (não dá pra testar nada).
 * `underpowered` = tem dado, mas abaixo do piso: NÃO afirmamos significância
 * nem ausência dela — o certo é dizer que a amostra não sustenta a conclusão.
 */
export function liftSignificance({ ctrlN, ctrlPositive, expN, expPositive } = {}) {
  const cn = finite(ctrlN);
  const en = finite(expN);
  // Positivos não podem passar do total — dado inconsistente vira o teto, em
  // vez de produzir proporção > 1 e uma variância negativa mais adiante.
  const cp = Math.min(finite(ctrlPositive), cn);
  const ep = Math.min(finite(expPositive), en);

  const base = { significant: false, confidence: null, moePts: null, z: null, minCell: MIN_CELL };

  if (cn === 0 || en === 0) return { ...base, status: "insufficient" };

  const pc = cp / cn;
  const pe = ep / en;

  // Erro-padrão da DIFERENÇA (não agrupado) — é ele que dá a margem de erro
  // exibida junto do lift.
  const se = Math.sqrt((pc * (1 - pc)) / cn + (pe * (1 - pe)) / en);

  // Erro-padrão AGRUPADO — o correto para o teste de hipótese, que assume
  // as duas proporções iguais sob a hipótese nula.
  const pooled = (cp + ep) / (cn + en);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / cn + 1 / en));
  const z = sePooled > 0 ? (pe - pc) / sePooled : 0;

  const out = {
    ...base,
    confidence: sePooled > 0 ? 2 * normalCdf(Math.abs(z)) - 1 : null,
    moePts: Number.isFinite(se) ? Z_95 * se * 100 : null,
    z: sePooled > 0 ? z : null,
  };

  if (cn < MIN_CELL || en < MIN_CELL) return { ...out, status: "underpowered" };

  return { ...out, status: "ok", significant: Math.abs(z) >= Z_95 };
}

/**
 * Frase curta pro rodapé do card de lift. Devolve `{text, tone}` — `tone` é
 * "good" | "warn" | "muted", pro chamador escolher a cor.
 */
export function significanceLabel(result) {
  if (!result || result.status === "insufficient") return null;
  if (result.status === "underpowered") {
    return {
      text: `amostra baixa — menos de ${MIN_CELL} por célula`,
      tone: "muted",
    };
  }
  const moe = result.moePts != null ? ` · ±${result.moePts.toFixed(1)} pp` : "";
  if (result.significant) {
    return { text: `significante a 95%${moe}`, tone: "good" };
  }
  return { text: `dentro da margem de erro${moe}`, tone: "warn" };
}
