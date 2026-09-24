import { test } from "node:test";
import assert from "node:assert/strict";
import { addressSubtitle, citiesOf, parseAddress } from "./maAddress.js";

test("endereço completo do geocoder", () => {
  const a = parseAddress("Avenida Baden Powell, Parque Prado, Campinas - SP, 13040-093, Brasil");
  assert.deepEqual(a, { street: "Avenida Baden Powell", district: "Parque Prado", city: "Campinas", uf: "SP" });
  assert.equal(addressSubtitle(a), "Parque Prado · Campinas/SP");
});

test("rua com número e sem bairro", () => {
  const a = parseAddress("Rua Siqueira Campos, 543, Centro Histórico, Porto Alegre - RS, 90010-000, Brasil");
  assert.equal(a.street, "Rua Siqueira Campos, 543");
  assert.equal(a.district, "Centro Histórico");
  const b = parseAddress("Avenida Meriti, 2557, Rio de Janeiro - RJ, 21211-800, Brasil");
  assert.equal(b.street, "Avenida Meriti, 2557");
  assert.equal(b.district, null);
  assert.equal(b.city, "Rio de Janeiro");
});

test("ponto com nome antes da rua", () => {
  const a = parseAddress("Banca da Vargas, Avenida Presidente Vargas, Subsetor Sul-2, Ribeirão Preto - SP, 14025-405, Brasil");
  assert.equal(a.street, "Banca da Vargas, Avenida Presidente Vargas");
  assert.equal(a.district, "Subsetor Sul-2");
  assert.equal(a.city, "Ribeirão Preto");
});

test("texto fora do padrão passa inteiro", () => {
  assert.deepEqual(parseAddress("Loja Moema"), { street: "Loja Moema", district: null, city: null, uf: null });
  assert.equal(parseAddress("").street, "");
  assert.equal(addressSubtitle(parseAddress("Loja Moema")), "");
});

test("cidades ordenadas pelo peso somado", () => {
  const items = [
    { address: { city: "Campinas", uf: "SP" }, weight: 1920 },
    { address: { city: "Rio de Janeiro", uf: "RJ" }, weight: 463 },
    { address: { city: "Rio de Janeiro", uf: "RJ" }, weight: 53 },
    { address: { city: "Campinas", uf: "SP" }, weight: 194 },
    { address: { city: null } , weight: 999 },
  ];
  const c = citiesOf(items);
  assert.deepEqual(c.map((x) => [x.city, x.count, x.weight]), [["Campinas", 2, 2114], ["Rio de Janeiro", 2, 516]]);
});
