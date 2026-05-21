// src/v2/admin/lib/alerts/constants.js
//
// Thresholds e metadados das regras de alertas. Centralizados aqui pra
// facilitar tuning sem mexer no engine ou nas regras individuais.

// ────────────────────────────────────────────────────────────────────────
// Severidades + pesos pro scoring
// ────────────────────────────────────────────────────────────────────────
//
// score = SEVERITY_WEIGHT × log10(1 + impactBrl)
//
// Crítico com R$ 50k de impacto → score ~4700
// Crítico com R$ 500             → score ~2700
// Warning com R$ 50k             → score ~470
//
// Critical sempre vence warning, mas dentro de cada nível o impacto BRL
// reordena. Resultado: campanha grande de R$ 50k em over moderado pesa
// mais que uma de R$ 2k em over extremo.
export const SEVERITY = {
  CRITICAL: "critical",
  WARNING:  "warning",
  INFO:     "info",
  POSITIVE: "positive",
};

export const SEVERITY_WEIGHT = {
  [SEVERITY.CRITICAL]: 1000,
  [SEVERITY.WARNING]:  100,
  [SEVERITY.INFO]:     10,
  [SEVERITY.POSITIVE]: 5,
};

// ────────────────────────────────────────────────────────────────────────
// Categorias (alimentam abas do popover)
// ────────────────────────────────────────────────────────────────────────
export const CATEGORY = {
  OPERATIONAL:  "operational",  // A — saúde do dado, parou, pipeline
  FINANCIAL:    "financial",    // C — tech cost atual + projetado
  CROSS_SIGNAL: "crossSignal",  // E — combinações que indicam algo
  MACRO:        "macro",        // H — agregados por owner/cliente
};

export const CATEGORY_META = {
  [CATEGORY.OPERATIONAL]:  { label: "Operação",   icon: "activity" },
  [CATEGORY.FINANCIAL]:    { label: "Financeiro", icon: "wallet" },
  [CATEGORY.CROSS_SIGNAL]: { label: "Sinais",     icon: "zap" },
  [CATEGORY.MACRO]:        { label: "Conta",      icon: "users" },
};

// ────────────────────────────────────────────────────────────────────────
// Thresholds das regras (em um lugar só pra fácil ajuste)
// ────────────────────────────────────────────────────────────────────────

// A · Operacional
export const STALE_UPDATED_AT_HOURS    = 48;
export const VELOCITY_DECEL_RATIO      = 0.3;   // D-1 < 30% da média
export const VELOCITY_ACCEL_RATIO      = 2.0;   // D-1 > 200% da média
export const MIN_DAYS_FOR_VELOCITY     = 5;     // só avalia velocidade após N dias rodando (D-1 isolado vira ruído)
export const MIN_DAYS_FOR_STOPPED      = 2;     // não alarma "parou" se campanha começou ontem

// C · Tech Cost (mesmas réguas do diagnostico)
export const TECH_COST = {
  noAbs: { healthy: 8,  warning: 10 },
  abs:   { healthy: 10, warning: 12 },
};
export const MIN_BUDGET_FOR_TECH_ALERT = 500;   // ignora tech cost em PIs minúsculos (ruído)

// Limite saudável de over delivery — espelha a classificação do diagnostico:
// 100-125% = OK. Acima disso já é "Over" (alerta). O "excesso" calculado em C4
// e H2 é o volume acima desse teto, em vez do volume acima de 100% — over de
// até 125% é gordura aceitável, não é over delivery problemática.
export const MAX_OK_PACING_RATIO       = 1.25;
export const EXCESS_BRL_THRESHOLD      = 2000;  // mínimo do excesso pra alarmar C4

// E · Cruzados
export const VIEWABILITY_LOW_PCT       = 60;    // < 60% considera ruim
export const FRAUD_CTR_PCT             = 1.5;   // CTR display > 1.5% + CPM baixo = suspeito
export const FRAUD_CPM_BRL             = 0.30;  // CPM display < R$ 0,30 = anormalmente barato

// H · Macro
export const MACRO_OWNER_CRITICAL_MIN  = 5;     // 5+ alertas críticos do mesmo owner
export const MACRO_CLIENT_SUPER_OVER   = 3;     // 3+ super_over no mesmo cliente
export const MACRO_CLIENT_TECH_CRIT    = 3;     // 3+ tech cost crítico no mesmo cliente

// Caps anti-fatigue
export const MAX_ALERTS_TOTAL          = 50;    // não mostra mais que isso
export const MAX_ALERTS_PER_CAMPAIGN   = 3;     // mesmo campanha não passa de 3 alertas

// Análise de custo (sheet de deep-dive)
// ─────────────────────────────────────
// `TARGET_PACING_PCT` é a meta "ideal" pra fechar a campanha — 110% dá
// margem operacional de 10% pra cobrir oscilações sem cair em under, e
// fica dentro da banda OK (100-125%). Usado pra calcular:
//   • quanto deveríamos ter gastado até hoje pra estar no pacing alvo
//   • quanto vamos gastar até o fim se mantivermos ritmo
//   • o ajuste % de gasto diário pra realinhar
export const TARGET_PACING_PCT         = 110;
