// Os filtros transversais do PMP Deals. O que estes testes travam é a regra
// que TODA view (Lista, No ar, Carteira, Histórico e Analytics) tem que
// aplicar do mesmo jeito — foi divergir aqui que fez a aba Analytics ignorar
// "Fonte · PubMatic" e mostrar dois totais contraditórios na mesma tela.

import test from "node:test";
import assert from "node:assert/strict";
import { filterPmpLines, matchesPmpFilters, lineSource, lineSearchHaystack, FILTER_ALL } from "./pmpFilters.js";
import { effectiveStatus } from "./pmpFormat.js";

const statusOf = effectiveStatus;

const LINES = [
  { line_id: 1, source: "xandr",    customer: "Ambev",   campaign_name: "Brahma Verão", line_name: "L1",
    bid_type: "flex",  status: "Andamento",  short_token: "ABC12", agency: "MediaCom", cp_email: "cp@x.com" },
  { line_id: 2, source: "pubmatic", customer: "Ambev",   campaign_name: "Brahma Verão", line_name: "L2",
    bid_type: "fixed", status: "Andamento",  short_token: "DEF34" },
  { line_id: 3, source: "pubmatic", customer: "Itaú",    campaign_name: "Cartões Q3",   line_name: "L3",
    bid_type: "flex",  status: "Finalizado", short_token: "GHI56" },
  { line_id: 4, source: null,       customer: "Vivo",    campaign_name: "Fibra",        line_name: "L4",
    bid_type: null,    status: "Pendente", delivery_status: "live" },
  { line_id: 5, source: "xandr",    customer: "Vivo",    campaign_name: "Fibra",        line_name: "L5",
    bid_type: "flex",  status: "Cancelado" },
];

const ids = (arr) => arr.map((l) => l.line_id);

test("sem critério nenhum, nada é filtrado", () => {
  assert.deepEqual(ids(filterPmpLines(LINES, { statusOf })), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(filterPmpLines(LINES, {})), [1, 2, 3, 4, 5]);
});

test("fonte: PubMatic só devolve lines da PubMatic", () => {
  assert.deepEqual(ids(filterPmpLines(LINES, { source: "pubmatic", statusOf })), [2, 3]);
});

test("fonte: line sem `source` conta como Xandr (backend antigo)", () => {
  assert.equal(lineSource({ line_id: 9 }), "xandr");
  assert.deepEqual(ids(filterPmpLines(LINES, { source: "xandr", statusOf })), [1, 4, 5]);
});

test("fonte: FILTER_ALL não recorta", () => {
  assert.equal(filterPmpLines(LINES, { source: FILTER_ALL, statusOf }).length, LINES.length);
});

test("cliente: multi-select é união", () => {
  assert.deepEqual(ids(filterPmpLines(LINES, { customers: ["Ambev"], statusOf })), [1, 2]);
  assert.deepEqual(ids(filterPmpLines(LINES, { customers: ["Ambev", "Itaú"], statusOf })), [1, 2, 3]);
  assert.deepEqual(ids(filterPmpLines(LINES, { customers: [], statusOf })), [1, 2, 3, 4, 5]);
});

test("bid: flex/fixed e o placeholder '—' pra line sem bid", () => {
  assert.deepEqual(ids(filterPmpLines(LINES, { bidType: "flex", statusOf })), [1, 3, 5]);
  assert.deepEqual(ids(filterPmpLines(LINES, { bidType: "fixed", statusOf })), [2]);
  assert.deepEqual(ids(filterPmpLines(LINES, { bidType: "—", statusOf })), [4]);
});

test("status: usa o status EFETIVO (deriva da entrega quando é Pendente)", () => {
  // line 4 é status "Pendente" com delivery_status "live" → efetivo Andamento.
  assert.deepEqual(ids(filterPmpLines(LINES, { statuses: ["Andamento"], statusOf })), [1, 2, 4]);
  assert.deepEqual(ids(filterPmpLines(LINES, { statuses: ["Finalizado", "Cancelado"], statusOf })), [3, 5]);
  // Sem `statusOf`, cai no status cru — é o contrato do parâmetro.
  assert.deepEqual(ids(filterPmpLines(LINES, { statuses: ["Andamento"] })), [1, 2]);
});

test("busca livre cobre id, nome, cliente, campanha, agência, token e e-mails", () => {
  assert.deepEqual(ids(filterPmpLines(LINES, { search: "brahma", statusOf })), [1, 2]);
  assert.deepEqual(ids(filterPmpLines(LINES, { search: "GHI56", statusOf })), [3]);
  assert.deepEqual(ids(filterPmpLines(LINES, { search: "mediacom", statusOf })), [1]);
  assert.deepEqual(ids(filterPmpLines(LINES, { search: "cp@x.com", statusOf })), [1]);
  assert.deepEqual(ids(filterPmpLines(LINES, { search: "  itaú  ", statusOf })), [3]);
  assert.deepEqual(ids(filterPmpLines(LINES, { search: "nada disso", statusOf })), []);
});

test("busca é case-insensitive e não explode com campos ausentes", () => {
  assert.equal(lineSearchHaystack({}), "");
  assert.deepEqual(ids(filterPmpLines(LINES, { search: "AMBEV", statusOf })), [1, 2]);
});

test("filtros combinam em AND", () => {
  assert.deepEqual(
    ids(filterPmpLines(LINES, { source: "pubmatic", customers: ["Ambev"], statusOf })),
    [2],
  );
  assert.deepEqual(
    ids(filterPmpLines(LINES, { source: "pubmatic", customers: ["Ambev"], bidType: "flex", statusOf })),
    [],
  );
  assert.deepEqual(
    ids(filterPmpLines(LINES, { search: "fibra", statuses: ["Andamento"], statusOf })),
    [4],
  );
});

test("matchesPmpFilters é a unidade da regra", () => {
  assert.equal(matchesPmpFilters(LINES[1], { source: "pubmatic" }), true);
  assert.equal(matchesPmpFilters(LINES[1], { source: "xandr" }), false);
});

test("filtrar não muta a lista de entrada", () => {
  const snapshot = JSON.stringify(LINES);
  filterPmpLines(LINES, { source: "pubmatic", search: "ambev", statusOf });
  assert.equal(JSON.stringify(LINES), snapshot);
});
