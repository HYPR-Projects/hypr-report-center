// src/v2/components/PacingBarV2.jsx
//
// Barra de pacing horizontal.
//
// A métrica `pacing` vinda do backend é `delivered / expected_today × 100`,
// que é matematicamente equivalente ao forecast de entrega final como %
// do contrato. Ou seja:
//   100% = projetado pra bater a meta exata
//   >100% = vai over-deliver (mostrado como pill "OVER X%" + segmento
//            signature blue além do limite verde)
//   <100% = vai sub-entregar (cor da barra reflete severidade)
//
// Como o eixo da barra já é normalizado em relação ao esperado, NÃO faz
// sentido sobrepor um marker de "tempo decorrido" — o esperado-hoje é,
// por definição, sempre 100% nessa escala. A transição de cor + pill
// "OVER" já comunica visualmente o status. (PR-13 introduziu um marker
// linear que confundia mais que ajudava; removido em PR-22.)
//
// Comportamento de cor:
//   <70%   → vermelho (atrasado)
//   70-99% → amarelo (alerta)
//   ≥100%  → verde (no alvo / over)
//   Over-delivery → segmento extra signature além dos 100%
//
// A barra é capada visualmente em 150% (50% de over) pra não estourar
// o layout. Número exato continua no label.
//
// Renderiza null quando pacing é null/undefined.

import { fmt, fmtR } from "../../shared/format";
import { PacingOverPillV2 } from "./PacingOverPillV2";

const palette = {
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
  signature: "var(--color-signature)",
  signatureLight: "var(--color-signature-light)",
};

function pickColor(pct) {
  if (pct >= 100) return palette.success;
  if (pct >= 70) return palette.warning;
  return palette.danger;
}

export function PacingBarV2({
  pacing,
  budget,
  cost,
  label = "Pacing",
  variant = "default", // "default" (card completo) | "compact" (sem card, só barra+label) | "sub" (linha minimal pra breakdown por tactic)
  subBars = null, // [{label, pacing}, ...] opcional — renderiza breakdown indented abaixo do bar principal
  // Em campanhas bonificadas, "Investido R$ 0,00 / Budget R$ 0,00" não diz
  // nada. Quando este prop está setado, o footer troca pra "Entregue / Meta"
  // em volume (impressões ou views), que é o que importa numa cortesia.
  bonusFooter = null, // { delivered, target, unit: "imp" | "views" } | null
  // Volumetria CONTRATADA (paga) e BÔNUS (cortesia), em impressões ou views.
  // Quando bonus > 0, a barra vira DUAS ZONAS: contrato (pago) + bônus. O
  // divisor marca onde termina o que o cliente pagou. Deixa claro que o
  // contrato pode estar 100% entregue mesmo com pacing < 100% (o que falta é
  // bônus). Sem bônus → barra simples (comportamento antigo, inalterado).
  contracted = 0,
  bonus = 0,
}) {
  if (pacing == null) return null;

  if (variant === "sub") {
    return <PacingSubBarRow label={label} pacing={pacing} />;
  }

  const realPct = Number(pacing) || 0;
  const visiblePct = Math.min(realPct, 150);
  const overPct = visiblePct > 100 ? visiblePct - 100 : 0;
  const baseWidth = Math.min(visiblePct, 100);
  const barColor = pickColor(visiblePct);
  const labelColor = realPct > 100 ? palette.signature : barColor;

  // ── Zona de bônus ──────────────────────────────────────────────────
  // A barra já é normalizada em contratado+bônus (100% = tudo prometido).
  // `contractedShare` = fração da barra que é contrato PAGO; o resto é bônus.
  // Ex: Amazon 4WA4TV — contratado 15,6M + bônus 15,6M → divisor em 50%.
  // Pacing 97,1% cai DENTRO da zona de bônus, então o contrato (0→50%) está
  // 100% cheio e só faltou um cantinho do bônus. `contractDone` decide a cor
  // da zona paga: verde se entregue, senão a severidade (amarelo/vermelho) —
  // aí sim o "under" que importa (do contrato pago) aparece.
  const hasBonus = bonus > 0 && contracted > 0;
  const contractedShare = hasBonus ? (contracted / (contracted + bonus)) * 100 : 100;
  const contractFillW = Math.min(baseWidth, contractedShare);
  const bonusFillW = Math.max(0, baseWidth - contractedShare);
  const contractDone = realPct >= contractedShare - 0.1;
  const contractColor = contractDone ? palette.success : pickColor((realPct / contractedShare) * 100);
  const contractPct = contractedShare > 0 ? Math.min((realPct / contractedShare) * 100, 100) : 0;
  const bonusPct = 100 - contractedShare > 0
    ? Math.max(0, Math.min(((realPct - contractedShare) / (100 - contractedShare)) * 100, 100))
    : 0;

  // Padding mobile-first: px-4/py-4 em mobile (ganha ~8px de chart útil),
  // px-5/py-5 em sm+ (mockup desktop).
  const wrapperClass =
    variant === "compact"
      ? "flex flex-col gap-2"
      : "rounded-xl border border-border bg-surface px-4 py-4 sm:px-5 sm:py-5";

  return (
    <div className={wrapperClass}>
      {/* Header: label + valor */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          <span
            className="size-2 rounded-full"
            style={{ background: barColor }}
            aria-hidden
          />
          {label}
        </span>
        <span
          className="text-sm font-bold tabular-nums whitespace-nowrap inline-flex items-center gap-2"
          style={{ color: labelColor }}
        >
          {fmt(realPct, 1)}%
          <PacingOverPillV2 pacing={realPct} size="sm" />
        </span>
      </div>

      {/* Bar */}
      <div className="relative h-2.5 rounded-full bg-track overflow-visible mt-4">
        <div className="absolute inset-0 rounded-full bg-track overflow-hidden">
          {hasBonus ? (
            <>
              {/* Contrato (pago) — verde se entregue, senão severidade */}
              <div
                className="absolute inset-y-0 left-0 rounded-l-full transition-[width] duration-500 ease-out"
                style={{ width: `${contractFillW}%`, background: contractColor }}
              />
              {/* Bônus (cortesia) — tom claro pra diferenciar do pago */}
              {bonusFillW > 0 && (
                <div
                  className="absolute inset-y-0 transition-[width] duration-500 ease-out"
                  style={{
                    left: `${contractedShare}%`,
                    width: `${bonusFillW}%`,
                    background: palette.signatureLight,
                  }}
                />
              )}
            </>
          ) : (
            <div
              className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
              style={{ width: `${baseWidth}%`, background: barColor }}
            />
          )}
          {overPct > 0 && (
            <div
              className="absolute inset-y-0 rounded-r-full transition-[width] duration-500 ease-out"
              style={{
                left: `${baseWidth}%`,
                width: `${Math.min(overPct, 50)}%`,
                background: palette.signature,
              }}
            />
          )}
        </div>
        {/* Divisor do contratado — marca onde termina o que o cliente pagou */}
        {hasBonus && (
          <div
            className="absolute -top-1 -bottom-1 w-px bg-fg/50"
            style={{ left: `${contractedShare}%` }}
            aria-hidden
          />
        )}
      </div>

      {/* Footer: investido/budget — ou, em bonificada, a quebra contrato/bônus
          (que substitui o "Investido/Budget", pois este mostraria 100% ao lado
          de um pacing < 100%, exatamente a confusão que as duas zonas resolvem). */}
      <div className="flex justify-between mt-3 text-[11px] text-fg-muted tabular-nums">
        {bonusFooter ? (
          <>
            <span>
              Entregue:{" "}
              <span className="text-fg font-semibold">
                {fmt(bonusFooter.delivered)} {bonusFooter.unit}
              </span>
            </span>
            <span>
              Meta bonificada:{" "}
              <span className="text-fg font-semibold">
                {fmt(bonusFooter.target)} {bonusFooter.unit}
              </span>
            </span>
          </>
        ) : hasBonus ? (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: contractColor }} aria-hidden />
              Contrato:{" "}
              <span className="text-fg font-semibold">
                {contractDone ? "entregue" : `${fmt(contractPct, 0)}%`}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: palette.signatureLight }} aria-hidden />
              Bônus:{" "}
              <span className="text-fg font-semibold">{fmt(bonusPct, 0)}%</span>
            </span>
          </>
        ) : (
          <>
            <span>
              Investido: <span className="text-fg font-semibold">{fmtR(cost)}</span>
            </span>
            <span>
              Budget: <span className="text-fg font-semibold">{fmtR(budget)}</span>
            </span>
          </>
        )}
      </div>

      {/* Breakdown por tactic (O2O/OOH) — só renderiza quando há mais de
          uma frente. Cada sub-row é um PacingSubBarRow inline: label
          curto + barra fina + %. Mantém o card único como container,
          comunicando "esta é a quebra do pacing acima". */}
      {subBars && subBars.length > 0 && (
        <div className="mt-4 pt-3 border-t border-border/60 space-y-2">
          {subBars.map((sub) => (
            <PacingSubBarRow
              key={sub.label}
              label={sub.label}
              pacing={sub.pacing}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Sub-row pro breakdown por tactic. Layout horizontal:
// [LABEL ~36px] [bar flex-1 h-1.5] [% + over pill ~110px right-aligned]
// Reusa pickColor pra cor da bar; over-segment seguindo a mesma lógica
// da bar principal.
function PacingSubBarRow({ label, pacing }) {
  const realPct = Number(pacing) || 0;
  const visiblePct = Math.min(realPct, 150);
  const overPct = visiblePct > 100 ? visiblePct - 100 : 0;
  const baseWidth = Math.min(visiblePct, 100);
  const barColor = pickColor(visiblePct);
  const labelColor = realPct > 100 ? palette.signature : barColor;

  // Layout em 4 colunas com larguras fixas pros slots de label, % e pill
  // — assim O2O e OOH ficam ALINHADOS verticalmente independente do
  // pacing/over de cada um. Antes o `% + pill` ficavam numa span única
  // com `justify-end`: quando não havia over, o % colava na borda
  // direita; quando havia over, ficavam pra esquerda — ritmo visual
  // inconsistente. Slot do pill reserva espaço mesmo vazio (no-op visual
  // quando pacing ≤ 100%) pra preservar a coluna do %.
  return (
    <div className="flex items-center gap-3">
      <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle w-9 shrink-0">
        {label}
      </span>
      <div className="relative h-1.5 rounded-full bg-track flex-1 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${baseWidth}%`, background: barColor }}
        />
        {overPct > 0 && (
          <div
            className="absolute inset-y-0 rounded-r-full transition-[width] duration-500 ease-out"
            style={{
              left: `${baseWidth}%`,
              width: `${Math.min(overPct, 50)}%`,
              background: palette.signature,
            }}
          />
        )}
      </div>
      <span
        className="text-[11px] font-bold tabular-nums whitespace-nowrap shrink-0 w-[52px] text-right"
        style={{ color: labelColor }}
      >
        {fmt(realPct, 1)}%
      </span>
      <span className="shrink-0 w-[88px] inline-flex justify-start">
        <PacingOverPillV2 pacing={realPct} size="sm" />
      </span>
    </div>
  );
}
