import { useState, useEffect } from "react";

export const useXlsx = () => {
  const [lib, setLib] = useState(null);
  useEffect(()=>{
    if (window.XLSX) { setLib(window.XLSX); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => setLib(window.XLSX);
    document.head.appendChild(s);
  },[]);
  return lib;
};
