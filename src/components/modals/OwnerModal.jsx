import { useState, useEffect } from "react";
import { C } from "../../shared/theme";
import { saveReportOwner } from "../../lib/api";
import ModalShell from "./ModalShell";
import { toast } from "../../lib/toast";

/**
 * OwnerModal — admin define quem é dono (CP/CS) de uma campanha.
 *
 * Props
 * -----
 *  - campaign: objeto da campanha sendo editada (null = fechado).
 *    Espera { short_token, client_name, cp_email, cs_email }.
 *  - onClose: callback de fechar
 *  - onSaved({ short_token, cp_email, cs_email }): callback após save
 *  - teamMembers: { cps: [{email, name}], css: [{email, name}] }
 *  - theme: { text, muted, modalBdr, inputBg }
 */
const OwnerModal = ({ campaign, onClose, onSaved, teamMembers, theme }) => {
  const [cpEmail, setCpEmail] = useState("");
  const [csEmail, setCsEmail] = useState("");
  const [saving, setSaving] = useState(false);

  // Sincroniza selects quando o pai abre com uma campanha diferente.
  useEffect(() => {
    if (!campaign) return;
    setCpEmail(campaign.cp_email || "");
    setCsEmail(campaign.cs_email || "");
  }, [campaign]);

  const text     = theme?.text     || C.white;
  const muted    = theme?.muted    || C.muted;
  const modalBdr = theme?.modalBdr || C.dark3;
  const inputBg  = theme?.inputBg  || C.dark3;

  const handleSave = async () => {
    if (!campaign) return;
    setSaving(true);
    try {
      await saveReportOwner({
        short_token: campaign.short_token,
        cp_email: cpEmail,
        cs_email: csEmail,
      });
      onSaved({
        short_token: campaign.short_token,
        cp_email: cpEmail || null,
        cs_email: csEmail || null,
      });
      toast.success(`Owners de ${campaign.short_token} atualizados`);
    } catch (e) {
      toast.error("Erro ao salvar owner: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!campaign) return null;

  return (
    <ModalShell onClose={onClose} maxWidth={520} theme={theme}>
      <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4, color: text }}>
        👤 Gerenciar Owner
      </h2>
      <p style={{ color: muted, fontSize: 13, marginBottom: 22 }}>
        <strong>{campaign.client_name}</strong>
        <span style={{ marginLeft: 8, fontFamily: "monospace", fontSize: 11, color: C.blue }}>
          {campaign.short_token}
        </span>
      </p>

      <p style={{ fontSize: 12, color: muted, marginBottom: 20, lineHeight: 1.5 }}>
        Por padrão, o owner vem do <strong>De-Para Comercial</strong> (planilha). Esta tela permite sobrescrever manualmente. Deixe ambos em branco para voltar ao padrão automático.
      </p>

      <label style={{ display: "block", fontSize: 11, color: muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
        CP — Comercial
      </label>
      <select
        value={cpEmail}
        onChange={(e) => setCpEmail(e.target.value)}
        style={{
          width: "100%", background: inputBg, border: `1px solid ${modalBdr}`,
          borderRadius: 8, padding: "10px 12px", color: text, fontSize: 14,
          outline: "none", marginBottom: 16, appearance: "auto",
        }}
      >
        <option value="">— sem CP atribuído —</option>
        {teamMembers.cps.map((p) => (
          <option key={p.email} value={p.email}>{p.name} ({p.email})</option>
        ))}
      </select>

      <label style={{ display: "block", fontSize: 11, color: muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
        CS — Customer Success
      </label>
      <select
        value={csEmail}
        onChange={(e) => setCsEmail(e.target.value)}
        style={{
          width: "100%", background: inputBg, border: `1px solid ${modalBdr}`,
          borderRadius: 8, padding: "10px 12px", color: text, fontSize: 14,
          outline: "none", marginBottom: 24, appearance: "auto",
        }}
      >
        <option value="">— sem CS atribuído —</option>
        {teamMembers.css.map((p) => (
          <option key={p.email} value={p.email}>{p.name} ({p.email})</option>
        ))}
      </select>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onClose}
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
          disabled={saving}
          style={{
            flex: 2, background: C.blue, color: C.white, border: "none",
            padding: 12, borderRadius: 8, cursor: "pointer", fontSize: 14,
            fontWeight: 700, opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Salvando..." : "✓ Salvar Owner"}
        </button>
      </div>
    </ModalShell>
  );
};

export default OwnerModal;
