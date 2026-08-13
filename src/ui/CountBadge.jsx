// src/ui/CountBadge.jsx
//
// Selo numérico — a contagem que acompanha um rótulo (pílula de mês, aba de
// filtro, sino de alertas, chip de owner).
//
// POR QUE ESTE COMPONENTE EXISTE
// ──────────────────────────────────────────────────────────────────────
// O mesmo objeto estava desenhado com SETE geometrias diferentes espalhadas
// pela base: 22×16, 16×16, 18×16, 18×18 com px-1, 18×18 com px-1.5... Metade
// declarava `leading-none`, a outra metade herdava a entrelinha do pai (que
// muda conforme onde o selo foi colado).
//
// O sintoma que a operação reportava era "os números não ficam centralizados
// dentro dos círculos". A causa NÃO era métrica de fonte — a Urbanist é
// verticalmente simétrica (upem 2000, ascender 1900, descender 500, cap 1400:
// o centro do glifo cai exatamente no centro da caixa de conteúdo), então
// centralizar por flexbox está correto e não precisa de nudge óptico.
//
// A causa era a FORMA: `min-w-[22px] h-4` com padding lateral produz uma
// cápsula cuja proporção muda com a quantidade de dígitos — 22×16 com um
// dígito, ~24×16 com dois, ~31×16 com três. Numa fileira de pílulas, cada
// selo tinha um formato diferente. O olho lê isso como desalinhamento.
//
// A REGRA AQUI
// ──────────────────────────────────────────────────────────────────────
//   1-2 dígitos → círculo de verdade (18×18 fixo, largura = altura)
//   3+ dígitos  → cápsula (a única forma honesta; altura preservada em 18)
//
// `leading-none` é explícito pra que a posição do dígito não dependa do
// contexto onde o selo foi montado.

import { cn } from "./cn";

const TONE = {
  // Selo de item selecionado / contagem ativa. Fill sólido escurecido
  // (signature-fill) porque carrega texto claro — ver theme.css.
  signature: "bg-signature-fill text-on-signature",
  // Contagem inativa, dentro de um controle não selecionado.
  neutral: "bg-surface-strong text-fg-muted",
  // Contagem dentro de um controle JÁ tintado de signature (pílula ativa):
  // um fill sólido brigaria com o fundo, então usa tinta translúcida.
  onSignature: "bg-signature/25 text-fg",
  // Contagem dentro de um controle tintado com cor SEMÂNTICA (pílulas de
  // status do Diagnóstico, que herdam a cor do próprio status). Aqui o fundo
  // do selo não pode ter matiz próprio — usa a superfície elevada translúcida
  // pra "furar" a tinta do host sem introduzir uma terceira cor.
  onColor: "bg-canvas-elevated/60 text-fg",
  // Alerta — sino, badges de pendência.
  danger: "bg-danger text-on-semantic",
};

/**
 * @param {number|string} value  Contagem a exibir.
 * @param {"signature"|"neutral"|"onSignature"|"danger"} tone
 * @param {string} className     Posicionamento (ex: absolute) fica com o pai.
 */
export function CountBadge({ value, tone = "neutral", className, ...rest }) {
  const text = String(value ?? "");
  // 3+ caracteres não cabem num círculo de 18px sem espremer o dígito —
  // aí a cápsula é a forma correta, não uma concessão.
  const isWide = text.length > 2;

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center shrink-0 rounded-full",
        "text-[10px] font-bold leading-none tabular-nums",
        // Círculo real: largura E altura travadas em 18. Sem padding, porque
        // padding é exatamente o que transformava o círculo em cápsula.
        isWide ? "h-[18px] min-w-[18px] px-1.5" : "size-[18px]",
        TONE[tone] || TONE.neutral,
        className
      )}
      {...rest}
    >
      {text}
    </span>
  );
}
