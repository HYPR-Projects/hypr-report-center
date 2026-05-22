import { useState, useEffect } from "react";
import { C } from "../shared/theme";
import RmndDashboard from "./RmndDashboard";
import PdoohDashboard from "./PdoohDashboard";
import RmndUploadModal from "../components/modals/RmndUploadModal";
import PdoohUploadModal from "../components/modals/PdoohUploadModal";

const UploadTab = ({ type, token, serverData, readOnly, adminJwt, isDark = true }) => {
  const [data, setData]           = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const storageKey                = `hypr_${type.toLowerCase()}_${token}`;

  // Server é a source of truth quando o backend devolveu algo: o payload já
  // reflete a `view` corrente (mês específico ou agregada). LocalStorage só
  // serve de fallback offline / pré-fetch — antes a ordem era invertida e a
  // aba ficava presa no último upload local mesmo quando a view mudava
  // (bug aparente em reports merged ao alternar entre meses).
  useEffect(() => {
    if (serverData) {
      try {
        const parsed = typeof serverData === "string" ? JSON.parse(serverData) : serverData;
        setData(parsed);
        try { localStorage.setItem(storageKey, JSON.stringify(parsed)); } catch { /* quota */ }
        return;
      } catch { /* fall through pra localStorage */ }
    }
    try {
      const s = localStorage.getItem(storageKey);
      if (s) { setData(JSON.parse(s)); return; }
    } catch { /* ignore */ }
    setData(null);
  }, [storageKey, serverData]);

  const clear = () => {
    setData(null);
    try { localStorage.removeItem(storageKey); } catch {}
  };

  const isRmnd  = type === "RMND";
  const isPdooh = type === "PDOOH";

  // Modal stylesheet (injetado em todos os componentes filhos consistente)
  const modalTheme = {
    text:     isDark ? C.white : "#1C262F",
    muted:    isDark ? C.muted : "#6B7A8D",
    modalBg:  isDark ? C.dark2 : "#FFFFFF",
    modalBdr: isDark ? C.dark3 : "#DDE2EC",
    inputBg:  isDark ? C.dark3 : "#F4F6FA",
  };

  const renderUploadButton = (label) => (
    <button
      type="button"
      onClick={() => setModalOpen(true)}
      style={{
        background: C.blue,
        color: "#fff",
        padding: "14px 32px",
        borderRadius: 10,
        border: "none",
        cursor: "pointer",
        fontSize: 15,
        fontWeight: 700,
      }}
    >
      {label}
    </button>
  );

  const renderModal = () => {
    if (!modalOpen) return null;
    if (isRmnd) {
      return (
        <RmndUploadModal
          shortToken={token}
          existing={data}
          adminJwt={adminJwt}
          theme={modalTheme}
          onClose={() => setModalOpen(false)}
          onSaved={(payload) => { setData(payload); setModalOpen(false); }}
        />
      );
    }
    if (isPdooh) {
      return (
        <PdoohUploadModal
          shortToken={token}
          existing={data}
          adminJwt={adminJwt}
          theme={modalTheme}
          onClose={() => setModalOpen(false)}
          onSaved={(payload) => { setData(payload); setModalOpen(false); }}
        />
      );
    }
    return null;
  };

  if (!data) {
    const muted = isDark ? C.muted : "#6B7A8D";
    const text  = isDark ? C.white : "#1C262F";
    return (
      <>
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📂</div>
          <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: text }}>{type}</h3>
          <p style={{ color: muted, fontSize: 14, marginBottom: 32, maxWidth: 440, margin: "0 auto 32px" }}>
            {readOnly
              ? "Nenhum dado disponível para esta campanha ainda."
              : isRmnd
                ? "Suba o relatório do Amazon Ads pra montar a aba RMND. Você poderá filtrar grupos de anúncios e período antes de salvar."
                : isPdooh
                  ? "Suba o HYPR_PDOOH_REPORT pra montar a aba PDOOH. Você poderá filtrar line items, painéis, cidades e período antes de salvar."
                  : "Faça upload do relatório para visualizar os dados desta campanha."}
          </p>
          {!readOnly && renderUploadButton(isRmnd ? "Subir base RMND" : isPdooh ? "Subir base PDOOH" : "Selecionar Arquivo")}
        </div>
        {renderModal()}
      </>
    );
  }

  if (isRmnd) {
    return (
      <>
        <RmndDashboard
          data={data}
          onClear={readOnly ? null : clear}
          onEdit={readOnly ? null : () => setModalOpen(true)}
        />
        {renderModal()}
      </>
    );
  }

  return (
    <>
      <PdoohDashboard
        data={data}
        onClear={readOnly ? null : clear}
        isDark={isDark}
      />
      {renderModal()}
    </>
  );
};

export default UploadTab;
