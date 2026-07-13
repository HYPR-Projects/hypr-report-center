// src/v2/dashboards/DisplayV2.jsx
//
// Dashboard Display V2 — REDESIGN PR-14
//
// Reescrita pra alinhar com o padrão visual da OverviewV2 (PR-13):
// hero ComparisonCard no topo, KPI grids contratual+performance,
// Pacing com marker "esperado hoje", tabela "Por Formato" com share
// visual, charts diários e detalhamento em collapsible fechado.
//
// LAYOUT, NA ORDEM (top → bottom)
//   1. Toolbar interna       — SegmentedControlV2 (O2O/OOH) + AudienceFilterV2
//   2. Hero ComparisonCard   — CPM Negociado vs Efetivo + economia
//   3. KPI grid contratual   — Budget · Imp Contratadas · Bonus · CPM Neg
//   4. KPI grid performance  — Imp · Visíveis · CPM Ef · Rentab · Cliques · CTR · CPC
//   5. PacingBar             — com marker "esperado hoje" (escondido sob filtro)
//   6. Charts diários        — Entrega × CTR
//   7. FormatBreakdownTable  — distribuição por creative_size com share visual
//   8. Chart Audiência       — DualChart byAudience (mantido como gráfico)
//   9. DailyAggregateTable   — agregada por dia (mediaFilter="DISPLAY")
//  10. Detalhamento por linha — collapsible FECHADO
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
import { useAudienceOverrides } from "../hooks/useAudienceOverrides";
import { useLabelOverrides } from "../hooks/useLabelOverrides";
import { fmt, fmtP, fmtP2, fmtR } from "../../shared/format";

import { Button } from "../../ui/Button";

import { useReportTrackingContext } from "../contexts/ReportTrackingContext";
import { CollapsibleSectionV2 } from "../components/CollapsibleSectionV2";
import { ComparisonCardV2 } from "../components/ComparisonCardV2";
import { DailyAggregateTableV2 } from "../components/DailyAggregateTableV2";
import { DualChartV2 } from "../components/DualChartV2";
import { ChartCardV2 } from "../components/ChartCardV2";
import { FormatBreakdownTableV2 } from "../components/FormatBreakdownTableV2";
import { KpiCardV2 } from "../components/KpiCardV2";
import { PacingBarV2 } from "../components/PacingBarV2";
import { SegmentedControlV2 } from "../components/SegmentedControlV2";

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
  const t0Display = (data.totals || [])[0] || {};
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
  // projeção. Rentabilidade segue a mesma fonte pra consistência visual
  // (Efetivo aqui vira X% melhor que Tabela = a Rentabilidade fica
  // positiva conforme o bonus rola).
  const cpmEfDisplay = useProjection ? cpmEfProjected : kpis.cpmEf;
  const rentabDisplay = useProjection && kpis.cpmNeg > 0
    ? ((kpis.cpmNeg - cpmEfProjected) / kpis.cpmNeg) * 100
    : kpis.rentab;

  return (
    <div className="space-y-6">
      {/* ─── 1. Toolbar interna ──────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        {/* Segmented O2O/OOH só renderiza se há mais de uma tactic com
            contrato ou entrega. Quando só uma frente existe, o toggle é
            ruído visual — escondemos e o conteúdo abaixo já reflete a
            tactic única via effectiveTactic. */}
        {availableTactics.length > 1 ? (
          <SegmentedControlV2
            label="Tática Display"
            options={availableTactics}
            value={effectiveTactic}
            onChange={(t) => {
              trackCta("tactic_change_display");
              setTactic(t);
              // Os filtros de audience/line/creative-line foram movidos pro
              // GlobalDataFilterBarV2 do dashboard pai (compartilhados com
              // Overview/Video). Não resetamos eles aqui — alternar O2O/OOH
              // deve preservar a seleção do usuário.
            }}
          />
        ) : (
          <div />
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
          rentabDisplay={rentabDisplay}
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
  rentabDisplay,
  useProjection,
  notStarted,
  isAdmin = false,
  aud,
  fmtOv,
  clOv,
}) {
  const campName = camp.campaign_name || "campanha";
  return (
    <>
      {/* Disclaimer "Entrega não iniciada" — pra contratos vendidos sem
          delivery ainda. Mantém os contratuais visíveis pro CS lembrar
          de destravar com o cliente. Pacing 0% reforça visualmente. */}
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

      {/* ─── 2. Hero ComparisonCard ──────────────────────────────────── */}
      <ComparisonCardV2
        title={`CPM Display · ${tactic}`}
        negociado={kpis.cpmNeg}
        efetivo={cpmEfDisplay}
        negociadoComBonus={cpmNegBonus}
        efetivoIsProjection={useProjection}
        formatValue={(v) => fmtR(v)}
      />

      {/* ─── 3. KPI grid contratual ──────────────────────────────────── */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
          Contratual
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCardV2
            outlined
            label="Budget Contratado"
            value={fmtR(kpis.budget)}
            hint="Budget alocado à tática selecionada (O2O ou OOH)."
          />
          <KpiCardV2
            outlined
            label="Imp. Contratadas"
            value={fmt(contractedImps)}
            hint="Volume de impressões contratadas para a tática."
          />
          <KpiCardV2
            outlined
            label="Imp. Bonus"
            value={fmt(bonusImps)}
            hint="Bonus negociado adicional ao contratado."
          />
          <KpiCardV2
            outlined
            label="CPM Negociado"
            value={fmtR(kpis.cpmNeg)}
            hint="CPM acordado em contrato — base do cálculo de rentabilidade."
          />
        </div>
      </section>


      {/* ─── 4. KPI grid performance ─────────────────────────────────── */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
          Performance
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <KpiCardV2 label="Impressões" value={fmt(kpis.impr)} />
          <KpiCardV2
            label="Imp. Visíveis"
            value={fmt(kpis.vi)}
            hint="Soma de viewable impressions filtradas pelo período/audiência."
          />
          <KpiCardV2
            label={useProjection ? "CPM Efetivo *" : "CPM Efetivo"}
            value={fmtR(cpmEfDisplay)}
            accent
            hint={useProjection
              ? "Projeção mantendo o ritmo atual de entrega até o fim da campanha. Considera o bonus contratado: se o pacing levar a entrega total além das impressões contratadas, o custo capa no budget e o CPM cai. Converge para o Negociado Ajustado em 100% de pacing."
              : "Custo entregue / Imp. Visíveis × 1000 — capado no negociado."}
          />
          <KpiCardV2
            label="Rentabilidade"
            value={fmtP(rentabDisplay)}
            accent
            hint={useProjection
              ? "(CPM Tabela HYPR − CPM Efetivo projetado) / CPM Tabela HYPR. Positivo = projeção indica entrega abaixo do CPM contratual graças ao bonus."
              : "(CPM Negociado − CPM Efetivo) / CPM Negociado. Positivo = a HYPR entregou mais que o contratado."}
          />
          <KpiCardV2 label="Cliques" value={fmt(kpis.clks)} />
          <KpiCardV2
            label="CTR"
            value={fmtP2(kpis.ctr)}
            hint="Cliques / Imp. Visíveis."
          />
          <KpiCardV2
            label="CPC"
            value={fmtR(kpis.cpc)}
            hint="Custo Efetivo / Cliques."
          />
          <KpiCardV2
            label="Custo Efetivo Total"
            value={fmtR(kpis.cost)}
            hint="Valor investido até o momento na tática selecionada — base do pacing."
          />
        </div>
      </section>

      {/* ─── 5. Pacing ───────────────────────────────────────────────── */}
      {!aggregates.isFiltered && (
        <PacingBarV2
          label={`Pacing Display ${tactic}`}
          pacing={kpis.pac}
          budget={kpis.budget}
          cost={kpis.cost}
          contracted={contractedImps}
          bonus={bonusImps}
          delivered={kpis.viAll}
        />
      )}

      {/* ─── 6. Chart diário (full-width) ────────────────────────────── */}
      {daily.length > 0 && (
        <section>
          <ChartCardV2
            title="Entrega × CTR Diário"
            downloadable={isAdmin}
            filename={`${campName} - Display ${tactic} - Entrega x CTR Diario`}
          >
            <DualChartV2
              data={daily}
              xKey="date"
              y1Key="viewable_impressions"
              y2Key="ctr"
              label1="Imp. Visíveis"
              label2="CTR %"
            />
          </ChartCardV2>
        </section>
      )}

      {/* ─── 7. Tabela "Por Formato" (creative_size) ─────────────────── */}
      {bySize.length > 0 && (
        <FormatBreakdownTableV2
          rows={bySize}
          groupKey="size"
          groupLabel="Tamanho"
          denomKey="viewable_impressions"
          denomLabel="Imp. Visíveis"
          numeratorKey="clicks"
          numeratorLabel="Cliques"
          rateKey="ctr"
          rateLabel="CTR"
          rateFormatter={fmtP2}
          extraRows={detailFiltered}
          getDetailGroupKey={(r) => applyLabelOverride(r.creative_size || "N/A", fmtOv?.overrideMap)}
          mediaType="DISPLAY"
          downloadable={isAdmin}
          filename={`${campName} - Display ${tactic} - Por Tamanho`}
          editable={isAdmin}
          busyAudience={fmtOv?.busyLabel}
          isRowOverridden={(row) => fmtOv?.isOverridden?.(row._rawLabels)}
          onRenameGroup={(row, name, scope) => fmtOv?.renameLabel(row._rawLabels, name, row.size, scope)}
          onResetGroup={(row) => fmtOv?.resetLabel(row._rawLabels, row.size)}
        />
      )}

      {/* ─── 7b. Tabela "Por Linha Criativa" (creative_name menos o size) ─ */}
      {byCreative.length > 0 && (
        <FormatBreakdownTableV2
          rows={byCreative}
          groupKey="creative_name"
          groupLabel="Linha Criativa"
          itemNoun="linha criativa"
          itemNounPlural="linhas criativas"
          denomKey="viewable_impressions"
          denomLabel="Imp. Visíveis"
          numeratorKey="clicks"
          numeratorLabel="Cliques"
          rateKey="ctr"
          rateLabel="CTR"
          rateFormatter={fmtP2}
          extraRows={detailFiltered}
          getDetailGroupKey={(r) => applyLabelOverride(getCreativeLineKey(r), clOv?.overrideMap)}
          mediaType="DISPLAY"
          downloadable={isAdmin}
          filename={`${campName} - Display ${tactic} - Por Linha Criativa`}
          editable={isAdmin}
          busyAudience={clOv?.busyLabel}
          isRowOverridden={(row) => clOv?.isOverridden?.(row._rawLabels)}
          onRenameGroup={(row, name, scope) => clOv?.renameLabel(row._rawLabels, name, row.creative_name, scope)}
          onResetGroup={(row) => clOv?.resetLabel(row._rawLabels, row.creative_name)}
        />
      )}

      {/* ─── 8. Chart de Audiência (mantido como gráfico) ────────────── */}
      {byAudience.length > 0 && (
        <section>
          <ChartCardV2
            title="Entrega × CTR por Audiência"
            downloadable={isAdmin}
            filename={`${campName} - Display ${tactic} - Entrega x CTR por Audiencia`}
          >
            <DualChartV2
              data={byAudience}
              xKey="audience"
              y1Key="viewable_impressions"
              y2Key="ctr"
              label1="Imp. Visíveis"
              label2="CTR %"
            />
          </ChartCardV2>
        </section>
      )}

      {/* ─── 8b. Tabela "Por Audiência" ──────────────────────────────────
          Mesmo estilo da tabela "Por Formato": share visual, métricas
          alinhadas, ordenação por share. Espelha a visão do gráfico
          acima — sempre mostra TODAS as audiências (detailAll), igual
          ao DualChart, ignorando o filtro de audience selecionada.
          extractAudience() resolve a chave de cada detail row pra
          casar com r.audience das rows agrupadas.
      */}
      {byAudience.length > 0 && (
        <FormatBreakdownTableV2
          rows={byAudience}
          groupKey="audience"
          groupLabel="Audiência"
          itemNoun="audiência"
          denomKey="viewable_impressions"
          denomLabel="Imp. Visíveis"
          numeratorKey="clicks"
          numeratorLabel="Cliques"
          rateKey="ctr"
          rateLabel="CTR"
          rateFormatter={fmtP2}
          extraRows={detailAll}
          getDetailGroupKey={(r) => applyAudienceOverride(extractAudience(r.line_name), aud?.overrideMap)}
          mediaType="DISPLAY"
          downloadable={isAdmin}
          filename={`${campName} - Display ${tactic} - Por Audiencia`}
          editable={isAdmin}
          busyAudience={aud?.busyAudience}
          isRowOverridden={(row) => aud?.isOverridden?.(row._rawLabels)}
          onRenameGroup={(row, name, scope) => aud?.renameAudience(row._rawLabels, name, row.audience, scope)}
          onResetGroup={(row) => aud?.resetAudience(row._rawLabels, row.audience)}
        />
      )}

      {/* ─── 9. Tabela "Por Dia" agregada ────────────────────────────── */}
      {detailFiltered.length > 0 && (
        <CollapsibleSectionV2 title="Entrega Agregada por Dia" defaultOpen>
          <DailyAggregateTableV2
            daily={detailFiltered}
            campaignName={`${camp.campaign_name || "campanha"}_display_${tactic}`}
            lockedMedia="DISPLAY"
            downloadable={isAdmin}
          />
        </CollapsibleSectionV2>
      )}
    </>
  );
}
