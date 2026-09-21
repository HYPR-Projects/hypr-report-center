import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeMaEmptyList,
  describeMaBrowseAll,
  formatSyncedAt,
  MA_EMPTY_REASONS,
} from "./maListing.js";

// O caso que motivou tudo isto: PPV8JF, lista vazia, "Nenhum criativo
// encontrado" — e nenhuma pista de qual das três causas era.

test("lista cheia não gera explicação", () => {
  assert.equal(describeMaEmptyList({ creatives: [{ creative_id: "x" }] }), null);
});

test("dimensão vazia aponta pro cron da plataforma e oferece busca ampla", () => {
  const r = describeMaEmptyList(
    { creatives: [], scope: "campaign", days: 180, diagnostics: { reason: "dim_empty", dim_rows: 0 } },
    { shortToken: "PPV8JF" },
  );
  assert.equal(r.reason, MA_EMPTY_REASONS.DIM_EMPTY);
  assert.match(r.detail, /rollup-creative-events/);
  assert.equal(r.canBrowseAll, true);
});

test("nome fora da convenção mostra a convenção, o estado da dimensão e a saída", () => {
  const r = describeMaEmptyList(
    {
      creatives: [], scope: "campaign", days: 180,
      diagnostics: { reason: "no_dim_match", dim_rows: 412, dim_synced_at: "2026-09-21T15:30:00+00:00" },
    },
    { shortToken: "PPV8JF" },
  );
  assert.equal(r.reason, MA_EMPTY_REASONS.NO_DIM_MATCH);
  assert.match(r.title, /«PPV8JF»/);
  assert.match(r.detail, /ID-PPV8JF_/);
  assert.match(r.detail, /412 criativos/);
  assert.match(r.detail, /última carga 21\/09 12:30/);   // 15:30Z = 12:30 BRT
  assert.match(r.hint, /renomeie/);
  assert.equal(r.canBrowseAll, true);
});

test("peça existe sem resposta lista os nomes e aponta pra coleta", () => {
  const names = ["ID-PPV8JF_HYPR_DIAGEO_SELO_SURVEY_CONTROLE", "ID-PPV8JF_HYPR_DIAGEO_SELO_SURVEY_EXPOSTO"];
  const r = describeMaEmptyList(
    {
      creatives: [], scope: "campaign", days: 180,
      diagnostics: { reason: "no_responses", dim_matched: 2, dim_names: names },
    },
    { shortToken: "PPV8JF" },
  );
  assert.equal(r.reason, MA_EMPTY_REASONS.NO_RESPONSES);
  assert.match(r.title, /^2 criativos «PPV8JF»/);
  assert.match(r.title, /últimos 180 dias/);
  for (const n of names) assert.ok(r.detail.includes(n));
  assert.match(r.hint, /Tap to Choose/);
});

test("um criativo só concorda em número", () => {
  const r = describeMaEmptyList(
    { creatives: [], scope: "campaign", diagnostics: { reason: "no_responses", dim_matched: 1, dim_names: ["X"] } },
    { shortToken: "ABC123" },
  );
  assert.match(r.title, /^1 criativo «ABC123»/);
});

test("backend antigo (sem diagnostics) ainda oferece a busca ampla", () => {
  const r = describeMaEmptyList({ creatives: [] }, { shortToken: "PPV8JF" });
  assert.equal(r.reason, "unknown");
  assert.equal(r.canBrowseAll, true);
  assert.match(r.title, /«PPV8JF»/);
});

test("busca ampla vazia é problema de coleta, não de campanha, e não oferece busca ampla de novo", () => {
  const r = describeMaEmptyList({ creatives: [], scope: "all", days: 30 }, { shortToken: "PPV8JF" });
  assert.equal(r.reason, "all_empty");
  assert.equal(r.canBrowseAll, false);
  assert.match(r.title, /últimos 30 dias/);
  assert.match(r.detail, /survey_answer/);
});

test("aviso de busca ampla diz a janela e que a campanha não está filtrada", () => {
  const r = describeMaBrowseAll(
    { scope: "all", days: 30, creatives: [{}, {}, {}] },
    { shortToken: "PPV8JF" },
  );
  assert.match(r.title, /3 criativos/);
  assert.match(r.title, /últimos 30 dias/);
  assert.match(r.title, /«PPV8JF»/);
  assert.equal(describeMaBrowseAll({ scope: "campaign", creatives: [] }), null);
});

test("formatSyncedAt converte pra Brasília e tolera lixo", () => {
  assert.equal(formatSyncedAt("2026-09-21T03:05:00Z"), "21/09 00:05");
  assert.equal(formatSyncedAt(""), "");
  assert.equal(formatSyncedAt("não é data"), "");
});
