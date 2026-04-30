// src/v2/components/CampaignHeaderV2.jsx
//
// Header da campanha — redesenhado em PR-13 pra bater com o mockup.
// Hero card com:
//   - Gradient sutil (radial blue glow no canto direito)
//   - Eyebrow com nome do cliente (uppercase tracking wide + barra azul)
//   - Título grande (campaign_name) com line-clamp 2
//   - Meta: período + duração + token badge
//   - Box do logo do cliente à direita (placeholder texto se não tiver)
//   - Status pill (rodando/encerrada/futura) integrado no eyebrow
//
// Bg sólido (surface-2) + border-strong garantem contraste visual
// claro contra canvas. O glow radial vem por inline style (gradient
// arbitrário, não tem utility direta).

import { useLogoAnalysis } from "../hooks/useLogoAnalysis";
import { useTheme } from "../hooks/useTheme";

const fmtDateShort = (ymd) => {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "short",
  });
};

const daysBetween = (startStr, endStr) => {
  if (!startStr || !endStr) return null;
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  return Math.round((end - start) / 86400000) + 1;
};

function deriveStatus(startStr, endStr) {
  if (!startStr || !endStr) return { dot: "neutral", label: null };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  if (today < start) return { dot: "warning", label: "Futura" };
  if (today > end) return { dot: "neutral", label: "Encerrada" };
  return { dot: "success", label: "Rodando" };
}

export function CampaignHeaderV2({
  campaignName,
  clientName,
  logo, // data URL base64 (PNG/JPG/SVG) — opcional. Se ausente, cai no placeholder de texto
  startDate,
  endDate,
  shortToken, // ex: "UT10QW" — vai no token-badge à direita do meta
}) {
  const status = deriveStatus(startDate, endDate);
  const start = fmtDateShort(startDate);
  const end = fmtDateShort(endDate);
  const days = daysBetween(startDate, endDate);

  // Logo dinâmica entre temas com UMA única imagem
  // ──────────────────────────────────────────────
  // O sistema analisa a logo (canvas API) e classifica como:
  //   • monochrome-light / monochrome-dark → pode ser invertida sem perda
  //   • colored                            → renderiza como veio (preserva
  //                                          identidade visual da marca)
  //
  // Quando a logo monocromática conflita com o tema (ex: logo branca da
  // Nintendo no tema light), aplica-se `filter: invert(1)` via CSS — que
  // funciona em PNG, JPG, SVG, e preserva alpha (transparência fica intacta).
  //
  // Logos coloridas (Coca-Cola, Spotify, McDonald's) NUNCA são invertidas:
  // a marca é a cor, e inverter destruiria a identidade visual.
  const logoKind = useLogoAnalysis(logo);
  const [theme] = useTheme();
  const shouldInvertLogo =
    (logoKind === "monochrome-light" && theme === "light") ||
    (logoKind === "monochrome-dark" && theme === "dark");

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-border-strong bg-surface-2 p-6 md:p-8"
      aria-label="Cabeçalho da campanha"
    >
      {/* Glow radial no canto superior direito (mockup hero pattern) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at top right, var(--color-signature-glow) 0%, transparent 60%)",
        }}
      />

      <div className="relative grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6 items-start">
        <div className="min-w-0">
          {/* Eyebrow: barra azul + nome do cliente + status */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="inline-block w-6 h-0.5 rounded-full bg-signature" aria-hidden />
            <span className="text-[11px] font-bold uppercase tracking-[1.5px] text-signature">
              {clientName || "Campanha"}
            </span>
            {status.label && (
              <>
                <span className="text-fg-subtle text-xs" aria-hidden>·</span>
                <StatusPill status={status} />
              </>
            )}
          </div>

          {/* Título */}
          <h1 className="text-2xl md:text-3xl lg:text-[34px] font-extrabold text-fg leading-[1.15] tracking-[-0.7px] line-clamp-2">
            {campaignName || "Campanha sem nome"}
          </h1>

          {/* Meta: período + duração + token */}
          <div className="mt-3 flex items-center gap-3 flex-wrap text-sm text-fg-muted">
            {start && end ? (
              <span className="tabular-nums">
                {start} <span className="text-fg-subtle">→</span> {end}
              </span>
            ) : (
              <span className="text-fg-subtle">Período não definido</span>
            )}
            {days && (
              <>
                <span className="text-fg-subtle">·</span>
                <span className="tabular-nums">{days} {days === 1 ? "dia" : "dias"}</span>
              </>
            )}
            {shortToken && (
              <>
                <span className="text-fg-subtle">·</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-signature-soft border border-signature/40 text-signature text-[11px] font-bold tracking-wider">
                  <CircleIcon className="size-3" />
                  {shortToken}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Logo do cliente — img quando o admin fez upload, senão fallback
            texto com inicial estilizada.

            Container transparente: a logo flutua direto sobre o card hero
            (surface-2), sem caixa sólida preta/branca em volta. Funciona
            porque combinamos com inversão CSS quando necessário.

            Inversão automática via filter: invert(1):
              • Logo monochrome-light em tema light → inverte (vira escura)
              • Logo monochrome-dark  em tema dark  → inverte (vira clara)
              • Logo colored                        → renderiza como veio
              • Logo monochrome em tema compatível  → renderiza como veio

            Padding generoso (px-6 py-4) dá margem pra logo respirar dentro
            do espaço alocado em vez de encostar nas bordas. Sem upload e
            sem clientName cai no placeholder textual com fallback de fundo
            translúcido pra demarcar a área. */}
        {(logo || clientName) && (
          <div
            className={`hidden md:flex items-center justify-center w-44 h-20 rounded-lg overflow-hidden transition-colors ${
              logo
                ? "px-6 py-4"
                : "border border-border bg-white/[0.03] p-3"
            }`}
          >
            {logo ? (
              <img
                src={logo}
                alt={clientName ? `Logo ${clientName}` : "Logo do cliente"}
                className="max-w-full max-h-full object-contain transition-[filter] duration-200"
                style={shouldInvertLogo ? { filter: "invert(1)" } : undefined}
                loading="lazy"
              />
            ) : (
              <span className="text-fg-muted font-semibold text-sm tracking-wide truncate">
                {clientName}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function StatusPill({ status }) {
  const dotClass =
    status.dot === "success"
      ? "bg-success"
      : status.dot === "warning"
        ? "bg-warning"
        : "bg-fg-subtle";
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
      <span className={`size-1.5 rounded-full ${dotClass}`} aria-hidden />
      {status.label}
    </span>
  );
}

function CircleIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}
