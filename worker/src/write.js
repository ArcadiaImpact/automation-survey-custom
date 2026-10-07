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
