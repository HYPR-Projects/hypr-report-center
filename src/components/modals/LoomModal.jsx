import { useState } from "react";
import { C } from "../../shared/theme";
import { saveLoom as saveLoomApi } from "../../lib/api";
import ModalShell from "./ModalShell";
import { toast } from "../../lib/toast";

/**
 * LoomModal — adiciona link Loom a uma campanha.
 *
 * Props
 * -----
 *  - shortToken: short_token da campanha (também aciona abertura — null = fechado)
 *  - onClose: callback quando o user fecha sem salvar
 *  - onSaved: callback após save bem-sucedido
 *  - theme: { text, muted, modalBdr, inputBg }
 */
const LoomModal = ({ shortToken, onClose, onSaved, theme }) => {
  const [loomUrl, setLoomUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const text     = theme?.text     || C.white;
  const muted    = theme?.muted    || C.muted;
  const modalBdr = theme?.modalBdr || C.dark3;
  const inputBg  = theme?.inputBg  || C.dark3;

  const handleClose = () => { setLoomUrl(""); if (onClose) onClose(); };

  const handleSave = async () => {
    if (!loomUrl.trim()) return;
    setSaving(true);
    try {
      await saveLoomApi({ short_token: shortToken, loom_url: loomUrl.trim() });
      toast.success(`Loom de ${shortToken} salvo`);
      setLoomUrl("");
      if (onSaved) onSaved();
    } catch {
      toast.error("Erro ao salvar Loom.");
    } finally {
      setSaving(false);
    }
  };

  if (!shortToken) return null;

  return (
    <ModalShell onClose={handleClose} theme={theme}>
      <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, color: text }}>
        🎥 Adicionar Loom
      </h2>
      <p style={{ color: muted, fontSize: 14, marginBottom: 24 }}>
        Cole o link do Loom para <strong>{shortToken}</strong>.
      </p>
      <input
        value={loomUrl}
        onChange={(e) => setLoomUrl(e.target.value)}
        placeholder="https://www.loom.com/share/..."
        style={{
          width: "100%", background: inputBg, border: `1px solid ${modalBdr}`,
          borderRadius: 8, padding: "12px 14px", color: text, fontSize: 14,
          outline: "none", marginBottom: 20,
        }}
      />
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
          disabled={saving || !loomUrl.trim()}
          style={{
            flex: 2, background: C.blue, color: C.white, border: "none",
            padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14,
            fontWeight: 700, opacity: !loomUrl.trim() ? 0.5 : 1,
          }}
        >
          {saving ? "Salvando..." : "✓ Salvar Loom"}
        </button>
      </div>
    </ModalShell>
  );
};

export default LoomModal;
