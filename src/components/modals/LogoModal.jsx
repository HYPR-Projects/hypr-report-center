import { useState } from "react";
import { C } from "../../shared/theme";
import { saveLogo as saveLogoApi } from "../../lib/api";
import { compressImageFile } from "../../shared/imageCompress";
import ModalShell from "./ModalShell";

/**
 * LogoModal — upload de logo PNG, JPG ou SVG de uma campanha.
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

  const text     = theme?.text     || C.white;
  const muted    = theme?.muted    || C.muted;
  const modalBdr = theme?.modalBdr || C.dark3;
  const inputBg  = theme?.inputBg  || C.dark3;

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
      alert("Formato não suportado. Use PNG, JPG ou SVG.");
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
      alert(err.message || "Falha ao processar imagem");
      e.target.value = "";
    }
  };

  const handleSave = async () => {
    if (!preview) return;
    setSaving(true);
    try {
      await saveLogoApi({ short_token: shortToken, logo_base64: preview });
      alert("Logo salvo com sucesso!");
      setFile(null); setPreview(null);
      if (onSaved) onSaved();
    } catch {
      alert("Erro ao salvar logo.");
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
      <p style={{ color: muted, fontSize: 12, marginBottom: 24, opacity: 0.8 }}>
        Aceita PNG, JPG ou SVG. SVG é recomendado para logos monocromáticos
        (melhor adaptação entre tema escuro e claro).
      </p>
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
          style={{ width: "100%", maxHeight: 120, objectFit: "contain", marginBottom: 20, borderRadius: 8 }}
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
