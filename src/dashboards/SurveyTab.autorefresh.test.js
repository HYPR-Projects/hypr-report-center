// Invariantes do auto-refresh da aba Survey.
//
// A aba recarrega sozinha de POLL_INTERVAL_MS em POLL_INTERVAL_MS. Três
// propriedades desse ciclo são invisíveis em code review e catastróficas em
// produção, cada uma de um jeito diferente:
//
//   1. ciclo SILENCIOSO — se `setLoading(true)` escapar do `if(!silent)`, a
//      aba inteira pisca em spinner de minuto em minuto. O cliente está
//      lendo um gráfico e ele desaparece;
//   2. só com a ABA VISÍVEL — sem a guarda, report aberto e esquecido numa
//      aba de fundo recarrega pra sempre, sem leitor nenhum do outro lado;
//   3. intervalo não-degenerado — um valor baixo (ou zero, num typo) transforma
//      o report em gerador de tráfego. O cache do backend é 5 min: ciclo mais
//      rápido não deixa o dado mais novo, só gasta invocação.
//
// Não há DOM nem React nos testes deste repo (`node --test` em módulos puros),
// então isto lê o SOURCE. Teste estrutural, mesmo espírito do
// backend/tests/test_pool_isolation.py: brittle de propósito, porque o que
// está guardado não é o formato do código — é a intenção dele.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  fileURLToPath(new URL("./SurveyTab.jsx", import.meta.url)),
  "utf-8",
);

// Colapsa espaço pra que a asserção sobreviva a reindentação/prettier.
const FLAT = SOURCE.replace(/\s+/g, " ");

test("POLL_INTERVAL_MS existe e não é degenerado", () => {
  const m = SOURCE.match(/const\s+POLL_INTERVAL_MS\s*=\s*(\d+)/);
  assert.ok(m, "POLL_INTERVAL_MS desapareceu — o auto-refresh saiu do ar");
  const ms = Number(m[1]);
  assert.ok(
    ms >= 30_000,
    `POLL_INTERVAL_MS=${ms}ms é mais rápido que o piso de 30s. O backend ` +
      `cacheia 5 min: ciclo mais curto não traz dado novo, só custo.`,
  );
  assert.ok(
    ms <= 300_000,
    `POLL_INTERVAL_MS=${ms}ms passa do TTL do backend (5 min): o dado ` +
      `envelheceria esperando o próximo ciclo, que é o bug original.`,
  );
});

test("o ciclo automático não mostra spinner", () => {
  // Todo setLoading(true) tem que estar atrás do `!silent`.
  const abertos = FLAT.match(/setLoading\(true\)/g) || [];
  assert.equal(
    abertos.length,
    1,
    "mais de um setLoading(true) no arquivo — confira se algum ficou no " +
      "caminho do refresh automático",
  );
  assert.ok(
    /if\s*\(\s*!silent\s*\)\s*\{\s*setLoading\(true\)/.test(FLAT),
    "setLoading(true) não está mais guardado por `!silent`: a aba vai " +
      "piscar em spinner a cada ciclo de auto-refresh",
  );
});

test("o ciclo automático não roda em aba de fundo", () => {
  assert.ok(
    /visibilityState\s*!==\s*"visible"\s*\)\s*return/.test(FLAT),
    "a guarda de visibilidade saiu: report esquecido numa aba de fundo " +
      "passaria a recarregar pra sempre sem leitor",
  );
  // A guarda tem que estar DENTRO do callback do setInterval, não só no
  // handler de foco — são duas guardas distintas com o mesmo texto.
  const intervalo = FLAT.match(/setInterval\(\s*\(\)\s*=>\s*\{(.*?)\}\s*,\s*POLL_INTERVAL_MS/);
  assert.ok(intervalo, "não achei o callback do setInterval do auto-refresh");
  assert.ok(
    intervalo[1].includes("visibilityState"),
    "o callback do setInterval não checa visibilidade",
  );
});

test("o refresh automático não apaga dado bom da tela em caso de falha", () => {
  // setError só pode ser chamado com mensagem quando NÃO é ciclo silencioso.
  assert.ok(
    /if\s*\(\s*!cancelled\s*&&\s*!silent\s*\)/.test(FLAT),
    "o catch não distingue mais ciclo silencioso: um 502 transitório do " +
      "Typeform trocaria o número que o cliente está lendo por uma " +
      "mensagem de erro",
  );
});
