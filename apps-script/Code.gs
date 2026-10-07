// ============================================================
// Automation Survey: response receiver (Google Apps Script).
// Paste this into Extensions → Apps Script of the results Google Sheet.
// Setup steps are in SETUP.md.
//
// What it does, per submission:
//   1. Parse the JSON the survey page sends.
//   2. Take a lock so two simultaneous submissions can't clash.
//   3. Flatten it to columns (points.design, hours.design.now, ...).
//      New questions automatically get new columns at the right edge.
//   4. If this response_id is already in the sheet (a retry), overwrite
//      that row; otherwise append a new row.
//   5. Also store the untouched JSON in raw_json, as a lossless backup.
//   6. Reply {ok:true}. The page only shows "thank you" after this.
// ============================================================

const RESPONSES_SHEET = 'responses';
const EVENTS_SHEET = 'response_events';
const MAX_BODY = 200000;      // characters; a real response is ~10–40k at most
const CELL_LIMIT = 45000;     // Sheets hard limit is 50,000 characters per cell
const FIXED_COLUMNS = ['received_at', 'response_id', 'content_version'];
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
const SHORT_TEXT_KEYS = ['job_title', 'role_type', 'experience'];
const LONG_TEXT_KEYS = [
  'ai_usage', 'hours_notes', 'highest_value_to_automate',
  'main_reason', 'agent_tracking'
];
const REQUIRED_FINAL_TEXT_KEYS = [
  'job_title', 'role_type', 'experience', 'ai_usage',
  'highest_value_to_automate', 'main_reason', 'agent_tracking'
];

function result_(ok, code, message) {
  return { ok: ok, code: code || '', message: message || '' };
}

function parseRequest_(rawBody) {
  if (!rawBody) return result_(false, 'empty_body', 'Empty request.');
  if (rawBody.length > MAX_BODY) {
    return result_(false, 'too_large', 'Response is too large.');
  }

  let value;
  try {
    value = JSON.parse(rawBody);
  } catch (err) {
    return result_(false, 'invalid_json', 'Invalid JSON.');
  }

  const checked = validateEnvelope_(value);
  if (!checked.ok) return checked;
  return { ok: true, value: value };
}

function validateEnvelope_(value) {
  if (!isObject_(value)) {
    return result_(false, 'invalid_request', 'Request must be an object.');
  }
  if (unknownKeys_(value, ENVELOPE_KEYS).length) {
    return result_(false, 'unknown_field', 'Unknown request field.');
  }
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
  if (typeof value.content_version !== 'string' ||
      !value.content_version || value.content_version.length > 100) {
    return result_(false, 'invalid_content_version', 'Invalid content version.');
  }
  if (typeof value.client_updated_at !== 'string' ||
      !Number.isFinite(Date.parse(value.client_updated_at))) {
    return result_(false, 'invalid_timestamp', 'Invalid client timestamp.');
  }
  return validateAnswers_(value.answers, value.status === 'submitted');
}

function validateAnswers_(answers, isFinal) {
  if (!isObject_(answers)) {
    return result_(false, 'invalid_answers', 'Answers must be an object.');
  }
  if (unknownKeys_(answers, ANSWER_KEYS).length) {
    return result_(false, 'unknown_answer', 'Unknown answer field.');
  }
  if (!isFinal && Object.prototype.hasOwnProperty.call(answers, 'email')) {
    return result_(false, 'draft_email', 'Drafts must not contain email.');
  }

  if (Object.prototype.hasOwnProperty.call(answers, 'email') &&
      !validText_(answers.email, 200, true)) {
    return result_(false, 'invalid_text', 'Invalid email.');
  }
  for (let i = 0; i < SHORT_TEXT_KEYS.length; i++) {
    const key = SHORT_TEXT_KEYS[i];
    if (Object.prototype.hasOwnProperty.call(answers, key) &&
        !validText_(answers[key], 300, true)) {
      return result_(false, 'invalid_text', 'Invalid ' + key + '.');
    }
  }
  for (let i = 0; i < LONG_TEXT_KEYS.length; i++) {
    const key = LONG_TEXT_KEYS[i];
    if (Object.prototype.hasOwnProperty.call(answers, key) &&
        !validText_(answers[key], 4000, true)) {
      return result_(false, 'invalid_text', 'Invalid ' + key + '.');
    }
  }

  const pointsResult = validatePoints_(answers.points, isFinal);
  if (!pointsResult.ok) return pointsResult;
  const hoursResult = validateHours_(answers.hours_active_human, isFinal);
  if (!hoursResult.ok) return hoursResult;

  if (isFinal) {
    for (let i = 0; i < REQUIRED_FINAL_TEXT_KEYS.length; i++) {
      const key = REQUIRED_FINAL_TEXT_KEYS[i];
      if (typeof answers[key] !== 'string' || !answers[key].trim()) {
        return result_(false, 'missing_required', 'Missing required answer.');
      }
    }
  }
  return result_(true);
}

function validatePoints_(points, isFinal) {
  if (points === undefined && !isFinal) return result_(true);
  if (!hasExactKeys_(points, TASK_IDS)) {
    return result_(false, 'invalid_points', 'Invalid points.');
  }
  let total = 0;
  for (let i = 0; i < TASK_IDS.length; i++) {
    const value = points[TASK_IDS[i]];
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return result_(false, 'invalid_points', 'Invalid points.');
    }
    total += value;
  }
  if (isFinal && total !== 100) {
    return result_(false, 'invalid_points', 'Points must total 100.');
  }
  return result_(true);
}

function validateHours_(hours, isFinal) {
  if (hours === undefined && !isFinal) return result_(true);
  if (!hasExactKeys_(hours, TASK_IDS)) {
    return result_(false, 'invalid_hours', 'Invalid hours.');
  }
  for (let i = 0; i < TASK_IDS.length; i++) {
    const row = hours[TASK_IDS[i]];
    if (!hasExactKeys_(row, ERAS)) {
      return result_(false, 'invalid_hours', 'Invalid hours.');
    }
    let nulls = 0;
    for (let j = 0; j < ERAS.length; j++) {
      const value = row[ERAS[j]];
      if (value === null) {
        nulls++;
      } else if (!Number.isFinite(value) || value < 0) {
        return result_(false, 'invalid_hours', 'Invalid hours.');
      }
    }
    if (isFinal && nulls !== 0 && nulls !== ERAS.length) {
      return result_(false, 'invalid_hours', 'Complete or clear each hours row.');
    }
  }
  return result_(true);
}

function decideWrite_(current, incoming) {
  if (!current) return { kind: 'accept' };
  if (current.status === 'submitted') {
    if (incoming.status === 'submitted' &&
        incoming.revision === current.revision) {
      return { kind: 'idempotent' };
    }
    return { kind: 'stale' };
  }
  if (incoming.revision <= current.revision) return { kind: 'stale' };
  return { kind: 'accept' };
}

function isObject_(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeys_(value, allowed) {
  return Object.keys(value).filter(function (key) {
    return allowed.indexOf(key) === -1;
  });
}

function hasExactKeys_(value, expected) {
  if (!isObject_(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every(function (key) {
      return Object.prototype.hasOwnProperty.call(value, key);
    });
}

function validText_(value, maxLength, allowNull) {
  if (allowNull && value === null) return true;
  return typeof value === 'string' && value.length <= maxLength;
}

function doPost(e) {
  try {
    const body = (e && e.postData && e.postData.contents) || '';
    const parsed = parseRequest_(body);
    if (!parsed.ok) return reply_(parsed);
    const data = parsed.value;

    const lock = LockService.getScriptLock();
    lock.waitLock(30000); // throws if it can't get the lock; caught below, page shows "try again"
    try {
      const row = writeResponse_(data, body);
      return reply_({ ok: true, response_id: data.response_id, row: row });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error(err);
    return reply_({ ok: false, error: String(err && err.message || err) });
  }
}

// Visiting the URL in a browser just confirms the script is deployed.
// It never returns any responses.
function doGet() {
  return reply_({ ok: true, message: 'Automation survey endpoint is running.' });
}

function writeResponse_(data, rawBody) {
  const sheet = getSheet_();

  const record = {
    received_at: new Date(),
    response_id: data.response_id,
    content_version: data.content_version || ''
  };
  const flat = flatten_(data);
  delete flat.response_id;
  delete flat.content_version;
  Object.assign(record, flat);

  // The raw JSON goes in raw_json (and raw_json_2, ... if it is very long).
  for (let i = 0, n = 1; i < rawBody.length || n === 1; i += CELL_LIMIT, n++) {
    record[n === 1 ? 'raw_json' : 'raw_json_' + n] = rawBody.slice(i, i + CELL_LIMIT);
  }

  // Make sure every key has a column; add missing ones at the right edge.
  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const missing = Object.keys(record).filter(k => headers.indexOf(k) === -1);
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
  }

  const values = headers.map(h => (h in record) ? toCell_(record[h]) : '');

  // Retry of an already-saved response → overwrite that row (latest answers win).
  const idCol = headers.indexOf('response_id') + 1;
  const lastRow = sheet.getLastRow();
  let target = lastRow + 1;
  if (lastRow >= 2) {
    const hit = sheet.getRange(2, idCol, lastRow - 1, 1)
      .createTextFinder(data.response_id).matchEntireCell(true).findNext();
    if (hit) target = hit.getRow();
  }
  sheet.getRange(target, 1, 1, values.length).setValues([values]);
  return target;
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(RESPONSES_SHEET);
  if (!sheet) sheet = ss.insertSheet(RESPONSES_SHEET);
  if (sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, FIXED_COLUMNS.length).setValues([FIXED_COLUMNS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// {points: {design: 20}} → {"points.design": 20}
function flatten_(obj, prefix, out) {
  out = out || {};
  Object.keys(obj).forEach(k => {
    const key = prefix ? prefix + '.' + k : k;
    const v = obj[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten_(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  });
  return out;
}

// Store numbers/dates as-is. Store text as plain text: Sheets would otherwise
// treat answers starting with = + - @ as formulas ("-ish, mostly Claude" → #ERROR!).
function toCell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  let s = String(v);
  if (s.length > CELL_LIMIT) s = s.slice(0, CELL_LIMIT); // full text is still in raw_json
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
