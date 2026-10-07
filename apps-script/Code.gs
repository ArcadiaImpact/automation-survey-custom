// ============================================================
// Automation Survey: response receiver (Google Apps Script).
// Deployed with clasp from apps-script/ (see SETUP.md), or pasted into
// Extensions → Apps Script of the results Google Sheet.
//
// What it does, per request (draft or final):
//   1. Parse and strictly validate the JSON the survey page sends. The
//      schema is fixed: unknown fields are rejected, never turned into
//      new Sheet columns.
//   2. Take a script lock so simultaneous requests cannot clash.
//   3. Compare revisions: a stale or duplicate write is acknowledged with
//      the current state and changes nothing; a submitted response is
//      never downgraded by a late draft.
//   4. Write the current state to the `responses` tab (one row per
//      response_id) and append the accepted snapshot to `response_events`.
//   5. Store the untouched JSON in raw_json columns as a lossless backup.
//   6. Reply {ok:true, accepted_revision, status}. The page shows
//      "thank you" only after a submitted acknowledgement.
// Hourly cleanup removes drafts idle for 48 h; a daily job backs up
// submitted rows to CSV. Both are installed by installMaintenanceTriggers.
// ============================================================

const RESPONSES_SHEET = 'responses';
const EVENTS_SHEET = 'response_events';
const MAX_BODY = 200000;      // characters; a real response is ~10–40k at most
const CELL_LIMIT = 45000;     // Sheets hard limit is 50,000 characters per cell
const DRAFT_RETENTION_MS = 48 * 60 * 60 * 1000;
const BACKUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
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
    if (incoming.status === 'submitted') {
      if (incoming.revision === current.revision) {
        return { kind: 'idempotent' };
      }
      if (incoming.revision > current.revision) {
        return { kind: 'accept' };
      }
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
      return reply_(processWrite_(data, body, new Date()));
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

// Visiting the URL in a browser just confirms the script is deployed.
// It never returns any responses.
function doGet() {
  return reply_({ ok: true, message: 'Automation survey endpoint is running.' });
}

function analysisColumns_() {
  const columns = [
    'response_id', 'status', 'revision', 'started_at', 'updated_at',
    'submitted_at', 'last_completed_step', 'content_version',
    'client_updated_at', 'email', 'job_title', 'role_type', 'experience',
    'ai_usage'
  ];
  TASK_IDS.forEach(function (id) {
    columns.push('points.' + id);
  });
  TASK_IDS.forEach(function (id) {
    ERAS.forEach(function (era) {
      columns.push('hours_active_human.' + id + '.' + era);
    });
  });
  columns.push(
    'hours_notes', 'highest_value_to_automate', 'main_reason',
    'agent_tracking'
  );
  return columns.concat(rawJsonColumns_());
}

function eventColumns_() {
  return [
    'event_key', 'event_at', 'response_id', 'revision', 'status'
  ].concat(rawJsonColumns_());
}

function rawJsonColumns_() {
  const count = Math.ceil(MAX_BODY / CELL_LIMIT);
  const columns = [];
  for (let n = 1; n <= count; n++) {
    columns.push(n === 1 ? 'raw_json' : 'raw_json_' + n);
  }
  return columns;
}

function eventKey_(responseId, revision) {
  return responseId + ':' + revision;
}

// Server timestamps are stored as ISO-8601 UTC text. Sheets never converts
// such text between time zones, whereas a Date cell read back through
// getValues() comes back shifted by the spreadsheet's UTC offset, so a
// read-and-rewrite would move started_at by that offset on every save.
function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function toMs_(value) {
  if (isDate_(value)) return value.getTime();
  if (typeof value === 'string' && value) return Date.parse(value);
  return NaN;
}

function toIso_(value) {
  const ms = toMs_(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function addRawJson_(record, rawBody) {
  const columns = rawJsonColumns_();
  for (let i = 0; i < columns.length; i++) {
    record[columns[i]] = rawBody.slice(i * CELL_LIMIT, (i + 1) * CELL_LIMIT);
  }
}

function buildResponseRecord_(incoming, rawBody, current, now) {
  const record = {
    response_id: incoming.response_id,
    status: incoming.status,
    revision: incoming.revision,
    started_at: toIso_(current && current.started_at) || toIso_(now),
    updated_at: toIso_(now),
    submitted_at: incoming.status === 'submitted'
      ? (toIso_(current && current.submitted_at) || toIso_(now))
      : '',
    last_completed_step: incoming.last_completed_step,
    content_version: incoming.content_version,
    client_updated_at: incoming.client_updated_at
  };
  Object.assign(record, flatten_(incoming.answers));
  addRawJson_(record, rawBody);
  return record;
}

function buildEventRecord_(response, now) {
  const event = {
    event_key: eventKey_(response.response_id, response.revision),
    event_at: toIso_(now),
    response_id: response.response_id,
    revision: response.revision,
    status: response.status
  };
  rawJsonColumns_().forEach(function (column) {
    event[column] = response[column] || '';
  });
  return event;
}

function processWriteWithStore_(store, incoming, rawBody, now) {
  let current = store.getResponse(incoming.response_id);
  const decision = decideWrite_(current, incoming);
  const isNew = !current;

  if (decision.kind === 'accept') {
    current = buildResponseRecord_(incoming, rawBody, current, now);
    store.putResponse(current);
  } else if (!current || current.revision !== incoming.revision) {
    return acknowledgement_(current);
  }

  // A brand-new response cannot have events yet, so skip that lookup.
  const key = eventKey_(current.response_id, current.revision);
  if (isNew || !store.hasEvent(key)) {
    store.appendEvent(buildEventRecord_(current, now));
  }
  return acknowledgement_(current);
}

function acknowledgement_(current) {
  if (!current) {
    return result_(false, 'missing_response', 'Response was not found.');
  }
  return {
    ok: true,
    response_id: current.response_id,
    accepted_revision: Number(current.revision),
    status: current.status
  };
}

function processWrite_(incoming, rawBody, now) {
  return processWriteWithStore_(
    createSheetStore_(SpreadsheetApp.getActiveSpreadsheet()),
    incoming, rawBody, now
  );
}

function createSheetStore_(ss) {
  const responseHeaders = analysisColumns_();
  const eventHeaders = eventColumns_();
  const responseSheet = getFixedSheet_(ss, RESPONSES_SHEET, responseHeaders);
  const eventSheet = getFixedSheet_(ss, EVENTS_SHEET, eventHeaders);

  // Row positions found while reading are reused when writing, so an
  // update searches the sheet once. The store lives for one locked request.
  const rowById = {};

  return {
    getResponse: function (id) {
      const row = findRow_(responseSheet, responseHeaders, 'response_id', id);
      rowById[id] = row;
      return row ? readRecord_(responseSheet, responseHeaders, row) : null;
    },
    putResponse: function (record) {
      const id = record.response_id;
      const known = Object.prototype.hasOwnProperty.call(rowById, id)
        ? rowById[id]
        : findRow_(responseSheet, responseHeaders, 'response_id', id);
      const row = known || responseSheet.getLastRow() + 1;
      rowById[id] = row;
      writeRecord_(responseSheet, responseHeaders, row, record);
    },
    hasEvent: function (key) {
      return Boolean(findRow_(eventSheet, eventHeaders, 'event_key', key));
    },
    appendEvent: function (record) {
      writeRecord_(
        eventSheet, eventHeaders, eventSheet.getLastRow() + 1, record
      );
    }
  };
}

function getFixedSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  // Validating the header row costs a Sheets read per tab per request.
  // Remember a passed check for ten minutes.
  const cache = CacheService.getScriptCache();
  const cacheKey = 'schema:' + name + ':' + hashText_(headers.join('|'));
  if (cache.get(cacheKey)) return sheet;
  const actual = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0].map(String);
  if (actual.length !== headers.length ||
      actual.some(function (header, index) { return header !== headers[index]; })) {
    throw new Error(
      'Unexpected headers in "' + name + '". Use a clean sheet or restore the expected schema.'
    );
  }
  cache.put(cacheKey, '1', 600);
  return sheet;
}

// Short stable fingerprint of a string (FNV-1a), used for cache keys.
function hashText_(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function findRow_(sheet, headers, keyColumn, value) {
  const column = headers.indexOf(keyColumn) + 1;
  const lastRow = sheet.getLastRow();
  if (!column || lastRow < 2) return 0;
  const hit = sheet.getRange(2, column, lastRow - 1, 1)
    .createTextFinder(String(value)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function readRecord_(sheet, headers, row) {
  const values = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
  const record = {};
  headers.forEach(function (header, index) {
    record[header] = values[index];
  });
  return record;
}

function writeRecord_(sheet, headers, row, record) {
  const values = headers.map(function (header) {
    return Object.prototype.hasOwnProperty.call(record, header)
      ? toCell_(record[header])
      : '';
  });
  sheet.getRange(row, 1, 1, values.length).setValues([values]);
}

function expiredDraftIds_(rows, nowMs) {
  return rows.filter(function (row) {
    const updatedMs = toMs_(row.updated_at);
    return row.status === 'draft' &&
      Number.isFinite(updatedMs) &&
      nowMs - updatedMs >= DRAFT_RETENTION_MS;
  }).map(function (row) {
    return row.response_id;
  });
}

function csvCell_(value) {
  const text = value === null || value === undefined
    ? ''
    : isDate_(value) ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text)
    ? '"' + text.replace(/"/g, '""') + '"'
    : text;
}

function toCsv_(rows) {
  return rows.map(function (row) {
    return row.map(csvCell_).join(',');
  }).join('\r\n');
}

function submittedRows_(headers, rows) {
  const statusColumn = headers.indexOf('status');
  if (statusColumn === -1) {
    throw new Error('Responses sheet has no status column.');
  }
  return rows.filter(function (row) {
    return row[statusColumn] === 'submitted';
  });
}

function readDataRows_(sheet, width) {
  const lastRow = sheet.getLastRow();
  return lastRow < 2
    ? []
    : sheet.getRange(2, 1, lastRow - 1, width).getValues();
}

function rowsToRecords_(headers, rows) {
  return rows.map(function (row) {
    const record = {};
    headers.forEach(function (header, index) {
      record[header] = row[index];
    });
    return record;
  });
}

function deleteRowsForIds_(sheet, headers, rows, idSet) {
  const idColumn = headers.indexOf('response_id');
  let removed = 0;
  for (let index = rows.length - 1; index >= 0; index--) {
    if (idSet[rows[index][idColumn]]) {
      sheet.deleteRow(index + 2);
      removed++;
    }
  }
  return removed;
}

function withLock_(lock, operation) {
  lock.waitLock(30000);
  try {
    return operation();
  } finally {
    lock.releaseLock();
  }
}

function cleanupExpiredDrafts() {
  return withLock_(LockService.getScriptLock(), function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const responseHeaders = analysisColumns_();
    const eventHeaders = eventColumns_();
    const responseSheet = getFixedSheet_(
      ss, RESPONSES_SHEET, responseHeaders
    );
    const eventSheet = getFixedSheet_(ss, EVENTS_SHEET, eventHeaders);
    const responseRows = readDataRows_(responseSheet, responseHeaders.length);
    const expired = expiredDraftIds_(
      rowsToRecords_(responseHeaders, responseRows),
      Date.now()
    );
    const idSet = {};
    expired.forEach(function (id) { idSet[id] = true; });

    const responsesRemoved = deleteRowsForIds_(
      responseSheet, responseHeaders, responseRows, idSet
    );
    const eventRows = readDataRows_(eventSheet, eventHeaders.length);
    const eventsRemoved = deleteRowsForIds_(
      eventSheet, eventHeaders, eventRows, idSet
    );
    console.log(
      'Expired drafts removed: ' + responsesRemoved +
      '; events removed: ' + eventsRemoved
    );
  });
}

function backupSubmittedResponses() {
  const folderId = PropertiesService.getScriptProperties()
    .getProperty('BACKUP_FOLDER_ID');
  if (!folderId) {
    throw new Error('BACKUP_FOLDER_ID script property is not set');
  }

  const snapshot = withLock_(LockService.getScriptLock(), function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const headers = analysisColumns_();
    const sheet = getFixedSheet_(ss, RESPONSES_SHEET, headers);
    const rows = readDataRows_(sheet, headers.length);
    return {
      headers: headers,
      submitted: submittedRows_(headers, rows)
    };
  });
  const headers = snapshot.headers;
  const submitted = snapshot.submitted;
  const folder = DriveApp.getFolderById(folderId);
  const now = new Date();
  const prefix = 'automation-survey-submitted-';
  const name = prefix +
    Utilities.formatDate(now, 'Etc/UTC', 'yyyy-MM-dd') + '.csv';

  if (!folder.getFilesByName(name).hasNext()) {
    const blob = Utilities.newBlob(
      toCsv_([headers].concat(submitted)),
      'text/csv',
      name
    );
    folder.createFile(blob);
  }

  const cutoff = now.getTime() - BACKUP_RETENTION_MS;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().indexOf(prefix) === 0 &&
        file.getDateCreated().getTime() <= cutoff) {
      file.setTrashed(true);
    }
  }
}

function installMaintenanceTriggers() {
  const managed = ['cleanupExpiredDrafts', 'backupSubmittedResponses'];
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (managed.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('cleanupExpiredDrafts')
    .timeBased().everyHours(1).create();
  ScriptApp.newTrigger('backupSubmittedResponses')
    .timeBased().everyDays(1).atHour(3).create();
}

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
