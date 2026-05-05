import { useState, useEffect, useRef } from "react";
import { C } from "../shared/theme";
import { useXlsx } from "../shared/useXlsx";
import { saveUpload } from "../lib/api";
import RmndDashboard from "./RmndDashboard";
import PdoohDashboard from "./PdoohDashboard";
import RmndUploadModal from "../components/modals/RmndUploadModal";
import { toast } from "../lib/toast";

const UploadTab = ({ type, token, serverData, readOnly, adminJwt, isDark = true }) => {
  const XLSX       = useXlsx();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const fileRef               = useRef();
  const storageKey            = `hypr_${type.toLowerCase()}_${token}`;

  useEffect(()=>{
    try { const s=localStorage.getItem(storageKey); if(s){setData(JSON.parse(s));return;} } catch{}
    if(serverData){
      try{
        const parsed=typeof serverData==="string"?JSON.parse(serverData):serverData;
        setData(parsed);
      }catch{}
    }
  },[storageKey,serverData]);

  // Upload "legado" (PDOOH ainda usa esse caminho — Excel solto sem
  // popup de filtros). RMND passou a usar o RmndUploadModal.
  const handleFile = async (e) => {
    const file = e.target.files?.[0]; if(!file||!XLSX) return;
    setLoading(true);
    try {
      const ab  = await file.arrayBuffer();
      const wb  = XLSX.read(ab);
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws,{header:1});
      let headerIdx=0;
      for(let i=0;i<raw.length;i++){
        const row=raw[i];
        if(row&&row.some(c=>typeof c==="string"&&(c.toUpperCase().includes("DATE")||c.toUpperCase().includes("CAMPAIGN")))){headerIdx=i;break;}
      }
      const headers=raw[headerIdx].map(h=>String(h||"").trim());
      const rows=raw.slice(headerIdx+1).filter(r=>r&&r[0]).map(r=>{
        const obj={};headers.forEach((h,i)=>{obj[h]=r[i];});return obj;
      });
      const parsed={type,rows,headers,uploadedAt:new Date().toISOString()};
      setData(parsed);
      try{localStorage.setItem(storageKey,JSON.stringify(parsed));}catch{}
      saveUpload({
        short_token: token,
        type,
        data_json: JSON.stringify(parsed),
        adminJwt,
      })
        .then(() => toast.success(`Base ${type} de ${token} salva`))
        .catch((e) => {
          console.warn("Erro ao salvar upload", e);
          toast.error(`Erro ao salvar base ${type} no servidor`);
        });
    } catch(err){toast.error("Erro ao ler arquivo: "+err.message);}
    finally{setLoading(false);}
  };

  const clear=()=>{setData(null);try{localStorage.removeItem(storageKey);}catch{} if(fileRef.current)fileRef.current.value="";};

  const isRmnd = type === "RMND";

  // Modal stylesheet (injetado em todos os componentes filhos consistente)
  const modalTheme = {
    text: isDark ? C.white : "#1C262F",
    muted: isDark ? C.muted : "#6B7A8D",
    modalBg: isDark ? C.dark2 : "#FFFFFF",
    modalBdr: isDark ? C.dark3 : "#DDE2EC",
    inputBg: isDark ? C.dark3 : "#F4F6FA",
  };

  if(!data) {
    const muted = isDark ? C.muted : "#6B7A8D";
    const text  = isDark ? C.white : "#1C262F";
    const bg3   = isDark ? C.dark3 : "#EEF1F7";
    return (
      <>
        <div style={{padding:"40px 0",textAlign:"center"}}>
          <div style={{fontSize:48,marginBottom:16}}>📂</div>
          <h3 style={{fontSize:18,fontWeight:700,marginBottom:8,color:text}}>{type}</h3>
          <p style={{color:muted,fontSize:14,marginBottom:32,maxWidth:440,margin:"0 auto 32px"}}>
            {readOnly
              ? "Nenhum dado disponível para esta campanha ainda."
              : isRmnd
                ? "Suba o relatório do Amazon Ads pra montar a aba RMND. Você poderá filtrar grupos de anúncios e período antes de salvar."
                : "Faça upload do relatório PDOOH (Excel) para visualizar os dados desta campanha."}
          </p>
          {!readOnly && (
            isRmnd ? (
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                style={{background:C.blue,color:"#fff",padding:"14px 32px",borderRadius:10,border:"none",cursor:"pointer",fontSize:15,fontWeight:700}}
              >
                Subir base RMND
              </button>
            ) : (
              <>
                <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{display:"none"}} id={`upload-${type}-${token}`}/>
                <label htmlFor={`upload-${type}-${token}`} style={{background:!XLSX?bg3:C.blue,color:"#fff",padding:"14px 32px",borderRadius:10,cursor:!XLSX?"not-allowed":"pointer",fontSize:15,fontWeight:700,display:"inline-block",opacity:!XLSX?0.6:1}}>
                  {loading?"Carregando...":!XLSX?"Carregando biblioteca...":"Selecionar Arquivo"}
                </label>
                <p style={{marginTop:16,fontSize:12,color:`${muted}80`}}>Formatos aceitos: .xlsx, .xls</p>
              </>
            )
          )}
        </div>
        {isRmnd && modalOpen && (
          <RmndUploadModal
            shortToken={token}
            existing={data}
            adminJwt={adminJwt}
            theme={modalTheme}
            onClose={() => setModalOpen(false)}
            onSaved={(payload) => { setData(payload); setModalOpen(false); }}
          />
        )}
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
        {modalOpen && (
          <RmndUploadModal
            shortToken={token}
            existing={data}
            adminJwt={adminJwt}
            theme={modalTheme}
            onClose={() => setModalOpen(false)}
            onSaved={(payload) => { setData(payload); setModalOpen(false); }}
          />
        )}
      </>
    );
  }
  return <PdoohDashboard data={data} onClear={readOnly?null:clear} isDark={isDark}/>;
};

export default UploadTab;
