// src/v2/dashboards/SurveyV2.jsx
//
// Tab "SURVEY" V2 — wrapper que reusa o SurveyTab Legacy preservado
// em src/dashboards/SurveyTab.jsx. Adiciona apenas frame visual V2.
//
// Diferente das outras tabs Legacy (RMND, PDOOH), Survey não usa
// UploadTab — admin edita as perguntas/respostas via SurveyModal
// integrado, e cliente vê read-only com gráficos (SurveyChart).
//
// Empty state precisa ser tratado FORA do SurveyTab porque ele assume
// que surveyJson sempre existe. Se data.survey for null/undefined,
// renderizamos placeholder V2 em vez de delegar.
//
// Merge Reports — quando o report é agregado e há 1+ surveys nos membros,
// o backend devolve `data.survey = { merged: true, items: [{short_token,
// label, survey: "<json>"}, ...] }`. Renderizamos uma seção por item, com
// header do mês entre eles. Cada SurveyTab busca seu próprio Typeform
// (filtrado pela URL daquele token) — dados NÃO se misturam entre meses.

import SurveyTab from "../../dashboards/SurveyTab";
import { useTheme } from "../hooks/useTheme";
import { legacyThemeObj } from "../legacyThemeBridge";
import { parseSurveyConfig, fmtClientRange, isQuestionRenderable } from "../../shared/surveyConfig";

// Decide se um JSON de survey é "renderizável".
// Caso típico de rejeição: token sem survey contratada — admin pode ter
// salvo o JSON com placeholders ou strings que não passam validação.
// Em vez de mostrar erro pro cliente, escondemos a seção inteira.
//
// Regra: pelo menos UMA pergunta precisa ter pelo menos UM lado preenchido
// (Controle ou Exposto). Sem ambos lados há distribuição mas não lift —
// renderer trata graciosamente. Modelo legado (CSV pré-Typeform): sem URLs,
// mas com `questions`.
function isRenderableSurvey(json) {
  const cfg = parseSurveyConfig(json);
  if (!cfg) return false;
  if (cfg.isLegacyCsv) {
    return !!(cfg.legacyObject && Array.isArray(cfg.legacyObject.questions) && cfg.legacyObject.questions.length);
  }
  if (!Array.isArray(cfg.questions)) return false;
  return cfg.questions.some(isQuestionRenderable);
}

export default function SurveyV2({ token, data, isAdmin, adminJwt }) {
  const [theme] = useTheme();
  const legacyTheme = legacyThemeObj(theme);

  const sv = data?.survey;

  // Detecta shape de merged report
  const isMerged = typeof sv === "object" && sv && sv.merged && Array.isArray(sv.items);
  const rawItems = isMerged
    ? sv.items
    : sv
      ? [{ short_token: token, label: null, survey: sv }]
      : [];

  // Filtra itens com JSON ausente/inválido (ex.: token de mês que não
  // teve survey contratada) — não mostramos erro pro cliente, só omitimos.
  const items = rawItems.filter((it) => isRenderableSurvey(it?.survey));

  // Sem survey cadastrado (ou todos os itens inválidos) — placeholder V2
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-20">
        <ClipboardIcon className="size-12 text-fg-subtle mb-4" />
        <h3 className="text-base font-semibold text-fg mb-2">
          Nenhum survey cadastrado
        </h3>
        <p className="text-sm text-fg-muted max-w-md">
          Esta campanha ainda não tem brand lift survey vinculado.
          {isAdmin
            ? " Use a área administrativa pra adicionar perguntas e respostas."
            : ""}
        </p>
      </div>
    );
  }

  // Período pro cliente — só renderizamos a badge pra !isAdmin porque:
  //   - Cliente VÊ os dados filtrados pelo clientRange → badge é descritiva.
  //   - Admin vê tudo por padrão (clientRange é ignorado), e o admin bar do
  //     SurveyTab já mostra "Cliente vê: X" com label que evita confusão.
  // Single-token (items.length === 1): badge no header global.
  // Merged (items.length > 1): badge no header de cada seção.
  const singleTokenCfg = items.length === 1 ? parseSurveyConfig(items[0].survey) : null;
  const singleTokenRange = singleTokenCfg?.clientRange || null;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-bold text-fg">Brand Lift Survey</h2>
        <p className="text-sm text-fg-muted">
          Resultado das perguntas aplicadas ao público impactado pela campanha.
          {isMerged && items.length > 1
            ? " Esta campanha tem múltiplos meses agrupados — cada seção abaixo mostra o survey daquele período."
            : isAdmin ? " Você pode editar perguntas e respostas." : ""}
        </p>
        {!isAdmin && singleTokenRange && (
          <p className="text-xs text-fg-muted pt-1">
            Período exibido: <span className="font-semibold text-fg">{fmtClientRange(singleTokenRange)}</span>
          </p>
        )}
      </header>

      {items.map((it, idx) => (
        <section
          key={`${it.short_token}-${idx}`}
          className={isMerged && items.length > 1 ? "space-y-3" : ""}
        >
          {isMerged && items.length > 1 && it.label && (
            <div className="flex items-center gap-3 pb-2 border-b border-border flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-signature-soft border border-signature/40 text-signature text-[11px] font-bold tracking-wider uppercase">
                {it.label}
              </span>
              <span className="text-[11px] text-fg-subtle font-mono">
                {it.short_token}
              </span>
              {!isAdmin && (() => {
                // Pro cliente: badge descreve com precisão o que ele vê
                // naquela seção (dados filtrados pelo clientRange salvo).
                // Pro admin: omitido — admin não vê filtrado, o admin bar
                // dentro do SurveyTab já mostra "Cliente vê: X" com label
                // próprio pra não dar a impressão de que admin está vendo
                // só aquele período.
                const cfg = parseSurveyConfig(it.survey);
                const cr = cfg?.clientRange;
                if (!cr) return null;
                return (
                  <span className="text-[11px] text-fg-muted bg-signature-soft/40 border border-border rounded px-2 py-0.5">
                    Período: <span className="font-semibold text-fg">{fmtClientRange(cr)}</span>
                  </span>
                );
              })()}
            </div>
          )}
          <SurveyTab
            surveyJson={it.survey}
            token={it.short_token}
            isAdmin={isAdmin}
            adminJwt={adminJwt}
            theme={legacyTheme}
          />
        </section>
      ))}
    </div>
  );
}

function ClipboardIcon({ className }) {
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
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" ry="1" />
      <line x1="9" y1="12" x2="15" y2="12" />
      <line x1="9" y1="16" x2="13" y2="16" />
    </svg>
  );
}
