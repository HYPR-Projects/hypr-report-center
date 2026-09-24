import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFilename } from "./download.js";

test("nome de arquivo sem acento nem símbolo", () => {
  assert.equal(safeFilename("Lançamento Verão 2026 — Always On - Por Audiência", "csv"), "Lancamento_Verao_2026_Always_On_Por_Audiencia.csv");
  assert.equal(safeFilename("", "csv"), "arquivo.csv");
  assert.equal(safeFilename("***"), "arquivo");
});
