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
