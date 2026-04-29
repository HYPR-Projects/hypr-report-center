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

import SurveyTab from "../../dashboards/SurveyTab";
import { useTheme } from "../hooks/useTheme";
import { legacyThemeObj } from "../legacyThemeBridge";

export default function SurveyV2({ token, data, isAdmin, adminJwt }) {
  const [theme] = useTheme();

  // Sem survey cadastrado — placeholder consistente com tom V2
  if (!data?.survey) {
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

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-bold text-fg">Brand Lift Survey</h2>
        <p className="text-sm text-fg-muted">
          Resultado das perguntas aplicadas ao público impactado pela campanha.
          {isAdmin ? " Você pode editar perguntas e respostas." : ""}
        </p>
      </header>

      <SurveyTab
        surveyJson={data.survey}
        token={token}
        isAdmin={isAdmin}
        adminJwt={adminJwt}
        theme={legacyThemeObj(theme)}
      />
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
