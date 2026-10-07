const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(`${__dirname}/Code.gs`, "utf8");
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  `${source}
  this.__test = {
    parseRequest_, validateEnvelope_, validateAnswers_, decideWrite_,
    buildResponseRecord_, eventKey_, toCell_, processWriteWithStore_,
    expiredDraftIds_, toCsv_, submittedRows_, withLock_,
    getFixedSheet_, createSheetStore_
  };`,
  sandbox
);

const {
  parseRequest_,
  validateEnvelope_,
  validateAnswers_,
  decideWrite_,
  buildResponseRecord_,
  eventKey_,
  toCell_,
  processWriteWithStore_,
  expiredDraftIds_,
  toCsv_,
  submittedRows_,
  withLock_,
  getFixedSheet_,
  createSheetStore_,
} = sandbox.__test;

function validAnswers() {
  const taskIds = [
    "conceptual",
    "design",
    "infra",
    "running",
    "writing",
    "collaborating",
  ];
  const points = Object.fromEntries(
    taskIds.map((id, index) => [id, index === 0 ? 100 : 0])
  );
  const hours_active_human = Object.fromEntries(
    taskIds.map((id) => [
      id,
      {
        without_ai: null,
        one_year_ago: null,
        now: null,
        in_6_months: null,
      },
    ])
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
    ...overrides,
  };
}

assert.equal(validateEnvelope_(envelope()).ok, true);
assert.equal(
  validateEnvelope_(envelope({ unexpected: true })).code,
  "unknown_field"
);
assert.equal(validateEnvelope_(envelope({ honeypot: "spam" })).code, "spam");
assert.equal(
  validateEnvelope_(
    envelope({ answers: { ...validAnswers(), email: "draft@example.com" } })
  ).code,
  "draft_email"
);
assert.equal(
  validateEnvelope_(
    envelope({ status: "submitted", answers: validAnswers() })
  ).ok,
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

const correctedFinal = decideWrite_(
  { status: "submitted", revision: 5 },
  { status: "submitted", revision: 6 }
);
assert.equal(correctedFinal.kind, "accept");

const unknownAnswers = { ...draftAnswers(), arbitrary: "column injection" };
assert.equal(
  validateEnvelope_(envelope({ answers: unknownAnswers })).code,
  "unknown_answer"
);

const badTotal = validAnswers();
badTotal.points = { ...badTotal.points, conceptual: 99 };
assert.equal(
  validateEnvelope_(
    envelope({ status: "submitted", answers: badTotal })
  ).code,
  "invalid_points"
);

const partialHours = validAnswers();
partialHours.hours_active_human.conceptual = {
  without_ai: 1,
  one_year_ago: null,
  now: 1,
  in_6_months: 1,
};
assert.equal(
  validateEnvelope_(
    envelope({ status: "submitted", answers: partialHours })
  ).code,
  "invalid_hours"
);

assert.equal(parseRequest_("").code, "empty_body");
assert.equal(parseRequest_("{").code, "invalid_json");

const submitted = envelope({
  status: "submitted",
  answers: validAnswers(),
});
const now = new Date("2026-10-07T09:00:00.000Z");
const record = buildResponseRecord_(
  submitted,
  JSON.stringify(submitted),
  null,
  now
);

assert.equal(record.status, "submitted");
assert.equal(record.revision, 3);
assert.equal(record["points.conceptual"], 100);
assert.equal(record["hours_active_human.conceptual.now"], null);
assert.equal(record.started_at, "2026-10-07T09:00:00.000Z", "server timestamps are ISO text");
assert.equal(record.updated_at, "2026-10-07T09:00:00.000Z");
assert.equal(record.submitted_at, "2026-10-07T09:00:00.000Z");
assert.equal(
  eventKey_(submitted.response_id, 3),
  "123e4567-e89b-42d3-a456-426614174000:3"
);
assert.equal(toCell_("=1+1"), "'=1+1");

// started_at must survive a read-back-and-rewrite unchanged, and a legacy row
// whose started_at is still a Date is converted to text so it stops drifting.
{
  const tz = createFakeStore();
  const id = "cccccccc-dddd-4eee-8fff-000000000000";
  const t1 = new Date("2026-10-07T09:00:00.000Z");
  const t2 = new Date("2026-10-07T09:45:00.000Z");
  const first = envelope({ response_id: id, revision: 1 });
  processWriteWithStore_(tz, first, JSON.stringify(first), t1);
  const second = envelope({ response_id: id, revision: 2 });
  processWriteWithStore_(tz, second, JSON.stringify(second), t2);
  const row = tz.getResponse(id);
  assert.equal(row.started_at, "2026-10-07T09:00:00.000Z", "started_at keeps the first write time");
  assert.equal(row.updated_at, "2026-10-07T09:45:00.000Z");
  assert.equal(tz.events[1].event_at, "2026-10-07T09:45:00.000Z", "event times are ISO text too");

  const legacy = buildResponseRecord_(
    envelope({ revision: 9 }),
    "{}",
    { started_at: new Date("2026-10-06T19:33:20.000Z"), submitted_at: "" },
    t2
  );
  assert.equal(legacy.started_at, "2026-10-06T19:33:20.000Z", "a Date read from an old row becomes text");
}

const laterDraft = envelope({
  revision: 6,
  status: "draft",
  answers: draftAnswers(),
});
assert.equal(
  decideWrite_({ status: "submitted", revision: 5 }, laterDraft).kind,
  "stale"
);

function createFakeStore() {
  return {
    responses: [],
    events: [],
    failNextEventAppend: false,
    getResponse(id) {
      return this.responses.find((item) => item.response_id === id) || null;
    },
    putResponse(value) {
      const index = this.responses.findIndex(
        (item) => item.response_id === value.response_id
      );
      if (index === -1) this.responses.push(value);
      else this.responses[index] = value;
    },
    hasEvent(key) {
      return this.events.some((item) => item.event_key === key);
    },
    appendEvent(value) {
      if (this.failNextEventAppend) {
        this.failNextEventAppend = false;
        throw new Error("simulated event append failure");
      }
      this.events.push(value);
    },
  };
}

const store = createFakeStore();
const incoming = envelope({ revision: 7 });
const incomingBody = JSON.stringify(incoming);

store.failNextEventAppend = true;
assert.throws(
  () => processWriteWithStore_(store, incoming, incomingBody, now),
  /simulated event append failure/
);
assert.equal(store.responses.length, 1);
assert.equal(store.events.length, 0);

const ack = processWriteWithStore_(store, incoming, incomingBody, now);
assert.equal(ack.ok, true);
assert.equal(ack.accepted_revision, 7);
assert.equal(ack.status, "draft");
assert.equal(store.responses.length, 1);
assert.equal(store.events.length, 1);
assert.equal(store.events[0].raw_json, store.responses[0].raw_json);

const repeated = processWriteWithStore_(store, incoming, incomingBody, now);
assert.equal(repeated.ok, true);
assert.equal(store.events.length, 1);

const oldDraft = envelope({ revision: 6 });
const oldAck = processWriteWithStore_(
  store,
  oldDraft,
  JSON.stringify(oldDraft),
  now
);
assert.equal(oldAck.accepted_revision, 7);
assert.equal(store.events.length, 1);

const NOW = Date.parse("2026-10-07T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const rows = [
  {
    response_id: "old",
    status: "draft",
    updated_at: new Date(NOW - 49 * HOUR),
  },
  {
    response_id: "boundary",
    status: "draft",
    updated_at: new Date(NOW - 48 * HOUR),
  },
  {
    response_id: "fresh",
    status: "draft",
    updated_at: new Date(NOW - 47 * HOUR),
  },
  {
    response_id: "done",
    status: "submitted",
    updated_at: new Date(NOW - 100 * HOUR),
  },
];
assert.deepEqual(Array.from(expiredDraftIds_(rows, NOW)), [
  "old",
  "boundary",
]);
assert.deepEqual(
  Array.from(
    expiredDraftIds_(
      [
        { response_id: "iso-old", status: "draft", updated_at: "2026-10-05T08:00:00.000Z" },
        { response_id: "iso-fresh", status: "draft", updated_at: "2026-10-05T10:00:00.001Z" },
        { response_id: "iso-garbage", status: "draft", updated_at: "not a time" },
      ],
      NOW
    )
  ),
  ["iso-old"],
  "ISO text timestamps are compared correctly; unparseable ones are left alone"
);

const csv = toCsv_([
  ["response_id", "status", "answer"],
  ["one", "submitted", 'comma, quote " and\nnewline'],
]);
assert.equal(
  csv,
  'response_id,status,answer\r\none,submitted,"comma, quote "" and\nnewline"'
);
assert.equal(
  toCsv_([[new Date("2026-10-07T09:00:00.000Z")]]),
  "2026-10-07T09:00:00.000Z",
  "legacy Date cells export as ISO text"
);

assert.deepEqual(
  Array.from(
    submittedRows_(
      ["response_id", "status", "answer"],
      [
        ["draft", "draft", "partial"],
        ["done", "submitted", "complete"],
      ]
    ),
    (row) => Array.from(row)
  ),
  [["done", "submitted", "complete"]]
);

const lockCalls = [];
assert.throws(
  () =>
    withLock_(
      {
        waitLock(timeout) {
          lockCalls.push(["wait", timeout]);
        },
        releaseLock() {
          lockCalls.push(["release"]);
        },
      },
      () => {
        throw new Error("operation failed");
      }
    ),
  /operation failed/
);
assert.deepEqual(lockCalls, [["wait", 30000], ["release"]]);

// ---- fewer Sheets round trips per request ----

// A brand-new response cannot already have events, so the duplicate-event
// lookup is skipped for it and only done when a current row existed.
{
  const fresh = createFakeStore();
  let hasEventCalls = 0;
  const originalHasEvent = fresh.hasEvent.bind(fresh);
  fresh.hasEvent = (key) => {
    hasEventCalls++;
    return originalHasEvent(key);
  };
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const first = envelope({ response_id: id, revision: 1 });
  processWriteWithStore_(fresh, first, JSON.stringify(first), now);
  assert.equal(hasEventCalls, 0, "new response: no duplicate-event lookup");
  assert.equal(fresh.events.length, 1);
  const second = envelope({ response_id: id, revision: 2 });
  processWriteWithStore_(fresh, second, JSON.stringify(second), now);
  assert.equal(hasEventCalls, 1, "existing response: lookup still happens");
  assert.equal(fresh.events.length, 2);
}

function createFakeCache() {
  const map = new Map();
  return {
    get: (key) => (map.has(key) ? map.get(key) : null),
    put: (key, value) => {
      map.set(key, value);
    },
  };
}

function createFakeSheet(headerRow) {
  const rows = headerRow.length ? [headerRow.slice()] : [];
  const sheet = {
    headerReads: 0,
    finderCalls: 0,
    _rows: rows,
    getLastColumn() {
      return rows[0] ? rows[0].length : 0;
    },
    getLastRow() {
      return rows.length;
    },
    setFrozenRows() {},
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues() {
          if (r === 1) sheet.headerReads++;
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = rows[r - 1 + i] || [];
            out.push(
              Array.from({ length: nc }, (_, j) =>
                row[c - 1 + j] === undefined ? "" : row[c - 1 + j]
              )
            );
          }
          return out;
        },
        setValues(values) {
          values.forEach((v, i) => {
            const index = r - 1 + i;
            rows[index] = rows[index] || [];
            v.forEach((x, j) => {
              rows[index][c - 1 + j] = x;
            });
          });
        },
        createTextFinder(text) {
          sheet.finderCalls++;
          return {
            matchEntireCell() {
              return this;
            },
            findNext() {
              for (let i = 0; i < nr; i++) {
                const row = rows[r - 1 + i];
                if (row && String(row[c - 1]) === text) {
                  const rowNumber = r + i;
                  return { getRow: () => rowNumber };
                }
              }
              return null;
            },
          };
        },
      };
    },
  };
  return sheet;
}

function createFakeSpreadsheet(sheets) {
  return {
    getSheetByName: (name) => sheets[name] || null,
    insertSheet(name) {
      sheets[name] = createFakeSheet([]);
      return sheets[name];
    },
  };
}

// Header validation is remembered in the script cache, so a warm request
// does not re-read the header row of each tab.
{
  const cache = createFakeCache();
  sandbox.CacheService = { getScriptCache: () => cache };
  const headers = ["alpha", "beta"];
  const sheets = { fixed: createFakeSheet(headers) };
  const ss = createFakeSpreadsheet(sheets);
  getFixedSheet_(ss, "fixed", headers);
  getFixedSheet_(ss, "fixed", headers);
  assert.equal(sheets.fixed.headerReads, 1, "header row validated once, then cached");

  // A wrong schema is still rejected when nothing is cached.
  sandbox.CacheService = { getScriptCache: () => createFakeCache() };
  assert.throws(
    () => getFixedSheet_(createFakeSpreadsheet({ fixed: createFakeSheet(["alpha", "WRONG"]) }), "fixed", headers),
    /Unexpected headers/
  );
}

// Updating an existing response searches for its row once, not once to read
// and again to write.
{
  sandbox.CacheService = { getScriptCache: () => createFakeCache() };
  const sheets = {};
  const store = createSheetStore_(createFakeSpreadsheet(sheets));
  const id = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const first = envelope({ response_id: id, revision: 1 });
  processWriteWithStore_(store, first, JSON.stringify(first), now);
  const second = envelope({ response_id: id, revision: 2 });
  processWriteWithStore_(store, second, JSON.stringify(second), now);
  assert.equal(sheets.responses.finderCalls, 1, "one row search per update");
  assert.equal(sheets.responses._rows.length, 2, "header row plus one response row");
  assert.equal(sheets.response_events._rows.length, 3, "header row plus two events");
  assert.equal(sheets.responses._rows[1][2], 2, "row holds the latest revision");
}

console.log("Apps Script contract checks passed.");
