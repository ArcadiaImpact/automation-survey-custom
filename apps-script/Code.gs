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

const SHEET_NAME = 'responses';
const MAX_BODY = 200000;      // characters; a real response is ~10–40k at most
const CELL_LIMIT = 45000;     // Sheets hard limit is 50,000 characters per cell
const FIXED_COLUMNS = ['received_at', 'response_id', 'content_version'];

function doPost(e) {
  try {
    const body = (e && e.postData && e.postData.contents) || '';
    if (!body) return reply_({ ok: false, error: 'empty body' });
    if (body.length > MAX_BODY) return reply_({ ok: false, error: 'response too large' });

    let data;
    try { data = JSON.parse(body); } catch (err) { return reply_({ ok: false, error: 'invalid JSON' }); }
    if (!data || typeof data !== 'object' || typeof data.response_id !== 'string' || !data.response_id) {
      return reply_({ ok: false, error: 'missing response_id' });
    }

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
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
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
