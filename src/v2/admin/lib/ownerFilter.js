// src/v2/admin/lib/ownerFilter.js
//
// Lógica do filtro multi-owner. Vive separado da UI pra ser reusada em
// CampaignMenuV2 (campanhas + clientes) e ClientDetailPage.
//
// Semântica
// ─────────
//   - DENTRO do mesmo papel (vários CPs OU vários CSs): OR
//   - ENTRE papéis (CP + CS):                            AND
//
// Exemplo:
//   Selecionado: Camila (CP), Eduarda (CP), João (CS)
//   Match:       (cp_email ∈ {Camila, Eduarda}) AND (cs_email = João)
//
// Por que assim
// ─────────────
// Antes era OR puro: "Camila + João" trazia tudo da Camila + tudo do João,
// mesmo sem trabalharem juntos. User esperava ver só a interseção (campanhas
// onde os dois atuam) — modelo natural quando se pensa em "time CP+CS".
//
// Edge case: se teamMembers ainda não carregou (race condition no boot),
// a função volta pro OR clássico em vez de zerar a lista visualmente. O
// AND entra assim que os papéis ficam conhecidos.

/**
 * Retorna uma função `(campaign) => boolean` que aplica o filtro de owners.
 * Memoizar do lado do caller via useMemo([ownerFilter, teamMembers]).
 */
export function createOwnerMatcher(ownerFilter, teamMembers) {
  if (!ownerFilter || ownerFilter.length === 0) {
    return () => true;
  }

  const cpEmails = new Set((teamMembers?.cps || []).map((p) => p.email));
  const csEmails = new Set((teamMembers?.css || []).map((p) => p.email));

  const selectedCPs = ownerFilter.filter((e) => cpEmails.has(e));
  const selectedCSs = ownerFilter.filter((e) => csEmails.has(e));

  // Fallback OR — usado quando o team ainda não chegou (boot) ou todos os
  // emails selecionados não estão classificáveis. Evita esvaziar a lista
  // por ambiguidade momentânea.
  if (selectedCPs.length === 0 && selectedCSs.length === 0) {
    return (c) =>
      ownerFilter.includes(c.cp_email) || ownerFilter.includes(c.cs_email);
  }

  return (c) => {
    const okCp = selectedCPs.length === 0 || selectedCPs.includes(c.cp_email);
    const okCs = selectedCSs.length === 0 || selectedCSs.includes(c.cs_email);
    return okCp && okCs;
  };
}
