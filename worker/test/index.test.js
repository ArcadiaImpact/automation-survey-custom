import assert from "node:assert/strict";
import { openDatabase, fakeD1, envelope, finalEnvelope, plain } from "./helpers.js";
import { handleRequest, runCleanup, allowedOrigin, secretsMatch } from "../src/index.js";
import { MAX_BODY } from "../src/validate.js";

const PAGES = "https://arcadiaimpact.github.io";
function makeEnv(overrides = {}) {
  const db = openDatabase();
  return {
    db,
    env: {
      DB: fakeD1(db),
      ALLOWED_ORIGINS: `${PAGES},http://127.0.0.1:8000`,
      EXPORT_SECRET: "test-secret",
      ...overrides,
    },
  };
}
const post = (body, headers = {}) =>
  new Request("https://worker.example/", { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8", ...headers }, body });
const rows = (db, table) => db.prepare(`SELECT * FROM ${table}`).all().map(plain);

// pure helpers
assert.equal(allowedOrigin(PAGES, `${PAGES},http://127.0.0.1:8000`), PAGES);
assert.equal(allowedOrigin("https://evil.example", `${PAGES},http://127.0.0.1:8000`), null);
assert.equal(allowedOrigin(null, PAGES), null);
assert.equal(allowedOrigin("http://127.0.0.1:8000", ` ${PAGES} , http://127.0.0.1:8000 `), "http://127.0.0.1:8000", "whitespace tolerated");
assert.equal(secretsMatch("abc", "abc"), true);
assert.equal(secretsMatch("abc", "abd"), false);
assert.equal(secretsMatch("abc", "abcd"), false);
assert.equal(secretsMatch("", ""), true);

// health check, with and without an allowed origin
{
  const { env } = makeEnv();
  const res = await handleRequest(new Request("https://worker.example/"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, message: "Automation survey endpoint is running." });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);

  const cors = await handleRequest(new Request("https://worker.example/", { headers: { Origin: PAGES } }), env);
  assert.equal(cors.headers.get("Access-Control-Allow-Origin"), PAGES);
  assert.equal(cors.headers.get("Vary"), "Origin");
  assert.equal(cors.headers.get("Cache-Control"), "no-store");
}

// a valid draft from the survey page is stored and acknowledged
{
  const { db, env } = makeEnv();
  const body = JSON.stringify(envelope({ revision: 2 }));
  const res = await handleRequest(post(body, { Origin: PAGES }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, response_id: envelope().response_id, accepted_revision: 2, status: "draft" });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), PAGES);
  assert.equal(rows(db, "responses").length, 1);
}

// a final from a command-line tool (no Origin) is processed
{
  const { db, env } = makeEnv();
  const res = await handleRequest(post(JSON.stringify(finalEnvelope({ revision: 1 }))), env);
  assert.equal((await res.json()).status, "submitted");
  assert.equal(rows(db, "responses")[0].status, "submitted");
}

// a foreign origin is refused before anything is stored
{
  const { db, env } = makeEnv();
  const res = await handleRequest(post(JSON.stringify(envelope()), { Origin: "https://evil.example" }), env);
  assert.equal(res.status, 403);
  assert.equal(rows(db, "responses").length, 0);
}

// validation failures come back as ok:false JSON with HTTP 200 (the client's contract)
{
  const { db, env } = makeEnv();
  for (const [body, code] of [
    ["{", "invalid_json"],
    ["", "empty_body"],
    [JSON.stringify(envelope({ honeypot: "bot" })), "spam"],
    [JSON.stringify(envelope({ unexpected: 1 })), "unknown_field"],
    ["x".repeat(MAX_BODY + 1), "too_large"],
  ]) {
    const res = await handleRequest(post(body, { Origin: PAGES }), env);
    assert.equal(res.status, 200, code);
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.equal(json.code, code);
  }
  assert.equal(rows(db, "responses").length, 0);
}

// an absurd declared length is refused without reading the body
{
  const { env } = makeEnv();
  const res = await handleRequest(post("{}", { "Content-Length": String(MAX_BODY * 4 + 1) }), env);
  assert.equal((await res.json()).code, "too_large");
}

// a database failure is a retryable server_error, not a crash
{
  const { env } = makeEnv({ DB: { prepare: () => ({ bind: () => ({}) }), batch: async () => { throw new Error("D1 down"); } } });
  const res = await handleRequest(post(JSON.stringify(envelope())), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, code: "server_error", message: "The response could not be saved." });
}

// preflight, just in case the content type ever changes
{
  const { env } = makeEnv();
  const res = await handleRequest(new Request("https://worker.example/", { method: "OPTIONS", headers: { Origin: PAGES } }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), PAGES);
  assert.equal(res.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
}

// export: secret required, then pages by cursor; garbage params fall back
{
  const { env } = makeEnv();
  await handleRequest(post(JSON.stringify(envelope({ revision: 1 }))), env);
  await handleRequest(post(JSON.stringify(envelope({ revision: 2 }))), env);

  const noAuth = await handleRequest(new Request("https://worker.example/export?after=0"), env);
  assert.equal(noAuth.status, 401);
  assert.equal((await noAuth.json()).ok, false);

  const wrong = await handleRequest(new Request("https://worker.example/export", { headers: { Authorization: "Bearer nope" } }), env);
  assert.equal(wrong.status, 401);

  const auth = { Authorization: "Bearer test-secret" };
  const page = await (await handleRequest(new Request("https://worker.example/export?after=0&limit=1", { headers: auth }), env)).json();
  assert.equal(page.ok, true);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].revision, 1);
  assert.equal(page.responses[0].revision, 2, "current row, not historical");
  assert.equal(page.next_after, 1);

  const rest = await (await handleRequest(new Request(`https://worker.example/export?after=${page.next_after}`, { headers: auth }), env)).json();
  assert.equal(rest.events.length, 1);
  assert.equal(rest.next_after, 2);

  const garbage = await (await handleRequest(new Request("https://worker.example/export?after=abc&limit=-5", { headers: auth }), env)).json();
  assert.equal(garbage.events.length, 1, "after=abc means 0, limit=-5 means 1");
  assert.equal(garbage.next_after, 1);

  const huge = await (await handleRequest(new Request("https://worker.example/export?after=1e9", { headers: auth }), env)).json();
  assert.deepEqual(huge, { ok: true, events: [], responses: [], next_after: 1000000000 });
}

// a missing EXPORT_SECRET never opens the export
{
  const { env } = makeEnv({ EXPORT_SECRET: undefined });
  const res = await handleRequest(new Request("https://worker.example/export", { headers: { Authorization: "Bearer " } }), env);
  assert.equal(res.status, 401);
}

// anything else is 404
{
  const { env } = makeEnv();
  assert.equal((await handleRequest(new Request("https://worker.example/nope"), env)).status, 404);
  assert.equal((await handleRequest(new Request("https://worker.example/export", { method: "POST" }), env)).status, 404);
}

// the scheduled job removes idle drafts
{
  const { db, env } = makeEnv();
  await handleRequest(post(JSON.stringify(envelope({ revision: 1 }))), env);
  db.prepare("UPDATE responses SET updated_at = '2026-10-01T00:00:00.000Z'").run();
  const removed = await runCleanup(env);
  assert.deepEqual(removed, { responses: 1, events: 1 });
  assert.equal(rows(db, "responses").length, 0);
}

console.log("index.test.js passed");
