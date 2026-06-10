import { useState, useEffect } from "react";

// Carrega o SheetJS sob demanda e devolve o namespace (ou null enquanto
// carrega — os modais desabilitam o botão de upload até resolver).
//
// Usa a MESMA lib do bundle (xlsx 0.18.5 via import dinâmico) que o resto
// do app já usa (PmpDealsPage, videoaskParser, diagnosticoExport). Antes
// este hook injetava o xlsx.full.min.js do cdnjs — uma segunda cópia da
// lib e uma dependência de CDN externo (fora do ar / bloqueado na rede do
// cliente = upload quebrado). Os parsers (rmndParse/pdoohParse) só chamam
// XLSX.read e XLSX.utils.sheet_to_json, presentes e idênticos no build npm.
export const useXlsx = () => {
  const [lib, setLib] = useState(null);
  useEffect(() => {
    let alive = true;
    import("xlsx").then((mod) => {
      if (alive) setLib(mod);
    });
    return () => { alive = false; };
  }, []);
  return lib;
};
