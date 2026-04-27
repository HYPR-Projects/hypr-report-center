export const fmt  = (n,d=0) => n==null?"—":Number(n).toLocaleString("pt-BR",{minimumFractionDigits:d,maximumFractionDigits:d});
export const fmtR = (n)     => n==null?"—":`R$ ${fmt(n,2)}`;
export const fmtP = (n)     => n==null?"—":`${fmt(n,1)}%`;
export const fmtP2= (n)     => n==null?"—":`${fmt(n,2)}%`;
