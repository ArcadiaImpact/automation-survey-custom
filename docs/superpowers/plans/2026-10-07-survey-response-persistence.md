# Survey Response Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add retry-safe anonymous server draft saving, final submission, 48-hour draft expiry, and submitted-only backups to the existing static survey.

**Architecture:** Keep the static page, Google Apps Script endpoint, and Google Sheet. Add a small browser-compatible persistence module for local expiry and serialized autosaves; change Apps Script to validate a fixed request schema, enforce monotonic revisions, maintain current and append-only sheets, and run retention and backup triggers.

**Tech Stack:** Vanilla HTML/JavaScript, browser `localStorage` and `fetch`, Google Apps Script, Google Sheets, Google Drive, Node.js built-in `assert`/`vm` for tests.

**Spec:** `docs/superpowers/specs/2026-10-07-survey-response-persistence-design.md`

## Global Constraints

- Expected scale is roughly 100 public respondents; add no database or application server.
- Drafts start saving to the server only after Start is pressed.
- Do not add the deferred respondent-disclosure copy during this implementation.
- Draft payloads must omit the optional email; only final submissions may contain it.
- Abandoned drafts and their events expire from active storage 48 hours after their latest accepted server save.
- Local drafts older than 48 hours are discarded on the next page load.
- Only `status = submitted` rows are included in analysis and daily backups.
- The thank-you screen appears, and local storage is cleared, only after the server acknowledges final submission.
- Existing task IDs and flattened analysis column names must remain stable.
- Public requests must not create arbitrary Sheet columns.
- Preserve the user's pre-existing uncommitted changes in `content.js`, `index.html`, and `survey.test.js`. Before execution, either have the user commit them or stage only implementation-specific hunks; never use a blanket `git add` on overlapping files.
- Daily submitted-response backups expire after 90 days. This concrete period should be confirmed during plan review.

## File Structure

- Create `persistence.js`: pure/browser-compatible local expiry, draft sanitization, and serialized autosave coordinator.
- Create `persistence.test.js`: deterministic unit tests for the persistence module using injected clocks and timers.
- Modify `index.html`: load the module, render save status and honeypot, track revisions/steps, and route draft/final writes through the coordinator.
- Modify `content.js`: add save-status strings only; do not add disclosure copy.
- Modify `survey.test.js`: pin required DOM hooks, script loading, and the absence of deferred disclosure text.
- Modify `apps-script/Code.gs`: fixed schema validation, response/event writes, revision ordering, cleanup, backups, and trigger installation.
- Create `apps-script/Code.test.js`: Node-executed pure-function tests for validation, ordering, expiry selection, and CSV generation.
- Modify `SETUP.md`: deployment, trigger installation, backup folder, privacy limitations, and pre-launch verification.
- Modify `README.md`: concise architecture and operator links.

## Review Focus

- Two rapid edits while one request is in flight: only the newest pending full snapshot is sent next, without concurrent writes.
- A delayed draft after final submission: the server retains `submitted` and returns the authoritative revision without appending a duplicate event.
- Draft content containing an email or unknown answer key: the server rejects it without changing either sheet.
- Partial write/retry around the current row and event log: retry repairs the missing side and does not duplicate an existing event key.
- CSV backup values containing commas, quotes, or newlines: exported files remain parseable and include submitted rows only.

---

### Task 1: Define and validate the server request contract

**Files:**
- Modify: `apps-script/Code.gs`
- Create: `apps-script/Code.test.js`

**Interfaces:**
- Consumes: JSON request bodies from the survey.
- Produces: `parseRequest_(rawBody)`, `validateEnvelope_(value)`, `validateAnswers_(answers, isFinal)`, `decideWrite_(current, incoming)`, and `reply_(object)`.
- Produces request shape:
  `{response_id, revision, status, last_completed_step, content_version, client_updated_at, honeypot, answers}`.

- [ ] **Step 1: Write failing contract and ordering tests**

Create `apps-script/Code.test.js` with a VM loader that exposes selected Apps
Script functions without requiring Google services:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(`${__dirname}/Code.gs`, "utf8");
const sandbox = { console };
const NOW = Date.parse("2026-10-07T09:00:00.000Z");
vm.createContext(sandbox);
vm.runInContext(
  `${source}
  this.__test = {
    parseRequest_, validateEnvelope_, validateAnswers_, decideWrite_
  };`,
  sandbox
);

const {
  parseRequest_, validateEnvelope_, validateAnswers_, decideWrite_
} = sandbox.__test;

function validAnswers() {
  const taskIds = [
    "conceptual", "design", "infra", "running", "writing", "collaborating"
  ];
  const points = Object.fromEntries(taskIds.map((id, index) => [id, index === 0 ? 100 : 0]));
  const hours_active_human = Object.fromEntries(taskIds.map(id => [
    id,
    { without_ai: null, one_year_ago: null, now: null, in_6_months: null }
  ]));
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
    agent_tracking: "Git commits"
  };
}

function draftAnswers() {
  const answers = validAnswers();
  delete answers.email;
  return answers;
}

function envelope(overrides = {}) {
  return {
    response_id: "123e4567-e89b-42d3-a456-426614174000",
    revision: 3,
    status: "draft",
    last_completed_step: 2,
    content_version: "abcd1234",
    client_updated_at: "2026-10-07T08:00:00.000Z",
    honeypot: "",
    answers: draftAnswers(),
    ...overrides
  };
}

assert.equal(validateEnvelope_(envelope()).ok, true);
assert.equal(validateEnvelope_(envelope({ unexpected: true })).code, "unknown_field");
assert.equal(validateEnvelope_(envelope({ honeypot: "spam" })).code, "spam");
assert.equal(
  validateEnvelope_(envelope({
    answers: { ...validAnswers(), email: "draft@example.com" }
  })).code,
  "draft_email"
);
assert.equal(
  validateEnvelope_(envelope({
    status: "submitted",
    answers: validAnswers()
  })).ok,
  true
);

const stale = decideWrite_(
  { status: "draft", revision: 4 },
  { status: "draft", revision: 3 }
);
assert.equal(stale.kind, "stale");

const downgrade = decideWrite_(
  { status: "submitted", revision: 5 },
  { status: "draft", revision: 6 }
);
assert.equal(downgrade.kind, "stale");

const retry = decideWrite_(
  { status: "submitted", revision: 5 },
  { status: "submitted", revision: 5 }
);
assert.equal(retry.kind, "idempotent");

console.log("Apps Script contract checks passed.");
```

- [ ] **Step 2: Run the tests and verify the new API is missing**

Run:

```bash
node apps-script/Code.test.js
```

Expected: FAIL because `validateEnvelope_` or `decideWrite_` is not defined.

- [ ] **Step 3: Implement fixed schema validation and pure write ordering**

Replace permissive dynamic flattening inputs in `apps-script/Code.gs` with
fixed constants and pure validators. Keep the existing formula-injection
protection:

```js
const RESPONSES_SHEET = 'responses';
const EVENTS_SHEET = 'response_events';
const MAX_BODY = 200000;
const CELL_LIMIT = 45000;
const TASK_IDS = [
  'conceptual', 'design', 'infra', 'running', 'writing', 'collaborating'
];
const ERAS = ['without_ai', 'one_year_ago', 'now', 'in_6_months'];
const ENVELOPE_KEYS = [
  'response_id', 'revision', 'status', 'last_completed_step',
  'content_version', 'client_updated_at', 'honeypot', 'answers'
];
const ANSWER_KEYS = [
  'email', 'job_title', 'role_type', 'experience', 'ai_usage', 'points',
  'hours_active_human', 'hours_notes', 'highest_value_to_automate',
  'main_reason', 'agent_tracking'
];

function result_(ok, code, message) {
  return { ok: ok, code: code || '', message: message || '' };
}

function parseRequest_(rawBody) {
  if (!rawBody) return { ok: false, code: 'empty_body', message: 'Empty request.' };
  if (rawBody.length > MAX_BODY) {
    return { ok: false, code: 'too_large', message: 'Response is too large.' };
  }
  let value;
  try { value = JSON.parse(rawBody); }
  catch (err) { return { ok: false, code: 'invalid_json', message: 'Invalid JSON.' }; }
  const checked = validateEnvelope_(value);
  if (!checked.ok) return checked;
  return { ok: true, value: value };
}

function validateEnvelope_(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result_(false, 'invalid_request', 'Request must be an object.');
  }
  const unknown = Object.keys(value).filter(k => ENVELOPE_KEYS.indexOf(k) === -1);
  if (unknown.length) return result_(false, 'unknown_field', 'Unknown request field.');
  if (value.honeypot) return result_(false, 'spam', 'Request rejected.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.response_id || '')) {
    return result_(false, 'invalid_id', 'Invalid response ID.');
  }
  if (!Number.isInteger(value.revision) || value.revision < 1) {
    return result_(false, 'invalid_revision', 'Invalid revision.');
  }
  if (value.status !== 'draft' && value.status !== 'submitted') {
    return result_(false, 'invalid_status', 'Invalid status.');
  }
  if (!Number.isInteger(value.last_completed_step) ||
      value.last_completed_step < 0 || value.last_completed_step > 4) {
    return result_(false, 'invalid_step', 'Invalid completed step.');
  }
  if (typeof value.content_version !== 'string' || value.content_version.length > 100) {
    return result_(false, 'invalid_content_version', 'Invalid content version.');
  }
  if (typeof value.client_updated_at !== 'string' ||
      !Number.isFinite(Date.parse(value.client_updated_at))) {
    return result_(false, 'invalid_timestamp', 'Invalid client timestamp.');
  }
  return validateAnswers_(value.answers, value.status === 'submitted');
}

function decideWrite_(current, incoming) {
  if (!current) return { kind: 'accept' };
  if (current.status === 'submitted') {
    if (incoming.status === 'submitted' && incoming.revision === current.revision) {
      return { kind: 'idempotent' };
    }
    return { kind: 'stale' };
  }
  if (incoming.revision <= current.revision) return { kind: 'stale' };
  return { kind: 'accept' };
}
```

Implement `validateAnswers_` using helpers that enforce:

- only `ANSWER_KEYS`;
- text maxima matching the HTML (`email` 200, other short text 300,
  long text 4000);
- no email key at all in drafts;
- exact `TASK_IDS` for points and hours;
- finite point values between 0 and 100;
- for submitted responses, exactly 100 points total;
- hours rows either entirely null or four finite non-negative values;
- required submitted text fields; and
- partial/missing values permitted for drafts when their supplied types are
  valid.

Return stable codes such as `unknown_answer`, `draft_email`,
`invalid_points`, `invalid_hours`, and `missing_required`.

- [ ] **Step 4: Add review-focus contract cases**

Extend `apps-script/Code.test.js` with:

```js
const unknownAnswers = { ...draftAnswers(), arbitrary: "column injection" };
assert.equal(
  validateEnvelope_(envelope({ answers: unknownAnswers })).code,
  "unknown_answer"
);

const badTotal = validAnswers();
badTotal.points = { ...badTotal.points, conceptual: 99 };
assert.equal(
  validateEnvelope_(envelope({
    status: "submitted",
    answers: badTotal
  })).code,
  "invalid_points"
);

const partialHours = validAnswers();
partialHours.hours_active_human.conceptual = {
  without_ai: 1, one_year_ago: null, now: 1, in_6_months: 1
};
assert.equal(
  validateEnvelope_(envelope({
    status: "submitted",
    answers: partialHours
  })).code,
  "invalid_hours"
);
```

- [ ] **Step 5: Run server contract tests**

Run:

```bash
node apps-script/Code.test.js
```

Expected: `Apps Script contract checks passed.`

- [ ] **Step 6: Commit the server contract**

```bash
git add apps-script/Code.gs apps-script/Code.test.js
git commit -m "Validate survey persistence requests"
```

### Task 2: Implement idempotent current-response and event writes

**Files:**
- Modify: `apps-script/Code.gs`
- Modify: `apps-script/Code.test.js`

**Interfaces:**
- Consumes: validated envelope from `parseRequest_`.
- Produces: `processWrite_(incoming, rawBody, now)`,
  `buildResponseRecord_(incoming, rawBody, current, now)`,
  `eventKey_(responseId, revision)`, `ensureEvent_(...)`, and
  `{ok, response_id, accepted_revision, status}` acknowledgements.

- [ ] **Step 1: Add failing record and idempotency tests**

Append to `apps-script/Code.test.js`, expose the additional functions in the
VM loader, and test stable flattened names:

```js
const submitted = envelope({ status: "submitted", answers: validAnswers() });
const now = new Date("2026-10-07T09:00:00.000Z");
const record = buildResponseRecord_(submitted, JSON.stringify(submitted), null, now);

assert.equal(record.status, "submitted");
assert.equal(record.revision, 3);
assert.equal(record["points.conceptual"], 100);
assert.equal(record["hours_active_human.conceptual.now"], null);
assert.equal(record.started_at.toISOString(), now.toISOString());
assert.equal(record.submitted_at.toISOString(), now.toISOString());
assert.equal(eventKey_(submitted.response_id, 3),
  "123e4567-e89b-42d3-a456-426614174000:3");
assert.equal(toCell_("=1+1"), "'=1+1");

const laterDraft = envelope({
  revision: 6,
  status: "draft",
  answers: draftAnswers()
});
assert.equal(
  decideWrite_({ status: "submitted", revision: 5 }, laterDraft).kind,
  "stale"
);
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
node apps-script/Code.test.js
```

Expected: FAIL because `buildResponseRecord_` and `eventKey_` are absent.

- [ ] **Step 3: Implement fixed columns and deterministic records**

Add explicit response columns and build records from `incoming.answers`
without an `answers.` prefix:

```js
function analysisColumns_() {
  const columns = [
    'response_id', 'status', 'revision', 'started_at', 'updated_at',
    'submitted_at', 'last_completed_step', 'content_version',
    'client_updated_at', 'email', 'job_title', 'role_type', 'experience',
    'ai_usage'
  ];
  TASK_IDS.forEach(id => columns.push('points.' + id));
  TASK_IDS.forEach(id => ERAS.forEach(era =>
    columns.push('hours_active_human.' + id + '.' + era)));
  columns.push(
    'hours_notes', 'highest_value_to_automate', 'main_reason',
    'agent_tracking', 'raw_json'
  );
  return columns;
}

function eventKey_(responseId, revision) {
  return responseId + ':' + revision;
}

function buildResponseRecord_(incoming, rawBody, current, now) {
  const answers = incoming.answers;
  const record = {
    response_id: incoming.response_id,
    status: incoming.status,
    revision: incoming.revision,
    started_at: current && current.started_at ? current.started_at : now,
    updated_at: now,
    submitted_at: incoming.status === 'submitted'
      ? (current && current.submitted_at ? current.submitted_at : now)
      : '',
    last_completed_step: incoming.last_completed_step,
    content_version: incoming.content_version,
    client_updated_at: incoming.client_updated_at
  };
  Object.assign(record, flatten_(answers));
  addRawJson_(record, rawBody);
  return record;
}
```

Make `analysisColumns_()` include enough `raw_json_N` continuation columns for
`MAX_BODY`. `getSheet_()` must create and verify the exact headers instead of
adding headers from request keys. A mismatch must throw an operator-facing
error rather than silently changing the schema.

- [ ] **Step 4: Implement retry-safe dual writes**

Within the existing script lock:

1. locate the response row by exact `response_id`;
2. read its current status, revision, and timestamps;
3. call `decideWrite_`;
4. for `stale` or `idempotent`, call `ensureEvent_` to repair a previously
   interrupted accepted write only when that exact revision is authoritative;
   build any repaired event from the stored current row and its `raw_json`,
   never from the repeated request body;
5. for `accept`, upsert the current row and then `ensureEvent_`;
6. acknowledge only after both exist.

Use `event_key = response_id + ":" + revision` as the first events-sheet
column. `ensureEvent_` must exact-match that key before appending, making a
retry safe if one Sheet write succeeded and the other failed.

The endpoint should become:

```js
function doPost(e) {
  try {
    const rawBody = (e && e.postData && e.postData.contents) || '';
    const parsed = parseRequest_(rawBody);
    if (!parsed.ok) return reply_(parsed);

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      return reply_(processWrite_(parsed.value, rawBody, new Date()));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error(err);
    notifyOwner_(err);
    return reply_({
      ok: false,
      code: 'server_error',
      message: 'The response could not be saved.'
    });
  }
}
```

Continue escaping formula-like cell values in `toCell_`.
Preserve `doGet()` as a health response that never returns response data.

Implement `notifyOwner_` for internal exceptions only, not rejected respondent
input. Read `ALERT_EMAIL` from Script Properties and use `CacheService` to
send at most one `MailApp` failure notification per hour:

```js
function notifyOwner_(err) {
  const email = PropertiesService.getScriptProperties()
    .getProperty('ALERT_EMAIL');
  if (!email) return;
  const cache = CacheService.getScriptCache();
  if (cache.get('server-failure-alert')) return;
  cache.put('server-failure-alert', '1', 3600);
  MailApp.sendEmail(
    email,
    'Automation survey save failure',
    String(err && err.stack || err)
  );
}
```

- [ ] **Step 5: Add a fake-sheet retry repair test**

Create minimal in-memory sheet/range fakes in `apps-script/Code.test.js`, then
exercise this sequence:

```js
const store = createFakeStore();
const incoming = envelope({ revision: 7 });

store.failNextEventAppend = true;
assert.throws(() => processWriteWithStore_(store, incoming, JSON.stringify(incoming), now));
assert.equal(store.responses.length, 1);
assert.equal(store.events.length, 0);

const ack = processWriteWithStore_(store, incoming, JSON.stringify(incoming), now);
assert.equal(ack.ok, true);
assert.equal(store.responses.length, 1);
assert.equal(store.events.length, 1);

const repeated = processWriteWithStore_(store, incoming, JSON.stringify(incoming), now);
assert.equal(repeated.ok, true);
assert.equal(store.events.length, 1);
```

Implement `processWriteWithStore_` as the pure orchestration boundary used by
`processWrite_`; its store interface is:

```js
// getResponse(id) -> record|null
// putResponse(record) -> void
// hasEvent(eventKey) -> boolean
// appendEvent(record) -> void
```

The production adapter wraps Google Sheets; the test adapter uses arrays.

- [ ] **Step 6: Run all server tests**

Run:

```bash
node apps-script/Code.test.js
```

Expected: all contract, ordering, record, and interrupted-write tests pass.

- [ ] **Step 7: Commit idempotent storage**

```bash
git add apps-script/Code.gs apps-script/Code.test.js
git commit -m "Store survey drafts idempotently"
```

### Task 3: Build the browser persistence module

**Files:**
- Create: `persistence.js`
- Create: `persistence.test.js`

**Interfaces:**
- Produces: `DRAFT_TTL_MS`, `isDraftExpired(draft, nowMs)`,
  `draftEnvelope(snapshot)`, and `createAutosaveCoordinator(options)`.
- `createAutosaveCoordinator` consumes:
  `{send, onState, now, setTimer, clearTimer, debounceMs, minIntervalMs, retryDelays}`.
- Coordinator methods: `queue(snapshot)`, `flush()`, `retry()`,
  `submit(snapshot)`, `dispose()`.

- [ ] **Step 1: Write failing local-expiry and sanitization tests**

Create `persistence.test.js`:

```js
const assert = require("node:assert/strict");
const {
  DRAFT_TTL_MS,
  isDraftExpired,
  draftEnvelope,
  createAutosaveCoordinator
} = require("./persistence.js");

const NOW = Date.parse("2026-10-07T09:00:00.000Z");
assert.equal(DRAFT_TTL_MS, 48 * 60 * 60 * 1000);
assert.equal(isDraftExpired({ local_updated_at: NOW - DRAFT_TTL_MS }, NOW), true);
assert.equal(isDraftExpired({ local_updated_at: NOW - DRAFT_TTL_MS + 1 }, NOW), false);
assert.equal(isDraftExpired({}, NOW), true);

const snapshot = {
  response_id: "123e4567-e89b-42d3-a456-426614174000",
  revision: 2,
  status: "draft",
  last_completed_step: 1,
  content_version: "abcd1234",
  client_updated_at: "2026-10-07T09:00:00.000Z",
  honeypot: "",
  answers: { email: "private@example.com", ai_usage: "Coding" }
};
const outgoing = draftEnvelope(snapshot);
assert.equal("email" in outgoing.answers, false);
assert.equal(snapshot.answers.email, "private@example.com");
```

- [ ] **Step 2: Run the module tests and verify failure**

Run:

```bash
node persistence.test.js
```

Expected: FAIL because `persistence.js` does not exist.

- [ ] **Step 3: Implement the module wrapper and pure helpers**

Create `persistence.js` as a browser/CommonJS module:

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SurveyPersistence = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DRAFT_TTL_MS = 48 * 60 * 60 * 1000;

  function isDraftExpired(draft, nowMs) {
    return !draft || !Number.isFinite(draft.local_updated_at) ||
      nowMs - draft.local_updated_at >= DRAFT_TTL_MS;
  }

  function draftEnvelope(snapshot) {
    const copy = JSON.parse(JSON.stringify(snapshot));
    delete copy.local_updated_at;
    if (copy.answers) delete copy.answers.email;
    copy.status = "draft";
    return copy;
  }

  // createAutosaveCoordinator is added in the next step.
  return {
    DRAFT_TTL_MS,
    isDraftExpired,
    draftEnvelope,
    createAutosaveCoordinator
  };
});
```

- [ ] **Step 4: Add deterministic coordinator tests**

Use a deferred promise and injected timers to verify serialization and latest
snapshot coalescing:

```js
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

(async () => {
  const calls = [];
  const states = [];
  const timers = [];
  const first = deferred();
  const coordinator = createAutosaveCoordinator({
    send: value => {
      calls.push(value.revision);
      return calls.length === 1
        ? first.promise
        : Promise.resolve({ ok: true, accepted_revision: value.revision });
    },
    onState: state => states.push(state),
    now: () => NOW,
    setTimer: fn => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    debounceMs: 0,
    minIntervalMs: 0
  });

  coordinator.queue({ ...snapshot, revision: 2 });
  timers.shift()();
  assert.deepEqual(calls, [2]);

  coordinator.queue({ ...snapshot, revision: 3 });
  coordinator.queue({ ...snapshot, revision: 4 });

  first.resolve({ ok: true, accepted_revision: 2 });
  await Promise.resolve();
  await Promise.resolve();
  timers.shift()();
  assert.deepEqual(calls, [2, 4]);

  coordinator.dispose();
})();
```

Add tests for:

- rejected `send` emits `offline` and preserves the latest snapshot;
- failed drafts retry at 2, 5, then at most 15 seconds;
- `retry()` cancels the backoff timer and immediately resends that snapshot;
- `submit(finalSnapshot)` waits behind an in-flight draft, discards pending
  drafts, returns the final acknowledgement, and prevents concurrent sends;
- a rejected final submission can be retried by calling `submit` again;
- an acknowledgement with authoritative `status: submitted` stops future
  draft writes; and
- `dispose()` cancels a pending timer.

- [ ] **Step 5: Implement the serialized coordinator**

Implement these invariants in `createAutosaveCoordinator`:

```js
function createAutosaveCoordinator(options) {
  let pending = null;
  let finalJob = null;
  let inFlight = false;
  let timer = null;
  let stopped = false;
  let lastStartedAt = -Infinity;
  let retryIndex = 0;
  const retryDelays = options.retryDelays || [2000, 5000, 15000];

  function emit(state) { options.onState(state); }

  function cancelTimer() {
    if (timer !== null) options.clearTimer(timer);
    timer = null;
  }

  function schedule(waitOverride) {
    if (stopped || inFlight || (!pending && !finalJob) || timer !== null) return;
    const wait = waitOverride === undefined
      ? Math.max(
          options.debounceMs,
          options.minIntervalMs - (options.now() - lastStartedAt)
        )
      : waitOverride;
    timer = options.setTimer(() => {
      timer = null;
      flush();
    }, Math.max(0, wait));
  }

  async function flush() {
    if (stopped || inFlight || (!pending && !finalJob)) return;
    cancelTimer();
    const job = finalJob || { snapshot: pending, kind: "draft" };
    let retryWait;
    if (job.kind === "draft") pending = null;
    inFlight = true;
    lastStartedAt = options.now();
    emit("saving");
    try {
      const ack = await options.send(job.snapshot);
      if (!ack || !ack.ok) throw new Error(ack && ack.message || "save failed");
      emit("saved");
      retryIndex = 0;
      if (job.kind === "final") {
        finalJob = null;
        stopped = true;
        job.resolve(ack);
      }
    } catch (error) {
      emit("offline");
      if (job.kind === "final") {
        finalJob = null;
        job.reject(error);
      } else if (!finalJob) {
        if (!pending || pending.revision < job.snapshot.revision) {
          pending = job.snapshot;
        }
        retryWait = retryDelays[Math.min(retryIndex, retryDelays.length - 1)];
        retryIndex += 1;
      }
    } finally {
      inFlight = false;
      if (finalJob) schedule(0);
      else if (pending && timer === null) schedule(retryWait);
    }
  }

  return {
    queue(snapshot) {
      if (stopped || finalJob) return;
      pending = snapshot;
      retryIndex = 0;
      if (!inFlight) cancelTimer();
      schedule();
    },
    flush,
    retry() {
      if (stopped || finalJob || !pending) return;
      cancelTimer();
      schedule(0);
    },
    submit(snapshot) {
      if (stopped) return Promise.reject(new Error("coordinator stopped"));
      pending = null;
      cancelTimer();
      return new Promise((resolve, reject) => {
        finalJob = { snapshot, kind: "final", resolve, reject };
        if (!inFlight) schedule(0);
      });
    },
    dispose() {
      stopped = true;
      pending = null;
      finalJob = null;
      cancelTimer();
    }
  };
}
```

Adjust the scheduling implementation until the deterministic tests prove:
there is at most one in-flight request, a pending snapshot is retained on
failure, only the newest pending revision follows an active request, retries
use bounded backoff, and final submission is serialized behind any active
draft.

- [ ] **Step 6: Run the browser persistence tests**

Run:

```bash
node persistence.test.js
```

Expected: all expiry, email omission, serialization, retry, and disposal tests
pass with no unhandled promise rejection.

- [ ] **Step 7: Commit the persistence module**

```bash
git add persistence.js persistence.test.js
git commit -m "Add browser autosave coordinator"
```

### Task 4: Wire local drafts, background saves, and final submission into the survey

**Files:**
- Modify: `index.html`
- Modify: `content.js`
- Modify: `survey.test.js`

**Interfaces:**
- Consumes: `window.SurveyPersistence`.
- Produces: `buildSnapshot(status)`, `queueDraftSave()`,
  `sendSnapshot(snapshot)`, and visible `saveStatus`.
- Preserves: current validation functions and final thank-you behavior.

- [ ] **Step 1: Extend structural tests before changing the page**

Add assertions to `survey.test.js`:

```js
assert.match(html, /<script src="persistence\.js"><\/script>/);
assert.match(html, /id="saveStatus"/);
assert.match(html, /id="website"/);
assert.match(html, /function buildSnapshot\(status\)/);
assert.match(html, /function queueDraftSave\(\)/);
assert.match(html, /window\.addEventListener\("online"/);
assert.match(html, /document\.addEventListener\("visibilitychange"/);
assert.doesNotMatch(C.intro.paragraphs.join(" "), /partial answers are saved/i);

assert.equal(typeof C.submit.saving, "string");
assert.equal(typeof C.submit.saved, "string");
assert.equal(typeof C.submit.savedOffline, "string");
```

- [ ] **Step 2: Run structural tests and verify failure**

Run:

```bash
node survey.test.js
```

Expected: FAIL because the persistence script, status element, honeypot, and
copy keys are absent.

- [ ] **Step 3: Add status copy and DOM hooks without disclosure copy**

In `content.js`, add:

```js
saving: "Saving…",
saved: "Saved",
savedOffline: "Saved on this device — offline",
saveFailed: "Could not reach the server — your answers remain on this device",
```

Do not change `C.intro.paragraphs`.

In `index.html`, load `persistence.js` before the inline survey script:

```html
<script src="content.js"></script>
<script src="persistence.js"></script>
<script>
```

Place a polite status region beside the progress indicator:

```html
<span id="saveStatus" class="save-status" role="status" aria-live="polite"></span>
```

Add an off-screen honeypot outside normal navigation:

```html
<div class="website-field" aria-hidden="true">
  <label for="website">Website</label>
  <input id="website" type="text" tabindex="-1" autocomplete="off">
</div>
```

Hide it with CSS that removes it visually without using `display: none`, so
simple bots still encounter the input:

```css
.website-field{
  position:absolute; left:-10000px; width:1px; height:1px; overflow:hidden;
}
.save-status{font-size:.8rem; color:var(--mid); white-space:nowrap}
```

- [ ] **Step 4: Replace the local draft loader with timestamped expiry**

Keep existing field/radio restoration, but accept a stored draft only when:

```js
const P = window.SurveyPersistence;
const now = Date.now();
if (saved && saved.response_id && !P.isDraftExpired(saved, now)) {
  draft = saved;
  // Existing field and radio hydration.
} else {
  localStorage.removeItem(DRAFT_KEY);
}
```

Initialize new drafts as:

```js
let draft = {
  response_id: newId(),
  revision: 0,
  last_completed_step: 0,
  local_updated_at: Date.now(),
  fields: {},
  radios: {}
};
```

Each changed local snapshot increments `revision`, updates
`local_updated_at`, and writes to local storage. Navigation updates
`last_completed_step` only after the current step validates successfully.

- [ ] **Step 5: Build exact draft and final envelopes**

Refactor the current `buildPayload()` answer collection into
`buildAnswers(includeEmail)` and `buildSnapshot(status)`:

```js
function buildSnapshot(status) {
  return {
    response_id: draft.response_id,
    revision: draft.revision,
    status,
    last_completed_step: draft.last_completed_step,
    content_version: CONTENT_VERSION,
    client_updated_at: new Date().toISOString(),
    honeypot: $("website").value,
    answers: buildAnswers(status === "submitted")
  };
}
```

`buildAnswers(false)` must not create an `email` property.
`buildAnswers(true)` includes `email: val("email") || null`.
Keep existing answer names so Apps Script produces the same flattened analysis
columns.

- [ ] **Step 6: Connect the coordinator after Start**

Create one coordinator:

```js
const autosave = P.createAutosaveCoordinator({
  send: sendSnapshot,
  onState(state) {
    const key = state === "saving" ? "saving"
      : state === "saved" ? "saved"
      : navigator.onLine ? "saveFailed" : "savedOffline";
    setText("saveStatus", C.submit[key]);
  },
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: id => clearTimeout(id),
  debounceMs: 3000,
  minIntervalMs: 5000,
  retryDelays: [2000, 5000, 15000]
});

let started = false;
function startSurvey() {
  started = true;
  go(1);
  queueDraftSave();
}

function queueDraftSave() {
  if (!started || MOCK) return;
  autosave.queue(P.draftEnvelope(buildSnapshot("draft")));
}
```

Change the Start button to call `startSurvey()`. After each local input/change
save, call `queueDraftSave()`. Next/Back should call `autosave.flush()` after
updating the completed step, without awaiting it.

Implement `sendSnapshot` with the existing 30-second abort and JSON response
checks. Add:

```js
window.addEventListener("online", () => autosave.retry());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") autosave.flush();
});
```

Do not depend on the visibility request arriving; local storage remains the
recovery source.

- [ ] **Step 7: Route final submission through the same contract**

Final submission must increment and persist the revision before sending:

```js
async function submitResponse() {
  if (MOCK) { review(); return; }
  if (sending) return;
  sending = true;
  const btn = $("submitBtn");
  btn.disabled = true;
  setText("submitBtn", C.submit.sending);
  setText("err4", "");

  try {
    saveDraft();
    const snapshot = buildSnapshot("submitted");
    const out = await autosave.submit(snapshot);
    if (!out.ok || out.status !== "submitted") {
      throw new Error(out.message || "final response was not confirmed");
    }
    autosave.dispose();
    localStorage.removeItem(DRAFT_KEY);
    go(5);
  } catch (err) {
    const network = err.name === "AbortError" || err instanceof TypeError;
    setText("err4", network
      ? C.submit.errNetwork
      : C.submit.errServer + err.message);
    setText("submitBtn", C.submit.retry);
  } finally {
    sending = false;
    btn.disabled = false;
  }
}
```

`autosave.submit` discards a merely pending draft and serializes the final
request behind an already in-flight draft. The server monotonic-status rule
remains the final protection against delayed delivery.

- [ ] **Step 8: Run all client tests**

Run:

```bash
node persistence.test.js
node survey.test.js
```

Expected: both suites pass.

- [ ] **Step 9: Manually exercise mock mode**

Run:

```bash
python3 -m http.server 8000
```

Verify at `http://localhost:8000`:

- no disclosure sentence was added;
- the survey still validates and navigates;
- refresh restores a local draft;
- changing the stored `local_updated_at` to more than 48 hours ago prevents
  restoration; and
- mock Submit still displays the final envelope.

- [ ] **Step 10: Commit client integration without staging unrelated hunks**

Inspect `git diff` and stage only persistence-related changes in overlapping
files:

```bash
git diff -- content.js index.html survey.test.js
git add -p content.js index.html survey.test.js
git commit -m "Autosave in-progress survey responses"
```

### Task 5: Add 48-hour cleanup and submitted-only backups

**Files:**
- Modify: `apps-script/Code.gs`
- Modify: `apps-script/Code.test.js`

**Interfaces:**
- Produces: `expiredDraftIds_(responseRows, nowMs)`,
  `cleanupExpiredDrafts()`, `toCsv_(rows)`,
  `backupSubmittedResponses()`, and `installMaintenanceTriggers()`.
- Consumes: Script Properties `BACKUP_FOLDER_ID` and `ALERT_EMAIL`.

- [ ] **Step 1: Write failing expiry and CSV tests**

Expose the new pure helpers from the VM loader and add:

```js
const HOUR = 60 * 60 * 1000;
const rows = [
  { response_id: "old", status: "draft", updated_at: new Date(NOW - 49 * HOUR) },
  { response_id: "fresh", status: "draft", updated_at: new Date(NOW - 47 * HOUR) },
  { response_id: "done", status: "submitted", updated_at: new Date(NOW - 100 * HOUR) }
];
assert.deepEqual(
  Array.from(expiredDraftIds_(rows, NOW)),
  ["old"]
);

const csv = toCsv_([
  ["response_id", "status", "answer"],
  ["one", "submitted", "comma, quote \" and\nnewline"]
]);
assert.equal(
  csv,
  'response_id,status,answer\r\none,submitted,"comma, quote "" and\nnewline"'
);
```

- [ ] **Step 2: Run server tests and verify failure**

Run:

```bash
node apps-script/Code.test.js
```

Expected: FAIL because expiry and CSV helpers are absent.

- [ ] **Step 3: Implement pure expiry and CSV helpers**

Add:

```js
const DRAFT_RETENTION_MS = 48 * 60 * 60 * 1000;
const BACKUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function expiredDraftIds_(rows, nowMs) {
  return rows
    .filter(row => row.status === 'draft' &&
      row.updated_at instanceof Date &&
      nowMs - row.updated_at.getTime() >= DRAFT_RETENTION_MS)
    .map(row => row.response_id);
}

function csvCell_(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function toCsv_(rows) {
  return rows.map(row => row.map(csvCell_).join(',')).join('\r\n');
}
```

- [ ] **Step 4: Implement active-storage cleanup**

`cleanupExpiredDrafts()` must:

1. acquire the script lock;
2. read response headers and rows into records;
3. derive expired IDs using server `updated_at`;
4. delete matching response rows from bottom to top;
5. delete every matching events row, including all historical revisions for
   those abandoned response IDs; and
6. release the lock in `finally`.

Submitted responses must never be selected, regardless of age. Log the count
of responses and events removed.

- [ ] **Step 5: Implement submitted-only daily CSV backups**

`backupSubmittedResponses()` must read the fixed response headers, select only
rows whose `status` cell equals `submitted`, and write a UTF-8 CSV to:

```js
const folderId = PropertiesService.getScriptProperties()
  .getProperty('BACKUP_FOLDER_ID');
if (!folderId) throw new Error('BACKUP_FOLDER_ID script property is not set');

const name = 'automation-survey-submitted-' +
  Utilities.formatDate(new Date(), 'Etc/UTC', 'yyyy-MM-dd') + '.csv';
const blob = Utilities.newBlob(
  toCsv_([headers].concat(submittedRows)),
  'text/csv',
  name
);
DriveApp.getFolderById(folderId).createFile(blob);
```

Before creating a file, exact-match today's filename and skip it if present.
After backup creation, trash files in that folder with the
`automation-survey-submitted-` prefix older than 90 days. Never include
`response_events` or draft rows in backup output.

- [ ] **Step 6: Install idempotent maintenance triggers**

Add a manually run setup function:

```js
function installMaintenanceTriggers() {
  const managed = ['cleanupExpiredDrafts', 'backupSubmittedResponses'];
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (managed.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('cleanupExpiredDrafts')
    .timeBased().everyHours(1).create();
  ScriptApp.newTrigger('backupSubmittedResponses')
    .timeBased().everyDays(1).atHour(3).create();
}
```

This is idempotent because it replaces only the two triggers owned by this
script.

- [ ] **Step 7: Run server tests**

Run:

```bash
node apps-script/Code.test.js
```

Expected: contract, storage, expiry, and CSV tests all pass.

- [ ] **Step 8: Commit maintenance automation**

```bash
git add apps-script/Code.gs apps-script/Code.test.js
git commit -m "Expire drafts and back up submissions"
```

### Task 6: Document deployment and run end-to-end verification

**Files:**
- Modify: `SETUP.md`
- Modify: `README.md`

**Interfaces:**
- Documents: production deployment, Script Property, trigger installation,
  expected sheets, operational checks, and rollback.

- [ ] **Step 1: Update setup instructions**

Add exact operator steps to `SETUP.md`:

1. Create a restricted Shared Drive folder for submitted-response backups.
2. In Apps Script, open **Project Settings → Script Properties** and add
   `BACKUP_FOLDER_ID` with the folder ID from its URL.
3. Add `ALERT_EMAIL` with the operator address that should receive rate-limited
   internal save-failure alerts.
4. Run `installMaintenanceTriggers` once and authorize Sheets/Drive/Mail
   access.
5. Confirm one hourly cleanup trigger and one daily backup trigger under
   **Triggers**.
6. Deploy a **new version** of the existing web-app deployment, preserving its
   `/exec` URL.
7. Confirm the script creates `responses` and `response_events`.
8. State that draft deletion is from active survey storage; Google service
   recovery copies follow Google's own retention.
9. State that respondent-disclosure copy remains deferred and is not part of
   this release.
10. Record the 90-day backup retention period.

- [ ] **Step 2: Update the README architecture summary**

Describe:

- immediate browser-local saving;
- anonymous server drafts without email;
- 48-hour abandoned-draft expiry;
- retry-safe final submissions;
- analysis from submitted rows only; and
- links to `SETUP.md`, the approved spec, and this plan.

- [ ] **Step 3: Run the complete local verification**

Run:

```bash
node survey.test.js
node persistence.test.js
node apps-script/Code.test.js
git diff --check
```

Expected: all three suites pass and `git diff --check` exits zero.

- [ ] **Step 4: Deploy to a test Sheet and verify the production path**

Use a non-production Google Sheet and the checklist below:

- start the survey and confirm a draft row and event appear without email;
- type rapidly and confirm revisions increase without overlapping duplicate
  event keys;
- turn Wi-Fi off, edit, and confirm the local/offline state;
- restore Wi-Fi and confirm the latest complete snapshot reaches the Sheet;
- submit and confirm one `submitted` response and a final event;
- resend the final request and confirm no duplicate event;
- send a later draft revision and confirm it cannot downgrade submission;
- send an unknown answer key and confirm no new header appears;
- alter a test draft's authoritative `updated_at` beyond 48 hours, run
  `cleanupExpiredDrafts`, and confirm both current and event rows disappear;
- run `backupSubmittedResponses` and parse the CSV to confirm drafts are
  absent and quoted multiline answers survive.

- [ ] **Step 5: Verify mobile and rage-quit recovery**

On one phone-sized browser and one desktop incognito window:

- fill half the survey and refresh;
- close and reopen the tab before 48 hours;
- navigate rapidly while saves occur;
- submit after a temporary network failure; and
- confirm the thank-you screen appears only after Sheet acknowledgement.

- [ ] **Step 6: Commit documentation**

```bash
git add SETUP.md README.md
git commit -m "Document survey persistence operations"
```

- [ ] **Step 7: Inspect the final branch**

Run:

```bash
git status --short
git log --oneline --decorate -8
```

Expected: implementation files are committed, while any pre-existing user
changes intentionally kept outside this work remain visible and uncommitted.
