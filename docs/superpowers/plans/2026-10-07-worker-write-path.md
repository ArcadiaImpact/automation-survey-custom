# Worker Write Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Apps Script write path with a Cloudflare Worker backed by D1, and have the Apps Script mirror the Worker's events into the existing Google Sheet every minute.

**Architecture:** The browser keeps sending the same `text/plain` JSON envelope, now to a Worker. The Worker validates with the rules ported from `Code.gs`, applies the revision rules as one atomic D1 batch (upsert guarded by a `WHERE`, event insert guarded by a `SELECT`), and answers with the unchanged acknowledgement JSON. A secret-protected `/export` endpoint pages events by id; `syncFromWorker` in Apps Script pulls pages every minute and writes rows through the existing `createSheetStore_`.

**Tech Stack:** Cloudflare Workers (ES modules) + D1 (SQLite); wrangler 4; Node 23 (`node:sqlite` for tests, plain `assert` scripts like the rest of the repo); Google Apps Script (V8) via clasp.

**Spec:** `docs/superpowers/specs/2026-10-07-worker-write-path-design.md`

## Global Constraints

- Request envelope, validation codes/messages, and acknowledgement JSON are unchanged from `apps-script/Code.gs`; every application-level reply is HTTP 200 JSON.
- `MAX_BODY = 200000` characters; `DRAFT_RETENTION_MS = 48 h`; export page default and maximum `200`.
- Server timestamps are ISO 8601 UTC text (`toISOString()`), never Dates.
- Allowed origins: `https://arcadiaimpact.github.io`, `http://127.0.0.1:8000`, `http://localhost:8000`; any other `Origin` header gets 403.
- Sheet tabs and columns (`analysisColumns_`, `eventColumns_`) do not change.
- Tests are plain scripts run with `node <file>`; no test framework, no new runtime dependencies. `wrangler` is the only dev dependency, under `worker/`.
- Only the user runs `wrangler login`, `d1 create`, `d1 execute --remote`, `secret put`, `deploy`, and the clasp push/redeploy. Claude verifies read-only afterwards.
- Nothing is pushed or merged without the user's explicit "ship it".

## Review Focus

1. A body just over the limit, or with multibyte text, must be refused as `too_large` without being stored. Test in Task 4.
2. Garbage `after`/`limit` query values (`abc`, `-5`, `1e9`) must fall back to `0` / the default page size, never throw. Test in Task 4.
3. An export page whose response row has already been deleted by cleanup must still mirror its events and not crash the sync. Test in Task 5.
4. An exported row whose `raw_json` fails to parse must still be written with its fixed columns and raw text, so one bad row cannot stall the cursor forever. Test in Task 5.
5. Two events for the same response in one page must leave exactly one current row in the Sheet. Test in Task 5.

---

### Task 1: Worker scaffold and validation port

**Files:**
- Create: `worker/package.json`, `worker/.gitignore`, `worker/src/validate.js`, `worker/test/helpers.js`, `worker/test/validate.test.js`

**Interfaces:**
- Produces: `parseRequest(rawBody) → {ok:true, value} | {ok:false, code, message}`, `validateEnvelope(value)`, `validateAnswers(answers, isFinal)`, `validatePoints(points, isFinal)`, `validateHours(hours, isFinal)`, `result(ok, code, message)`, constants `MAX_BODY`, `TASK_IDS`, `ERAS`.
- Test helpers: `validAnswers()`, `draftAnswers()`, `envelope(overrides)` (same fixtures as `apps-script/Code.test.js`).

- [ ] **Step 1: Scaffold the package**

`worker/package.json`:

```json
{
  "name": "automation-survey-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node test/validate.test.js && node test/write.test.js && node test/index.test.js",
    "dev": "wrangler dev --local --port 8787",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^4.148.0"
  }
}
```

`worker/.gitignore`:

```
node_modules/
.wrangler/
.dev.vars
```

- [ ] **Step 2: Write the fixtures helper (no SQLite yet)**

`worker/test/helpers.js`:

```js
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const TASK_IDS = ["conceptual", "design", "infra", "running", "writing", "collaborating"];

export function validAnswers() {
  const points = Object.fromEntries(TASK_IDS.map((id, i) => [id, i === 0 ? 100 : 0]));
  const hours_active_human = Object.fromEntries(
    TASK_IDS.map((id) => [id, { without_ai: null, one_year_ago: null, now: null, in_6_months: null }])
  );
  return {
    email: null,
    job_title: "Research Lead",
    role_type: "Technical AI Safety",
    experience: "2–5 years",
    ai_usage: "Pair programming",
    points,
    hours_active_human,
    hours_notes: null,
    highest_value_to_automate: "Literature review",
    main_reason: "Context gathering",
    agent_tracking: "Git commits",
  };
}

export function draftAnswers() {
  const answers = validAnswers();
  delete answers.email;
  return answers;
}

export function envelope(overrides = {}) {
  return {
    response_id: "123e4567-e89b-42d3-a456-426614174000",
    revision: 3,
    status: "draft",
    last_completed_step: 2,
    content_version: "abcd1234",
    client_updated_at: "2026-10-07T08:00:00.000Z",
    honeypot: "",
    answers: draftAnswers(),
    ...overrides,
  };
}

export function finalEnvelope(overrides = {}) {
  return envelope({ status: "submitted", answers: validAnswers(), ...overrides });
}

// An in-memory SQLite database with the production schema applied.
export function openDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(here, "..", "schema.sql"), "utf8"));
  return db;
}

// Just enough of the D1 client API (prepare/bind/all/run/first/batch) over
// node:sqlite that the production store adapter is what the tests exercise.
// batch() is one transaction, as D1's is.
export function fakeD1(db) {
  const isSelect = (sql) => /^\s*select/i.test(sql);
  const execute = (sql, params) =>
    isSelect(sql)
      ? { success: true, results: db.prepare(sql).all(...params), meta: {} }
      : { success: true, results: [], meta: db.prepare(sql).run(...params) };
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql,
            params,
            async all() { return execute(sql, params); },
            async run() { return execute(sql, params); },
            async first() { return execute(sql, params).results[0] || null; },
          };
        },
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => execute(s.sql, s.params));
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

// node:sqlite returns null-prototype rows; make them plain for deepEqual.
export function plain(row) {
  return row == null ? row : JSON.parse(JSON.stringify(row));
}
```

- [ ] **Step 3: Write the failing validation tests**

`worker/test/validate.test.js`:

```js
import assert from "node:assert/strict";
import { parseRequest, validateEnvelope, MAX_BODY } from "../src/validate.js";
import { envelope, finalEnvelope, validAnswers, draftAnswers } from "./helpers.js";

assert.equal(validateEnvelope(envelope()).ok, true, "a well-formed draft passes");
assert.equal(validateEnvelope(finalEnvelope()).ok, true, "a well-formed final passes");

assert.equal(validateEnvelope("nope").code, "invalid_request");
assert.equal(validateEnvelope(envelope({ unexpected: true })).code, "unknown_field");
assert.equal(validateEnvelope(envelope({ honeypot: "spam" })).code, "spam");
assert.equal(validateEnvelope(envelope({ response_id: "not-a-uuid" })).code, "invalid_id");
assert.equal(validateEnvelope(envelope({ revision: 0 })).code, "invalid_revision");
assert.equal(validateEnvelope(envelope({ revision: 1.5 })).code, "invalid_revision");
assert.equal(validateEnvelope(envelope({ status: "final" })).code, "invalid_status");
assert.equal(validateEnvelope(envelope({ last_completed_step: 5 })).code, "invalid_step");
assert.equal(validateEnvelope(envelope({ content_version: "" })).code, "invalid_content_version");
assert.equal(validateEnvelope(envelope({ client_updated_at: "yesterday" })).code, "invalid_timestamp");

assert.equal(
  validateEnvelope(envelope({ answers: { ...validAnswers(), email: "draft@example.com" } })).code,
  "draft_email",
  "drafts must not carry the email"
);
assert.equal(
  validateEnvelope(envelope({ answers: { ...draftAnswers(), arbitrary: "column injection" } })).code,
  "unknown_answer"
);
assert.equal(
  validateEnvelope(envelope({ answers: { ...draftAnswers(), job_title: "x".repeat(301) } })).code,
  "invalid_text"
);
assert.equal(
  validateEnvelope(envelope({ answers: { ...draftAnswers(), ai_usage: "x".repeat(4001) } })).code,
  "invalid_text"
);

{
  const badTotal = validAnswers();
  badTotal.points = { ...badTotal.points, conceptual: 99 };
  assert.equal(validateEnvelope(finalEnvelope({ answers: badTotal })).code, "invalid_points");
}
{
  const draftTotal = draftAnswers();
  draftTotal.points = { ...draftTotal.points, conceptual: 99 };
  assert.equal(validateEnvelope(envelope({ answers: draftTotal })).ok, true, "drafts may have partial points");
}
{
  const partialHours = validAnswers();
  partialHours.hours_active_human.conceptual = { without_ai: 1, one_year_ago: null, now: 1, in_6_months: 1 };
  assert.equal(validateEnvelope(finalEnvelope({ answers: partialHours })).code, "invalid_hours");
}
{
  const negative = draftAnswers();
  negative.hours_active_human.design.now = -1;
  assert.equal(validateEnvelope(envelope({ answers: negative })).code, "invalid_hours");
}
{
  const missing = validAnswers();
  missing.job_title = "   ";
  assert.equal(validateEnvelope(finalEnvelope({ answers: missing })).code, "missing_required");
}
{
  const noPoints = draftAnswers();
  delete noPoints.points;
  delete noPoints.hours_active_human;
  assert.equal(validateEnvelope(envelope({ answers: noPoints })).ok, true, "drafts may omit points and hours");
  assert.equal(validateEnvelope(finalEnvelope({ answers: { ...validAnswers(), points: undefined } })).code, "invalid_points");
}

assert.equal(parseRequest("").code, "empty_body");
assert.equal(parseRequest("{").code, "invalid_json");
assert.equal(parseRequest("x".repeat(MAX_BODY + 1)).code, "too_large");
{
  const body = JSON.stringify(envelope());
  const parsed = parseRequest(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.response_id, envelope().response_id);
}

console.log("validate.test.js passed");
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd worker && node test/validate.test.js`
Expected: FAIL with `Cannot find module '../src/validate.js'`

- [ ] **Step 5: Port the validation code**

`worker/src/validate.js` (a line-for-line port of `parseRequest_` and friends from `apps-script/Code.gs`; trailing underscores dropped, `export` added):

```js
// Ported from apps-script/Code.gs. The schema is fixed: unknown fields are
// rejected, never stored. Codes and messages are the client's contract.
export const MAX_BODY = 200000; // characters; a real response is ~10–40k at most
export const TASK_IDS = ["conceptual", "design", "infra", "running", "writing", "collaborating"];
export const ERAS = ["without_ai", "one_year_ago", "now", "in_6_months"];

const ENVELOPE_KEYS = [
  "response_id", "revision", "status", "last_completed_step",
  "content_version", "client_updated_at", "honeypot", "answers",
];
const ANSWER_KEYS = [
  "email", "job_title", "role_type", "experience", "ai_usage", "points",
  "hours_active_human", "hours_notes", "highest_value_to_automate",
  "main_reason", "agent_tracking",
];
const SHORT_TEXT_KEYS = ["job_title", "role_type", "experience"];
const LONG_TEXT_KEYS = ["ai_usage", "hours_notes", "highest_value_to_automate", "main_reason", "agent_tracking"];
const REQUIRED_FINAL_TEXT_KEYS = [
  "job_title", "role_type", "experience", "ai_usage",
  "highest_value_to_automate", "main_reason", "agent_tracking",
];

export function result(ok, code, message) {
  return { ok, code: code || "", message: message || "" };
}

export function parseRequest(rawBody) {
  if (!rawBody) return result(false, "empty_body", "Empty request.");
  if (rawBody.length > MAX_BODY) return result(false, "too_large", "Response is too large.");
  let value;
  try {
    value = JSON.parse(rawBody);
  } catch (err) {
    return result(false, "invalid_json", "Invalid JSON.");
  }
  const checked = validateEnvelope(value);
  if (!checked.ok) return checked;
  return { ok: true, value };
}

export function validateEnvelope(value) {
  if (!isObject(value)) return result(false, "invalid_request", "Request must be an object.");
  if (unknownKeys(value, ENVELOPE_KEYS).length) return result(false, "unknown_field", "Unknown request field.");
  if (value.honeypot) return result(false, "spam", "Request rejected.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.response_id || "")) {
    return result(false, "invalid_id", "Invalid response ID.");
  }
  if (!Number.isInteger(value.revision) || value.revision < 1) {
    return result(false, "invalid_revision", "Invalid revision.");
  }
  if (value.status !== "draft" && value.status !== "submitted") {
    return result(false, "invalid_status", "Invalid status.");
  }
  if (!Number.isInteger(value.last_completed_step) || value.last_completed_step < 0 || value.last_completed_step > 4) {
    return result(false, "invalid_step", "Invalid completed step.");
  }
  if (typeof value.content_version !== "string" || !value.content_version || value.content_version.length > 100) {
    return result(false, "invalid_content_version", "Invalid content version.");
  }
  if (typeof value.client_updated_at !== "string" || !Number.isFinite(Date.parse(value.client_updated_at))) {
    return result(false, "invalid_timestamp", "Invalid client timestamp.");
  }
  return validateAnswers(value.answers, value.status === "submitted");
}

export function validateAnswers(answers, isFinal) {
  if (!isObject(answers)) return result(false, "invalid_answers", "Answers must be an object.");
  if (unknownKeys(answers, ANSWER_KEYS).length) return result(false, "unknown_answer", "Unknown answer field.");
  if (!isFinal && has(answers, "email")) return result(false, "draft_email", "Drafts must not contain email.");
  if (has(answers, "email") && !validText(answers.email, 200, true)) {
    return result(false, "invalid_text", "Invalid email.");
  }
  for (const key of SHORT_TEXT_KEYS) {
    if (has(answers, key) && !validText(answers[key], 300, true)) return result(false, "invalid_text", "Invalid " + key + ".");
  }
  for (const key of LONG_TEXT_KEYS) {
    if (has(answers, key) && !validText(answers[key], 4000, true)) return result(false, "invalid_text", "Invalid " + key + ".");
  }
  const pointsResult = validatePoints(answers.points, isFinal);
  if (!pointsResult.ok) return pointsResult;
  const hoursResult = validateHours(answers.hours_active_human, isFinal);
  if (!hoursResult.ok) return hoursResult;
  if (isFinal) {
    for (const key of REQUIRED_FINAL_TEXT_KEYS) {
      if (typeof answers[key] !== "string" || !answers[key].trim()) {
        return result(false, "missing_required", "Missing required answer.");
      }
    }
  }
  return result(true);
}

export function validatePoints(points, isFinal) {
  if (points === undefined && !isFinal) return result(true);
  if (!hasExactKeys(points, TASK_IDS)) return result(false, "invalid_points", "Invalid points.");
  let total = 0;
  for (const id of TASK_IDS) {
    const value = points[id];
    if (!Number.isFinite(value) || value < 0 || value > 100) return result(false, "invalid_points", "Invalid points.");
    total += value;
  }
  if (isFinal && total !== 100) return result(false, "invalid_points", "Points must total 100.");
  return result(true);
}

export function validateHours(hours, isFinal) {
  if (hours === undefined && !isFinal) return result(true);
  if (!hasExactKeys(hours, TASK_IDS)) return result(false, "invalid_hours", "Invalid hours.");
  for (const id of TASK_IDS) {
    const row = hours[id];
    if (!hasExactKeys(row, ERAS)) return result(false, "invalid_hours", "Invalid hours.");
    let nulls = 0;
    for (const era of ERAS) {
      const value = row[era];
      if (value === null) nulls++;
      else if (!Number.isFinite(value) || value < 0) return result(false, "invalid_hours", "Invalid hours.");
    }
    if (isFinal && nulls !== 0 && nulls !== ERAS.length) {
      return result(false, "invalid_hours", "Complete or clear each hours row.");
    }
  }
  return result(true);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}
function hasExactKeys(value, expected) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => has(value, key));
}
function has(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function validText(value, maxLength, allowNull) {
  if (allowNull && value === null) return true;
  return typeof value === "string" && value.length <= maxLength;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd worker && node test/validate.test.js`
Expected: `validate.test.js passed`

- [ ] **Step 7: Commit**

```bash
git add worker/package.json worker/.gitignore worker/src/validate.js worker/test/helpers.js worker/test/validate.test.js
git commit -m "Worker: scaffold and port the request validation from Code.gs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Schema, store adapter, and the atomic write

**Files:**
- Create: `worker/schema.sql`, `worker/src/write.js`, `worker/test/write.test.js`

**Interfaces:**
- Consumes: `result` from `validate.js`; `openDatabase`, `fakeD1`, `envelope`, `finalEnvelope`, `plain` from `test/helpers.js`.
- Produces: `createStore(d1) → {batch(statements), all(sql, params)}` where a statement is `{sql, params}` and `batch` resolves to an array of `{results, meta}`; `writeSnapshot(store, incoming, rawBody, now) → ack`; constants `DRAFT_RETENTION_MS`, `EXPORT_PAGE_LIMIT`.

- [ ] **Step 1: Write the schema**

`worker/schema.sql`:

```sql
-- One current row per response. started_at never changes after insert;
-- submitted_at keeps its first value. Timestamps are ISO 8601 UTC text.
CREATE TABLE IF NOT EXISTS responses (
  response_id         TEXT PRIMARY KEY,
  status              TEXT NOT NULL CHECK (status IN ('draft', 'submitted')),
  revision            INTEGER NOT NULL,
  started_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  submitted_at        TEXT,
  last_completed_step INTEGER NOT NULL,
  content_version     TEXT NOT NULL,
  client_updated_at   TEXT NOT NULL,
  raw_json            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS responses_status_updated ON responses (status, updated_at);

-- Append-only log of accepted writes. id is the mirror's cursor.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_at    TEXT NOT NULL,
  response_id TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  status      TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  UNIQUE (response_id, revision)
);
```

- [ ] **Step 2: Write the failing write tests**

`worker/test/write.test.js`:

```js
import assert from "node:assert/strict";
import { openDatabase, fakeD1, envelope, finalEnvelope, plain } from "./helpers.js";
import { createStore, writeSnapshot } from "../src/write.js";

const ID = envelope().response_id;
const t1 = new Date("2026-10-07T09:00:00.000Z");
const t2 = new Date("2026-10-07T09:45:00.000Z");
const t3 = new Date("2026-10-07T10:30:00.000Z");

function fresh() {
  const db = openDatabase();
  return { db, store: createStore(fakeD1(db)) };
}
async function write(store, body, when) {
  return writeSnapshot(store, body, JSON.stringify(body), when);
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(plain);

// A new response is inserted and its event logged; the ack echoes the row.
{
  const { db, store } = fresh();
  const ack = await write(store, envelope({ revision: 7 }), t1);
  assert.deepEqual(ack, { ok: true, response_id: ID, accepted_revision: 7, status: "draft" });
  const [row] = rows(db, "responses");
  assert.equal(row.revision, 7);
  assert.equal(row.started_at, "2026-10-07T09:00:00.000Z");
  assert.equal(row.updated_at, "2026-10-07T09:00:00.000Z");
  assert.equal(row.submitted_at, null);
  assert.equal(row.raw_json, JSON.stringify(envelope({ revision: 7 })), "body stored untouched");
  const events = rows(db, "events");
  assert.equal(events.length, 1);
  assert.equal(events[0].raw_json, row.raw_json);
  assert.equal(events[0].event_at, "2026-10-07T09:00:00.000Z");
}

// Repeating the same write changes nothing and adds no event.
{
  const { db, store } = fresh();
  await write(store, envelope({ revision: 7 }), t1);
  const again = await write(store, envelope({ revision: 7 }), t2);
  assert.equal(again.accepted_revision, 7);
  assert.equal(rows(db, "events").length, 1);
  assert.equal(rows(db, "responses")[0].updated_at, "2026-10-07T09:00:00.000Z", "idempotent repeat does not touch the row");
}

// An older draft is stale: acknowledged with the current state, nothing written.
{
  const { db, store } = fresh();
  await write(store, envelope({ revision: 7 }), t1);
  const stale = await write(store, envelope({ revision: 6 }), t2);
  assert.deepEqual(stale, { ok: true, response_id: ID, accepted_revision: 7, status: "draft" });
  assert.equal(rows(db, "events").length, 1);
}

// A newer draft replaces the draft; started_at is kept, updated_at moves.
{
  const { db, store } = fresh();
  await write(store, envelope({ revision: 1 }), t1);
  const ack = await write(store, envelope({ revision: 2 }), t2);
  assert.equal(ack.accepted_revision, 2);
  const [row] = rows(db, "responses");
  assert.equal(row.started_at, "2026-10-07T09:00:00.000Z", "started_at keeps the first write time");
  assert.equal(row.updated_at, "2026-10-07T09:45:00.000Z");
  assert.deepEqual(rows(db, "events").map((e) => e.revision), [1, 2]);
}

// A final sets submitted_at once; a later draft can never downgrade it.
{
  const { db, store } = fresh();
  await write(store, envelope({ revision: 4 }), t1);
  const final = await write(store, finalEnvelope({ revision: 5 }), t2);
  assert.deepEqual(final, { ok: true, response_id: ID, accepted_revision: 5, status: "submitted" });
  assert.equal(rows(db, "responses")[0].submitted_at, "2026-10-07T09:45:00.000Z");

  const late = await write(store, envelope({ revision: 6 }), t3);
  assert.deepEqual(late, { ok: true, response_id: ID, accepted_revision: 5, status: "submitted" }, "late draft is stale");
  assert.equal(rows(db, "responses")[0].status, "submitted");
  assert.equal(rows(db, "events").length, 2, "no event for the refused draft");

  const retry = await write(store, finalEnvelope({ revision: 5 }), t3);
  assert.equal(retry.accepted_revision, 5, "repeating the final is idempotent");
  assert.equal(rows(db, "events").length, 2);

  const corrected = await write(store, finalEnvelope({ revision: 6 }), t3);
  assert.equal(corrected.accepted_revision, 6, "a higher-revision final is accepted");
  assert.equal(rows(db, "responses")[0].submitted_at, "2026-10-07T09:45:00.000Z", "submitted_at keeps its first value");
  assert.equal(rows(db, "responses")[0].updated_at, "2026-10-07T10:30:00.000Z");
  assert.equal(rows(db, "events").length, 3);
}

// Two responses never interfere.
{
  const { db, store } = fresh();
  const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await write(store, envelope({ revision: 1 }), t1);
  await write(store, envelope({ response_id: other, revision: 9 }), t1);
  assert.deepEqual(rows(db, "responses").map((r) => [r.response_id, r.revision]), [[ID, 1], [other, 9]]);
}

// The batch is one transaction: a failure in the middle leaves nothing behind.
{
  const { db, store } = fresh();
  await write(store, envelope({ revision: 1 }), t1);
  await assert.rejects(
    store.batch([
      { sql: "INSERT INTO events (event_at, response_id, revision, status, raw_json) VALUES (?, ?, ?, ?, ?)", params: ["x", ID, 99, "draft", "{}"] },
      { sql: "INSERT INTO nowhere VALUES (1)", params: [] },
    ])
  );
  assert.equal(rows(db, "events").length, 1, "the first insert was rolled back");
}

console.log("write.test.js passed");
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd worker && node test/write.test.js`
Expected: FAIL with `Cannot find module '../src/write.js'`

- [ ] **Step 4: Implement the store adapter and the write**

`worker/src/write.js`:

```js
// The revision rules of decideWrite_ in apps-script/Code.gs, expressed as
// one atomic D1 batch so no application lock is needed:
//   1. insert, or update only if the incoming revision is higher and the row
//      is not submitted (or the incoming write is itself submitted);
//   2. log an event only if the row now carries the incoming revision
//      (accepted, or an identical repeat whose event is missing);
//   3. read back the row for the acknowledgement.
import { result } from "./validate.js";

export const DRAFT_RETENTION_MS = 48 * 60 * 60 * 1000;
export const EXPORT_PAGE_LIMIT = 200;

// Thin adapter over the D1 client. Tests pass a D1-shaped shim over node:sqlite.
export function createStore(d1) {
  return {
    async batch(statements) {
      return d1.batch(statements.map((s) => d1.prepare(s.sql).bind(...s.params)));
    },
    async all(sql, params) {
      const out = await d1.prepare(sql).bind(...params).all();
      return out.results;
    },
  };
}

const UPSERT_SQL = `
INSERT INTO responses (response_id, status, revision, started_at, updated_at, submitted_at,
                       last_completed_step, content_version, client_updated_at, raw_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (response_id) DO UPDATE SET
  status = excluded.status,
  revision = excluded.revision,
  updated_at = excluded.updated_at,
  submitted_at = COALESCE(responses.submitted_at, excluded.submitted_at),
  last_completed_step = excluded.last_completed_step,
  content_version = excluded.content_version,
  client_updated_at = excluded.client_updated_at,
  raw_json = excluded.raw_json
WHERE excluded.revision > responses.revision
  AND (responses.status <> 'submitted' OR excluded.status = 'submitted')`;

const EVENT_SQL = `
INSERT OR IGNORE INTO events (event_at, response_id, revision, status, raw_json)
SELECT ?, response_id, revision, status, raw_json FROM responses
WHERE response_id = ? AND revision = ?`;

const CURRENT_SQL = `SELECT response_id, revision, status FROM responses WHERE response_id = ?`;

export async function writeSnapshot(store, incoming, rawBody, now) {
  const nowIso = now.toISOString();
  const results = await store.batch([
    {
      sql: UPSERT_SQL,
      params: [
        incoming.response_id, incoming.status, incoming.revision, nowIso, nowIso,
        incoming.status === "submitted" ? nowIso : null,
        incoming.last_completed_step, incoming.content_version, incoming.client_updated_at, rawBody,
      ],
    },
    { sql: EVENT_SQL, params: [nowIso, incoming.response_id, incoming.revision] },
    { sql: CURRENT_SQL, params: [incoming.response_id] },
  ]);
  const row = results[2].results[0];
  if (!row) return result(false, "missing_response", "Response was not found.");
  return { ok: true, response_id: row.response_id, accepted_revision: Number(row.revision), status: row.status };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd worker && node test/write.test.js`
Expected: `write.test.js passed`

- [ ] **Step 6: Commit**

```bash
git add worker/schema.sql worker/src/write.js worker/test/write.test.js
git commit -m "Worker: D1 schema and the revision rules as one atomic batch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Export paging and draft expiry

**Files:**
- Modify: `worker/src/write.js` (append), `worker/test/write.test.js` (append before the final `console.log`)

**Interfaces:**
- Produces: `pageSize(limit) → integer in [1, 200]`; `exportEvents(store, after, limit) → {events, responses, next_after}`; `deleteExpiredDrafts(store, now) → {responses, events}` counts.

- [ ] **Step 1: Append the failing tests**

Add to `worker/test/write.test.js`, importing `pageSize, exportEvents, deleteExpiredDrafts, DRAFT_RETENTION_MS` from `../src/write.js`:

```js
// ---- export paging ----
assert.equal(pageSize(undefined), 200);
assert.equal(pageSize(0), 200);
assert.equal(pageSize("abc"), 200);
assert.equal(pageSize(-5), 1);
assert.equal(pageSize(1e9), 200);
assert.equal(pageSize(50), 50);

{
  const { store } = fresh();
  assert.deepEqual(await exportEvents(store, 0, 10), { events: [], responses: [], next_after: 0 });
  assert.deepEqual((await exportEvents(store, 42, 10)).next_after, 42, "an empty page keeps the cursor");
}

// Pages follow next_after with no gaps or repeats, and each page carries the
// current row of every response that appears in it.
{
  const { store } = fresh();
  const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await write(store, envelope({ revision: 1 }), t1);
  await write(store, envelope({ response_id: other, revision: 1 }), t1);
  await write(store, envelope({ revision: 2 }), t2);
  await write(store, finalEnvelope({ revision: 3 }), t3);
  await write(store, envelope({ response_id: other, revision: 2 }), t3);

  const page1 = await exportEvents(store, 0, 2);
  assert.deepEqual(page1.events.map((e) => [e.response_id, e.revision]), [[ID, 1], [other, 1]]);
  assert.equal(page1.next_after, 2);
  assert.deepEqual(page1.responses.map((r) => [r.response_id, r.revision, r.status]).sort(),
    [[ID, 3, "submitted"], [other, 2, "draft"]].sort(), "current rows, not the rows as they were");

  const page2 = await exportEvents(store, page1.next_after, 2);
  assert.deepEqual(page2.events.map((e) => [e.response_id, e.revision]), [[ID, 2], [ID, 3]]);
  assert.deepEqual(page2.responses.map((r) => r.response_id), [ID], "only responses in this page");
  assert.equal(page2.events[1].status, "submitted");
  assert.equal(page2.events[1].raw_json, JSON.stringify(finalEnvelope({ revision: 3 })));

  const page3 = await exportEvents(store, page2.next_after, 2);
  assert.deepEqual(page3.events.map((e) => [e.response_id, e.revision]), [[other, 2]]);
  assert.equal(page3.next_after, 5);
  assert.deepEqual(await exportEvents(store, page3.next_after, 2), { events: [], responses: [], next_after: 5 });
}

// ---- draft expiry ----
{
  const { db, store } = fresh();
  const base = Date.parse("2026-10-09T09:00:00.000Z");
  const now = new Date(base);
  const at = (hoursAgo) => new Date(base - hoursAgo * 3600 * 1000);
  const ids = {
    old: "11111111-1111-4111-8111-111111111111",
    boundary: "22222222-2222-4222-8222-222222222222",
    fresh: "33333333-3333-4333-8333-333333333333",
    done: "44444444-4444-4444-8444-444444444444",
  };
  await write(store, envelope({ response_id: ids.old, revision: 1 }), at(49));
  await write(store, envelope({ response_id: ids.boundary, revision: 1 }), at(48));
  await write(store, envelope({ response_id: ids.fresh, revision: 1 }), at(47));
  await write(store, finalEnvelope({ response_id: ids.done, revision: 1 }), at(100));

  const removed = await deleteExpiredDrafts(store, now);
  assert.deepEqual(removed, { responses: 2, events: 2 });
  assert.deepEqual(rows(db, "responses").map((r) => r.response_id).sort(), [ids.fresh, ids.done].sort());
  assert.deepEqual(rows(db, "events").map((e) => e.response_id).sort(), [ids.fresh, ids.done].sort());
  assert.equal(DRAFT_RETENTION_MS, 48 * 60 * 60 * 1000);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd worker && node test/write.test.js`
Expected: FAIL with `does not provide an export named 'pageSize'`

- [ ] **Step 3: Implement export and expiry**

Append to `worker/src/write.js`:

```js
export function pageSize(limit) {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n === 0) return EXPORT_PAGE_LIMIT;
  return Math.max(1, Math.min(n, EXPORT_PAGE_LIMIT));
}

const EVENTS_SQL = `
SELECT id, event_at, response_id, revision, status, raw_json
FROM events WHERE id > ? ORDER BY id LIMIT ?`;

// The page is exactly the events with after < id <= last, so the current
// rows for the page are selected with two parameters, well under D1's
// 100-bound-parameter limit.
const PAGE_RESPONSES_SQL = `
SELECT response_id, status, revision, started_at, updated_at, submitted_at,
       last_completed_step, content_version, client_updated_at, raw_json
FROM responses
WHERE response_id IN (SELECT DISTINCT response_id FROM events WHERE id > ? AND id <= ?)
ORDER BY response_id`;

export async function exportEvents(store, after, limit) {
  const events = await store.all(EVENTS_SQL, [after, pageSize(limit)]);
  if (!events.length) return { events: [], responses: [], next_after: after };
  const last = events[events.length - 1].id;
  const responses = await store.all(PAGE_RESPONSES_SQL, [after, last]);
  return { events, responses, next_after: last };
}

// Same rule as cleanupExpiredDrafts in Code.gs: a draft idle for 48 h or
// more goes, with its events. ISO text compares correctly as text.
export async function deleteExpiredDrafts(store, now) {
  const cutoff = new Date(now.getTime() - DRAFT_RETENTION_MS).toISOString();
  const results = await store.batch([
    {
      sql: `DELETE FROM events WHERE response_id IN
              (SELECT response_id FROM responses WHERE status = 'draft' AND updated_at <= ?)`,
      params: [cutoff],
    },
    { sql: `DELETE FROM responses WHERE status = 'draft' AND updated_at <= ?`, params: [cutoff] },
  ]);
  return { responses: results[1].meta.changes, events: results[0].meta.changes };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd worker && node test/write.test.js`
Expected: `write.test.js passed`

- [ ] **Step 5: Commit**

```bash
git add worker/src/write.js worker/test/write.test.js
git commit -m "Worker: export events by cursor and expire idle drafts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: HTTP handler, CORS, export auth, scheduled cleanup, wrangler config

**Files:**
- Create: `worker/src/index.js`, `worker/test/index.test.js`, `worker/wrangler.toml`

**Interfaces:**
- Consumes: `parseRequest`, `MAX_BODY`, `result` from `validate.js`; `createStore`, `writeSnapshot`, `exportEvents`, `deleteExpiredDrafts` from `write.js`.
- Produces: default export `{fetch(request, env), scheduled(event, env, ctx)}`; named `handleRequest(request, env) → Response`, `runCleanup(env)`, `allowedOrigin(origin, configured) → origin|null`, `secretsMatch(given, expected) → boolean`. `env` carries `DB`, `ALLOWED_ORIGINS`, `EXPORT_SECRET`.

- [ ] **Step 1: Write the failing handler tests**

`worker/test/index.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd worker && node test/index.test.js`
Expected: FAIL with `Cannot find module '../src/index.js'`

- [ ] **Step 3: Implement the handler**

`worker/src/index.js`:

```js
// Automation survey write API (Cloudflare Worker + D1).
//   POST /         draft or final snapshot from the survey page → ack JSON
//   GET  /         health check
//   GET  /export   events after a cursor, for the Sheet mirror (bearer secret)
//   cron           hourly removal of drafts idle for 48 h
import { parseRequest, MAX_BODY, result } from "./validate.js";
import { createStore, writeSnapshot, exportEvents, deleteExpiredDrafts, EXPORT_PAGE_LIMIT } from "./write.js";

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  },
};

export async function runCleanup(env) {
  const removed = await deleteExpiredDrafts(createStore(env.DB), new Date());
  console.log(`Expired drafts removed: ${removed.responses}; events removed: ${removed.events}`);
  return removed;
}

export function allowedOrigin(origin, configured) {
  if (!origin) return null;
  const list = String(configured || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

// Constant-time comparison; portable (no crypto.subtle.timingSafeEqual in Node tests).
export function secretsMatch(given, expected) {
  const a = new TextEncoder().encode(String(given ?? ""));
  const b = new TextEncoder().encode(String(expected ?? ""));
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigin(origin, env.ALLOWED_ORIGINS);
  if (origin && !allowed) return new Response("Forbidden", { status: 403 });
  const cors = allowed ? { "Access-Control-Allow-Origin": allowed, Vary: "Origin" } : {};

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (url.pathname === "/" && request.method === "GET") {
    return json({ ok: true, message: "Automation survey endpoint is running." }, 200, cors);
  }
  if (url.pathname === "/" && request.method === "POST") {
    return json(await handleWrite(request, env), 200, cors);
  }
  if (url.pathname === "/export" && request.method === "GET") {
    return handleExport(request, env, url);
  }
  return new Response("Not found", { status: 404 });
}

async function handleWrite(request, env) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY * 4) {
    return result(false, "too_large", "Response is too large.");
  }
  let body;
  try {
    body = await request.text();
  } catch (err) {
    return result(false, "invalid_request", "Unreadable request body.");
  }
  const parsed = parseRequest(body);
  if (!parsed.ok) return parsed;
  try {
    return await writeSnapshot(createStore(env.DB), parsed.value, body, new Date());
  } catch (err) {
    console.error("write failed", (err && err.stack) || err);
    return result(false, "server_error", "The response could not be saved.");
  }
}

async function handleExport(request, env, url) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!env.EXPORT_SECRET || !secretsMatch(token, env.EXPORT_SECRET)) {
    return json({ ok: false, code: "unauthorized", message: "Unauthorized." }, 401, {});
  }
  const after = Math.max(0, Math.floor(Number(url.searchParams.get("after")) || 0));
  const limit = url.searchParams.get("limit") ?? EXPORT_PAGE_LIMIT;
  const page = await exportEvents(createStore(env.DB), after, limit);
  return json({ ok: true, ...page }, 200, {});
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd worker && node test/index.test.js`
Expected: `index.test.js passed`

- [ ] **Step 5: Write the wrangler config**

`worker/wrangler.toml`:

```toml
name = "automation-survey"
main = "src/index.js"
compatibility_date = "2025-09-01"

[observability]
enabled = true

[vars]
ALLOWED_ORIGINS = "https://arcadiaimpact.github.io,http://127.0.0.1:8000,http://localhost:8000"

# EXPORT_SECRET is a secret: `npx wrangler secret put EXPORT_SECRET` in production,
# a line `EXPORT_SECRET=local-secret` in worker/.dev.vars for `wrangler dev`.

[[d1_databases]]
binding = "DB"
database_name = "automation-survey"
# Replace with the database_id printed by `npx wrangler d1 create automation-survey`.
database_id = "00000000-0000-0000-0000-000000000000"

[triggers]
crons = ["17 * * * *"]
```

- [ ] **Step 6: Run the whole Worker suite and a dry-run build**

Run: `cd worker && npm install && npm test && npx wrangler deploy --dry-run --outdir=/tmp/wrangler-dry 2>&1 | tail -5`
Expected: all three `passed` lines; the dry run reports the bundle size and no errors. (`npm install` only fetches wrangler; if the permission classifier refuses, skip the dry run and continue.)

- [ ] **Step 7: Commit**

```bash
git add worker/src/index.js worker/test/index.test.js worker/wrangler.toml
git commit -m "Worker: HTTP handler with CORS, secret-protected export, hourly cleanup

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Apps Script mirror (`syncFromWorker`)

**Files:**
- Modify: `apps-script/Code.gs` (header comment; new constants; new functions after `installMaintenanceTriggers`; `installMaintenanceTriggers` itself)
- Modify: `apps-script/Code.test.js` (export list at the top; new tests appended before the final `console.log`)

**Interfaces:**
- Consumes (existing in `Code.gs`): `createSheetStore_(ss)` with `putResponse(record)`, `hasEvent(key)`, `appendEvent(record)`; `eventKey_`, `flatten_`, `addRawJson_`, `withLock_`, `notifyOwner_`, `buildResponseRecord_`.
- Produces: `syncFromWorker()`, `fetchExportPage_(url, secret, after)`, `mirrorBatch_(ss, batch)`, `mirrorResponseRecord_(row)`, `mirrorEventRecord_(event)`; Script Properties `WORKER_URL`, `EXPORT_SECRET`, `SYNC_AFTER_EVENT_ID`; a third managed trigger `syncFromWorker` every minute.

- [ ] **Step 1: Add the new names to the test's export list**

In `apps-script/Code.test.js`, change the `this.__test = {...}` block and the destructuring to also include:

```js
    mirrorResponseRecord_, mirrorEventRecord_, mirrorBatch_, syncFromWorker,
    fetchExportPage_, installMaintenanceTriggers, buildEventRecord_
```

- [ ] **Step 2: Append the failing mirror tests**

Append to `apps-script/Code.test.js` before `console.log("Apps Script contract checks passed.");`:

```js
// ---- mirror of the Worker's database ----

// The mirror writes exactly the row doPost writes today for the same payload.
{
  const payload = envelope({ status: "submitted", answers: validAnswers(), revision: 3 });
  const raw = JSON.stringify(payload);
  const when = new Date("2026-10-07T09:00:00.000Z");
  const expected = buildResponseRecord_(payload, raw, null, when);
  const exported = {
    response_id: payload.response_id, status: "submitted", revision: 3,
    started_at: "2026-10-07T09:00:00.000Z", updated_at: "2026-10-07T09:00:00.000Z",
    submitted_at: "2026-10-07T09:00:00.000Z", last_completed_step: 2,
    content_version: "abcd1234", client_updated_at: "2026-10-07T08:00:00.000Z", raw_json: raw,
  };
  assert.deepEqual(mirrorResponseRecord_(exported), expected);

  const draftRow = { ...exported, status: "draft", submitted_at: null, raw_json: JSON.stringify(envelope({ revision: 3 })) };
  assert.equal(mirrorResponseRecord_(draftRow).submitted_at, "", "null submitted_at becomes an empty cell");

  const expectedEvent = buildEventRecord_(expected, when);
  assert.deepEqual(
    mirrorEventRecord_({ id: 9, event_at: "2026-10-07T09:00:00.000Z", response_id: payload.response_id, revision: 3, status: "submitted", raw_json: raw }),
    expectedEvent
  );
}

// A row whose raw_json cannot be parsed still lands with its fixed columns
// and raw text, so one bad row cannot stall the cursor.
{
  const broken = mirrorResponseRecord_({
    response_id: "123e4567-e89b-42d3-a456-426614174000", status: "draft", revision: 1,
    started_at: "2026-10-07T09:00:00.000Z", updated_at: "2026-10-07T09:00:00.000Z", submitted_at: null,
    last_completed_step: 0, content_version: "v", client_updated_at: "2026-10-07T08:00:00.000Z", raw_json: "{not json",
  });
  assert.equal(broken.revision, 1);
  assert.equal(broken.raw_json, "{not json");
  assert.equal(broken.job_title, undefined);
}

function exportedRow(payload, when) {
  return {
    response_id: payload.response_id, status: payload.status, revision: payload.revision,
    started_at: when, updated_at: when, submitted_at: payload.status === "submitted" ? when : null,
    last_completed_step: payload.last_completed_step, content_version: payload.content_version,
    client_updated_at: payload.client_updated_at, raw_json: JSON.stringify(payload),
  };
}
function exportedEvent(id, payload, when) {
  return { id, event_at: when, response_id: payload.response_id, revision: payload.revision, status: payload.status, raw_json: JSON.stringify(payload) };
}

// mirrorBatch_: one Sheet row per response, one event row per event, and a
// repeat of the same page changes nothing.
{
  sandbox.CacheService = { getScriptCache: () => createFakeCache() };
  const sheets = {};
  const ss = createFakeSpreadsheet(sheets);
  const when = "2026-10-07T09:00:00.000Z";
  const a1 = envelope({ revision: 1 });
  const a2 = envelope({ revision: 2 });
  const otherId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const b1 = envelope({ response_id: otherId, revision: 1 });
  const orphan = envelope({ response_id: "99999999-9999-4999-8999-999999999999", revision: 1 });
  const batch = {
    events: [exportedEvent(1, a1, when), exportedEvent(2, b1, when), exportedEvent(3, a2, when), exportedEvent(4, orphan, when)],
    responses: [exportedRow(a2, when), exportedRow(b1, when)], // the orphan's row was already deleted by cleanup
    next_after: 4,
  };
  mirrorBatch_(ss, batch);
  assert.equal(sheets.responses._rows.length, 3, "header plus two current rows, not three");
  assert.equal(sheets.responses._rows[1][2], 2, "the twice-seen response holds revision 2");
  assert.equal(sheets.response_events._rows.length, 5, "header plus four events, orphan included");

  mirrorBatch_(ss, batch);
  assert.equal(sheets.responses._rows.length, 3, "repeating a page adds no rows");
  assert.equal(sheets.response_events._rows.length, 5, "repeating a page adds no events");
}

// syncFromWorker: fetches with the secret, pages until a short page, and
// advances the cursor only after a page is written.
function installSyncFakes({ pages, failWith }) {
  const props = new Map([["WORKER_URL", "https://api.example/"], ["EXPORT_SECRET", "s3cret"], ["ALERT_EMAIL", "ops@example.com"]]);
  const calls = { fetches: [], mails: [] };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => { props.set(k, v); },
    }),
  };
  sandbox.UrlFetchApp = {
    fetch(url, options) {
      calls.fetches.push({ url, options });
      if (failWith) return { getResponseCode: () => failWith, getContentText: () => "boom" };
      const page = pages.shift() || { events: [], responses: [], next_after: Number(new URL(url).searchParams.get("after")) };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(page) };
    },
  };
  sandbox.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const sheets = {};
  sandbox.SpreadsheetApp = { getActiveSpreadsheet: () => createFakeSpreadsheet(sheets) };
  sandbox.CacheService = { getScriptCache: () => createFakeCache() };
  sandbox.MailApp = { sendEmail: (to, subject) => calls.mails.push([to, subject]) };
  return { props, calls, sheets };
}
{
  const when = "2026-10-07T09:00:00.000Z";
  const full = [];
  for (let i = 1; i <= 200; i++) {
    const p = envelope({ response_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, revision: 1 });
    full.push(exportedEvent(i, p, when));
  }
  const fullResponses = full.map((e) => exportedRow(JSON.parse(e.raw_json), when));
  const tail = envelope({ revision: 1 });
  const { props, calls, sheets } = installSyncFakes({
    pages: [
      { events: full, responses: fullResponses, next_after: 200 },
      { events: [exportedEvent(201, tail, when)], responses: [exportedRow(tail, when)], next_after: 201 },
    ],
  });
  syncFromWorker();
  assert.equal(calls.fetches.length, 2, "a full page is followed by another fetch; a short page stops");
  assert.equal(calls.fetches[0].url, "https://api.example/export?after=0&limit=200");
  assert.equal(calls.fetches[1].url, "https://api.example/export?after=200&limit=200");
  assert.equal(calls.fetches[0].options.headers.Authorization, "Bearer s3cret");
  assert.equal(calls.fetches[0].options.muteHttpExceptions, true);
  assert.equal(props.get("SYNC_AFTER_EVENT_ID"), "201");
  assert.equal(sheets.responses._rows.length, 202, "header plus 201 responses");
  assert.equal(sheets.response_events._rows.length, 202);
  assert.equal(calls.mails.length, 0);
}
{
  const { props, calls } = installSyncFakes({ pages: [], failWith: 502 });
  props.set("SYNC_AFTER_EVENT_ID", "17");
  assert.throws(() => syncFromWorker(), /HTTP 502/);
  assert.equal(props.get("SYNC_AFTER_EVENT_ID"), "17", "cursor untouched after a failed fetch");
  assert.deepEqual(calls.mails, [["ops@example.com", "Automation survey save failure"]]);
}
{
  const { props } = installSyncFakes({ pages: [] });
  props.delete("WORKER_URL");
  assert.throws(() => syncFromWorker(), /WORKER_URL and EXPORT_SECRET/);
}

// installMaintenanceTriggers manages three triggers, including the minute sync.
{
  const created = [];
  const deleted = [];
  const existing = [
    { getHandlerFunction: () => "cleanupExpiredDrafts" },
    { getHandlerFunction: () => "somethingElse" },
  ];
  const builder = (fn) => {
    const spec = { fn };
    const chain = {
      timeBased: () => chain,
      everyHours: (n) => { spec.everyHours = n; return chain; },
      everyMinutes: (n) => { spec.everyMinutes = n; return chain; },
      everyDays: (n) => { spec.everyDays = n; return chain; },
      atHour: (h) => { spec.atHour = h; return chain; },
      create: () => { created.push(spec); },
    };
    return chain;
  };
  sandbox.ScriptApp = {
    getProjectTriggers: () => existing,
    deleteTrigger: (t) => deleted.push(t.getHandlerFunction()),
    newTrigger: builder,
  };
  installMaintenanceTriggers();
  assert.deepEqual(deleted, ["cleanupExpiredDrafts"], "only managed triggers are replaced");
  assert.deepEqual(created, [
    { fn: "cleanupExpiredDrafts", everyHours: 1 },
    { fn: "backupSubmittedResponses", everyDays: 1, atHour: 3 },
    { fn: "syncFromWorker", everyMinutes: 1 },
  ]);
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node apps-script/Code.test.js`
Expected: FAIL with `mirrorResponseRecord_ is not defined`

- [ ] **Step 4: Implement the mirror in Code.gs**

Replace the header comment block at the top of `apps-script/Code.gs` (lines 1–21) with:

```js
// ============================================================
// Automation Survey: Sheet side (Google Apps Script).
// Deployed with clasp from apps-script/ (see SETUP.md).
//
// Since 2026-10-07 the survey page writes to a Cloudflare Worker backed by
// D1 (see worker/). This script mirrors the Worker's data into the Sheet
// and runs the maintenance jobs:
//   - syncFromWorker (every minute): pulls new events from the Worker's
//     /export endpoint and writes the current row of each response to the
//     `responses` tab and each event to `response_events`.
//   - cleanupExpiredDrafts (hourly): removes drafts idle for 48 h from the
//     Sheet; the Worker applies the same rule to its database.
//   - backupSubmittedResponses (daily): CSV of submitted rows.
//
// doPost still accepts writes directly, with the same validation and
// revision rules, so the old endpoint keeps working while the survey
// switches over. It is retired in a later change.
// ============================================================
```

Add after the `BACKUP_RETENTION_MS` constant:

```js
const EXPORT_PAGE_SIZE = 200;   // the Worker's maximum page
const SYNC_MAX_PAGES = 10;      // per trigger run; the next run continues
```

Replace `installMaintenanceTriggers` with:

```js
function installMaintenanceTriggers() {
  const managed = ['cleanupExpiredDrafts', 'backupSubmittedResponses', 'syncFromWorker'];
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (managed.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('cleanupExpiredDrafts')
    .timeBased().everyHours(1).create();
  ScriptApp.newTrigger('backupSubmittedResponses')
    .timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger('syncFromWorker')
    .timeBased().everyMinutes(1).create();
}

// ---------- mirror of the Worker's database into the Sheet ----------

// Pulls events the Sheet has not seen yet. The Worker has already applied
// the revision rules and exported rows only ever move forward, so the mirror
// writes what it receives. A run that fails midway repeats from the saved
// cursor: rewriting a current row is harmless and events are deduplicated.
function syncFromWorker() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WORKER_URL');
  const secret = props.getProperty('EXPORT_SECRET');
  if (!url || !secret) {
    throw new Error('WORKER_URL and EXPORT_SECRET script properties are required');
  }
  let after = Number(props.getProperty('SYNC_AFTER_EVENT_ID') || 0);
  let mirrored = 0;
  try {
    for (let page = 0; page < SYNC_MAX_PAGES; page++) {
      const batch = fetchExportPage_(url, secret, after);
      if (!batch.events.length) break;
      withLock_(LockService.getScriptLock(), function () {
        mirrorBatch_(SpreadsheetApp.getActiveSpreadsheet(), batch);
        props.setProperty('SYNC_AFTER_EVENT_ID', String(batch.next_after));
      });
      after = batch.next_after;
      mirrored += batch.events.length;
      if (batch.events.length < EXPORT_PAGE_SIZE) break;
    }
    console.log('Mirrored ' + mirrored + ' events; cursor ' + after);
  } catch (err) {
    console.error(err);
    notifyOwner_(err);
    throw err;
  }
}

function fetchExportPage_(url, secret, after) {
  const response = UrlFetchApp.fetch(
    url.replace(/\/$/, '') + '/export?after=' + after + '&limit=' + EXPORT_PAGE_SIZE,
    { headers: { Authorization: 'Bearer ' + secret }, muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) {
    throw new Error('Export request failed with HTTP ' + response.getResponseCode());
  }
  const batch = JSON.parse(response.getContentText());
  if (!batch || !Array.isArray(batch.events) || !Array.isArray(batch.responses)) {
    throw new Error('Export reply has an unexpected shape');
  }
  return batch;
}

function mirrorBatch_(ss, batch) {
  const store = createSheetStore_(ss);
  batch.responses.forEach(function (row) {
    store.putResponse(mirrorResponseRecord_(row));
  });
  batch.events.forEach(function (event) {
    const key = eventKey_(event.response_id, event.revision);
    if (!store.hasEvent(key)) store.appendEvent(mirrorEventRecord_(event));
  });
}

// Same columns as buildResponseRecord_, but the timestamps come from the
// Worker's row. Unparseable raw_json is logged and the row still lands with
// its fixed columns and raw text, so one bad row cannot stall the mirror.
function mirrorResponseRecord_(row) {
  const record = {
    response_id: row.response_id,
    status: row.status,
    revision: Number(row.revision),
    started_at: row.started_at,
    updated_at: row.updated_at,
    submitted_at: row.submitted_at || '',
    last_completed_step: Number(row.last_completed_step),
    content_version: row.content_version,
    client_updated_at: row.client_updated_at
  };
  try {
    Object.assign(record, flatten_(JSON.parse(row.raw_json).answers || {}));
  } catch (err) {
    console.error('Unparseable raw_json for ' + row.response_id + ': ' + err);
  }
  addRawJson_(record, row.raw_json);
  return record;
}

function mirrorEventRecord_(event) {
  const record = {
    event_key: eventKey_(event.response_id, event.revision),
    event_at: event.event_at,
    response_id: event.response_id,
    revision: Number(event.revision),
    status: event.status
  };
  addRawJson_(record, event.raw_json);
  return record;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node apps-script/Code.test.js`
Expected: `Apps Script contract checks passed.`

- [ ] **Step 6: Run every suite in the repo**

Run: `node persistence.test.js && node survey.test.js && node apps-script/Code.test.js && (cd worker && npm test)`
Expected: each prints its pass line.

- [ ] **Step 7: Commit**

```bash
git add apps-script/Code.gs apps-script/Code.test.js
git commit -m "Apps Script: mirror the Worker's events into the Sheet every minute

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Local end-to-end against `wrangler dev`

**Files:**
- No repo changes. Uses the scratchpad harness from the burst test (`e2e/burst.js`, `e2e/e2e-local.js`) and a local Worker.

- [ ] **Step 1: Start the Worker locally with a local database**

Run (from `worker/`), each in the background:

```bash
printf 'EXPORT_SECRET=local-secret\n' > .dev.vars
npx wrangler d1 execute automation-survey --local --file=schema.sql
npx wrangler dev --local --port 8787 --var ALLOWED_ORIGINS:"http://127.0.0.1:8765,http://127.0.0.1:8000,http://localhost:8000"
```

Expected: `Ready on http://127.0.0.1:8787`. Then `curl -s http://127.0.0.1:8787/` prints `{"ok":true,"message":"Automation survey endpoint is running."}`.

- [ ] **Step 2: Drive the real page through one full survey**

Copy the scratchpad `e2e/e2e-local.js` to `e2e/e2e-worker.js` and change it to proxy instead of stub: replace the `if (req.method === "POST" && req.url === "/exec")` block with a proxy that forwards the body to `http://127.0.0.1:8787/` (same method, `Content-Type: text/plain`, plus the page's `Origin` header) and pipes the Worker's JSON back; keep the `content.js` endpoint rewrite pointing at `http://127.0.0.1:8765/exec`. Delete the stub-store assertions and instead, after the thank-you page appears, read the local database:

```bash
npx wrangler d1 execute automation-survey --local --json \
  --command "SELECT response_id, status, revision, submitted_at FROM responses"
```

Expected: one row, `status = submitted`, `submitted_at` an ISO timestamp, and the page shows the thank-you title with no error text.

- [ ] **Step 3: Burst the local Worker**

Run the existing scratchpad `e2e/burst.js` scenario 1 with 30 tabs against the proxy server (the page is served from `http://127.0.0.1:8765/`, so set `BASE` accordingly), then:

```bash
npx wrangler d1 execute automation-survey --local --json \
  --command "SELECT count(*) AS n FROM responses WHERE status = 'submitted'"
```

Expected: `thank-you shown: 30/30`, every submit under one second locally, and `n = 30`. This proves the write path before any account exists; the deployed re-run in Task 8 is the real measurement.

- [ ] **Step 4: Stop the local Worker and remove `.dev.vars`**

`.dev.vars` is git-ignored; nothing to commit.

---

### Task 7: Setup documentation

**Files:**
- Modify: `SETUP.md`

- [ ] **Step 1: Rewrite the top of SETUP.md and add the Worker section**

Replace the opening paragraph and insert a new section before "## 1. Create the sheet":

```markdown
# Saving responses: setup

Responses are written by a small Cloudflare Worker ([`worker/`](worker/))
into D1, Cloudflare's hosted SQLite database. The Worker confirms a save in
well under a second. A Google Apps Script attached to the results Sheet
([`apps-script/Code.gs`](apps-script/Code.gs)) copies new events from the
Worker into the Sheet every minute, so the Sheet stays the place the team
looks at results. The survey page shows "thank you" only after the Worker
confirms the final response was written.

## 0. Deploy the write API (Cloudflare Worker)

One-time, from the `worker/` folder, by whoever owns the Cloudflare account:

```
npm install
npx wrangler login                               # opens a browser window
npx wrangler d1 create automation-survey         # prints a database_id
```

Paste the printed `database_id` into `worker/wrangler.toml`, then:

```
npx wrangler d1 execute automation-survey --remote --file=schema.sql
npx wrangler secret put EXPORT_SECRET            # paste a long random string, e.g. `openssl rand -hex 32`
npx wrangler deploy                              # prints https://automation-survey.<account>.workers.dev
```

Keep the secret: the Apps Script needs the same value (step 3). Check the
deployment in a private window: the Worker URL shows
`{"ok":true,"message":"Automation survey endpoint is running."}`.

Later code changes to the Worker are `npx wrangler deploy` again. Logs:
`npx wrangler tail`. A full database dump:
`npx wrangler d1 export automation-survey --remote --output=backup.sql`.
The free tier covers this survey; the Workers Paid plan is optional.
```

- [ ] **Step 2: Update the Script Properties and trigger steps**

In "## 3. Configure maintenance and alerts", add two properties and a trigger:

```markdown
2. Add `BACKUP_FOLDER_ID` with the restricted backup folder's ID.
3. Add `ALERT_EMAIL` with the operator address that should receive internal
   save-failure alerts. Alerts are limited to one per hour.
4. Add `WORKER_URL` (the `https://….workers.dev` URL from step 0) and
   `EXPORT_SECRET` (the same value given to `wrangler secret put`).
5. Select `installMaintenanceTriggers` in the function menu and click **Run**.
   Authorize Sheets, Drive, Mail and external-request access.
6. Open **Triggers** and confirm exactly:
   - one hourly `cleanupExpiredDrafts` trigger;
   - one daily `backupSubmittedResponses` trigger; and
   - one every-minute `syncFromWorker` trigger.
```

In "## 6. Point the survey at it", change the URL example to the Worker URL
and add: "During the transition the Apps Script web app (step 4) keeps
accepting writes too, so the two can coexist; it is retired in a later
change." In "## 7. Test before sending the link to anyone", change the first
checklist item to end "…and both appear in the Sheet within two minutes."

- [ ] **Step 3: Commit**

```bash
git add SETUP.md
git commit -m "SETUP: document the Cloudflare Worker write API and the Sheet mirror

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Deploy, switch the endpoint, re-run the burst test

**Files:**
- Modify: `content.js` (`submit.endpoint`), `worker/wrangler.toml` (`database_id`)

- [ ] **Step 1: User deploys**

Give the user the six commands from SETUP.md step 0 and the two Script Properties. They also run `installMaintenanceTriggers` once and push/redeploy the script with clasp:

```bash
npx @google/clasp push -f
npx @google/clasp update-deployment AKfycbxbIV0tw_cK9fWpGrlk-dihlwKojSnovu02f1vn_25Rst-JojwQ1GJ0qDfylgwpXQaK -d "mirror from worker"
```

- [ ] **Step 2: Verify read-only**

```bash
curl -s https://automation-survey.<account>.workers.dev/
curl -s -o /dev/null -w '%{http_code}\n' https://automation-survey.<account>.workers.dev/export
```

Expected: the health JSON, then `401`. Commit the real `database_id` in `wrangler.toml`.

- [ ] **Step 3: Switch the endpoint**

In `content.js`, set `submit.endpoint` to the Worker URL (with trailing slash removed). Run `node survey.test.js`. Commit:

```bash
git add content.js worker/wrangler.toml
git commit -m "Point the survey at the Cloudflare Worker write API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: Burst test the deployed Worker**

Run the scratchpad `e2e/burst.js` scenario 1 with 30 tabs against the local preview server (`python3 -m http.server 8000 --bind 127.0.0.1` from the repo root, which serves the new `content.js`). Then ask the Worker, per response id, with the stale-revision probe from the scratchpad (`e2e/probe.js`, pointed at the Worker URL) which finals landed.

Expected: `thank-you shown: 30/30`, median under 1 s, probe `submitted` for 30/30. Record the numbers next to the 2026-10-07 Apps Script run (26/30 saved, median 27 s).

- [ ] **Step 5: Ship on the user's word**

Only after an explicit "ship it": fast-forward `main` to `backend`, push both, poll GitHub Pages until `content.js` carries the Worker URL, then submit one real response from the hosted page and confirm it appears in the Sheet within two minutes. Remind the user to delete the test rows in both tabs and the test database rows (`npx wrangler d1 execute automation-survey --remote --command "DELETE FROM events; DELETE FROM responses;"`) before launch.
