// src/shared/tokens.js
//
// Design tokens do HYPR Report Hub V2.
//
// Esta é a fonte única de verdade para cores, tipografia, espaçamentos,
// raios e elevações usados pelo V2 (e adotados gradualmente pelo Legacy).
//
// ATENÇÃO: este arquivo está intencionalmente VAZIO nesta PR (Fase 0, PR-01).
// O preenchimento acontece na Fase 1 (Design System primitives + tokens),
// onde definiremos:
//
//   • colors        — paleta HYPR oficial:
//                     #1C262F (canvas), #3397B9 (azul signature),
//                     #246C84 (azul escuro), #EDD900 (amarelo, atenção),
//                     #4CB050 (verde, sucesso), #F5272B (vermelho, erro)
//   • typography    — Urbanist em escala consistente
//   • spacing       — escala 4/8/12/16/24/32/48/64
//   • radii         — sm/md/lg
//   • shadows       — elevações sutis
//   • motion        — durations e easings padrão
//   • breakpoints   — mobile-first
//
// Referência cruzada:
//   • src/shared/theme.js  — tema atual do Legacy (será mantido intacto)
//   • src/v2/              — consumidor primário destes tokens
//   • src/ui/              — primitives que aplicam estes tokens
//
// Quando este arquivo for populado (Fase 1), o Legacy continua usando
// shared/theme.js sem nenhuma mudança. Convergência é gradual e opt-in.

export const tokens = {};
