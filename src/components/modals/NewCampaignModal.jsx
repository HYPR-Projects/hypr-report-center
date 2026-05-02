import { useState } from "react";
import { C } from "../../shared/theme";
import { checkCampaignToken, saveLogo as saveLogoApi, getShareId } from "../../lib/api";
import Spinner from "../Spinner";
import ModalShell from "./ModalShell";

/**
 * Modal "+ Novo Report" — fluxo de duas etapas:
 *   1. Admin digita short_token, backend valida que existe.
 *   2. Backend retorna metadata (cliente, datas), admin confirma e
 *      opcionalmente sobe o logo.
 *
 * Ao confirmar, dispara `onConfirm(tokenData)` pra o pai inserir a campanha
 * na lista local. O save do logo acontece aqui dentro mesmo (é opcional —
 * caller original tinha try/catch silencioso).
 *
 * Props
 * -----
 * - `onClose`: callback ao fechar/cancelar;
 * - `onConfirm(tokenData)`: callback após confirmação bem-sucedida —
 *   recebe os dados da campanha pra o CampaignMenu inserir na lista;
 * - `theme`: cores derivadas do isDark.
 */
const NewCampaignModal = ({ onClose, onConfirm, theme }) => {
  const [newToken,    setNewToken]    = useState("");
  const [tokenData,   setTokenData]   = useState(null);
  const [shareId,     setShareId]     = useState(null);
  const [logoPreview, setLogoPreview] = useState(null);
  const [checking,    setChecking]    = useState(false);

  const text     = theme?.text     || C.white;
  const muted    = theme?.muted    || C.muted;
  const modalBdr = theme?.modalBdr || C.dark3;
  const inputBg  = theme?.inputBg  || C.dark3;

  const reset = () => {
    setNewToken(""); setTokenData(null); setShareId(null);
    setLogoPreview(null);
  };

  const handleClose = () => {
    reset();
    if (onClose) onClose();
  };

  const handleCheckToken = async () => {
    if (!newToken.trim()) return;
    setChecking(true);
    try {
      const d = await checkCampaignToken(newToken.trim());
      if (d?.campaign) {
        setTokenData(d.campaign);
        // Busca/cria share_id em paralelo. Se falhar (rede ou backend
        // sem o endpoint), o display cai no formato legacy via fallback
        // no template — link continua válido, só sem o ganho de
        // privacidade na URL.
        getShareId(d.campaign.short_token).then(setShareId).catch(() => setShareId(null));
      } else {
        alert("Token não encontrado.");
      }
    } catch {
      alert("Erro ao buscar token.");
    } finally {
      setChecking(false);
    }
  };

  const handleConfirm = async () => {
    if (!tokenData) return;
    if (logoPreview) {
      try {
        await saveLogoApi({ short_token: tokenData.short_token, logo_base64: logoPreview });
      } catch (e) {
        console.warn("Erro ao salvar logo", e);
      }
    }
    if (onConfirm) onConfirm(tokenData);
    reset();
  };

  const handleLogoFile = e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = ev => setLogoPreview(ev.target.result);
    reader.readAsDataURL(f);
  };

  return (
    <ModalShell onClose={handleClose} theme={theme}>
      <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, color: text }}>Novo Report</h2>
      <p style={{ color: muted, fontSize: 14, marginBottom: 28 }}>
        Digite o short_token da campanha para gerar o link de acesso do cliente.
      </p>

      {!tokenData ? (
        <>
          <label htmlFor="ncm-short-token" style={{ fontSize: 12, color: muted, textTransform: "uppercase", letterSpacing: 1 }}>
            Short Token
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              id="ncm-short-token"
              value={newToken}
              onChange={e => setNewToken(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && handleCheckToken()}
              placeholder="ex: GEE-MAR26"
              style={{
                flex: 1, background: inputBg, border: `1px solid ${modalBdr}`,
                borderRadius: 8, padding: "12px 14px", color: text, fontSize: 15,
                fontWeight: 700, letterSpacing: 1, outline: "none",
              }}
            />
            <button
              onClick={handleCheckToken}
              disabled={checking || !newToken.trim()}
              style={{
                background: C.blue, color: C.white, border: "none",
                padding: "12px 20px", borderRadius: 8, cursor: "pointer",
                fontSize: 14, fontWeight: 700, minWidth: 80,
                opacity: !newToken.trim() ? 0.5 : 1,
              }}
            >
              {checking ? <Spinner size={16} color={C.white}/> : "Buscar"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ background: `${C.blue}15`, border: `1px solid ${C.blue}30`, borderRadius: 10, padding: 20, marginBottom: 24 }}>
            <div style={{ fontSize: 12, color: C.blue, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
              Campanha encontrada
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: text }}>{tokenData.client_name}</div>
            <div style={{ fontSize: 14, color: muted, marginTop: 4 }}>{tokenData.campaign_name}</div>
            <div style={{ marginTop: 12, display: "flex", gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: muted }}>Início</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: text }}>{tokenData.start_date}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: muted }}>Fim</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: text }}>{tokenData.end_date}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: muted }}>Token</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.blue }}>{tokenData.short_token}</div>
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
              Logo do Cliente (PNG sem fundo)
            </div>
            {logoPreview ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12, background: inputBg, borderRadius: 8, padding: 12 }}>
                <img src={logoPreview} alt="Preview da logo" style={{ height: 40, objectFit: "contain", maxWidth: 120 }}/>
                <span style={{ fontSize: 12, color: muted, flex: 1 }}>Logo carregado</span>
                <button
                  onClick={() => { setLogoPreview(null); }}
                  style={{ background: "none", border: "none", color: muted, cursor: "pointer", fontSize: 18, lineHeight: 1 }}
                >×</button>
              </div>
            ) : (
              <label style={{ display: "flex", alignItems: "center", gap: 10, background: inputBg, border: `1px dashed ${modalBdr}`, borderRadius: 8, padding: 12, cursor: "pointer" }}>
                <input
                  type="file"
                  accept="image/png"
                  style={{ display: "none" }}
                  onChange={handleLogoFile}
                />
                <span aria-hidden="true" style={{ fontSize: 20 }}>🖼️</span>
                <span style={{ fontSize: 13, color: muted }}>Clique para inserir logo PNG</span>
              </label>
            )}
          </div>

          <div style={{ background: inputBg, borderRadius: 8, padding: 12, marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: muted, marginBottom: 4 }}>
              Link do cliente (senha = short token)
            </div>
            <div style={{ fontSize: 13, color: C.blue, wordBreak: "break-all" }}>
              {window.location.origin}/report/{shareId || tokenData.short_token}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => { setTokenData(null); setNewToken(""); }}
              style={{
                flex: 1, background: inputBg, color: muted,
                border: `1px solid ${modalBdr}`, padding: 12, borderRadius: 8,
                cursor: "pointer", fontSize: 14,
              }}
            >
              Voltar
            </button>
            <button
              onClick={handleConfirm}
              style={{
                flex: 2, background: C.blue, color: C.white, border: "none",
                padding: 12, borderRadius: 8, cursor: "pointer",
                fontSize: 14, fontWeight: 700,
              }}
            >
              ✓ Confirmar e Adicionar
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
};

export default NewCampaignModal;
