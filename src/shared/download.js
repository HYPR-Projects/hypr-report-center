// src/shared/download.js
//
// Downloads gerados no navegador (CSV). Nome do arquivo sem acento nem
// símbolo: alguns navegadores/ambientes trocam nome com caractere não-ASCII
// por "download" — a exportação de PNG já fazia o mesmo (slugifyFilename).

export function safeFilename(name, ext = "") {
  const base =
    String(name || "arquivo")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "arquivo";
  return ext ? `${base}.${ext}` : base;
}

/** Baixa um CSV (UTF-8 com BOM, para o Excel abrir os acentos certo). */
export function downloadCsvText(csv, name) {
  const blob = new Blob([String.fromCharCode(0xfeff) + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = safeFilename(name, "csv");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
