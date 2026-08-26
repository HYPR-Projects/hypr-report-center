// src/v2/admin/components/PmpComponents.jsx
//
// Componentes visuais da view PMP Lines v3. Espelham o vocabulário do
// CampaignMenuV2 (spacing generoso, cards bordados leves, dot de status à
// esquerda, hierarquia tipográfica clara).
//
// Atomicidade: tudo em 1 arquivo pra reduzir churn de imports na refactor.
// Se algum desses crescer, separar em arquivo próprio depois.

import { memo, useState, useMemo } from "react";
import { cn } from "../../../ui/cn";
import {
  effectiveDeliveryMeta, LIVE_STATUSES,
  statusPillClass, healthPillClass, healthLabel,
  pctDeliveryClass, pctBarColor,
  formatBRL, formatBRLCompact, formatInt, formatIntCompact,
  formatRatioPct, formatLastDelivery, emailInitial,
  pctEntrega, groupPctEntrega,
  pctEntregaRev, groupPctEntregaRev,
  faltaEntregarRev, groupFaltaEntregarRev,
  resolveGroupPi,
  effectiveStatus, formatLineStartPeriod,
  isNewLine, METRIC,
} from "../lib/pmpFormat";


// ═══════════════════════════════════════════════════════════════════════════
// SourceChip — fonte de curadoria da line (Xandr Curate × PubMatic)
// ═══════════════════════════════════════════════════════════════════════════
// Por padrão OCULTA a fonte 'xandr' (maioria histórica) pra não poluir a lista;
// PubMatic ganha chip visível. `showXandr` força mostrar (ex: modal de grupo,
// onde é útil distinguir as fontes ao misturar).
const SOURCE_META = {
  pubmatic: { label: "PubMatic", cls: "text-indigo-300 bg-indigo-500/10 border-indigo-500/30" },
  xandr:    { label: "Xandr",    cls: "text-fg-muted bg-surface border-border" },
};
export function SourceChip({ source, showXandr = false, className }) {
  const key = (source || "xandr").toLowerCase();
  if (key === "xandr" && !showXandr) return null;
  const m = SOURCE_META[key] || { label: source, cls: "text-fg-muted bg-surface border-border" };
  return (
    <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-medium border", m.cls, className)}>
      {m.label}
    </span>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// PmpLineGroupCard — wrapper visual pra N lines agrupadas sob mesmo PI
// ═══════════════════════════════════════════════════════════════════════════
// Espelha o MergeGroupCardV2 do admin de reports — border signature, header
// com chip "1 PI", lista de PmpLineRow dentro, e TOTAL agregado no rodapé.
//
// Premissas:
//   - `lines` é array de lines do mesmo group_id (já filtrado pelo caller)
//   - todas têm o mesmo group_curator_revenue, group_curator_margin, pi_brl
//   - usa o group_name OU customer + "campanha do checklist" como título
export function PmpLineGroupCard({ lines, onLineClick, onLinkClick, variant = "default" }) {
  if (!lines || lines.length === 0) return null;
  const nested = variant === "nested";

  const first = lines[0];
  const groupName = first.group_name
    || (first.customer ? `${first.customer} · ${first.campaign_name || "—"}` : "Grupo");
  // PI compartilhado: primeiro membro COM PI — nem todos têm pi_brl setado.
  const pi = resolveGroupPi(lines);
  const groupRev = first.group_curator_revenue || 0;
  const groupMgn = first.group_curator_margin || 0;
  // % entrega = margem HYPR ÷ PI (não revenue)
  const groupPct = groupPctEntrega(first, pi);
  const groupMarginPct = first.group_effective_margin_pct;

  return (
    <section
      className={cn(
        "rounded-lg border bg-signature/[0.03] overflow-hidden",
        nested ? "border-signature/25" : "border-signature/30",
      )}
      aria-label={`Grupo ${groupName}`}
    >
      {/* Header — minimal, sem fundo extra */}
      <header className={cn(
        "flex items-center gap-3 border-b border-signature/15",
        // Densidade compacta: padding vertical encolhe, fonte não.
        nested ? "px-4 py-2.5 dense:py-1.5" : "px-5 py-3.5 dense:py-2",
      )}>
        <span className="shrink-0 text-signature">
          <MergeIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="lbl-micro text-signature">
              Grupo · 1 PI
            </span>
            <span className="text-fg-subtle text-[10px]">·</span>
            <span className="text-[13px] font-semibold text-fg truncate">{groupName}</span>
          </div>
          <div className="text-[11px] text-fg-muted mt-0.5 tabular-nums">
            {lines.length} lines
            {pi != null && (
              <> · PI compartilhado <strong className="text-fg">{formatBRL(pi)}</strong></>
            )}
            {first.group_short_token && (
              <> · <span className="font-mono text-signature">{first.group_short_token}</span></>
            )}
          </div>
        </div>
        {/* Métricas chave do grupo direto no header — número grande, fácil escanear */}
        <div className="hidden md:flex items-center gap-6 text-right shrink-0 tabular-nums">
          <div>
            <div className="lbl-micro text-fg-subtle">Receita Bruta</div>
            <div className="text-[13px] text-fg font-semibold">{formatBRL(groupRev)}</div>
          </div>
          <div>
            <div className="lbl-micro text-fg-subtle">Margem HYPR</div>
            <div className="text-[13px] text-success font-bold">{formatBRL(groupMgn)}</div>
          </div>
          <div>
            <div className="lbl-micro text-fg-subtle">% Entrega</div>
            <div className={cn("text-[13px] font-bold px-2 py-0.5 rounded", pctDeliveryClass(groupPct))}>
              {formatRatioPct(groupPct, 0)}
            </div>
          </div>
        </div>
      </header>

      {/* Lines individuais — sem coluna PI (já está no header).
          Scroll horizontal: o grid hidePi precisa de 1112px (1072px de
          trilhas+gaps + 40px do px-5 do próprio row — esse padding TEM que
          entrar na conta, senão o grid recebe menos espaço do que precisa
          e a última trilha, que não tem `fr` sobrando pra ceder, vaza
          silenciosamente sem gerar scroll pra revelar o que sobrou) e
          estoura tanto o viewport <768px quanto laptops com o rail aberto.
          `scrollbar-thin` + `scroll-fade-x` (ver PmpDealsPage) deixam
          explícito que dá pra arrastar em vez de simplesmente cortar a
          última coluna — e a própria coluna Entrega agora tem piso real
          (116px, ver ROW_GRID acima) em vez de um `fr` que nunca crescia. */}
      <div className="overflow-x-auto scrollbar-thin scroll-fade-x">
        <div className="md:min-w-[1112px] divide-y divide-border/30">
          {lines.map((l) => (
            <PmpLineRow key={l.line_id} line={l}
                        onClick={onLineClick} onLinkClick={onLinkClick}
                        compact hidePi />
          ))}
        </div>
      </div>
    </section>
  );
}

function MergeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round"
         aria-hidden="true">
      <circle cx="6"  cy="6"  r="2.5" />
      <circle cx="6"  cy="18" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M9 6c4 0 6 2 6 6M9 18c4 0 6-2 6-6" />
    </svg>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// KPI Strip rico (estilo MetricStrip do admin)
// ═══════════════════════════════════════════════════════════════════════════
// Valores SEMPRE em formato completo (R$ 11.339.437,28) — nunca abreviados.
// Operação contábil precisa do número exato. Tipografia menor (text-xl)
// compensa o tamanho dos valores grandes.
export function PmpKpiStrip({ kpis, livesCount, totalCount, showExtra = false, windowed = false, windowLabel = null, windowLoading = false }) {
  // Subtítulo das receitas: quando janelado, os números JÁ são do período —
  // então mostra o range em vez do "últ. 7d" (que confundiria).
  const periodSub = windowed ? (windowLoading ? "calculando…" : `no período ${windowLabel || ""}`.trim()) : null;
  const items = [
    { label: "Lines no ar",   value: livesCount,
      sub: totalCount ? `${livesCount} de ${totalCount} ativas` : null,
      valueClass: livesCount > 0 ? "text-success" : "text-fg" },
    // Contagem é de PIs (unidade de conta), não de lines: um grupo de N lines
    // divide um PI só e conta uma vez.
    { label: "Total PI",      value: formatBRL(kpis.pi),
      sub: kpis.countWithPi != null
        ? `${kpis.countWithPi} ${kpis.countWithPi === 1 ? "PI vinculado" : "PIs vinculados"}`
        : null,
      title: METRIC.pi.hint },
    { label: METRIC.revenue.label, value: formatBRL(kpis.revenue),
      sub: windowed ? periodSub : (kpis.revenue7d ? `${formatBRL(kpis.revenue7d)} últ. 7d` : null),
      title: METRIC.revenue.hint },
    { label: METRIC.margin.label, value: formatBRL(kpis.margin),
      sub: windowed ? periodSub : (kpis.margin7d ? `${formatBRL(kpis.margin7d)} últ. 7d` : null),
      valueClass: "text-success",
      title: `${METRIC.margin.hint} É a receita líquida da operação.` },
    { label: "% Entrega (Margem)", value: kpis.pctReceber != null ? formatRatioPct(kpis.pctReceber) : "—",
      sub: kpis.countWithPi ? "Margem HYPR ÷ Total PI" : "sem PI cadastrado",
      valueClass: kpis.pctReceber == null ? "text-fg"
        : kpis.pctReceber >= 0.85 ? "text-success" : "text-warning",
      title: METRIC.pctMargin.hint,
      hint: kpis.pctReceber != null
        ? { text: "ideal ≥ 85%", ok: kpis.pctReceber >= 0.85 }
        : null },
    // Receita BRUTA entregue ÷ Total PI. Mesma família da de cima (é a mesma
    // conta com outro numerador), sem régua de "ideal" — por isso fica neutra
    // em sky pra diferenciar da métrica que tem meta.
    { label: "% Entrega (Receita)", value: kpis.pctReceberRev != null ? formatRatioPct(kpis.pctReceberRev) : "—",
      sub: kpis.countWithPi ? "Receita Bruta ÷ Total PI" : "sem PI cadastrado",
      valueClass: kpis.pctReceberRev == null ? "text-fg" : "text-signature",
      title: METRIC.pctRev.hint },
    // Receita Extra só faz sentido como leitura lifetime (Histórico) — fora
    // disso muitas lines mid-flight aparecem muito negativas e poluem.
    // Receita Extra compara margem realizada vs. esperada pelo PI CHEIO do
    // contrato — não dá pra fatiar por janela (entrega parcial vs. contrato
    // inteiro daria número enganoso). Com período ativo, esconde ("—").
    ...(showExtra ? [windowed ? {
      label: "Receita Extra",
      value: "—",
      sub: "indisponível com filtro de período",
      valueClass: "text-fg-subtle",
      title: "Receita Extra compara o realizado com o esperado pelo contrato inteiro (PI cheio), então não faz sentido com a data filtrada. Limpe o período pra ver.",
    } : {
      label: "Receita Extra",
      value: kpis.extraLinesCount > 0
        ? `${kpis.extraRevenue >= 0 ? "+ " : "− "}${formatBRL(Math.abs(kpis.extraRevenue))}`
        : "—",
      sub: kpis.extraLinesCount > 0
        ? `acima do esperado · ${kpis.extraLinesCount} lines`
        : "sem dado de margem configurada",
      valueClass: kpis.extraLinesCount === 0 ? "text-fg"
        : kpis.extraRevenue >= 0 ? "text-success" : "text-warning",
      // O tooltip descrevia "receita bruta × margem configurada"; a conta real
      // (e a do badge da coluna Margem) é contra o PI CHEIO do contrato.
      title: "Margem HYPR realizada − (PI × margem configurada). Positivo = a HYPR capturou mais que o esperado pelo contrato.",
    }] : []),
  ];
  // Grid: 7 cards só cabem sem truncar a partir de 2xl (~1536px). Entre lg e
  // 2xl a tela tinha 7 colunas de ~190px e o valor cheio (R$ 14.299.476,71)
  // saía cortado — o número que mais importa na tela virava "R$ 14.299.4…".
  // Menos colunas em telas médias = valor inteiro sempre legível.
  // Com showExtra são 7 cards — número ímpar que não fecha em nenhum dos
  // breakpoints acima (2 cols → 3+3+1, 3 cols → 3+3+1, 4 cols → 4+3), deixando
  // o último card sozinho com o resto da linha vazio ao lado. Em lg isso era um
  // buraco de 334px medido em produção.
  //
  // Em vez de mexer na contagem de colunas (que está justificada acima pela
  // legibilidade do valor de 8 dígitos), o ÚLTIMO card estica pra fechar a
  // linha. Mesma solução da grade de tiles do drawer e do grid do Overview.
  // Sem showExtra são 6 cards e todos os breakpoints já fecham — daí o span
  // só entrar no caso ímpar.
  // O span TEM que falar a mesma língua da grade. Quando a grade migrou pra
  // container queries (por causa do rail, que estreita a coluna sem mudar o
  // viewport), estas classes continuaram em breakpoint de viewport — num
  // monitor de 1600px o `2xl:col-span-1` vencia enquanto a grade estava em 4
  // colunas, e sobrava uma célula vazia de ~330px ao lado do último card.
  //
  // Fechamento por largura de board, espelhando a grade abaixo:
  //   <560px   2 cols → 7 = 2+2+2+1(span 2)
  //   560-760  3 cols → 7 = 3+3+1(span 3)
  //   760-1350 4 cols → 7 = 4+(1+1+span 2)
  //   ≥1350    7 cols → uma linha, span 1
  const tailSpan = showExtra
    ? "col-span-2 @min-[560px]:col-span-3 @min-[760px]:col-span-2 @min-[1350px]:col-span-1"
    : "";
  return (
    // Limiares por largura do BOARD (ver KpiBoard), não do viewport: com o
    // rail aberto o board é ~250px mais estreito que a janela, e os valores
    // aqui são sempre completos (R$ 1.794.308,80 — operação contábil não
    // abrevia), então cada card precisa de ~185px pra não quebrar o número.
    <div className={cn("grid grid-cols-2 gap-px bg-border @min-[560px]:grid-cols-3",
      showExtra ? "@min-[760px]:grid-cols-4 @min-[1350px]:grid-cols-7"
                : "@min-[1150px]:grid-cols-6")}>
      {items.map((it, i) => (
        <div key={i}
             className={cn("bg-canvas-elevated px-3.5 py-3",
               i === items.length - 1 && tailSpan)}
             title={it.title}>
          <div className="lbl-section">{it.label}</div>
          <div className={cn("text-base xl:text-lg font-bold tabular-nums mt-1.5 whitespace-nowrap overflow-hidden text-ellipsis", it.valueClass || "text-fg")}
               title={typeof it.value === "string" ? it.value : ""}>
            {it.value}
          </div>
          {it.sub && <div className="text-[10.5px] text-fg-muted mt-1">{it.sub}</div>}
          {it.hint && (
            <div className={cn(
              "text-[10px] mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded",
              it.hint.ok
                ? "bg-success-soft text-success"
                : "bg-warning-soft text-warning",
            )}>
              <span className="text-[8px] leading-none">●</span>
              <span>{it.hint.text}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AlertsBar — chips clicáveis com atalhos pra worklist
// ═══════════════════════════════════════════════════════════════════════════
export function PmpAlertsBar({ alerts, onClickAlert }) {
  if (!alerts || alerts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {alerts.map((a, i) => (
        <button key={i} onClick={() => onClickAlert?.(a.bucket)}
                className={cn(
                  "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] border transition-colors cursor-pointer",
                  a.kind === "danger" ? "border-danger/30 bg-danger/10 text-danger hover:bg-danger/15"
                  : a.kind === "warn" ? "border-warning/30 bg-warning/10 text-warning hover:bg-warning/15"
                  : "border-signature/30 bg-signature/10 text-signature hover:bg-signature/15",
                )}>
          <span className="text-[10px] leading-none">●</span>
          <span>{a.text}</span>
          {a.bucket && (
            <span className="text-[10px] opacity-70 ml-1">→ ver</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PmpLiveCard — Card rico pra view "Ao vivo"
// ═══════════════════════════════════════════════════════════════════════════
function PmpLiveCardInner({ line, onClick, onLinkClick }) {
  const dm = effectiveDeliveryMeta(line);
  const lastDeliv = formatLastDelivery(line.hours_since_last_delivery);
  const pct = pctEntrega(line);
  const pctRev = pctEntregaRev(line);
  const hasPi = line.pi_brl != null && line.pi_brl > 0;

  // content-visibility:auto — browser pula render/paint dos cards fora do
  // viewport (centenas de lines = scroll pesado sem isso). intrinsic-size
  // `auto 230px` é só a estimativa pré-primeiro-paint pro scrollbar não
  // pular; depois o browser memoriza a altura real. Browsers sem suporte
  // ignoram a propriedade (degradação = comportamento de hoje).
  return (
    <button onClick={() => onClick?.(line)}
            className="group relative w-full text-left rounded-xl border border-border bg-canvas-elevated hover:bg-surface/50 transition-all p-5 overflow-hidden [content-visibility:auto] [contain-intrinsic-size:auto_230px]">
      {/* Stripe lateral por status */}
      <div className={cn("absolute left-0 top-0 bottom-0 w-1", dm.dot)} />

      <div className="flex items-start gap-4 mb-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border", dm.border, dm.text, dm.bg)}>
              <span className={cn("w-1.5 h-1.5 rounded-full", dm.dot)} />
              {dm.label}
            </span>
            <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border", statusPillClass(effectiveStatus(line)))}>
              {effectiveStatus(line)}
            </span>
            {line.short_token && (
              <span className="font-mono text-[10px] text-signature bg-signature/10 border border-signature/20 px-1.5 py-0.5 rounded">
                {line.short_token}
              </span>
            )}
          </div>
          <div className="mt-2">
            <div className="text-fg font-semibold text-base truncate">
              {line.customer || "Sem cliente"} <span className="text-fg-muted font-normal mx-1">·</span> <span className="text-fg">{line.campaign_name || "Sem nome"}</span>
            </div>
            <div className="text-[11px] text-fg-subtle mt-0.5 truncate">
              {line.agency || "—"} <span className="mx-1">·</span> Line {line.line_id}
            </div>
          </div>
        </div>

        <div className="text-right shrink-0">
          {lastDeliv && (
            <div className="text-[11px] text-fg-muted">Última delivery</div>
          )}
          {lastDeliv && (
            <div className={cn("text-sm font-semibold tabular-nums", dm.text)}>{lastDeliv}</div>
          )}
          {line.days_remaining != null && (
            <div className={cn("text-[11px] mt-1",
              line.days_remaining < 3 ? "text-danger" :
              line.days_remaining < 7 ? "text-warning" : "text-fg-subtle")}>
              {line.days_remaining >= 0 ? `${line.days_remaining}d restantes` : "fim passou"}
            </div>
          )}
        </div>
      </div>

      {/* Barras de progresso vs PI: margem entregue + revenue entregue */}
      {hasPi ? (
        <div className="mb-4 space-y-2.5">
          {/* Margem HYPR ÷ PI */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <div className="text-[11px] text-fg-muted">
                <span className="font-medium text-success tabular-nums">{formatBRL(line.curator_margin)}</span>
                <span className="text-fg-subtle"> de </span>
                <span className="tabular-nums">{formatBRL(line.pi_brl)}</span>
                <span className="text-fg-subtle ml-1.5">· margem entregue</span>
              </div>
              <div className={cn("text-sm font-bold tabular-nums",
                pctDeliveryClass(pct).replace(/bg-\S+/g, "").trim() || "text-fg")}>
                {formatRatioPct(pct)}
              </div>
            </div>
            <div className="h-2 rounded-full bg-surface overflow-hidden">
              <div className={cn("h-full transition-all", pctBarColor(pct))}
                   style={{ width: `${Math.min(100, (pct || 0) * 100)}%` }} />
            </div>
          </div>
          {/* Revenue bruto ÷ PI */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <div className="text-[11px] text-fg-muted">
                <span className="font-medium text-signature tabular-nums">{formatBRL(line.curator_revenue)}</span>
                <span className="text-fg-subtle"> de </span>
                <span className="tabular-nums">{formatBRL(line.pi_brl)}</span>
                <span className="text-fg-subtle ml-1.5">· revenue entregue</span>
              </div>
              <div className={cn("text-sm font-bold tabular-nums",
                pctDeliveryClass(pctRev).replace(/bg-\S+/g, "").trim() || "text-fg")}>
                {formatRatioPct(pctRev)}
              </div>
            </div>
            <div className="h-2 rounded-full bg-surface overflow-hidden">
              <div className={cn("h-full transition-all", pctBarColor(pctRev))}
                   style={{ width: `${Math.min(100, (pctRev || 0) * 100)}%` }} />
            </div>
          </div>
        </div>
      ) : effectiveStatus(line) === "Cancelado" ? (
        // Cancelada sem PI: não polui a UI com CTA de vincular.
        <div className="mb-4 px-3 py-2 rounded-md border border-border bg-surface/30 text-[11px] text-fg-subtle">
          Cancelada — sem PI vinculado
        </div>
      ) : (
        <div className="mb-4 flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-dashed border-warning/30 bg-warning/5">
          <div className="text-[11px] text-warning">
            Sem PI vinculado ao Hypr Command
          </div>
          {onLinkClick && (
            <button onClick={(e) => { e.stopPropagation(); onLinkClick(line); }}
                    className="text-[11px] font-medium text-warning hover:text-warning underline-offset-2 hover:underline">
              🔗 vincular
            </button>
          )}
        </div>
      )}

      {/* Footer: métricas + owners */}
      <div className="flex items-center justify-between flex-wrap gap-3 pt-3 border-t border-border/50">
        <div className="flex items-center gap-5 text-[11px]">
          <Metric label="Margem %" value={formatRatioPct(line.effective_margin_pct)} />
          <Metric label="eCPM" value={line.ecpm != null ? formatBRL(line.ecpm) : "—"} />
          <Metric label="Impressões" value={formatIntCompact(line.imps)} />
        </div>
        <div className="flex items-center gap-1.5">
          {line.cp_email && <OwnerChip email={line.cp_email} role="CP" />}
          {line.cs_email && <OwnerChip email={line.cs_email} role="CS" />}
        </div>
      </div>
    </button>
  );
}

// memo com comparação rasa padrão — `line` vem de setLines imutável
// (spread + map no PmpDealsPage), onClick/onLinkClick são setters/refs
// estáveis. Evita re-render de centenas de cards quando estado não
// relacionado muda (drawer, KPIs, saving indicator).
export const PmpLiveCard = memo(PmpLiveCardInner);

function Metric({ label, value }) {
  return (
    <div>
      <div className="lbl-micro text-fg-subtle">{label}</div>
      <div className="text-fg tabular-nums">{value}</div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// PmpLiveGroupCard — Card rico pra view "Ao vivo" representando 1 grupo
// ═══════════════════════════════════════════════════════════════════════════
// Encaixa no mesmo grid 2-col do PmpLiveCard, mas mostra N lines agregadas
// sob 1 PI compartilhado: 1 header, 1 barra de progresso (group revenue/PI),
// sub-rows das lines individuais, footer com totais do grupo.
export function PmpLiveGroupCard({ members, onLineClick }) {
  if (!members || members.length === 0) return null;
  const hero = members[0];

  // PI compartilhado: primeiro membro com pi_brl > 0 (todos do mesmo grupo
  // apontam pro mesmo checklist por definição).
  const groupPi = resolveGroupPi(members);
  const groupRev = hero.group_curator_revenue || 0;
  const groupMargin = hero.group_curator_margin || 0;
  const groupImps = hero.group_imps || 0;
  // % entrega = margem HYPR ÷ PI compartilhado (não revenue)
  const groupPct = groupPi ? groupMargin / groupPi : null;
  // % entrega Rev = revenue bruto agregado ÷ PI compartilhado
  const groupPctRev = groupPi ? groupRev / groupPi : null;
  const groupMarginPct = groupRev > 0 ? groupMargin / groupRev : null;
  const groupEcpm = groupImps > 0 ? (groupRev * 1000) / groupImps : null;

  // Última delivery do grupo = a mais recente entre os membros (= menor hours_since)
  let lastHours = null;
  for (const m of members) {
    if (m.hours_since_last_delivery == null) continue;
    if (lastHours == null || m.hours_since_last_delivery < lastHours) lastHours = m.hours_since_last_delivery;
  }
  const lastDeliv = formatLastDelivery(lastHours);

  return (
    <div className="relative rounded-xl border border-signature/25 bg-signature/[0.04] overflow-hidden">
      {/* Barra signature à esquerda (consistência com Lista/Histórico) */}
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-signature/70 pointer-events-none" />

      <div className="p-5">
        {/* Header: badge GROUP + título + última delivery */}
        <div className="flex items-start gap-4 mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="lbl-section text-signature inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-signature/15 border border-signature/25">
                <MergeIcon />
                Grupo · {members.length} lines · 1 PI
              </span>
              {hero.group_short_token && (
                <span className="font-mono text-[10px] text-signature bg-signature/10 border border-signature/20 px-1.5 py-0.5 rounded">
                  {hero.group_short_token}
                </span>
              )}
            </div>
            <div className="mt-2">
              <div className="text-fg font-semibold text-base truncate">
                {hero.customer || "Sem cliente"}
                <span className="text-fg-muted font-normal mx-1">·</span>
                <span className="text-fg">{hero.group_name || hero.campaign_name || "Sem nome"}</span>
              </div>
              <div className="text-[11px] text-fg-subtle mt-0.5 truncate">
                {hero.agency || "—"} <span className="mx-1">·</span> {members.length} lines agrupadas sob mesmo PI
              </div>
            </div>
          </div>
          {lastDeliv && (
            <div className="text-right shrink-0">
              <div className="text-[11px] text-fg-muted">Última delivery</div>
              <div className="text-sm font-semibold tabular-nums text-fg">{lastDeliv}</div>
            </div>
          )}
        </div>

        {/* Barras DO GRUPO vs PI compartilhado: margem + revenue */}
        {groupPi ? (
          <div className="mb-4 space-y-2.5">
            {/* Margem HYPR agregada ÷ PI compartilhado */}
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <div className="text-[11px] text-fg-muted">
                  <span className="font-medium text-success tabular-nums">{formatBRL(groupMargin)}</span>
                  <span className="text-fg-subtle"> de </span>
                  <span className="tabular-nums">{formatBRL(groupPi)}</span>
                  <span className="text-fg-subtle ml-1.5">· margem entregue do PI compartilhado</span>
                </div>
                <div className={cn("text-sm font-bold tabular-nums",
                  pctDeliveryClass(groupPct).replace(/bg-\S+/g, "").trim() || "text-fg")}>
                  {formatRatioPct(groupPct)}
                </div>
              </div>
              <div className="h-2 rounded-full bg-surface overflow-hidden">
                <div className={cn("h-full transition-all", pctBarColor(groupPct))}
                     style={{ width: `${Math.min(100, (groupPct || 0) * 100)}%` }} />
              </div>
            </div>
            {/* Revenue bruto agregado ÷ PI compartilhado */}
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <div className="text-[11px] text-fg-muted">
                  <span className="font-medium text-signature tabular-nums">{formatBRL(groupRev)}</span>
                  <span className="text-fg-subtle"> de </span>
                  <span className="tabular-nums">{formatBRL(groupPi)}</span>
                  <span className="text-fg-subtle ml-1.5">· revenue entregue do PI compartilhado</span>
                </div>
                <div className={cn("text-sm font-bold tabular-nums",
                  pctDeliveryClass(groupPctRev).replace(/bg-\S+/g, "").trim() || "text-fg")}>
                  {formatRatioPct(groupPctRev)}
                </div>
              </div>
              <div className="h-2 rounded-full bg-surface overflow-hidden">
                <div className={cn("h-full transition-all", pctBarColor(groupPctRev))}
                     style={{ width: `${Math.min(100, (groupPctRev || 0) * 100)}%` }} />
              </div>
            </div>
          </div>
        ) : (
          <div className="mb-4 px-3 py-2 rounded-md border border-dashed border-warning/30 bg-warning/5 text-[11px] text-warning">
            Grupo sem PI vinculado — vincule pelo checklist do Hypr Command.
          </div>
        )}

        {/* Sub-rows: cada line do grupo, compacto */}
        <div className="space-y-1.5 mb-4">
          {members.map((m) => {
            const mDm = effectiveDeliveryMeta(m);
            return (
              <button
                key={m.line_id}
                onClick={(e) => { e.stopPropagation(); onLineClick?.(m); }}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-md bg-canvas-elevated/70 border border-border/40 hover:border-signature/40 hover:bg-canvas-elevated transition-colors text-left"
              >
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", mDm.dot)} title={mDm.label} />
                <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[10px] text-fg-muted shrink-0">{m.line_id}</span>
                  <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border", mDm.border, mDm.text, mDm.bg)}>
                    {mDm.label}
                  </span>
                </div>
                <div className="text-right shrink-0 tabular-nums">
                  <div className="text-[12px] text-success font-semibold" title="Margem HYPR">{formatBRL(m.curator_margin)}</div>
                  <div className="text-[10px] text-fg-subtle" title="Revenue bruto">{formatBRL(m.curator_revenue)}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer: métricas TOTAIS do grupo + owners */}
        <div className="flex items-center justify-between flex-wrap gap-3 pt-3 border-t border-signature/15">
          <div className="flex items-center gap-5 text-[11px]">
            <Metric label="Margem %" value={formatRatioPct(groupMarginPct)} />
            <Metric label="eCPM" value={groupEcpm != null ? formatBRL(groupEcpm) : "—"} />
            <Metric label="Impressões" value={formatIntCompact(groupImps)} />
          </div>
          <div className="flex items-center gap-1.5">
            {hero.cp_email && <OwnerChip email={hero.cp_email} role="CP" />}
            {hero.cs_email && <OwnerChip email={hero.cs_email} role="CS" />}
          </div>
        </div>
      </div>
    </div>
  );
}

function OwnerChip({ email, role }) {
  return (
    <div className="inline-flex items-center gap-1.5" title={`${role}: ${email}`}>
      <div className="w-6 h-6 rounded-full bg-signature/15 text-signature flex items-center justify-center text-[10px] font-bold ring-1 ring-signature/20">
        {emailInitial(email)}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// PmpCustomerAccordion — Card de cliente expansível
// ═══════════════════════════════════════════════════════════════════════════
// Hierarquia visual:
//   ▶ Customer (KPIs agregados — sem dedupe PI de grupos)
//     ├─ Grupo "Nutren A/B" (PI compartilhado · sub-lines + total)
//     ├─ Grupo "..."
//     └─ Line solo (sem grupo)
//
// Agrupamento PI-aware: quando lines compartilham group_id, o PI conta UMA
// vez nos totais do cliente (não N vezes). Dentro do accordion, lines do
// mesmo grupo renderizam um sub-card com soma agregada.
export function PmpCustomerAccordion({ customer, lines, onLineClick, onLinkClick, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);

  // Particiona lines por group_id pra calcular agregados PI-aware
  const { groups, singles, agg } = useMemo(() => {
    const groupsMap = new Map();
    const singles = [];
    for (const l of lines) {
      if (l.group_id) {
        if (!groupsMap.has(l.group_id)) groupsMap.set(l.group_id, []);
        groupsMap.get(l.group_id).push(l);
      } else {
        singles.push(l);
      }
    }
    const groupsArr = [...groupsMap.values()];

    // Totais sem dupla-contagem de PI:
    //   • PI de grupo = primeiro membro COM pi_brl (nem todos têm) — conta 1x
    //   • PI de solo = pi_brl da line
    //   • Revenue/Margin/Imps de grupo = group_curator_* (já agregado)
    //   • Revenue/Margin/Imps de solo = curator_*
    let pi = 0, revenue = 0, margin = 0, imps = 0;
    let live = 0, stopped = 0;
    for (const grp of groupsArr) {
      const first = grp[0];
      const grpPi = resolveGroupPi(grp);
      if (grpPi != null) pi += Number(grpPi);
      revenue += Number(first.group_curator_revenue || 0);
      margin  += Number(first.group_curator_margin  || 0);
      imps    += Number(first.group_imps            || 0);
      for (const m of grp) {
        if (LIVE_STATUSES.has(m.delivery_status)) live++;
        if (m.delivery_status === "stopped") stopped++;
      }
    }
    for (const l of singles) {
      if (l.pi_brl != null) pi += Number(l.pi_brl);
      revenue += Number(l.curator_revenue || 0);
      margin  += Number(l.curator_margin  || 0);
      imps    += Number(l.imps            || 0);
      if (LIVE_STATUSES.has(l.delivery_status)) live++;
      if (l.delivery_status === "stopped") stopped++;
    }
    // % entrega = margem ÷ PI (não revenue ÷ PI)
    const pctEntregaAgg = pi > 0 ? margin / pi : null;
    return {
      groups: groupsArr,
      singles,
      agg: { pi, revenue, margin, imps, live, stopped,
              count: lines.length, pctEntrega: pctEntregaAgg,
              marginPct: revenue > 0 ? margin / revenue : null },
    };
  }, [lines]);

  return (
    <div className={cn(
      "rounded-xl border border-border bg-canvas-elevated overflow-hidden transition-all",
      open && "shadow-sm",
    )}>
      {/* Header limpo — sem stripe lateral, apenas chevron + dados essenciais */}
      <button onClick={() => setOpen(o => !o)}
              className="w-full text-left px-6 py-5 hover:bg-surface/30 transition-colors flex items-center gap-4">
        <Chevron open={open} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <h3 className="text-base font-semibold text-fg truncate">
              {customer || <span className="italic text-fg-muted">(sem cliente)</span>}
            </h3>
            <div className="flex items-center gap-3 text-[11px] text-fg-subtle tabular-nums">
              {agg.live > 0    && <span className="text-success">● {agg.live} no ar</span>}
              {agg.stopped > 0 && <span className="text-danger">● {agg.stopped} parou</span>}
              <span>{agg.count} {agg.count === 1 ? "line" : "lines"}</span>
            </div>
          </div>
          {/* Métricas inline — texto leve, valores em negrito */}
          <div className="mt-2.5 grid grid-cols-2 md:grid-cols-5 gap-x-6 gap-y-1.5 text-[12px] tabular-nums">
            <MetricInline label="PI" value={agg.pi > 0 ? formatBRL(agg.pi) : "—"} />
            <MetricInline label="Receita Bruta" value={formatBRL(agg.revenue)} />
            <MetricInline label="Margem HYPR" value={formatBRL(agg.margin)}
                          highlight={agg.marginPct != null ? formatRatioPct(agg.marginPct, 0) : null} valueClass="text-success" />
            <MetricInline label="% Entrega" value={agg.pctEntrega != null ? formatRatioPct(agg.pctEntrega, 1) : "—"} />
            <MetricInline label="Impressões" value={formatInt(agg.imps)} />
          </div>
        </div>
      </button>

      {/* Lista expandida */}
      {open && (lines.length > 0) && (
        <div className="border-t border-border/40 px-3 py-3 space-y-2 bg-surface/20">
          {/* Grupos primeiro (visualmente mais densos) */}
          {groups.map((grp) => (
            <PmpLineGroupCard key={grp[0].group_id} lines={grp}
                              onLineClick={onLineClick} onLinkClick={onLinkClick}
                              variant="nested" />
          ))}
          {/* Lines soltas — tabela minimalista sem header.
              Scroll horizontal (grid completo, 1402px = trilhas+gaps +
              px-5 do row — ver ROW_GRID acima) — barra visível + sombra de
              bordas (ver PmpDealsPage), não `scrollbar-hidden`. */}
          {singles.length > 0 && (
            <div className="rounded-lg border border-border/60 bg-canvas-elevated overflow-hidden">
              <div className="overflow-x-auto scrollbar-thin scroll-fade-x">
                <div className="md:min-w-[1402px] divide-y divide-border/30">
                  {singles.map(l => (
                    <PmpLineRow key={l.line_id} line={l}
                                onClick={() => onLineClick?.(l)} onLinkClick={onLinkClick}
                                compact />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetricInline({ label, value, highlight, valueClass }) {
  return (
    <div className="min-w-0">
      <div className="lbl-micro text-fg-subtle mb-0.5">{label}</div>
      <div className={cn("text-[13px] font-semibold truncate", valueClass || "text-fg")} title={String(value)}>
        {value}
        {highlight && <span className="ml-1.5 text-[11px] font-normal text-fg-muted">{highlight}</span>}
      </div>
    </div>
  );
}

function Chevron({ open }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
         className={cn("text-fg-subtle transition-transform shrink-0", open ? "rotate-90" : "")}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// PmpLineRow — linha estilo Linear/Vercel pra view Lista
// ═══════════════════════════════════════════════════════════════════════════
// Colunas numéricas separam claramente os 3 valores que importam:
//   • Cost     — quanto o curator paga (Xandr tech fee + media cost)
//   • Revenue  — quanto o buyer paga ao curator
//   • Margem   — Revenue - Cost = o que a HYPR efetivamente fatura (DESTAQUE)
//
// Larguras medidas, não estimadas. O maior valor que aparece numa LINHA é
// ~94px ("R$ 4.000.000,00"); os totais de 8 dígitos vivem nos cards do topo,
// não aqui. As colunas numéricas estavam em 136-148px — 40px de folga cada,
// somando ~84px parados enquanto a coluna do cliente colapsava.
//
// A COLUNA DO CLIENTE PRECISA DE MÍNIMO EXPLÍCITO. Era `minmax(0,1.3fr)`, e
// o `0` é o que permitia o colapso: com todas as vizinhas fixas, a fração
// resolvia em 105px para caber nome + token + chip de fonte. Os badges são
// `shrink-0` e o nome é `truncate`, então quem desaparecia era justamente a
// informação primária — sobrava "Amazon…", "Al…", às vezes um caractere só.
// Com `minmax(220px, …)` a coluna nunca encolhe abaixo do legível; se a tela
// for estreita, o container já tem overflow-x-auto e rola.
//
// A ÚLTIMA COLUNA (Entrega) TAMBÉM PRECISA DE MÍNIMO REAL, NÃO SÓ FR. Estava
// `minmax(88px,0.44fr)` — e na prática o `0.44fr` NUNCA cresce: com 3 trilhas
// flexíveis de pesos bem desiguais (Cliente 2.4fr, Status 0.36fr, Entrega
// 0.44fr), o algoritmo de free-space do CSS Grid "congela" as trilhas cujo
// piso já excede a fatia proporcional que o fr daria — e é exatamente o caso
// aqui, então TODO o espaço extra vai pro Cliente e Entrega fica travada em
// 88px sempre, em qualquer largura de tela. Medido: "R$ 13,4 mil ↗" (valor +
// seta) já ocupa ~90,5px sozinho — mais largo que os 88px do piso, SEM
// margem nenhuma. Como o texto usa nbsp (espaço não-quebrável) do
// Intl.NumberFormat entre "R$", o número e "mil", não há onde quebrar
// linha: o texto simplesmente
// vaza pra fora da coluna e é cortado pelo `overflow-hidden` do card — sem
// que scroll horizontal ajude, porque a trilha nunca cresce pra caber. Não é
// bug de "não dá pra ver que rola" (isso já foi corrigido à parte); é a
// coluna genuinely pequena demais pro próprio conteúdo. 120px fixo (piso real
// medido + ~30px de folga, mesmo padrão das colunas numéricas acima) resolve
// definitivamente — sem fr, porque fr aqui nunca funcionou mesmo.
const ROW_GRID = "grid grid-cols-[12px_minmax(220px,2.4fr)_minmax(104px,0.36fr)_84px_112px_112px_128px_136px_58px_72px_72px_120px] gap-x-3";

export function PmpLineRowHeader({ hidePi = false, sortBy = null, sortDir = "desc", onColumnClick = null }) {
  const grid = hidePi
    ? "grid grid-cols-[12px_minmax(220px,2.6fr)_minmax(110px,0.4fr)_88px_116px_116px_138px_60px_116px] gap-x-3"
    : ROW_GRID;
  const interactive = !!onColumnClick;

  // Wrapper que vira <button> quando onColumnClick é fornecido. Mantém o
  // mesmo alinhamento (text-right pra colunas numéricas) e injeta seta na
  // coluna ativa.
  //
  // CUIDADO: <button> não herda font-size/font-weight/text-transform do pai
  // (user-agent stylesheet sobrescreve), então o `lbl-section` do container
  // some quando o filho é <button>. Por isso aplico a mesma utility
  // EXPLICITAMENTE no botão também.
  // `sub` = segunda linha minúscula do rótulo. Existe pra "% Entrega" caber
  // em duas linhas ("% ENTREGA" / "margem" e "receita") em vez de virar a
  // abreviação enigmática de antes ("% Entr Mgm").
  const Th = ({ field, align = "right", accent = false, sub = null, children }) => {
    const active = field && sortBy === field;
    const arrow = active ? (sortDir === "asc" ? "↑" : "↓") : null;
    const cls = cn(
      "select-none",
      align === "right" ? "text-right" : "text-left",
      accent && "text-success/80",
    );
    const label = sub ? (
      <span className={cn("flex flex-col leading-tight", align === "right" ? "items-end" : "items-start")}>
        <span>{children}</span>
        <span className="text-[9px] normal-case tracking-wide font-medium text-fg-subtle/80">{sub}</span>
      </span>
    ) : children;
    if (!field || !interactive) {
      return <div className={cls}>{label}</div>;
    }
    const tip = active
      ? (sortDir === "desc"
          ? "Clique pra inverter (asc); 3º clique limpa"
          : "Clique pra limpar a ordenação")
      : "Clique pra ordenar do maior pro menor";
    return (
      <button
        type="button"
        onClick={() => onColumnClick(field)}
        title={tip}
        className={cn(
          cls,
          // Tipografia replicada pra não cair no default do <button>.
          "lbl-section",
          "inline-flex items-center gap-1 w-full cursor-pointer hover:text-fg transition-colors",
          align === "right" && "justify-end",
          active && "text-fg",
        )}
      >
        <span>{label}</span>
        {arrow && <span className="text-fg-muted text-[9px]">{arrow}</span>}
      </button>
    );
  };

  return (
    <div className={cn(grid, "lbl-section hidden md:grid px-5 py-3 dense:py-2 bg-surface/60 border-b border-border/60")}>
      <div />
      <Th field="customer" align="left">Cliente / Campanha</Th>
      <Th>Status</Th>
      <Th field="start_date">Início</Th>
      {!hidePi && <Th field="pi_brl">PI</Th>}
      <Th field="curator_total_cost">Custo</Th>
      <Th field="curator_revenue">Receita Bruta</Th>
      <Th field="curator_margin">Margem HYPR</Th>
      <Th field="effective_margin_pct">Margem %</Th>
      {!hidePi && <Th field="pct_a_receber"     sub="margem">% Entrega</Th>}
      {!hidePi && <Th field="pct_a_receber_rev" sub="receita">% Entrega</Th>}
      <Th field="hours_since_last_delivery">Entrega</Th>
    </div>
  );
}

function PmpLineRowInner({
  line, onClick, onLinkClick,
  compact = false, hidePi = false,
  groupBadge = null,
  // Quando a line está num grupo, o pai injeta o PI unificado e o %
  // entrega calculado contra esse PI compartilhado (em vez do per-line).
  groupPi = null, groupPctReceber = null, groupPctReceberRev = null,
  // True só no 1º membro do grupo — usado pra renderizar o badge de
  // Receita Extra uma única vez por grupo (no 1º membro), usando a
  // margem agregada do grupo (não per-line).
  isFirstGroupMember = false,
}) {
  const dm = effectiveDeliveryMeta(line);
  const piToShow = groupPi != null ? groupPi : line.pi_brl;
  const hasPi = piToShow != null && piToShow > 0;
  // % entrega per-line agora é margem ÷ PI; em grupo usa o valor injetado pelo pai
  const pctToShow = groupPctReceber != null ? groupPctReceber : pctEntrega(line);
  // % Entr Rev (revenue ÷ PI) — métrica extra ao lado da de margem
  const pctRevToShow = groupPctReceberRev != null ? groupPctReceberRev : pctEntregaRev(line);
  const lastDeliv = formatLastDelivery(line.hours_since_last_delivery);
  // Lines canceladas: cores cinza claro em quase tudo, mantendo só o pill
  // de status "Cancelado" colorido como sinal forte. Tira a competição
  // visual com lines vivas/finalizadas (que ainda têm dados úteis).
  const effStatus = effectiveStatus(line);
  const isCancelado = effStatus === "Cancelado";

  // Grid: quando hidePi, esconde a coluna PI (PI está no header do grupo).
  // Também esconde % Entrega per-line (faz sentido só ao nível do grupo).
  const grid = hidePi
    ? "grid grid-cols-[12px_minmax(220px,2.6fr)_minmax(110px,0.4fr)_88px_116px_116px_138px_60px_116px] gap-x-3"
    : ROW_GRID;

  // content-visibility:auto — browser pula render/paint das rows fora do
  // viewport (1000+ lines na Lista/Histórico = scroll e filtro pesados).
  // intrinsic-size `auto 72px` é a estimativa pré-primeiro-paint (altura
  // da row desktop) pro scrollbar não pular; o browser memoriza a altura
  // real depois. Browsers sem suporte ignoram (degradação = hoje).
  // Row é clicável (abre o drawer) — precisa ser alcançável por teclado.
  // Continua <div> (e não <button>) porque tem botões dentro ("vincular"),
  // e botão aninhado em botão é HTML inválido.
  return (
    <div onClick={() => onClick?.(line)}
         role="button"
         tabIndex={0}
         aria-label={`Abrir ${line.campaign_name || line.line_name || `line ${line.line_id}`}`}
         onKeyDown={(e) => {
           if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(line); }
         }}
         className={cn("cursor-pointer transition-colors hover:bg-surface/40 group",
           "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-signature",
           "[content-visibility:auto] [contain-intrinsic-size:auto_72px]",
           line.is_archived && "opacity-50")}>
      {/* ── Desktop (md+): grid denso de 11 colunas ──────────────────────── */}
      <div className={cn(grid, "hidden md:grid px-5 items-center",
           compact ? "py-4" : "py-5")}>
      <div className="flex justify-center" title={dm.label}>
        <span className={cn("w-2 h-2 rounded-full", dm.dot)} />
      </div>

      {/* DUAS FAIXAS COM PAPÉIS SEPARADOS
          ────────────────────────────────────────────────────────────────
          Linha 1 = o que se LÊ: cliente · campanha, e só. Antes ela também
          carregava o token (48px) e o chip de fonte (39px), ambos `shrink-0`,
          num espaço que resolvia em 105px — então quem cedia era o nome, que
          é a informação primária. Sobrava "Amazon…" ou um caractere.

          Linha 2 = os IDENTIFICADORES técnicos: agência, deal/line id e o
          token. Continuam a um passo de distância (11px abaixo), com o token
          preservando a cor signature pra seguir localizável no scan.

          O `title` com o texto completo é a prévia no hover — não existia,
          então um nome truncado era simplesmente inalcançável. */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn("text-[13px] font-medium truncate", isCancelado ? "text-fg-subtle" : "text-fg")}
            title={[!hidePi && (line.customer || "sem cliente"), line.campaign_name || "—"]
              .filter(Boolean).join(" · ")}
          >
            {!hidePi && (line.customer || <span className="italic text-fg-muted">sem cliente</span>)}
            {!hidePi && <span className={cn("mx-2", isCancelado ? "text-fg-subtle/60" : "text-fg-subtle")}>·</span>}
            <span className={isCancelado ? "text-fg-subtle italic" : "text-fg"}>{line.campaign_name || "—"}</span>
          </span>
          {!isCancelado && isNewLine(line) && (
            <span
              className="lbl-micro text-signature badge-new px-1.5 py-0.5 rounded-full shrink-0 bg-signature/15 border border-signature/40"
              title="Line criada há menos de 72h">
              new
            </span>
          )}
        </div>
        <div className={cn("text-[11px] mt-0.5 flex items-center gap-2 min-w-0",
          isCancelado ? "text-fg-subtle/60" : "text-fg-subtle")}>
          <span
            className="truncate"
            title={`${line.agency || "sem agência"} · ${line.external_deal_id || `Line ${line.line_id}`}`}
          >
            {line.agency || "—"} <span className="mx-1.5">·</span> {line.external_deal_id || `Line ${line.line_id}`}
          </span>
          {line.short_token && (
            <span className={cn("font-mono text-[10px] px-1.5 py-0.5 rounded shrink-0",
              isCancelado
                ? "text-fg-subtle bg-surface border border-border"
                : "text-signature bg-signature/10")}>
              {line.short_token}
            </span>
          )}
          {/* Sem `showXandr`: medido na lista em produção, "Xandr" aparecia em
              93 de 94 lines e "PubMatic" em 1 — o chip gastava 39px + gap em
              toda linha pra não distinguir nada. É o comportamento default do
              SourceChip (xandr → null), que a lista estava anulando. Agora só
              aparece quando de fato informa algo. */}
          <SourceChip source={line.source} className="shrink-0" />
          {groupBadge && (
            <span className="lbl-micro text-signature inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-signature/10 border border-signature/20 shrink-0"
                  title={`Esta line pertence a um grupo · ${groupBadge}`}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                   strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/>
                <path d="M8 7c4 0 6 2 6 5M8 17c4 0 6-2 6-5"/>
              </svg>
              Grupo · 1 PI
            </span>
          )}
        </div>
      </div>

      <div className="flex justify-end items-center">
        {/* Pill de Bid (flex/fixed) saiu da lista — fica só no drawer da line.
            Status segue como sinal visual principal. */}
        <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border", statusPillClass(effStatus))}>
          {effStatus}
        </span>
      </div>

      <div className={cn("text-right text-[12px] tabular-nums",
        isCancelado ? "text-fg-subtle/70" : "text-fg-muted")}>
        {formatLineStartPeriod(line) || "—"}
      </div>

      {!hidePi && (
        <div className="text-right text-[13px] tabular-nums">
          {hasPi ? (
            <span className={cn(
                    isCancelado ? "text-fg-subtle/70"
                    : groupPi != null ? "text-fg-muted"
                    : "text-fg")}
                  title={groupPi != null ? "PI compartilhado do grupo" : undefined}>
              {formatBRL(piToShow)}
            </span>
          ) : isCancelado ? (
            // Line cancelada não mostra CTA "vincular" — apenas placeholder.
            // O drawer ainda permite vincular via edição (não polui a UI de lista).
            <span className="text-fg-subtle/60">—</span>
          ) : onLinkClick ? (
            <button onClick={(e) => { e.stopPropagation(); onLinkClick(line); }}
                    className="text-[11px] text-warning hover:text-warning underline-offset-2 hover:underline">
              🔗 vincular
            </button>
          ) : (
            <span className="text-[11px] text-warning/60">sem PI</span>
          )}
        </div>
      )}

      <div className={cn("text-right text-[13px] tabular-nums",
        isCancelado ? "text-fg-subtle/70" : "text-fg-subtle")}>
        {formatBRL(line.curator_total_cost)}
      </div>
      <div className={cn("text-right text-[13px] tabular-nums",
        isCancelado ? "text-fg-subtle/70" : "text-fg-muted")}>
        {formatBRL(line.curator_revenue)}
        {(() => {
          // Falta entregar (R$) = PI − revenue: saldo de faturamento bruto
          // ainda a fechar contra o contratado. Contraparte absoluta do
          // % Entr Rev. Em grupo, calcula contra o PI compartilhado e mostra
          // só no 1º membro (mesma regra do badge de ganho extra). Esconde
          // quando a entrega já bateu/passou o PI (falta ≤ 0).
          if (isCancelado) return null;
          const isGroupMember = line.group_id != null;
          if (isGroupMember && !isFirstGroupMember) return null;
          const falta = isGroupMember
            ? groupFaltaEntregarRev(line, groupPi != null ? groupPi : line.pi_brl)
            : faltaEntregarRev(line);
          if (falta == null || falta < 1) return null;
          return (
            <div className="text-[10px] text-warning mt-0.5"
                 title={isGroupMember
                   ? "Falta entregar = PI compartilhado do grupo − revenue agregada do grupo"
                   : "Falta entregar = PI − revenue bruto (faturamento a fechar)"}>
              falta {formatBRLCompact(falta)}
            </div>
          );
        })()}
      </div>
      <div className={cn("text-right tabular-nums",
        isCancelado ? "text-fg-subtle" : "text-fg")}>
        <div className="text-[13px] font-semibold">{formatBRL(line.curator_margin)}</div>
        {(() => {
          if (isCancelado) return null;
          const pct = line.curator_margin_pct;
          const isGroupMember = line.group_id != null;
          // Em grupo, badge só no 1º membro pra não duplicar o "ganho extra"
          // (membros seguintes representam a mesma agregação grupo×PI).
          if (isGroupMember && !isFirstGroupMember) return null;
          const piBase = isGroupMember ? (groupPi != null ? groupPi : line.pi_brl) : line.pi_brl;
          const realized = isGroupMember
            ? Number(line.group_curator_margin || 0)
            : Number(line.curator_margin || 0);
          if (piBase == null || pct == null) return null;
          const expected = Number(piBase) * (Number(pct) / 100);
          const extra = realized - expected;
          if (Math.abs(extra) < 1) return null;
          const positive = extra >= 0;
          return (
            <div className={cn(
              "inline-block mt-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded",
              positive
                ? "bg-success-soft text-success"
                : "bg-warning-soft text-warning",
            )} title={isGroupMember
              ? "Margem agregada do grupo − PI × margem configurada"
              : "Margem realizada − PI × margem configurada"}>
              {positive ? "+ " : "− "}{formatBRLCompact(Math.abs(extra))}
            </div>
          );
        })()}
      </div>
      <div className={cn("text-right text-[12px] tabular-nums",
        isCancelado ? "text-fg-subtle/70" : "text-fg-muted")}>
        {formatRatioPct(line.effective_margin_pct, 0)}
      </div>
      {!hidePi && (
        <div className={cn("text-right text-[12px] tabular-nums px-2 py-0.5 rounded",
          isCancelado ? "text-fg-subtle" : pctDeliveryClass(pctToShow))}
             title={groupPctReceber != null
               ? "% entrega (margem ÷ PI compartilhado do grupo)"
               : "% entrega = margem HYPR ÷ PI"}>
          {formatRatioPct(pctToShow, 0)}
        </div>
      )}
      {!hidePi && (
        <div className={cn("text-right text-[12px] tabular-nums px-2 py-0.5 rounded",
          isCancelado ? "text-fg-subtle" : pctDeliveryClass(pctRevToShow))}
             title={groupPctReceberRev != null
               ? "% entrega (revenue ÷ PI compartilhado do grupo)"
               : "% entrega = revenue bruto ÷ PI"}>
          {formatRatioPct(pctRevToShow, 0)}
        </div>
      )}
      {/* Pra lines ativas que entregaram ontem, mostra a margem do dia + uma
          seta direcional vs média/dia dos 6 dias anteriores, e o % de delta
          embaixo. Dá ao admin uma leitura rápida de "estamos avançando?"
          sem precisar abrir o drawer. Mantém consistência com a coluna
          Margem HYPR e com o toggle MARGEM do gráfico do drawer — tudo
          falando da mesma métrica (margem = curator_margin). Outras lines
          mantêm o relativo ("há Xd", "Pausado", etc). */}
      <div className="text-right">
        {(() => {
          const my = Number(line.margin_yesterday || 0);
          if (effStatus === "Andamento" && my > 0) {
            const avg = Number(line.margin_prev_6d_avg || 0);
            // Tolerância de ±10% — abaixo disso é flutuação normal entre dias
            // úteis/fim-de-semana e não vale piscar verde/amarelo.
            const diff = avg > 0 ? (my - avg) / avg : null;
            const arrow = diff == null ? "" : diff > 0.10 ? "↗" : diff < -0.10 ? "↘" : "→";
            const tone = diff == null ? "text-fg-muted"
                       : diff > 0.10  ? "text-success"
                       : diff < -0.10 ? "text-warning"
                       :                "text-fg-muted";
            const pct = diff != null ? Math.round(diff * 100) : null;
            const pctLabel = pct != null
              ? ` · ${pct >= 0 ? "+" : ""}${pct}%`
              : "";
            const title = avg > 0
              ? `Margem entregue ontem · média/dia dos 6d anteriores: ${formatBRL(avg)}`
              : "Margem entregue ontem (sem histórico de 6d pra comparar)";
            return (
              <div title={title}>
                <div className={cn("text-[12px] font-semibold tabular-nums", tone)}>
                  {formatBRLCompact(my)}{arrow ? ` ${arrow}` : ""}
                </div>
                <div className="text-[10px] text-fg-subtle mt-0.5 tabular-nums">
                  ontem{pctLabel}
                </div>
              </div>
            );
          }
          // Entregou RECENTEMENTE mas não ontem — típico de fonte com lag de
          // reporting (PubMatic fecha D-2/D-3). Em vez de só "há Xd", mostra o
          // valor do ÚLTIMO dia com entrega, rotulado pelo tempo relativo.
          const mld = Number(line.margin_last_delivery || 0);
          const hrs = line.hours_since_last_delivery;
          if (effStatus === "Andamento" && my <= 0 && mld > 0 && hrs != null && hrs <= 24 * 7) {
            return (
              <div title="Margem do último dia com entrega (fonte com lag de reporting)">
                <div className="text-[12px] font-semibold tabular-nums text-fg-muted">
                  {formatBRLCompact(mld)}
                </div>
                <div className="text-[10px] text-fg-subtle mt-0.5">
                  {lastDeliv || "último dia"}
                </div>
              </div>
            );
          }
          return (
            <div className={cn("text-[11px]", dm.text)}>
              {lastDeliv || dm.label}
            </div>
          );
        })()}
      </div>
      </div>

      {/* ── Mobile (<md): card empilhado ─────────────────────────────────────
          Substitui o grid de 11 colunas (que exigia scroll horizontal e
          escondia as métricas financeiras) por um card que mostra TUDO
          verticalmente, legível em 375px. Mesmo dado, mesma formatação. */}
      <div className="md:hidden px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <span className={cn("mt-1 w-2 h-2 rounded-full shrink-0", dm.dot)} title={dm.label} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={cn("text-[13px] font-medium leading-snug", isCancelado ? "text-fg-subtle" : "text-fg")}>
                {!hidePi && (line.customer || "sem cliente")}
                {!hidePi && <span className="text-fg-subtle mx-1.5">·</span>}
                <span className={isCancelado ? "italic text-fg-subtle" : ""}>{line.campaign_name || "—"}</span>
              </span>
              {line.short_token && (
                <span className={cn("font-mono text-[10px] px-1.5 py-0.5 rounded shrink-0",
                  isCancelado ? "text-fg-subtle bg-surface border border-border" : "text-signature bg-signature/10")}>
                  {line.short_token}
                </span>
              )}
            </div>
            <div className="text-[11px] text-fg-subtle mt-0.5">
              {line.agency || "—"} <span className="mx-1">·</span> Line {line.line_id}
              {groupBadge && <span className="text-signature"> · Grupo · 1 PI</span>}
            </div>
          </div>
          <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border shrink-0", statusPillClass(effStatus))}>
            {effStatus}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
          {!hidePi && (
            <PmpMobileStat label="PI">
              {hasPi ? (
                <span className={isCancelado ? "text-fg-subtle/70" : "text-fg"}>{formatBRL(piToShow)}</span>
              ) : isCancelado ? (
                <span className="text-fg-subtle/60">—</span>
              ) : onLinkClick ? (
                <button onClick={(e) => { e.stopPropagation(); onLinkClick(line); }}
                        className="text-[13px] text-warning hover:text-warning underline-offset-2 hover:underline">
                  🔗 vincular
                </button>
              ) : <span className="text-warning/60">sem PI</span>}
            </PmpMobileStat>
          )}
          <PmpMobileStat label="Custo"><span className="text-fg-muted">{formatBRL(line.curator_total_cost)}</span></PmpMobileStat>
          <PmpMobileStat label="Receita Bruta">
            <span className="text-fg-muted">{formatBRL(line.curator_revenue)}</span>
            {(() => {
              if (isCancelado) return null;
              const isGroupMember = line.group_id != null;
              if (isGroupMember && !isFirstGroupMember) return null;
              const falta = isGroupMember
                ? groupFaltaEntregarRev(line, groupPi != null ? groupPi : line.pi_brl)
                : faltaEntregarRev(line);
              if (falta == null || falta < 1) return null;
              return (
                <div className="text-[10px] text-warning mt-0.5"
                     title="Falta entregar = PI − revenue bruto (faturamento a fechar)">
                  falta {formatBRLCompact(falta)}
                </div>
              );
            })()}
          </PmpMobileStat>
          <PmpMobileStat label="Margem HYPR">
            <span className={cn("font-semibold", isCancelado ? "text-fg-subtle" : "text-success")}>
              {formatBRL(line.curator_margin)}
            </span>
          </PmpMobileStat>
          <PmpMobileStat label="Margem %"><span className="text-fg-muted">{formatRatioPct(line.effective_margin_pct, 0)}</span></PmpMobileStat>
          {!hidePi && (
            <PmpMobileStat label="% Entrega (margem)">
              <span className={cn("inline-block px-1.5 py-0.5 rounded", !isCancelado && pctDeliveryClass(pctToShow))}>
                {formatRatioPct(pctToShow, 0)}
              </span>
            </PmpMobileStat>
          )}
          {!hidePi && (
            <PmpMobileStat label="% Entrega (receita)">
              <span className={cn("inline-block px-1.5 py-0.5 rounded", !isCancelado && pctDeliveryClass(pctRevToShow))}>
                {formatRatioPct(pctRevToShow, 0)}
              </span>
            </PmpMobileStat>
          )}
        </div>

        <div className="mt-2.5 pt-2 border-t border-border/50 flex items-center justify-between text-[11px]">
          <span className="text-fg-subtle tabular-nums">{formatLineStartPeriod(line) || "—"}</span>
          <span className={cn("tabular-nums", dm.text)}>{lastDeliv || dm.label}</span>
        </div>
      </div>
    </div>
  );
}

// memo com comparação rasa padrão — `line` vem de setLines imutável
// (spread + map), onClick/onLinkClick são setters/refs estáveis, e as
// props de grupo (groupPi, groupPctReceber, groupBadge, flags) são
// primitivas. Em listas de 1000+ lines, evita re-renderizar tudo a cada
// tecla na busca / abrir-fechar drawer / tick do saving indicator.
export const PmpLineRow = memo(PmpLineRowInner);

// Stat empilhado do card mobile da PmpLineRow — label minúsculo + valor.
function PmpMobileStat({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="lbl-micro text-fg-subtle mb-0.5">{label}</div>
      <div className="text-[13px] tabular-nums">{children}</div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// PmpWorklistBuckets — 4 buckets de ações imediatas
// ═══════════════════════════════════════════════════════════════════════════
export function PmpWorklistView({ lines, onLineClick, onLinkClick, focusBucket }) {
  const buckets = useMemo(() => {
    const stopped = [], noPi = [];
    // Worklist olha a BASE INTEIRA — não filtra por live partition. Assim
    // pega lines com state=active no Xandr mesmo que já estejam classificadas
    // como "ended" (≥7d sem delivery) no nosso modelo.
    //
    // "Pararam de entregar" (stopped) = state=active no Xandr MAS sem delivery
    // há 8-30 dias. Ou seja: lines ativadas/rodando há pouco que pararam de
    // entregar sem terem sido finalizadas no Xandr. É o sinal de "algo tá
    // errado, ainda tá ligado lá mas não tá entregando".
    for (const l of lines) {
      if (l.delivery_status === "stopped") stopped.push(l);
      if (LIVE_STATUSES.has(l.delivery_status) && l.pi_brl == null) noPi.push(l);
    }
    return [
      { key: "stopped", title: "Pararam de entregar", desc: "Lines com state=active no Xandr mas sem delivery há mais de 7 dias", lines: stopped, color: "rose" },
      { key: "no_pi",   title: "Sem PI vinculado",    desc: "Lines no ar mas sem ligação com o Hypr Command",                     lines: noPi,    color: "amber" },
    ];
  }, [lines]);

  const totalUrgent = buckets.reduce((s, b) => s + b.lines.length, 0);

  if (totalUrgent === 0) {
    return (
      <div className="rounded-xl border border-success/30 bg-success/5 px-6 py-12 text-center">
        <div className="text-success text-3xl mb-2">✓</div>
        <div className="text-fg font-medium">Nenhuma ação urgente no momento</div>
        <div className="text-fg-muted text-sm mt-1">Todas as lines ativas estão entregando dentro do esperado.</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {buckets.map(b => (
        <WorklistBucket key={b.key} bucket={b} onLineClick={onLineClick} onLinkClick={onLinkClick} focused={focusBucket === b.key} />
      ))}
    </div>
  );
}

function WorklistBucket({ bucket, onLineClick, onLinkClick, focused }) {
  const colorClasses = bucket.color === "rose"
    ? { border: "border-danger/30", bg: "bg-danger/5", text: "text-danger", chip: "bg-danger/15 text-danger border-danger/30" }
    : { border: "border-warning/30", bg: "bg-warning/5", text: "text-warning", chip: "bg-warning/15 text-warning border-warning/30" };

  return (
    <div className={cn(
      "rounded-xl border bg-canvas-elevated overflow-hidden transition-shadow",
      colorClasses.border,
      focused && "ring-2 ring-signature/40",
    )}>
      <div className={cn("px-5 py-3.5 border-b", colorClasses.border, colorClasses.bg)}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className={cn("text-sm font-semibold", colorClasses.text)}>{bucket.title}</h3>
            <p className="text-[11px] text-fg-muted mt-0.5">{bucket.desc}</p>
          </div>
          <span className={cn("inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border tabular-nums", colorClasses.chip)}>
            {bucket.lines.length}
          </span>
        </div>
      </div>
      {bucket.lines.length === 0 ? (
        <div className="px-5 py-6 text-center text-xs text-fg-subtle italic">Tudo limpo aqui</div>
      ) : (
        <div className="divide-y divide-border/30">
          {bucket.lines.slice(0, 8).map(l => (
            <button key={l.line_id} onClick={() => onLineClick?.(l)}
                    className="w-full text-left px-5 py-3 hover:bg-surface/50 transition-colors flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-fg font-medium truncate">
                  {l.customer || "—"} <span className="text-fg-subtle mx-1">·</span> {l.campaign_name || "—"}
                </div>
                <div className="text-[10px] text-fg-subtle mt-0.5">
                  Line {l.line_id} {l.short_token ? `· ${l.short_token}` : ""}
                </div>
              </div>
              <div className="text-right shrink-0">
                {bucket.key === "stopped" && (
                  <div className="text-xs text-danger">{formatLastDelivery(l.hours_since_last_delivery) || "sem delivery"}</div>
                )}
                {bucket.key === "no_pi" && (
                  effectiveStatus(l) === "Cancelado" ? (
                    <span className="text-xs text-fg-subtle/60">—</span>
                  ) : onLinkClick ? (
                    <button onClick={(e) => { e.stopPropagation(); onLinkClick(l); }}
                            className="text-xs text-warning hover:text-warning underline-offset-2 hover:underline">
                      🔗 vincular
                    </button>
                  ) : (
                    <span className="text-xs text-warning/60">sem PI</span>
                  )
                )}
              </div>
            </button>
          ))}
          {bucket.lines.length > 8 && (
            <div className="px-5 py-2 text-[11px] text-fg-subtle text-center">
              + {bucket.lines.length - 8} {bucket.lines.length - 8 === 1 ? "outra" : "outras"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// Ícones do LayoutToggle
// ═══════════════════════════════════════════════════════════════════════════
function DotIcon() { return <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>; }
function UsersIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="7" r="3.5" /><path d="M3 21v-1a6 6 0 0 1 12 0v1" /><circle cx="17" cy="7" r="3" strokeOpacity="0.5" /></svg>; }
function ListIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>; }
function TargetIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></svg>; }
function ArchiveIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/></svg>; }
function AnalyticsIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M7 15l3.5-4 3 3L21 7"/></svg>; }
