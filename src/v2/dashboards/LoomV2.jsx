// src/v2/dashboards/LoomV2.jsx
//
// Tab "VIDEO LOOM" V2 — exibe vídeo explicativo da campanha (gravado pela
// equipe HYPR) num iframe responsivo com aspect ratio 16:9.
//
// Reescrita do LoomTab Legacy (src/components/dashboard-tabs/LoomTab.jsx)
// pra usar tokens V2 em vez de cores inline da paleta antiga, e dialect
// Tailwind v4 em vez de inline styles.
//
// EMBED LOOM
//   URL pública (compartilhamento): https://www.loom.com/share/{id}
//   URL embed (iframe):              https://www.loom.com/embed/{id}
//   `parseLoomEmbedUrl` valida o domínio e extrai o id — se vier qualquer
//   coisa que não bata com loom.com/(share|embed)/{id}, devolve null e o
//   tab mostra placeholder de URL inválida em vez de embeddar URL crua
//   (admin já registrou caso onde foi salvo o link do próprio report,
//   resultando em dashboard renderizando recursivo dentro do iframe).

import { Card } from "../../ui/Card";

const LOOM_URL_RE = /^https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([a-zA-Z0-9]+)/i;

function parseLoomEmbedUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const match = rawUrl.trim().match(LOOM_URL_RE);
  if (!match) return null;
  return `https://www.loom.com/embed/${match[1]}`;
}

export default function LoomV2({ loomUrl }) {
  // Sem vídeo cadastrado — placeholder explicativo
  if (!loomUrl) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-20">
        <FilmIcon className="size-12 text-fg-subtle mb-4" />
        <h3 className="text-base font-semibold text-fg mb-2">
          Nenhum vídeo disponível ainda
        </h3>
        <p className="text-sm text-fg-muted max-w-md">
          O vídeo explicativo será adicionado em breve pela equipe HYPR.
        </p>
      </div>
    );
  }

  const embedUrl = parseLoomEmbedUrl(loomUrl);

  // URL cadastrada não é do Loom — mostra placeholder em vez de embeddar
  // URL arbitrária (ver comentário no topo do arquivo).
  if (!embedUrl) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-20">
        <FilmIcon className="size-12 text-fg-subtle mb-4" />
        <h3 className="text-base font-semibold text-fg mb-2">
          Link do Loom inválido
        </h3>
        <p className="text-sm text-fg-muted max-w-md">
          A URL cadastrada não parece ser de um vídeo do Loom. Esperado:
          <span className="block mt-1 font-mono text-[11px] text-fg-subtle">
            https://www.loom.com/share/&lt;id&gt;
          </span>
        </p>
      </div>
    );
  }

  return (
    <Card className="overflow-hidden bg-canvas-deeper border-border">
      <div className="relative w-full" style={{ paddingTop: "56.25%" }}>
        <iframe
          src={embedUrl}
          frameBorder="0"
          allowFullScreen
          className="absolute inset-0 w-full h-full"
          title="Vídeo explicativo da campanha"
        />
      </div>
    </Card>
  );
}

function FilmIcon({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
      <line x1="7" y1="2" x2="7" y2="22" />
      <line x1="17" y1="2" x2="17" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="2" y1="7" x2="7" y2="7" />
      <line x1="2" y1="17" x2="7" y2="17" />
      <line x1="17" y1="17" x2="22" y2="17" />
      <line x1="17" y1="7" x2="22" y2="7" />
    </svg>
  );
}
