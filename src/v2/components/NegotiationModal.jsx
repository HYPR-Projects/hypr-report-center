// src/v2/components/NegotiationModal.jsx
//
// Modal centralizado — resumo da negociação da campanha vinda do Sales
// Center (`hypr_sales_center.checklists`). Aparece quando o user clica no
// botão "Negociado" do CampaignHeaderV2. Render condicional: só monta
// quando `negotiation` é truthy (campanhas pré-Sales Center ficam sem o
// botão).
//
// Layout (top → bottom):
//   1. Eyebrow — "RESUMO DA NEGOCIAÇÃO"
//   2. Hero — agência · tipo · vertical · período (badges/meta)
//   3. Plano comercial — investimento (destaque) + CPM + CPCV
//   4. Formatos e produtos — chips
//   5. Volumes — O2O contratado/bonus (Sales Center) + OOH/breakdown opcional
//      do checklist_info legacy (passado via `legacyTotals`)
//   6. Features ativadas — chips do extras.cl_features (+ tipo + volume)
//   7. Audiências — texto livre formatado
//   8. Praças — pracas_type + pracas_detail
//   9. Estudos usados — selected_studies do extras
//  10. Documentos — PI, peças, proposta, ooh_link (botões com link externo)
//  11. Times — CP, CS, submitted_by (avatar inicial)
//
// Cada seção fica oculta quando vazia — mantém o card limpo pra
// campanhas com cadastro parcial.

import * as Dialog from "@radix-ui/react-dialog";
import { useMemo } from "react";
import { cn } from "../../ui/cn";

// ─── Formatters ─────────────────────────────────────────────────────────

const fmtBRL = (n) => {
  if (n == null || isNaN(n)) return null;
  return n.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
};

const fmtBRLPrecise = (n) => {
  if (n == null || isNaN(n)) return null;
  return n.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const fmtNum = (n) => {
  if (n == null || isNaN(n)) return null;
  return n.toLocaleString("pt-BR");
};

const fmtDateLong = (ymd) => {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

// ─── Parsers ────────────────────────────────────────────────────────────

function parseExtras(json) {
  if (!json) return {};
  try {
    return JSON.parse(json) || {};
  } catch {
    return {};
  }
}

// Extras carrega features e detalhes numa estrutura sui generis:
//   cl_features: ["P-DOOH", "Survey"]                    → lista
//   fv_<feat>_<metric>: "10000"                          → volume
//   fvol_type_<feat>: "contratada"|"bonificada"          → tipo
//   ftext_<feat>: "..."                                  → texto livre
function deriveFeatures(extras) {
  const list = Array.isArray(extras.cl_features) ? extras.cl_features : [];
  return list.map((name) => {
    const volumes = [];
    const prefix = `fv_${name}_`;
    for (const k of Object.keys(extras)) {
      if (k.startsWith(prefix)) {
        volumes.push({
          metric: k.slice(prefix.length),
          value: extras[k],
        });
      }
    }
    return {
      name,
      type: extras[`fvol_type_${name}`] || null,
      text: extras[`ftext_${name}`] || null,
      volumes,
    };
  });
}

// `selected_studies`: [{name, link, status, delivery, cs, date}]
function deriveStudies(extras) {
  return Array.isArray(extras.selected_studies) ? extras.selected_studies : [];
}

// ─── Detecção de "ativado" no report ───────────────────────────────────
//
// Recebemos o payload do report (`data`) e descobrimos, para cada item
// negociado, se há entrega real OU cadastro paralelo correspondente.
// Resultado vira a pílula verde "Ativado" / cinza "Pendente" no card.

// Features com slot dedicado no payload (admin cadastra explicitamente).
// Match por keyword no nome — case-insensitive — pra pegar variações
// ("P-DOOH", "PDOOH", "Brand Lift" → Survey).
const FEATURE_PAYLOAD_KEY = [
  { match: /survey|brand\s*lift/i,    key: "survey" },
  { match: /loom/i,                   key: "loom" },
  { match: /^p[-\s]?dooh$|pdooh/i,    key: "pdooh" },
  { match: /rmnd|amazon/i,            key: "rmnd" },
];

// Constrói uma string única com line_name + creative_name de todas as
// rows (totals + detail) — usada pra grep de features que vivem no nome
// da line/criativo (ex: "Topics", "Tap to Go", "Downloaded Apps").
function buildLineHaystack(reportData) {
  if (!reportData) return "";
  const rows = [
    ...(reportData.totals || []),
    ...(reportData.detail || []),
  ];
  return rows
    .map((r) => `${r?.line_name || ""} ${r?.creative_name || ""}`)
    .join(" ")
    .toLowerCase();
}

function detectFeatureActive(featureName, reportData, haystack) {
  if (!reportData || !featureName) return false;
  const lower = featureName.toLowerCase().trim();

  // Tier 1: feature tem slot dedicado no payload?
  for (const { match, key } of FEATURE_PAYLOAD_KEY) {
    if (match.test(featureName)) return !!reportData[key];
  }

  // Tier 2: grep no haystack (line_name + creative_name).
  if (!haystack) return false;
  // Variantes pra cobrir convenções de naming:
  //   "Tap to Go" → também "tap_to_go", "taptogo", "tapto_go"
  const variants = new Set([
    lower,
    lower.replace(/\s+/g, "_"),
    lower.replace(/\s+/g, ""),
    lower.replace(/\s+/g, "-"),
  ]);
  for (const v of variants) {
    if (v && haystack.includes(v)) return true;
  }
  return false;
}

// O2O / OOH "ativado" = há ao menos uma row de delivery com aquela
// tactic_type. Sem delivery ainda = pendente (campanha brand-new ou
// frente que não rodou).
function detectTacticActive(tactic, reportData) {
  if (!reportData) return false;
  return (reportData.totals || []).some((r) => r.tactic_type === tactic) ||
         (reportData.detail || []).some((r) => r.tactic_type === tactic);
}

// ─── Componente principal ───────────────────────────────────────────────

export function NegotiationModal({ open, onOpenChange, negotiation, legacyTotals, reportData }) {
  const extras = useMemo(() => parseExtras(negotiation?.extras), [negotiation]);
  const features = useMemo(() => deriveFeatures(extras), [extras]);
  const studies = useMemo(() => deriveStudies(extras), [extras]);
  // Haystack de nomes de line/criativo — usado pelos detectores de
  // feature. Pré-computado uma vez por payload pra não rodar n vezes.
  const lineHaystack = useMemo(() => buildLineHaystack(reportData), [reportData]);

  if (!negotiation) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-40 bg-black/60 backdrop-blur-[3px]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "duration-200",
          )}
        />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50",
            "-translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-32px)] max-w-[720px]",
            "max-h-[calc(100vh-48px)] overflow-hidden",
            "rounded-2xl border border-border-strong bg-canvas-elevated shadow-2xl",
            "flex flex-col outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            "duration-200",
          )}
        >
          <NegotiationHeader negotiation={negotiation} />
          <div className="flex-1 overflow-y-auto px-6 md:px-8 pb-8 pt-6 space-y-6">
            <CommercialPlan negotiation={negotiation} />
            <FormatsAndProducts negotiation={negotiation} />
            <Volumes
              negotiation={negotiation}
              legacyTotals={legacyTotals}
              extras={extras}
              reportData={reportData}
            />
            <FeaturesGrid features={features} reportData={reportData} lineHaystack={lineHaystack} />
            <Audiences negotiation={negotiation} />
            <Pracas negotiation={negotiation} extras={extras} />
            <Studies studies={studies} />
            <Documents negotiation={negotiation} />
            <People negotiation={negotiation} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Header (sticky topo do modal) ──────────────────────────────────────
function NegotiationHeader({ negotiation }) {
  const start = fmtDateLong(negotiation.start_date);
  const end = fmtDateLong(negotiation.end_date);
  return (
    <div className="px-6 md:px-8 pt-6 pb-5 border-b border-border bg-surface-2/60 relative">
      {/* Glow sutil pra dar peso visual no topo do modal — mesma linguagem
          do hero do dashboard */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at top right, var(--color-signature-glow) 0%, transparent 70%)",
        }}
      />
      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-block w-6 h-0.5 rounded-full bg-signature" aria-hidden />
            <Dialog.Title asChild>
              <span className="text-[10.5px] font-bold uppercase tracking-[1.5px] text-signature">
                Resumo da Negociação
              </span>
            </Dialog.Title>
          </div>
          <h2 className="text-xl md:text-2xl font-bold text-fg leading-tight tracking-[-0.4px] line-clamp-2">
            {negotiation.campaign_name || "Campanha"}
          </h2>
          <Dialog.Description asChild>
            <div className="mt-2 flex items-center gap-2 flex-wrap text-[12.5px] text-fg-muted">
              {negotiation.client && (
                <span className="font-medium">{negotiation.client}</span>
              )}
              {negotiation.agency && (
                <>
                  <span className="text-fg-subtle">·</span>
                  <span>{negotiation.agency}</span>
                </>
              )}
              {negotiation.industry && (
                <>
                  <span className="text-fg-subtle">·</span>
                  <Pill>{negotiation.industry}</Pill>
                </>
              )}
              {negotiation.campaign_type && (
                <Pill tone="signature">{negotiation.campaign_type}</Pill>
              )}
            </div>
          </Dialog.Description>
          {(start || end) && (
            <div className="mt-2.5 text-[12.5px] text-fg-muted tabular-nums">
              {start} <span className="text-fg-subtle">→</span> {end}
            </div>
          )}
        </div>
        <Dialog.Close
          aria-label="Fechar"
          className={cn(
            "shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-md",
            "text-fg-muted hover:text-fg hover:bg-surface",
            "transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
          )}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </Dialog.Close>
      </div>
    </div>
  );
}

// ─── Plano comercial ───────────────────────────────────────────────────
function CommercialPlan({ negotiation }) {
  const investment = fmtBRL(negotiation.investment);
  const cpm = fmtBRLPrecise(negotiation.cpm);
  const cpcv = fmtBRLPrecise(negotiation.cpcv);

  if (!investment && !cpm && !cpcv) return null;

  return (
    <Section title="Plano comercial" eyebrow={null}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {investment && (
          <Stat
            label="Investimento total"
            value={investment}
            emphasis
          />
        )}
        {cpm && <Stat label="CPM negociado" value={cpm} />}
        {cpcv && <Stat label="CPCV negociado" value={cpcv} />}
      </div>
    </Section>
  );
}

// ─── Formatos / Produtos ───────────────────────────────────────────────
function FormatsAndProducts({ negotiation }) {
  const formats = (negotiation.formats || []).filter(Boolean);
  const products = (negotiation.products || []).filter(Boolean);
  const marketplaces = (negotiation.marketplaces || []).filter(Boolean);

  if (!formats.length && !products.length && !marketplaces.length) return null;

  return (
    <Section title="Formatos e produtos">
      <div className="space-y-3">
        {formats.length > 0 && (
          <ChipRow label="Formatos" items={formats} tone="signature" />
        )}
        {products.length > 0 && (
          <ChipRow label="Produtos" items={products} />
        )}
        {marketplaces.length > 0 && (
          <ChipRow label="Marketplaces" items={marketplaces} />
        )}
      </div>
    </Section>
  );
}

// ─── Volumes contratados ───────────────────────────────────────────────
function Volumes({ negotiation, legacyTotals, extras, reportData }) {
  const o2oDisp = negotiation.o2o_impressoes ?? 0;
  const o2oVid = negotiation.o2o_views ?? 0;
  const o2oDispBonus = negotiation.bonus_o2o_impressoes ?? 0;
  const o2oVidBonus = negotiation.bonus_o2o_views ?? 0;

  // OOH no Sales Center vive em extras.OOH_imp + ooh_link (planilha externa).
  // Tentamos a chave conhecida e caímos no checklist_info legacy se vazio.
  const oohImpFromExtras = Number(extras?.OOH_imp || 0) || 0;

  const lt = legacyTotals || {};
  const legacyO2ODisp = lt.contracted_o2o_display_impressions || 0;
  const legacyO2OVid = lt.contracted_o2o_video_completions || 0;
  const legacyOOHDisp = lt.contracted_ooh_display_impressions || 0;
  const legacyOOHVid = lt.contracted_ooh_video_completions || 0;
  const legacyO2ODispBonus = lt.bonus_o2o_display_impressions || 0;
  const legacyO2OVidBonus = lt.bonus_o2o_video_completions || 0;
  const legacyOOHDispBonus = lt.bonus_ooh_display_impressions || 0;
  const legacyOOHVidBonus = lt.bonus_ooh_video_completions || 0;

  // Fonte de verdade: Sales Center quando tem volume; fallback no legacy
  // pra completar OOH (que o Sales Center não armazena em colunas próprias).
  const o2oDisplayContracted = o2oDisp || legacyO2ODisp;
  const o2oDisplayBonus = o2oDispBonus || legacyO2ODispBonus;
  const o2oVideoContracted = o2oVid || legacyO2OVid;
  const o2oVideoBonus = o2oVidBonus || legacyO2OVidBonus;
  const oohDisplayContracted = oohImpFromExtras || legacyOOHDisp;
  const oohDisplayBonus = legacyOOHDispBonus;
  const oohVideoContracted = legacyOOHVid;
  const oohVideoBonus = legacyOOHVidBonus;

  const hasO2O = !!(o2oDisplayContracted || o2oDisplayBonus || o2oVideoContracted || o2oVideoBonus);
  const hasOOH = !!(oohDisplayContracted || oohDisplayBonus || oohVideoContracted || oohVideoBonus);

  if (!hasO2O && !hasOOH) return null;

  const o2oActive = detectTacticActive("O2O", reportData);
  const oohActive = detectTacticActive("OOH", reportData);

  return (
    <Section title="Volumes contratados">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {hasO2O && (
          <VolumeCard
            tactic="O2O"
            active={o2oActive}
            displayContracted={o2oDisplayContracted}
            displayBonus={o2oDisplayBonus}
            videoContracted={o2oVideoContracted}
            videoBonus={o2oVideoBonus}
          />
        )}
        {hasOOH && (
          <VolumeCard
            tactic="OOH"
            active={oohActive}
            displayContracted={oohDisplayContracted}
            displayBonus={oohDisplayBonus}
            videoContracted={oohVideoContracted}
            videoBonus={oohVideoBonus}
          />
        )}
      </div>
    </Section>
  );
}

function VolumeCard({ tactic, active, displayContracted, displayBonus, videoContracted, videoBonus }) {
  const hasDisplay = !!(displayContracted || displayBonus);
  const hasVideo = !!(videoContracted || videoBonus);
  return (
    <div className="h-full rounded-xl border border-border bg-surface-2 px-4 py-3.5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-signature">
          {tactic}
        </span>
        <StatusPill active={active} />
      </div>
      <div className="space-y-2.5">
        {hasDisplay && (
          <VolumeLine label="Display" contracted={displayContracted} bonus={displayBonus} unit="imp." />
        )}
        {hasVideo && (
          <VolumeLine label="Video" contracted={videoContracted} bonus={videoBonus} unit="completions" />
        )}
      </div>
    </div>
  );
}

function VolumeLine({ label, contracted, bonus, unit }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="text-fg font-semibold tabular-nums">
        {fmtNum(contracted) || "0"}
        <span className="text-fg-subtle font-normal text-xs ml-1">{unit}</span>
        {bonus > 0 && (
          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-warning-soft text-warning border border-warning/30">
            + {fmtNum(bonus)} bônus
          </span>
        )}
      </span>
    </div>
  );
}

// ─── Features ativadas ─────────────────────────────────────────────────
function FeaturesGrid({ features, reportData, lineHaystack }) {
  if (!features.length) return null;
  return (
    <Section title="Features ativadas">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 items-stretch">
        {features.map((f) => (
          <FeatureCard
            key={f.name}
            feature={f}
            active={detectFeatureActive(f.name, reportData, lineHaystack)}
          />
        ))}
      </div>
    </Section>
  );
}

function FeatureCard({ feature: f, active }) {
  // `ftext_<feature>` ocasionalmente carrega URL (ex: link da Survey).
  // Detectamos e renderizamos como link clicável com `break-all` pra
  // não estourar a largura do card. Texto comum vai num <p> normal.
  const textIsLink = f.text && /^https?:\/\//i.test(f.text.trim());
  return (
    <div className="h-full rounded-xl border border-border bg-surface-2 px-4 py-3.5 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg leading-tight">{f.name}</div>
          {f.type && (
            <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
              {f.type}
            </div>
          )}
        </div>
        <StatusPill active={active} />
      </div>
      {f.volumes.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-fg-muted">
          {f.volumes.map((v) => (
            <span key={v.metric} className="tabular-nums">
              <span className="text-fg-subtle">{v.metric}:</span>{" "}
              <span className="font-medium text-fg">{fmtNum(Number(v.value)) || v.value}</span>
            </span>
          ))}
        </div>
      )}
      {f.text && textIsLink && (
        <a
          href={f.text.trim()}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "inline-flex items-center gap-1.5 self-start mt-auto",
            "text-[11px] font-semibold text-signature hover:text-signature-hover",
            "underline decoration-signature/40 hover:decoration-signature underline-offset-2",
            "transition-colors max-w-full break-all",
          )}
        >
          <ExternalLinkIcon className="size-3 shrink-0" />
          <span className="truncate">Abrir link</span>
        </a>
      )}
      {f.text && !textIsLink && (
        <p className="text-[11.5px] text-fg-subtle leading-relaxed break-words">{f.text}</p>
      )}
    </div>
  );
}

// ─── Audiências ────────────────────────────────────────────────────────
function Audiences({ negotiation }) {
  const aud = (negotiation.audiences || "").trim();
  if (!aud) return null;

  // Heurística: se tiver " + ", quebra em itens (formato comum de
  // anotação). Senão, renderiza o bloco inteiro com whitespace-pre-line.
  const items = aud.includes(" + ") ? aud.split(/\s\+\s/).map((s) => s.trim()) : null;

  return (
    <Section title="Audiências">
      {items && items.length > 1 ? (
        <ul className="space-y-1.5">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-fg-muted">
              <span className="text-signature select-none mt-0.5">•</span>
              <span className="whitespace-pre-line">{it}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] leading-relaxed text-fg-muted whitespace-pre-line">{aud}</p>
      )}
    </Section>
  );
}

// ─── Praças (geo OOH) ──────────────────────────────────────────────────
function Pracas({ negotiation, extras }) {
  const type = negotiation.pracas_type || extras?.["praças_type"] || null;
  const detail = negotiation.pracas_detail || null;
  const states = Array.isArray(extras?.["praças_states"]) ? extras["praças_states"] : [];
  const cities = Array.isArray(extras?.["praças_cities"]) ? extras["praças_cities"] : [];

  if (!type && !detail && !states.length && !cities.length) return null;

  return (
    <Section title="Praças">
      <div className="rounded-xl border border-border bg-surface-2 px-4 py-3.5 space-y-2 text-[13px]">
        {type && (
          <Row label="Cobertura" value={type} />
        )}
        {detail && (
          <Row label="Detalhe" value={detail} />
        )}
        {states.length > 0 && (
          <Row
            label="Estados"
            value={
              <div className="flex flex-wrap gap-1.5">
                {states.map((s) => (
                  <Pill key={s}>{s}</Pill>
                ))}
              </div>
            }
          />
        )}
        {cities.length > 0 && (
          <Row
            label="Cidades"
            value={
              <div className="flex flex-wrap gap-1.5">
                {cities.map((c) => (
                  <Pill key={c}>{c}</Pill>
                ))}
              </div>
            }
          />
        )}
      </div>
    </Section>
  );
}

// ─── Estudos usados ───────────────────────────────────────────────────
function Studies({ studies }) {
  if (!studies.length) return null;
  return (
    <Section title="Estudos usados">
      <div className="space-y-2">
        {studies.map((s, i) => (
          <a
            key={i}
            href={s.link}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "block rounded-xl border border-border bg-surface-2 px-4 py-3.5",
              "hover:border-signature/50 hover:bg-surface-3 transition-colors group",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-fg truncate group-hover:text-signature transition-colors">
                  {s.name || "Estudo"}
                </div>
                <div className="text-[11.5px] text-fg-muted mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  {s.cs && <span>{s.cs}</span>}
                  {s.delivery && (
                    <span className="text-fg-subtle">entrega {s.delivery}</span>
                  )}
                  {s.date && (
                    <span className="text-fg-subtle">{s.date}</span>
                  )}
                </div>
              </div>
              {s.status && (
                <span
                  className={cn(
                    "shrink-0 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded",
                    s.status === "Feito"
                      ? "bg-success-soft text-success border border-success/30"
                      : "bg-signature-soft text-signature border border-signature/30",
                  )}
                >
                  {s.status}
                </span>
              )}
            </div>
          </a>
        ))}
      </div>
    </Section>
  );
}

// ─── Documentos (PI / peças / proposta) ────────────────────────────────
function Documents({ negotiation }) {
  const docs = [
    {
      label: "Pedido de Inserção",
      sub: "PI",
      url: negotiation.pi_link,
      icon: <DocIcon />,
    },
    {
      label: "Peças",
      sub: "Criativos",
      url: negotiation.pecas_link,
      icon: <ImageIcon />,
    },
    {
      label: "Proposta",
      sub: "Comercial",
      url: negotiation.proposta_link,
      icon: <PresentationIcon />,
    },
    {
      label: "Plano OOH",
      sub: "Praças",
      url: negotiation.ooh_link,
      icon: <MapIcon />,
    },
  ].filter((d) => d.url && isLink(d.url));

  if (!docs.length) {
    // Quando tem texto não-URL no pi_link (ex: "JA FATURADO"), mostra como
    // status. Edge case real visto na base.
    if (negotiation.pi_link && !isLink(negotiation.pi_link)) {
      return (
        <Section title="Documentos">
          <div className="rounded-xl border border-border bg-surface-2 px-4 py-3.5 text-[13px] text-fg-muted">
            <span className="text-fg-subtle mr-2">PI:</span>
            <span className="font-semibold text-fg uppercase tracking-wide text-xs">
              {negotiation.pi_link}
            </span>
          </div>
        </Section>
      );
    }
    return null;
  }

  return (
    <Section title="Documentos">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {docs.map((d) => (
          <a
            key={d.label}
            href={d.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3.5",
              "hover:border-signature/50 hover:bg-surface-3 transition-colors group",
            )}
          >
            <span
              className={cn(
                "shrink-0 inline-flex items-center justify-center size-9 rounded-md",
                "bg-signature-soft text-signature border border-signature/30",
              )}
              aria-hidden
            >
              {d.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-fg truncate group-hover:text-signature transition-colors">
                {d.label}
              </div>
              <div className="text-[11px] text-fg-subtle uppercase tracking-wider font-medium">
                {d.sub}
              </div>
            </div>
            <ExternalLinkIcon className="shrink-0 size-3.5 text-fg-subtle group-hover:text-signature transition-colors" />
          </a>
        ))}
      </div>
    </Section>
  );
}

function isLink(s) {
  if (!s || typeof s !== "string") return false;
  return /^https?:\/\//i.test(s.trim());
}

// ─── Times (CP / CS) ───────────────────────────────────────────────────
function People({ negotiation }) {
  const cp = negotiation.cp_name || negotiation.cp_email;
  const cs = negotiation.cs_name || negotiation.cs_email;
  const submitter = negotiation.submitted_by || negotiation.submitted_by_email;

  if (!cp && !cs && !submitter) return null;

  return (
    <Section title="Time">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        {cp && <Person role="CP / Vendedor" name={negotiation.cp_name} email={negotiation.cp_email} />}
        {cs && <Person role="CS" name={negotiation.cs_name} email={negotiation.cs_email} />}
        {submitter && submitter !== cp && submitter !== cs && (
          <Person role="Cadastrado por" name={negotiation.submitted_by} email={negotiation.submitted_by_email} />
        )}
      </div>
    </Section>
  );
}

function Person({ role, name, email }) {
  const display = name || email || "—";
  const initial = (display.match(/\S/) || ["?"])[0].toUpperCase();
  return (
    <div className="rounded-xl border border-border bg-surface-2 px-4 py-3.5 flex items-center gap-3">
      <span
        className={cn(
          "shrink-0 inline-flex items-center justify-center size-9 rounded-full",
          "bg-signature-soft text-signature font-bold text-sm border border-signature/30",
        )}
        aria-hidden
      >
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-bold uppercase tracking-[1.5px] text-fg-subtle">
          {role}
        </div>
        <div className="text-sm font-semibold text-fg truncate">{name || email}</div>
        {name && email && (
          <div className="text-[11px] text-fg-subtle truncate">{email}</div>
        )}
      </div>
    </div>
  );
}

// ─── Building blocks ────────────────────────────────────────────────────
function Section({ title, eyebrow, children }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-block w-3 h-px rounded-full bg-signature" aria-hidden />
        <h3 className="text-[10.5px] font-bold uppercase tracking-[1.5px] text-fg-muted">
          {title}
        </h3>
      </div>
      {eyebrow && <div className="mb-3 text-xs text-fg-subtle">{eyebrow}</div>}
      {children}
    </div>
  );
}

function Stat({ label, value, emphasis }) {
  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3.5 transition-colors",
        emphasis
          ? "border-signature/40 bg-signature-soft"
          : "border-border bg-surface-2",
      )}
    >
      <div
        className={cn(
          "text-[10px] font-bold uppercase tracking-[1.5px]",
          emphasis ? "text-signature" : "text-fg-subtle",
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          "mt-1.5 tabular-nums font-bold",
          emphasis ? "text-fg text-xl" : "text-fg text-base",
        )}
      >
        {value}
      </div>
    </div>
  );
}

// Pílula de status — verde "Ativado" se a feature/tactic foi detectada
// no payload do report, cinza "Pendente" caso contrário. Decisão visual:
// success-soft sólido pro ativo (chama atenção positiva); cinza neutro
// pro pendente (não compete visualmente com bonificada/contratada nem
// gera ansiedade — é só "ainda não").
function StatusPill({ active }) {
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded",
        "text-[9.5px] font-bold uppercase tracking-wider border",
        active
          ? "bg-success-soft text-success border-success/30"
          : "bg-canvas-deeper text-fg-subtle border-border",
      )}
      title={active ? "Detectado no report" : "Ainda não detectado no report"}
    >
      <span
        className={cn("size-1.5 rounded-full", active ? "bg-success" : "bg-fg-subtle")}
        aria-hidden
      />
      {active ? "Ativado" : "Pendente"}
    </span>
  );
}

function Pill({ children, tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-[10.5px] font-semibold border",
        tone === "signature"
          ? "bg-signature-soft text-signature border-signature/30"
          : "bg-surface text-fg-muted border-border",
      )}
    >
      {children}
    </span>
  );
}

function ChipRow({ label, items, tone }) {
  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <span className="text-[10.5px] font-bold uppercase tracking-[1.5px] text-fg-subtle min-w-[88px]">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => (
          <Pill key={it} tone={tone}>
            {it}
          </Pill>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <span className="text-[10.5px] font-bold uppercase tracking-[1.5px] text-fg-subtle min-w-[80px]">
        {label}
      </span>
      <div className="flex-1 text-fg">
        {typeof value === "string" ? <span>{value}</span> : value}
      </div>
    </div>
  );
}

// ─── Icons ─────────────────────────────────────────────────────────────

function DocIcon({ className }) {
  return (
    <svg
      className={cn("size-4", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </svg>
  );
}

function ImageIcon({ className }) {
  return (
    <svg
      className={cn("size-4", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

function PresentationIcon({ className }) {
  return (
    <svg
      className={cn("size-4", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 3h20" />
      <path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3" />
      <path d="M8 21l4-5 4 5" />
      <line x1="12" y1="16" x2="12" y2="21" />
    </svg>
  );
}

function MapIcon({ className }) {
  return (
    <svg
      className={cn("size-4", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function ExternalLinkIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
