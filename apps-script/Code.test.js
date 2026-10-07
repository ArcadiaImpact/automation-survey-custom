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
    expiredDraftIds_, toCsv_, submittedRows_
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
assert.equal(record.started_at.toISOString(), now.toISOString());
assert.equal(record.submitted_at.toISOString(), now.toISOString());
assert.equal(
  eventKey_(submitted.response_id, 3),
  "123e4567-e89b-42d3-a456-426614174000:3"
);
assert.equal(toCell_("=1+1"), "'=1+1");

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

const csv = toCsv_([
  ["response_id", "status", "answer"],
  ["one", "submitted", 'comma, quote " and\nnewline'],
]);
assert.equal(
  csv,
  'response_id,status,answer\r\none,submitted,"comma, quote "" and\nnewline"'
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

console.log("Apps Script contract checks passed.");
