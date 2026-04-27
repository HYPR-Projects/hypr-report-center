import { useState, useEffect, useRef } from "react";
import { API_URL } from "../shared/config";
import { C } from "../shared/theme";
import { adminAuthHeaders } from "../shared/auth";
import { useXlsx } from "../shared/useXlsx";
import RmndDashboard from "./RmndDashboard";
import PdoohDashboard from "./PdoohDashboard";

const UploadTab = ({ type, token, serverData, readOnly, adminJwt }) => {
  const XLSX       = useXlsx();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
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
      fetch(`${API_URL}?action=save_upload`,{
        method:"POST",
        headers:{"Content-Type":"application/json", ...adminAuthHeaders(adminJwt)},
        body:JSON.stringify({short_token:token,type,data_json:JSON.stringify(parsed)})
      }).catch(e=>console.warn("Erro ao salvar upload",e));
    } catch(err){alert("Erro ao ler arquivo: "+err.message);}
    finally{setLoading(false);}
  };

  const clear=()=>{setData(null);try{localStorage.removeItem(storageKey);}catch{} if(fileRef.current)fileRef.current.value="";};

  if(!data) return (
    <div style={{padding:"40px 0",textAlign:"center"}}>
      <div style={{fontSize:48,marginBottom:16}}>📂</div>
      <h3 style={{fontSize:18,fontWeight:700,marginBottom:8}}>{type}</h3>
      <p style={{color:C.muted,fontSize:14,marginBottom:32,maxWidth:400,margin:"0 auto 32px"}}>
        {readOnly
          ? "Nenhum dado disponível para esta campanha ainda."
          : type==="RMND"
            ?"Faça upload do relatório Amazon Ads (Excel) para visualizar os dados de RMND desta campanha."
            :"Faça upload do relatório PDOOH (Excel) para visualizar os dados desta campanha."}
      </p>
      {!readOnly&&(
        <>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{display:"none"}} id={`upload-${type}-${token}`}/>
          <label htmlFor={`upload-${type}-${token}`} style={{background:!XLSX?C.dark3:C.blue,color:C.white,padding:"14px 32px",borderRadius:10,cursor:!XLSX?"not-allowed":"pointer",fontSize:15,fontWeight:700,display:"inline-block",opacity:!XLSX?0.6:1}}>
            {loading?"Carregando...":!XLSX?"Carregando biblioteca...":"Selecionar Arquivo"}
          </label>
          <p style={{marginTop:16,fontSize:12,color:`${C.muted}80`}}>Formatos aceitos: .xlsx, .xls</p>
        </>
      )}
    </div>
  );
  if(type==="RMND") return <RmndDashboard data={data} onClear={readOnly?null:clear}/>;
  return <PdoohDashboard data={data} onClear={readOnly?null:clear}/>;
};

// ── RMND Dashboard ────────────────────────────────────────────────────────────

export default UploadTab;
