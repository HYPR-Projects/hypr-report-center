import { useState, useEffect } from "react";
import { C } from "../../shared/theme";
import { saveLogo as saveLogoApi, listClientLogos, getLogo } from "../../lib/api";
import { compressImageFile } from "../../shared/imageCompress";
import { useLogoAnalysis } from "../../v2/hooks/useLogoAnalysis";
import { useTheme } from "../../v2/hooks/useTheme";
import ModalShell from "./ModalShell";
import { toast } from "../../lib/toast";

/**
 * LogoModal — upload de logo PNG, JPG ou SVG de uma campanha.
 *
 * Suporta dois fluxos:
 *  1. Upload de arquivo novo (PNG/JPG/SVG, comprimido pra max 600px).
 *  2. Reaproveitamento de logo já cadastrado em outra campanha do
 *     mesmo cliente (galeria no topo). Click → busca o base64 daquele
 *     token via `getLogo` → vira o preview → admin confirma e salva.
 *
 * SVG é preferido porque permite inversão de cor limpa via CSS filter
 * (invert) entre temas dark/light sem perda de qualidade — útil pra
 * logos monocromáticos. PNG/JPG continuam suportados pra logos
 * coloridos onde inversão não faz sentido.
 *
 * Estado de file e preview ficam locais. Ao fechar, tudo é resetado.
 *
 * Props
 * -----
 *  - shortToken: short_token (null = fechado)
 *  - onClose: callback de fechar
 *  - onSaved: callback após save
 *  - theme: { text, muted, modalBdr, inputBg }
 */
const LogoModal = ({ shortToken, onClose, onSaved, theme }) => {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [gallery, setGallery] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [pickingFrom, setPickingFrom] = useState(null); // short_token sendo carregado

  const text     = theme?.text     || C.white;
  const muted    = theme?.muted    || C.muted;
  const modalBdr = theme?.modalBdr || C.dark3;
  const inputBg  = theme?.inputBg  || C.dark3;

  // Espelha a lógica do CampaignHeaderV2: detecta se a logo é monocromática
  // clara/escura e aplica `filter: invert(1)` quando o tema do app conflita
  // com a logo. Sem isso, logos brancas (Heineken, Nintendo) somem na
  // preview do modal em tema light, e o admin acha que falhou.
  const logoKind = useLogoAnalysis(preview);
  const [appTheme] = useTheme();
  const shouldInvertPreview =
    (logoKind === "monochrome-light" && appTheme === "light") ||
    (logoKind === "monochrome-dark"  && appTheme === "dark");

  // Ao abrir o modal, busca a galeria de logos já cadastrados em outras
  // campanhas do mesmo cliente. Em falha (rede, sem permissão, sem outras
  // campanhas), galeria fica vazia e o modal funciona só com upload.
  useEffect(() => {
    if (!shortToken) return;
    let cancelled = false;
    setGalleryLoading(true);
    listClientLogos({ short_token: shortToken })
      .then((items) => { if (!cancelled) setGallery(items); })
      .finally(() => { if (!cancelled) setGalleryLoading(false); });
    return () => { cancelled = true; };
  }, [shortToken]);

  const handleClose = () => {
    setFile(null); setPreview(null);
    if (onClose) onClose();
  };

  const handleFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // Aceita PNG, JPG e SVG. Filtro extra além do `accept` do input pra
    // pegar arquivos arrastados ou com mime type inconsistente.
    const allowed = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml"];
    if (f.type && !allowed.includes(f.type) && !f.name.toLowerCase().endsWith(".svg")) {
      toast.error("Formato não suportado. Use PNG, JPG ou SVG.");
      e.target.value = "";
      return;
    }
    try {
      // Compressão silenciosa: redimensiona pra max 600px, recusa > 5MB.
      // SVG passa direto (já é leve).
      const compressed = await compressImageFile(f, { maxWidth: 600 });
      setFile(f);
      setPreview(compressed);
    } catch (err) {
      toast.error(err.message || "Falha ao processar imagem");
      e.target.value = "";
    }
  };

  const handlePickFromGallery = async (sourceToken) => {
    setPickingFrom(sourceToken);
    try {
      const base64 = await getLogo({ short_token: sourceToken });
      if (!base64) {
        toast.error("Não foi possível carregar esse logo.");
        return;
      }
      setFile(null); // não é upload de arquivo novo
      setPreview(base64);
    } finally {
      setPickingFrom(null);
    }
  };

  const handleSave = async () => {
    if (!preview) return;
    setSaving(true);
    try {
      await saveLogoApi({ short_token: shortToken, logo_base64: preview });
      toast.success(`Logo de ${shortToken} salvo`);
      setFile(null); setPreview(null);
      if (onSaved) onSaved();
    } catch {
      toast.error("Erro ao salvar logo.");
    } finally {
      setSaving(false);
    }
  };

  if (!shortToken) return null;

  return (
    <ModalShell onClose={handleClose} theme={theme}>
      <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, color: text }}>
        🖼️ Adicionar Logo
      </h2>
      <p style={{ color: muted, fontSize: 14, marginBottom: 6 }}>
        Selecione o logo para <strong>{shortToken}</strong>.
      </p>
      <p style={{ color: muted, fontSize: 12, marginBottom: 16, opacity: 0.8 }}>
        Aceita PNG, JPG ou SVG. SVG é recomendado para logos monocromáticos
        (melhor adaptação entre tema escuro e claro).
      </p>

      {/* Galeria de logos do mesmo cliente — só aparece se houver outras
          campanhas com logo. Carrega lazy ao abrir o modal. */}
      {galleryLoading && (
        <p style={{ color: muted, fontSize: 12, marginBottom: 16, opacity: 0.7 }}>
          Buscando logos de outras campanhas do mesmo cliente…
        </p>
      )}
      {!galleryLoading && gallery.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ color: muted, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
            Reaproveitar de outra campanha
          </div>
          <div
            style={{
              display: "flex", flexWrap: "wrap", gap: 6,
              maxHeight: 120, overflowY: "auto",
              border: `1px solid ${modalBdr}`, borderRadius: 8, padding: 8,
              background: inputBg,
            }}
          >
            {gallery.map((item) => (
              <button
                key={item.short_token}
                onClick={() => handlePickFromGallery(item.short_token)}
                disabled={pickingFrom != null}
                title={`Usar logo de ${item.campaign_name || item.short_token}`}
                style={{
                  background: "transparent",
                  border: `1px solid ${modalBdr}`,
                  borderRadius: 6,
                  padding: "6px 10px",
                  cursor: pickingFrom != null ? "wait" : "pointer",
                  fontSize: 12,
                  color: text,
                  opacity: pickingFrom === item.short_token ? 0.5 : 1,
                  display: "inline-flex", alignItems: "center", gap: 6,
                  maxWidth: "100%",
                }}
              >
                <span style={{ fontSize: 11, color: muted, fontFamily: "monospace" }}>
                  {item.short_token}
                </span>
                <span style={{
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  maxWidth: 180,
                }}>
                  {item.campaign_name || "—"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <label
        style={{
          display: "flex", alignItems: "center", gap: 10,
          background: inputBg, border: `1px solid ${modalBdr}`,
          borderRadius: 8, padding: "12px 14px", cursor: "pointer", marginBottom: 20,
        }}
      >
        <input type="file" accept="image/png,image/jpeg,image/svg+xml,.svg" style={{ display: "none" }} onChange={handleFile} />
        <span aria-hidden="true" style={{ fontSize: 20 }}>📁</span>
        <span style={{ fontSize: 13, color: muted }}>
          {file ? file.name : "Clique para selecionar imagem"}
        </span>
      </label>
      {preview && (
        <img
          src={preview}
          style={{
            width: "100%",
            maxHeight: 120,
            objectFit: "contain",
            marginBottom: 20,
            borderRadius: 8,
            filter: shouldInvertPreview ? "invert(1)" : undefined,
            transition: "filter 0.2s",
          }}
          alt="Preview do logo"
        />
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={handleClose}
          style={{
            flex: 1, background: inputBg, color: muted,
            border: `1px solid ${modalBdr}`, padding: 12, borderRadius: 8,
            cursor: "pointer", fontSize: 14,
          }}
        >
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !preview}
          style={{
            flex: 2, background: C.blue, color: C.white, border: "none",
            padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14,
            fontWeight: 700, opacity: !preview ? 0.5 : 1,
          }}
        >
          {saving ? "Salvando..." : "✓ Salvar Logo"}
        </button>
      </div>
    </ModalShell>
  );
};

export default LogoModal;
