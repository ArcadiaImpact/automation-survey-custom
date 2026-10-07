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
