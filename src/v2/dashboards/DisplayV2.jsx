// src/v2/dashboards/DisplayV2.jsx
//
// Aba Display — Report 2.0.
//
// LAYOUT, NA ORDEM (top → bottom)
//   1. Título "Display" com a frente (O2O / OOH / Groundflow) ao lado
//   2. Negociado × Efetivo (CPM, com a economia sempre visível) e a faixa
//      de contrato no rodapé: budget, imp. contratadas, bônus, CPM negociado
//   3. 6 KPIs: impressões, imp. visíveis, viewability, cliques, CTR, CPC
//   4. Pacing da frente com o investido (custo efetivo × budget); com filtro
//      de período, o custo efetivo do período no lugar
//   5. Tendência diária: imp. visíveis e CTR alinhados, cada um na sua escala
//   6. Explorador de entrega: Audiência · Tamanho · Linha criativa · Line · Dia
//
// FILTRO DE PERÍODO É GLOBAL (shell ClientDashboardV2).
// FILTRO DE TACTIC: deriva no frontend pra alinhar com o que totals já
//   faz no backend (`query_totals` tem fallback hardcoded `ELSE 'O2O'`,
//   `query_detail` tem `ELSE tactic_type` — fallbacks diferentes
//   geravam mismatch). Lógica:
//     1. line_name tem `_O2O_`/`_O2O$` (case insensitive) → "O2O"
//     2. line_name tem `_OOH_`/`_OOH$`                    → "OOH"
//     3. fallback                                          → "O2O"

import { useMemo } from "react";
import {
  computeDisplayKpis,
  applyAudienceOverride,
  applyLabelOverride,
  extractAudience,
  getCreativeLineKey,
  groupByDate,
  groupBySize,
  groupByCreativeName,
  groupByAudience,
} from "../../shared/aggregations";
import { groupByLine } from "../../shared/explorer";
import { useAudienceOverrides } from "../hooks/useAudienceOverrides";
import { useLabelOverrides } from "../hooks/useLabelOverrides";
import { fmt, fmtP2, fmtR } from "../../shared/format";

import { useReportTrackingContext } from "../contexts/ReportTrackingContext";
import { Card } from "../../ui/Card";
import { AlignedTrendCardV2 } from "../components/AlignedTrendCardV2";
import { ComparisonCardV2 } from "../components/ComparisonCardV2";
import { DeliveryExplorerV2 } from "../components/DeliveryExplorerV2";
import { KpiCardV2 } from "../components/KpiCardV2";
import { PacingBarV2 } from "../components/PacingBarV2";
import { SegmentedControlV2 } from "../components/SegmentedControlV2";

const EMPTY_TOTALS = {};

const TACTIC_OPTIONS = [
  { value: "O2O", label: "O2O" },
  { value: "OOH", label: "OOH" },
  { value: "GROUNDFLOW", label: "Groundflow" },
];

// Espelha o CASE do `query_totals` no backend. ORDEM IMPORTA: Groundflow
// (token RMNF ou GROUNDFLOW no line_name) vence O2O — as lines vêm como
// `..._O2O_GROUNDFLOW_...`, então sem a prioridade cairiam em O2O.
// Delimitador pode ser `_` ou `-` (naming mistura os dois).
// `gfOn` = a campanha tem contrato de groundflow. Sem contrato, a line é
// "dark test" e conta como O2O/OOH normal (espelha o _GF_CONTRACT_GATE do
// backend) — senão a entrega sumiria do O2O na aba.
const GROUNDFLOW_RE = /(?:^|[_-])(?:RMNF|GROUNDFLOW)(?:[_-]|$)/i;
const O2O_RE = /(?:^|[_-])O2O(?:[_-]|$)/i;
const OOH_RE = /(?:^|[_-])OOH(?:[_-]|$)/i;
const deriveTactic = (lineName, gfOn) => {
  const ln = lineName || "";
  if (gfOn && GROUNDFLOW_RE.test(ln)) return "GROUNDFLOW";
  if (O2O_RE.test(ln)) return "O2O";
  if (OOH_RE.test(ln)) return "OOH";
  return "O2O";
};

export default function DisplayV2({
  data,
  aggregates,
  tactic,
  setTactic,
  isAdmin = false,
}) {
  const camp = data.campaign;
  // trackCta vem do contexto montado pelo ClientDashboardV2. Noop fora dele.
  const { trackCta } = useReportTrackingContext();

  // Override de nome de audiência (Report Center, por anunciante). Aplicado na
  // quebra "Por Audiência" abaixo; editável inline só por admin. Mapa inicial
  // vem no payload (data.audience_overrides), mutado otimista pelo hook.
  const aud = useAudienceOverrides({
    initialMap: data.audience_overrides,
    clientName: camp.client_name,
    shortToken: camp.short_token,
    isAdmin,
  });

  // Override de NOME de formato (creative_size) e linha criativa — mesma
  // mecânica do de audiência, dimensões distintas. Mapa inicial vem em
  // data.label_overrides[dimension].
  const fmtOv = useLabelOverrides({
    dimension: "format",
    initialMap: data.label_overrides?.format,
    clientName: camp.client_name,
    shortToken: camp.short_token,
    isAdmin,
  });
  const clOv = useLabelOverrides({
    dimension: "creative_line",
    initialMap: data.label_overrides?.creative_line,
    clientName: camp.client_name,
    shortToken: camp.short_token,
    isAdmin,
  });

  // Tactics disponíveis: O2O e OOH só aparecem se houver contrato (incl.
  // bônus) OU entrega real pra essa frente. Evita mostrar segmento
  // sem dado nem possibilidade de dado. Quando só uma tactic está
  // disponível, escondemos o SegmentedControl inteiro (1 opção é UI ruim).
  // `effectiveTactic` cobre o caso do state apontar pra tactic sumida —
  // sem setState em effect (anti-padrão React 19).
  // Objeto vazio de módulo (não `{}` literal): report sem totals criava um
  // objeto novo por render e invalidava o useMemo da `view` abaixo, que
  // refazia todos os groupBy a cada render.
  const t0Display = (data.totals || [])[0] || EMPTY_TOTALS;
  const hasDelivery = (tac) => aggregates.totals.some(
    (r) => r.media_type === "DISPLAY" && r.tactic_type === tac,
  );
  const hasContract = (frente) =>
    (t0Display[`contracted_${frente}_display_impressions`] || 0) > 0 ||
    (t0Display[`bonus_${frente}_display_impressions`] || 0) > 0;
  // Gate do Groundflow (espelha o backend): só é frente própria com contrato.
  // Sem contrato, lines groundflow são dark test → contam como O2O no detail.
  const hasGfContract = hasContract("groundflow");
  // Override de core products (curadoria admin): esconde frentes fora do set
  // mesmo com entrega. Backend já zerou o contrato delas; isto gateia a entrega.
  const activeCP = camp.active_core_products;
  const isActiveCP = (frente) => !activeCP || activeCP.includes(frente);
  const showByTactic = {
    O2O:        isActiveCP("O2O")        && (hasContract("o2o")        || hasDelivery("O2O")),
    OOH:        isActiveCP("OOH")        && (hasContract("ooh")        || hasDelivery("OOH")),
    GROUNDFLOW: isActiveCP("GROUNDFLOW") && hasGfContract,  // contract-only (≠ O2O/OOH): dark test não vira frente
  };
  const availableTactics = TACTIC_OPTIONS.filter((opt) => showByTactic[opt.value]);
  const effectiveTactic =
    availableTactics.find((t) => t.value === tactic)?.value
    || availableTactics[0]?.value
    || tactic;

  // Derivações por tactic. Os filtros multi-select (audiência/line/creative
  // line/tamanho/formato) ficam no GlobalDataFilterBarV2 do dashboard pai —
  // já aplicados upstream em computeAggregates, então `aggregates.detail`
  // que chega aqui já está recortado pelo recorte global do usuário. Aqui
  // só fatiamos por mídia (DISPLAY) e tactic.
  const view = useMemo(() => {
    const totals = aggregates.totals.filter(
      (r) => r.media_type === "DISPLAY" && r.tactic_type === effectiveTactic,
    );
    const detailAll = aggregates.detail.filter(
      (r) => r.media_type === "DISPLAY" && deriveTactic(r.line_name, hasGfContract) === effectiveTactic,
    );

    const kpis = computeDisplayKpis({
      rows: totals,
      detail: detailAll,
      detailAll,
      tactic: effectiveTactic,
      camp,
      checklist: t0Display,
    });

    const daily = groupByDate(detailAll, "clicks", "viewable_impressions", "ctr");
    const bySize = groupBySize(detailAll, "clicks", "viewable_impressions", "ctr", fmtOv.overrideMap);
    const byCreative = groupByCreativeName(detailAll, "clicks", "viewable_impressions", "ctr", clOv.overrideMap);
    const byAudience = groupByAudience(detailAll, "clicks", "viewable_impressions", "ctr", aud.overrideMap);

    return { totals, detailAll, kpis, daily, bySize, byCreative, byAudience };
  }, [aggregates, effectiveTactic, camp, t0Display, hasGfContract, aud.overrideMap, fmtOv.overrideMap, clOv.overrideMap]);

  const { totals, detailAll, kpis, daily, bySize, byCreative, byAudience } = view;
  // Alias mantido pelos consumers internos que esperavam `detailFiltered`.
  // Agora "filtered" e "all" são equivalentes dentro do DisplayV2 (o filtro
  // de verdade aconteceu antes, no computeAggregates).
  const detailFiltered = detailAll;

  // Empty state vs notStarted:
  //  - notStarted: há contrato negociado pra essa tactic mas zero delivery
  //    (campanha aguardando início). Mostra contratual + disclaimer pro CS
  //    lembrar de cobrar/destravar.
  //  - isEmpty: zero contrato E zero delivery — caso raro, só acontece se
  //    availableTactics permitiu render mesmo sem contrato (defensivo).
  const isEmpty = totals.length === 0 && view.detailAll.length === 0 && !kpis.notStarted;

  // Imp. contratadas e bonus — prioriza qualquer row, cai pro checklist
  // (t0Display) quando a tactic ainda não entregou nada.
  const row0 = totals[0] || t0Display || {};
  const _frente = (effectiveTactic || "O2O").toLowerCase();
  const contractedImps = row0[`contracted_${_frente}_display_impressions`] || 0;
  const bonusImps      = row0[`bonus_${_frente}_display_impressions`]      || 0;

  // CPM "com bonus": divide o mesmo budget pela entrega total prometida
  // (contratadas + bonus). Reflete a economia real do deal — cliente paga
  // R$ X mas recebe ~contracted+bonus impressões visíveis, então o CPM
  // por entrega de fato é mais baixo que o cpm contratual.
  //   CPM c/ Bonus = (cpmNeg × contracted) / (contracted + bonus)
  // Equivale a (budget / total) × 1000 — escrito assim pra evitar
  // depender de orçamento explícito (que vem em coluna separada e nem
  // sempre é populada). Só faz sentido quando há bonus > 0.
  const cpmNegBonus = bonusImps > 0 && contractedImps > 0 && kpis.cpmNeg > 0
    ? (kpis.cpmNeg * contractedImps) / (contractedImps + bonusImps)
    : null;

  // CPM Efetivo PROJETADO — só em campanhas com bonus. Mostra onde o CPM
  // vai parar SE o ritmo atual de entrega continuar até o fim da campanha.
  // Bonus faz parte da promessa contratual, então o cliente espera ver o
  // benefício no Efetivo conforme a entrega total avança em direção a
  // contracted+bonus. A regra:
  //
  //   pacingRatio    = MIN(kpis.pac / 100, 1)   // cap em 100% (não da pra > 8M)
  //   projectedVisible = pacingRatio × (contracted + bonus)
  //   projectedCost  = projectedVisible > contracted
  //                      ? budget                              // capou (bonus rolou)
  //                      : (cpmNeg × projectedVisible) / 1000  // ainda contratado
  //   cpmEfProjected = projectedCost / projectedVisible × 1000
  //
  // Quando o pacing é tão baixo que a entrega projetada nem atinge as
  // contratadas, o resultado é cpmEf=cpmNeg (=tabela) — correto: sem
  // bonus efetivamente entregue, não há economia. Campanhas SEM bonus
  // pulam isso e mantêm o cpmEf factual do computeDisplayKpis.
  const cpmEfProjected = (() => {
    if (!bonusImps || bonusImps <= 0) return null;
    if (!contractedImps || !kpis.cpmNeg || !(kpis.pac > 0)) return null;
    const totalPromise = contractedImps + bonusImps;
    const budget = (kpis.cpmNeg * contractedImps) / 1000;
    const pacingRatio = Math.min(kpis.pac / 100, 1);
    const projectedVisible = pacingRatio * totalPromise;
    if (projectedVisible <= 0) return null;
    const projectedCost = projectedVisible > contractedImps
      ? budget
      : (kpis.cpmNeg * projectedVisible) / 1000;
    return (projectedCost / projectedVisible) * 1000;
  })();
  // A projeção só vale enquanto a entrega factual ainda NÃO realizou a
  // economia. Assim que a entrega real ultrapassa contratadas+bonus, o
  // cpmEf factual (= budget / visíveis reais) já caiu ABAIXO da projeção —
  // que fica travada em budget/(contratadas+bonus) pelo cap de pacing em
  // 100% (linha 200). Nesse ponto o factual É a verdade entregue, não uma
  // estimativa, então mostramos ele. Ex.: pacing 107,8% → factual R$9,27
  // vence a projeção capada em R$10,00.
  const useProjection =
    cpmEfProjected !== null &&
    !(kpis.cpmEf != null && kpis.cpmEf < cpmEfProjected);
  // cpmEf "renderizado" — em campanhas com bonus, sobrescreve com a
  // projeção. A economia (célula do ComparisonCard) sai da mesma fonte:
  // (tabela − efetivo projetado) / tabela, igual à antiga Rentabilidade.
  const cpmEfDisplay = useProjection ? cpmEfProjected : kpis.cpmEf;

  return (
    <div className="space-y-6">
      {/* ─── 1. Título com a frente ──────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold text-fg leading-tight">Display</h2>
        {/* Seletor de frente só com 2+ frentes (contrato ou entrega). Com
            uma só, fica o selo da frente — o conteúdo já é dela. */}
        {availableTactics.length > 1 ? (
          <SegmentedControlV2
            label="Frente Display"
            options={availableTactics}
            value={effectiveTactic}
            onChange={(t) => {
              trackCta("tactic_change_display");
              setTactic(t);
              // Filtros globais (audiência/line/...) não resetam na troca.
            }}
          />
        ) : (
          <span className="inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-[11px] font-semibold text-fg-muted">
            {availableTactics[0]?.label || effectiveTactic}
          </span>
        )}
      </div>

      {isEmpty ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center">
          <p className="text-sm text-fg-muted">
            Não há entrega Display {effectiveTactic} nesta campanha.
          </p>
        </div>
      ) : (
        <DisplayContent
          camp={camp}
          tactic={effectiveTactic}
          aggregates={aggregates}
          detailAll={detailAll}
          detailFiltered={detailFiltered}
          kpis={kpis}
          daily={daily}
          bySize={bySize}
          byCreative={byCreative}
          byAudience={byAudience}
          contractedImps={contractedImps}
          bonusImps={bonusImps}
          cpmNegBonus={cpmNegBonus}
          cpmEfDisplay={cpmEfDisplay}
          useProjection={useProjection}
          notStarted={kpis.notStarted}
          isAdmin={isAdmin}
          aud={aud}
          fmtOv={fmtOv}
          clOv={clOv}
        />
      )}
    </div>
  );
}

// Conteúdo "pesado" do Display — extraído pra fora pra evitar render
// condicional gigante dentro do componente principal e simplificar o
// fluxo de empty state.
function DisplayContent({
  camp,
  tactic,
  aggregates,
  detailAll,
  detailFiltered,
  kpis,
  daily,
  bySize,
  byCreative,
  byAudience,
  contractedImps,
  bonusImps,
  cpmNegBonus,
  cpmEfDisplay,
  useProjection,
  notStarted,
  isAdmin = false,
  aud,
  fmtOv,
  clOv,
}) {
  const campName = camp.campaign_name || "campanha";
  const isFiltered = aggregates.isFiltered;
  const viewability = kpis.impr > 0 ? (kpis.vi / kpis.impr) * 100 : null;
  const byLine = groupByLine(detailFiltered, "clicks", "viewable_impressions", "ctr");
  const contract = [
    { label: "Budget", value: fmtR(kpis.budget), hint: "Budget alocado à frente selecionada." },
    { label: "Imp. contratadas", value: fmt(contractedImps) },
    bonusImps > 0 ? { label: "Bônus", value: `${fmt(bonusImps)} imp.`, hint: "Bônus negociado além do contratado." } : null,
    bonusImps > 0 ? { label: "Total c/ bônus", value: `${fmt(contractedImps + bonusImps)} imp.`, hint: "Impressões contratadas + bonificadas." } : null,
    { label: "CPM negociado", value: fmtR(kpis.cpmNeg) },
  ].filter(Boolean);

  const dims = [
    {
      key: "audience",
      label: "Audiência",
      rows: byAudience,
      groupKey: "audience",
      itemNoun: "audiência",
      extraRows: detailAll,
      getDetailGroupKey: (r) => applyAudienceOverride(extractAudience(r.line_name), aud?.overrideMap),
      rename: aud ? {
        busy: aud.busyAudience,
        isOverridden: (row) => aud.isOverridden?.(row._rawLabels),
        rename: (row, name, scope) => aud.renameAudience(row._rawLabels, name, row.audience, scope),
        reset: (row) => aud.resetAudience(row._rawLabels, row.audience),
      } : null,
    },
    {
      key: "size",
      label: "Tamanho",
      rows: bySize,
      groupKey: "size",
      itemNoun: "tamanho",
      extraRows: detailFiltered,
      getDetailGroupKey: (r) => applyLabelOverride(r.creative_size || "N/A", fmtOv?.overrideMap),
      rename: fmtOv ? {
        busy: fmtOv.busyLabel,
        isOverridden: (row) => fmtOv.isOverridden?.(row._rawLabels),
        rename: (row, name, scope) => fmtOv.renameLabel(row._rawLabels, name, row.size, scope),
        reset: (row) => fmtOv.resetLabel(row._rawLabels, row.size),
      } : null,
    },
    {
      key: "creative",
      label: "Linha criativa",
      rows: byCreative,
      groupKey: "creative_name",
      itemNoun: "linha criativa",
      itemNounPlural: "linhas criativas",
      extraRows: detailFiltered,
      getDetailGroupKey: (r) => applyLabelOverride(getCreativeLineKey(r), clOv?.overrideMap),
      rename: clOv ? {
        busy: clOv.busyLabel,
        isOverridden: (row) => clOv.isOverridden?.(row._rawLabels),
        rename: (row, name, scope) => clOv.renameLabel(row._rawLabels, name, row.creative_name, scope),
        reset: (row) => clOv.resetLabel(row._rawLabels, row.creative_name),
      } : null,
    },
    {
      key: "line",
      label: "Line",
      rows: byLine,
      groupKey: "line_name",
      itemNoun: "line",
      extraRows: detailFiltered,
      getDetailGroupKey: (r) => r.line_name || "N/A",
      rename: null,
    },
    { key: "day", label: "Dia" },
  ];

  return (
    <>
      {/* Disclaimer "Entrega não iniciada" — contratos vendidos sem
          delivery ainda. Os valores negociados seguem visíveis. */}
      {notStarted && (
        <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 flex items-start gap-3">
          <span className="size-2 rounded-full bg-warning mt-1.5 shrink-0" aria-hidden />
          <div className="text-sm">
            <div className="font-medium text-fg">Entrega {tactic} ainda não iniciada</div>
            <div className="text-fg-muted mt-0.5">
              Exibindo apenas os valores negociados. Verifique pendências com o cliente.
            </div>
          </div>
        </div>
      )}

      {/* ─── 2. Negociado × Efetivo + contrato ───────────────────────── */}
      <ComparisonCardV2
        title={`CPM Display · ${tactic}`}
        negociado={kpis.cpmNeg}
        efetivo={cpmEfDisplay}
        negociadoComBonus={cpmNegBonus}
        efetivoIsProjection={useProjection}
        formatValue={(v) => fmtR(v)}
        unit="CPM"
        contract={contract}
      />

      {/* ─── 3. KPIs ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCardV2 label="Impressões" value={fmt(kpis.impr)} hint="Impressões medidas no período." />
        <KpiCardV2 label="Imp. visíveis" value={fmt(kpis.vi)} hint="Impressões visíveis (viewable) no período." />
        <KpiCardV2
          label="Viewability"
          value={viewability == null ? "—" : `${fmt(viewability, 1)}%`}
          hint="Imp. visíveis ÷ impressões medidas. Mostra a qualidade do inventário comprado."
        />
        <KpiCardV2 label="Cliques" value={fmt(kpis.clks)} />
        <KpiCardV2 label="CTR" value={fmtP2(kpis.ctr)} accent hint="Cliques ÷ imp. visíveis." />
        <KpiCardV2 label="CPC" value={fmtR(kpis.cpc)} hint="Custo efetivo ÷ cliques." />
      </div>

      {/* ─── 4. Pacing (ou custo do período) ─────────────────────────── */}
      {!isFiltered ? (
        <PacingBarV2
          label={`Pacing Display ${tactic}`}
          pacing={kpis.pac}
          budget={kpis.budget}
          cost={kpis.cost}
          contracted={contractedImps}
          bonus={bonusImps}
          delivered={kpis.viAll}
          showCost
        />
      ) : (
        <Card className="px-5 py-4 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Custo efetivo no período</span>
          <span className="text-lg font-bold text-fg tabular-nums">{fmtR(kpis.cost)}</span>
          <span className="w-full text-[11px] text-fg-subtle">O pacing fica oculto com filtro de período: ele mede a campanha inteira.</span>
        </Card>
      )}

      {/* ─── 5. Tendência diária ─────────────────────────────────────── */}
      {daily.length > 0 && (
        <AlignedTrendCardV2
          data={daily}
          volumeKey="viewable_impressions"
          volumeLabel="Imp. visíveis"
          rateKey="ctr"
          rateLabel="CTR"
          downloadable={isAdmin}
          filename={`${campName} - Display ${tactic} - Tendencia diaria`}
        />
      )}

      {/* ─── 6. Explorador de entrega ────────────────────────────────── */}
      {detailFiltered.length > 0 && (
        <DeliveryExplorerV2
          dims={dims}
          mediaType="DISPLAY"
          numeratorKey="clicks"
          numeratorLabel="Cliques"
          rateKey="ctr"
          rateLabel="CTR"
          rateFormatter={fmtP2}
          dailyDetail={detailFiltered}
          campaignName={campName}
          tactic={tactic}
          isAdmin={isAdmin}
        />
      )}
    </>
  );
}
