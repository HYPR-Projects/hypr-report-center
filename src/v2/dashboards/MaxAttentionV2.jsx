// src/v2/dashboards/MaxAttentionV2.jsx
//
// Aba Max Attention: as peças rich media da HYPR vinculadas à campanha, com
// métricas medidas pela própria peça (via backend → Platform) e a impressão
// da DSP quando a peça está ligada ao criativo da DSP.
//
// Níveis: visão agregada (KPIs comparáveis, comparativo, empilhado diário,
// galeria por formato) → detalhe da peça (preview real, camadas Mídia /
// Peça / Widget). A peça aberta fica na URL (?piece=<id>), então o link
// compartilhado abre direto nela e o voltar do navegador funciona.
//
// Estados de borda tratados:
//   • sem peça vinculada → a aba só aparece para o admin, com "Vincular";
//   • integração não configurada → admin vê o que falta; cliente vê aviso;
//   • peça sem entrega no período → "aguardando a primeira impressão";
//   • só uma peça → abre direto no detalhe;
//   • merge de meses → peças de todos os membros juntas.

import { useEffect, useMemo, useState } from "react";
import { isDemoToken } from "../../shared/demoData";
import { ymd } from "../../shared/dateFilter";
import { fmt } from "../../shared/format";
import {
  dspDeliveryByPiece,
  formatColorSlots,
  formatLabel,
  groupByFormat,
  isWaiting,
  pieceMedia,
  relativeUpdated,
  sumMedia,
} from "../../shared/maMetrics";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/Skeleton";
import { ChipGroupV2 } from "../components/ChipGroupV2";
import { MaOverviewV2 } from "../components/ma/MaOverviewV2";
import { MaPieceDetailV2 } from "../components/ma/MaPieceDetailV2";
import { MaLinksModalV2 } from "../components/ma/MaLinksModalV2";
import { invalidateMaReport, useMaReport } from "../hooks/useMaReport";

const PIECE_PARAM = "piece";

function readPieceFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get(PIECE_PARAM) || null;
  } catch {
    return null;
  }
}

function writePieceToUrl(id) {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set(PIECE_PARAM, id);
    else url.searchParams.delete(PIECE_PARAM);
    window.history.pushState(null, "", url.toString());
  } catch {
    /* URL indisponível (SSR/teste) — segue só com o estado */
  }
}

const ERROR_TEXT = {
  not_found: "não encontrada na Platform (excluída?)",
  internal: "erro ao calcular as métricas",
  missing: "sem resposta da Platform",
};

function monthLabel(ymdStr) {
  const [y, m] = String(ymdStr || "").split("-").map(Number);
  if (!y || !m) return null;
  const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${MESES[m - 1]}/${String(y).slice(-2)}`;
}

export default function MaxAttentionV2({ token, view = null, data, range = null, isAdmin = false, adminJwt = null, onLinksChanged }) {
  const payloadLinks = data?.max_attention?.links || [];
  const { status, data: ma, error, refreshing, reload } = useMaReport({
    token,
    view,
    range,
    enabled: payloadLinks.length > 0,
    adminJwt,
  });
  const [pieceId, setPieceId] = useState(() => readPieceFromUrl());
  const [formatFilter, setFormatFilter] = useState("all");
  const [linksOpen, setLinksOpen] = useState(false);

  useEffect(() => {
    const onPop = () => setPieceId(readPieceFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openPiece = (id) => {
    setPieceId(id);
    writePieceToUrl(id);
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); }
  };
  const backToAll = () => openPiece(null);

  const rangeYmd = range?.from && range?.to ? { from: ymd(range.from), to: ymd(range.to) } : null;
  const links = ma?.links?.length ? ma.links : payloadLinks;
  const allPieces = useMemo(() => ma?.pieces || [], [ma]);
  const dsp = useMemo(
    () => dspDeliveryByPiece(links, data?.detail || [], rangeYmd),
    // rangeYmd é derivado de range; as strings bastam como dependência
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [links, data?.detail, rangeYmd?.from, rangeYmd?.to],
  );
  const medias = useMemo(() => {
    const m = new Map();
    for (const p of allPieces) m.set(p.creative_id, pieceMedia(p, dsp.get(p.creative_id)));
    return m;
  }, [allPieces, dsp]);
  // Cor por formato calculada sobre TODAS as peças vinculadas: filtrar não
  // repinta os formatos que sobram.
  const formatColors = useMemo(
    () => formatColorSlots([...links.map((l) => l.format || l.template_slug), ...allPieces.map((p) => p.format)].filter(Boolean)),
    [links, allPieces],
  );
  const groups = groupByFormat(allPieces);
  const pieces = formatFilter === "all" ? allPieces : allPieces.filter((p) => p.format === formatFilter);
  const selected = allPieces.find((p) => p.creative_id === pieceId) || (allPieces.length === 1 ? allPieces[0] : null);
  const avgEngagement = sumMedia(allPieces.filter((p) => !isWaiting(p)).map((p) => medias.get(p.creative_id))).engagement;

  const targets = useMemo(() => {
    const members = data?.merge_meta?.members || [];
    if (!members.length) return [{ token, label: token }];
    return members.map((m) => ({
      token: m.short_token,
      label: `${monthLabel(m.start_date) || m.short_token} · ${m.short_token}`,
    }));
  }, [data?.merge_meta, token]);
  const defaultTarget = (() => {
    const members = data?.merge_meta?.members || [];
    if (!members.length) return token;
    if (view && members.some((m) => m.short_token === view)) return view;
    return data?.merge_meta?.active_token || members[0].short_token;
  })();

  const onSaved = async () => {
    invalidateMaReport(token);
    await onLinksChanged?.();
    reload({ refresh: false }).catch(() => {});
  };

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-bold text-fg leading-tight">Max Attention</h2>
        <p className="text-[12px] text-fg-subtle mt-0.5">
          {links.length} {links.length === 1 ? "peça" : "peças"}
          {groups.length ? ` em ${groups.length} ${groups.length === 1 ? "formato" : "formatos"}` : ""} · métricas medidas pela própria peça
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {ma?.fetched_at && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[11px] text-fg-muted"
            title="Números principais recalculados pela Platform a cada ~15 min; o report guarda por até 10 min."
          >
            <span className={`size-1.5 rounded-full ${refreshing ? "bg-warning" : "bg-success"}`} aria-hidden />
            {refreshing ? "Atualizando…" : relativeUpdated(ma.fetched_at)}
          </span>
        )}
        {isAdmin && links.length > 0 && !isDemoToken(token) && (
          <Button variant="ghost" size="sm" onClick={() => reload({ refresh: true }).catch(() => {})} disabled={refreshing}>
            Atualizar métricas
          </Button>
        )}
        {isAdmin && (
          <Button variant="secondary" size="sm" onClick={() => setLinksOpen(true)}>
            {links.length ? "Gerenciar peças" : "Vincular peças"}
          </Button>
        )}
      </div>
    </div>
  );

  const modal = isAdmin && linksOpen ? (
    <MaLinksModalV2
      open={linksOpen}
      onOpenChange={setLinksOpen}
      targets={targets}
      defaultTarget={defaultTarget}
      adminJwt={adminJwt}
      onSaved={onSaved}
    />
  ) : null;

  // ── Estados de borda ────────────────────────────────────────────────
  if (!payloadLinks.length) {
    return (
      <div className="space-y-5">
        {header}
        <EmptyState
          title="Nenhuma peça Max Attention vinculada a esta campanha"
          body={isAdmin
            ? "Vincule as peças da Platform para a aba aparecer para o cliente. A Platform sugere pelas tags da DSP, pelo token no nome e pelo cliente; você confirma."
            : "As peças desta campanha aparecem aqui assim que forem vinculadas."}
          action={isAdmin ? <Button size="sm" onClick={() => setLinksOpen(true)}>Vincular peças</Button> : null}
        />
        {modal}
      </div>
    );
  }

  if (status === "loading" || status === "idle") {
    return (
      <div className="space-y-5">
        {header}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)}
        </div>
        <Skeleton className="h-[220px] rounded-xl" />
        <Skeleton className="h-[260px] rounded-xl" />
        {modal}
      </div>
    );
  }

  if (status === "error" || (ma && !ma.configured)) {
    const notConfigured = ma && !ma.configured;
    return (
      <div className="space-y-5">
        {header}
        <EmptyState
          title={notConfigured ? "Métricas das peças ainda não disponíveis" : "Não foi possível carregar as métricas das peças"}
          body={
            notConfigured
              ? isAdmin
                ? "A integração do report com a Platform não está configurada no backend: crie o secret MA_SERVICE_KEY no Secret Manager (mesmo valor de REPORT_CENTER_SERVICE_KEY na Platform) e rode o deploy do backend. Os vínculos já estão salvos."
                : "As métricas das peças aparecem aqui em breve."
              : isAdmin
                ? `${error?.message || "Falha na Platform"}. Tente de novo em alguns minutos.`
                : "Tente de novo em alguns minutos."
          }
          action={!notConfigured ? <Button size="sm" variant="secondary" onClick={() => reload().catch(() => {})}>Tentar de novo</Button> : null}
        />
        {modal}
      </div>
    );
  }

  const errors = ma?.errors || [];
  const errorNote = errors.length > 0 && (
    isAdmin ? (
      <div className="rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[12px] leading-snug text-fg-muted">
        <span className="font-semibold text-fg">{errors.length} {errors.length === 1 ? "peça não carregou" : "peças não carregaram"}:</span>{" "}
        {errors.map((e) => `${e.name || e.creative_id} (${ERROR_TEXT[e.error] || e.error})`).join(" · ")}. Aviso interno — o cliente vê só as peças que carregaram.
      </div>
    ) : null
  );

  if (!allPieces.length) {
    return (
      <div className="space-y-5">
        {header}
        {errorNote}
        <EmptyState
          title="Peças vinculadas ainda sem medição no período"
          body="Assim que as peças entregarem, as métricas aparecem aqui. Se você filtrou um período, tente ampliar."
        />
        {modal}
      </div>
    );
  }

  if (selected) {
    return (
      <div className="space-y-5">
        {errorNote}
        <MaPieceDetailV2
          piece={selected}
          pieces={allPieces}
          media={medias.get(selected.creative_id)}
          avgEngagement={avgEngagement}
          formatColors={formatColors}
          onSelect={openPiece}
          onBack={backToAll}
          campaignStart={data?.campaign?.start_date || null}
          isDemo={isDemoToken(token)}
          campaignName={data?.campaign?.campaign_name || "campanha"}
        />
        {isAdmin && (
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={() => setLinksOpen(true)}>Gerenciar peças</Button>
          </div>
        )}
        {modal}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {header}
      {errorNote}
      {groups.length > 1 && (
        <ChipGroupV2
          label="Filtrar por formato"
          value={formatFilter}
          onChange={setFormatFilter}
          options={[
            { value: "all", label: "Todos os formatos", count: fmt(allPieces.length) },
            ...groups.map((g) => ({ value: g.format, label: formatLabel(g.format), count: fmt(g.items.length) })),
          ]}
        />
      )}
      <MaOverviewV2
        pieces={pieces}
        medias={medias}
        formatColors={formatColors}
        onOpenPiece={openPiece}
        campaignName={data?.campaign?.campaign_name || "campanha"}
      />
      {modal}
    </div>
  );
}

function EmptyState({ title, body, action }) {
  return (
    <div className="rounded-xl border border-dashed border-border-strong bg-surface px-6 py-10 text-center">
      <div className="mx-auto max-w-[560px]">
        <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">{body}</p>
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}
