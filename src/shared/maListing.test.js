import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeMaEmptyList,
  describeMaCampaignNote,
  describeRecentSkipped,
  formatSyncedAt,
  MA_EMPTY_REASONS,
} from "./maListing.js";

// O caso que motivou tudo isto: PPV8JF, lista vazia, "Nenhum criativo
// encontrado" — e nenhuma pista de qual das três causas era.

const broad = (over = {}) => ({
  scope: "campaign", days: 180, recent_days: 30, includes_recent: true,
  campaign_count: 0, creatives: [], diagnostics: null, ...over,
});

test("lista com peças não gera explicação de vazio", () => {
  assert.equal(describeMaEmptyList(broad({ creatives: [{ creative_id: "x" }] })), null);
});

test("lista ampla vazia é problema de coleta, e ainda menciona o diagnóstico da campanha", () => {
  const r = describeMaEmptyList(
    broad({ diagnostics: { reason: "no_dim_match", dim_rows: 843 } }),
    { shortToken: "PPV8JF" },
  );
  assert.equal(r.reason, "all_empty");
  assert.match(r.title, /últimos 30 dias/);
  assert.match(r.title, /campanha nenhuma/);
  assert.match(r.detail, /survey_answer/);
  assert.match(r.detail, /«PPV8JF».*Nenhuma peça com «PPV8JF» no nome/);
});

test("lista cheia sem peça da campanha: nome fora da convenção, com estado da dimensão", () => {
  const r = describeMaCampaignNote(
    broad({
      creatives: [{ creative_id: "a", match: null }, { creative_id: "b", match: null }],
      diagnostics: { reason: "no_dim_match", dim_rows: 843, dim_synced_at: "2026-09-21T11:45:00+00:00" },
    }),
    { shortToken: "PPV8JF" },
  );
  assert.equal(r.reason, MA_EMPTY_REASONS.NO_DIM_MATCH);
  assert.match(r.title, /«PPV8JF»/);
  assert.match(r.detail, /ID-PPV8JF_/);
  assert.match(r.detail, /843 criativos/);
  assert.match(r.detail, /última carga 21\/09 08:45/);   // 11:45Z = 08:45 BRT
  assert.match(r.detail, /2 peças com resposta nos últimos 30 dias, de todas as campanhas/);
  assert.match(r.hint, /renomeie/);
  assert.equal(r.shown, 2);
});

test("dimensão vazia aponta pro cron da plataforma", () => {
  const r = describeMaCampaignNote(
    broad({ creatives: [{ creative_id: "a" }], diagnostics: { reason: "dim_empty", dim_rows: 0 } }),
    { shortToken: "PPV8JF" },
  );
  assert.equal(r.reason, MA_EMPTY_REASONS.DIM_EMPTY);
  assert.match(r.detail, /rollup-creative-events/);
});

test("peça existe sem resposta lista os nomes e aponta pra coleta", () => {
  const names = ["ID-PPV8JF_HYPR_DIAGEO_SELO_SURVEY_CONTROLE", "ID-PPV8JF_HYPR_DIAGEO_SELO_SURVEY_EXPOSTO"];
  const r = describeMaCampaignNote(
    broad({
      creatives: [{ creative_id: "outra" }],
      diagnostics: { reason: "no_responses", dim_matched: 2, dim_names: names },
    }),
    { shortToken: "PPV8JF" },
  );
  assert.equal(r.reason, MA_EMPTY_REASONS.NO_RESPONSES);
  assert.match(r.title, /^2 peças «PPV8JF»/);
  assert.match(r.title, /últimos 180 dias/);
  for (const n of names) assert.ok(r.detail.includes(n));
  assert.match(r.hint, /Tap to Choose/);
});

test("uma peça só concorda em número", () => {
  const r = describeMaCampaignNote(
    broad({ creatives: [{}], diagnostics: { reason: "no_responses", dim_matched: 1, dim_names: ["X"] } }),
    { shortToken: "ABC123" },
  );
  assert.match(r.title, /^1 peça «ABC123»/);
});

test("com peça da campanha na lista não há aviso", () => {
  const p = broad({
    creatives: [{ creative_id: "a", match: "name" }],
    campaign_count: 1,
    diagnostics: null,
  });
  assert.equal(describeMaCampaignNote(p, { shortToken: "PPV8JF" }), null);
  // Mesmo se um diagnóstico vazasse, `match` na lista manda.
  assert.equal(
    describeMaCampaignNote({ ...p, campaign_count: 0, diagnostics: { reason: "no_dim_match" } }),
    null,
  );
});

test("sem diagnóstico não há aviso", () => {
  assert.equal(describeMaCampaignNote(broad({ creatives: [{ creative_id: "a" }] })), null);
});

test("backend antigo (lista só da campanha, sem includes_recent) ainda explica o vazio", () => {
  const r = describeMaEmptyList({ creatives: [], scope: "campaign" }, { shortToken: "PPV8JF" });
  assert.equal(r.reason, "unknown");
  assert.match(r.title, /«PPV8JF»/);
  assert.match(r.hint, /pelo nome/);
});

test("formatSyncedAt converte pra Brasília e tolera lixo", () => {
  assert.equal(formatSyncedAt("2026-09-21T03:05:00Z"), "21/09 00:05");
  assert.equal(formatSyncedAt(""), "");
  assert.equal(formatSyncedAt("não é data"), "");
});

test("ramo amplo deixado de fora por custo vira frase, não silêncio", () => {
  assert.equal(describeRecentSkipped(broad()), "");
  assert.equal(describeRecentSkipped(broad({ includes_recent: false, recent_skipped: null })), "");
  const t = describeRecentSkipped(broad({ includes_recent: false, recent_skipped: "bytes_limit" }));
  assert.match(t, /teto de custo do BigQuery/);
  assert.match(t, /só as peças desta campanha/);
});

test("vazio com ramo amplo de fora explica a campanha E avisa que o amplo não veio", () => {
  const r = describeMaEmptyList(
    broad({ includes_recent: false, recent_skipped: "bytes_limit", diagnostics: { reason: "no_dim_match", dim_rows: 843 } }),
    { shortToken: "PPV8JF" },
  );
  assert.equal(r.reason, "no_dim_match");
  assert.match(r.title, /«PPV8JF»/);
  assert.match(r.detail, /843 criativos/);
  assert.match(r.detail, /teto de custo do BigQuery/);
});
