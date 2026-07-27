import { createPortal } from "react-dom";
import { C } from "../../shared/theme";

/**
 * ModalShell — overlay base que todos os modais do CampaignMenu compartilham.
 *
 * Responsabilidades:
 *  - renderiza o backdrop full-screen com fundo translúcido
 *  - intercepta cliques no backdrop pra fechar (ignora cliques no conteúdo)
 *  - aplica padding e centralização consistentes
 *  - aceita maxWidth e maxHeight customizados (Survey precisa de maxHeight + scroll)
 *
 * O conteúdo do modal vem como children. Cada modal cuida do próprio layout
 * interno, fields e botões.
 *
 * Props
 * -----
 *  - onClose: chamado quando o user clica no backdrop (cliques no conteúdo
 *    são ignorados via comparação target/currentTarget).
 *  - maxWidth: largura máxima do card interno (default 480).
 *  - maxHeight: opcional. Se passar, ativa scroll vertical interno.
 *  - padding: padding do card (default 40, mas SurveyModal usa 32).
 *  - theme: { modalBg, modalBdr } — fallback pro tema dark se ausente.
 */
const ModalShell = ({
  onClose,
  maxWidth = 480,
  maxHeight,
  padding = 40,
  theme,
  children,
}) => {
  const bg  = theme?.modalBg  || C.dark2;
  const bdr = theme?.modalBdr || C.dark3;

  // Padding responsivo: em mobile (<640px), reduz pra 24px (de 40 padrão)
  // pra ganhar largura útil em viewport apertado. CSS clamp permite a
  // transição suave sem media query inline. maxHeight cai pra 92vh em
  // mobile (vs 100% raw) — deixa folga pra status bar/notch.
  const innerStyle = {
    background: bg,
    border: `1px solid ${bdr}`,
    borderRadius: 16,
    padding: `clamp(20px, 5vw, ${padding}px)`,
    width: "100%",
    maxWidth,
    ...(maxHeight
      ? { maxHeight: `min(${typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight}, 92vh)`, overflowY: "auto" }
      : null),
  };

  // Portal pra document.body: sem isso o overlay fica preso no subtree onde
  // o modal é montado (ex.: dentro de um TabsContent). O `.tabs-content` ativo
  // roda `animation: fade-in ... both` (anima opacity) → cria um stacking
  // context, e o `zIndex: 1000` do overlay passa a valer SÓ dentro dele, que
  // por sua vez fica em nível auto na raiz — abaixo dos triggers de aba
  // (`z-10`). Resultado: os textos das abas vazavam por cima do modal.
  // Portalizando pra body, o overlay entra no stacking context raiz e cobre
  // tudo. Também imuniza contra ancestrais com transform/filter. Mesmo padrão
  // já usado por Toast, DateRangeFilter e PortalAnalytics.
  const overlay = (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#00000080",
        display: "flex",
        // Mobile: alinha ao centro mas com `safe-area-inset` no padding
        // pra não cobrir notch nem home indicator no iOS.
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left))",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="fade-in" style={innerStyle}>
        {children}
      </div>
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(overlay, document.body)
    : overlay;
};

export default ModalShell;
