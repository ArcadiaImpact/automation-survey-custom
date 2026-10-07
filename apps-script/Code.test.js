const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(`${__dirname}/Code.gs`, "utf8");
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  `${source}
  this.__test = {
    parseRequest_, validateEnvelope_, validateAnswers_, decideWrite_
  };`,
  sandbox
);

const {
  parseRequest_,
  validateEnvelope_,
  validateAnswers_,
  decideWrite_,
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

console.log("Apps Script contract checks passed.");
