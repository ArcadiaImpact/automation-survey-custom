# Fast Write Path: Cloudflare Worker + D1, Sheet as a Mirror

## Summary

The survey stays a static site and Google Sheets stays the place the team looks
at results. What changes is where the browser sends its writes. Today every
draft and final submission goes to a Google Apps Script web app, which takes
1.5 to 20 seconds per request and serialises all writes behind one lock. A
burst test on 2026-10-07 with 30 simultaneous submits lost about half of all
write attempts and made the other half wait 12 to 28 seconds.

This design moves the write path to a small Cloudflare Worker backed by D1,
Cloudflare's hosted SQLite database. The Worker validates each request with the
same rules the Apps Script uses today, applies the same revision rules inside
one atomic database transaction, and answers in well under a second. The Apps
Script keeps its Sheet-writing half and gains one job: every minute it pulls
new events from the Worker and mirrors them into the existing `responses` and
`response_events` tabs. Everything downstream of the Sheet (analysis, hourly
draft cleanup, daily CSV backup, alert emails) is unchanged.

## Goals

- Final submission confirms in well under a second for a respondent on an
  ordinary connection, and the thank-you page still appears only after a real
  confirmation.
- Bursts of at least 100 simultaneous respondents, drafts included, save
  without loss.
- Keep the request format, the acknowledgement format, the Sheet schema, the
  retention rules and the respondent-facing behaviour exactly as they are.
- Reuse the tested validation, revision and Sheet-writing code rather than
  rewriting it.
- Keep operations small: one new vendor account, four one-time commands, no
  servers to patch.

## Non-goals

- Changing the survey content, the autosave cadence or the client code beyond
  the endpoint URL.
- Real-time Sheet updates. A lag of about one minute is acceptable.
- Querying D1 directly for analysis. The Sheet remains the analysis surface;
  D1 is the system of record and can be exported if ever needed.
- Rate limiting or bot challenges before abuse is observed. Cloudflare can add
  both without code changes if that day comes.

## Architecture

```
browser ──POST JSON (text/plain)──▶ Cloudflare Worker ──▶ D1 (responses, events)
                                          ▲
Apps Script (every minute) ──GET /export──┘ ──▶ Google Sheet tabs: responses, response_events
                                                      │
                                      hourly draft cleanup · daily CSV backup · alert emails
```

Five components:

1. **Static survey** on GitHub Pages. Only `submit.endpoint` in `content.js`
   changes.
2. **Write API: Cloudflare Worker** in `worker/`. Public `POST` for drafts and
   finals, public `GET /` health check, secret-protected `GET /export` for the
   mirror, and an hourly scheduled job that deletes expired drafts.
3. **D1 database** with two tables: `responses` (one current row per
   response) and `events` (append-only, one row per accepted write).
4. **Apps Script** attached to the Sheet. Loses the public write path over
   time (see Switch-over) and gains `syncFromWorker`, run by a one-minute
   trigger.
5. **Google Sheet** with the same two tabs and the same columns as today.

## Request handling in the Worker

The request body, envelope, validation rules and acknowledgement contract are
unchanged from the current design and are ported function by function from
`apps-script/Code.gs`: `parseRequest_`, `validateEnvelope_`,
`validateAnswers_`, `validatePoints_`, `validateHours_` and their helpers
become `worker/src/validate.js`. Their unit tests in `apps-script/Code.test.js`
move with them.

Replies are JSON with HTTP 200 for every application-level outcome, exactly
as Apps Script behaved, so `persistence.js` and `index.html` need no change:

- accepted, idempotent or stale write: `{ok: true, response_id,
  accepted_revision, status}` with the row's current state;
- validation failure: `{ok: false, code, message}` with the existing codes;
- database or unexpected failure: `{ok: false, code: "server_error",
  message}`. The client treats only `server_error` as retryable.

### Cross-origin rules

The page posts `text/plain`, which the browser sends without a preflight. The
Worker answers with `Access-Control-Allow-Origin` set to the request's
`Origin` when that origin is in the `ALLOWED_ORIGINS` variable
(`https://arcadiaimpact.github.io` in production, plus the two local preview
origins), and rejects a request that carries any other `Origin` with 403.
Requests with no `Origin` header (command-line tools) are processed, since a
browser restriction cannot stop them anyway. `OPTIONS` returns 204 with the
same headers in case the content type ever changes.

### Revision rules as one transaction

D1 runs a `batch()` of statements as a single transaction. The write is three
statements and never needs an application-level lock:

1. Insert the row, or on conflict update it **only if** the incoming revision
   is higher **and** the current row is not submitted or the incoming write is
   itself submitted. `started_at` is never touched on update; `submitted_at`
   keeps its first value.
2. Insert the event **only if** the row now carries the incoming revision,
   ignoring a duplicate `(response_id, revision)`. This reproduces today's
   behaviour: an event is appended for an accepted write, or for an identical
   repeat whose event is somehow missing, and never for a stale write.
3. Select the row's current revision and status for the acknowledgement.

This is the existing `decideWrite_` table expressed in SQL. The port is
verified by running the current `decideWrite_` test cases against the SQL with
Node's built-in SQLite, so the two cannot drift apart silently.

### Schema

```sql
CREATE TABLE responses (
  response_id         TEXT PRIMARY KEY,
  status              TEXT NOT NULL CHECK (status IN ('draft', 'submitted')),
  revision            INTEGER NOT NULL,
  started_at          TEXT NOT NULL,          -- ISO 8601 UTC, server clock
  updated_at          TEXT NOT NULL,
  submitted_at        TEXT,
  last_completed_step INTEGER NOT NULL,
  content_version     TEXT NOT NULL,
  client_updated_at   TEXT NOT NULL,
  raw_json            TEXT NOT NULL           -- the accepted body, untouched
);
CREATE INDEX responses_status_updated ON responses (status, updated_at);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- the mirror's cursor
  event_at    TEXT NOT NULL,
  response_id TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  status      TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  UNIQUE (response_id, revision)
);
```

Flattened answer columns are not stored in D1. The Sheet mirror flattens
`raw_json` with the existing `flatten_` when it writes a row, so the analysis
columns are produced by the same code as today and the database schema never
has to change when a question is added.

## Mirroring into the Sheet

### Export endpoint

`GET /export?after=<event id>&limit=<n>` requires
`Authorization: Bearer <EXPORT_SECRET>`, compared in constant time. It returns
up to `n` events with `id` greater than `after`, in id order, plus the current
`responses` row for every response id that appears in that page, and
`next_after`, the last event id returned. Default and maximum `limit` is 200.
Anything else on the Worker returns 404.

### Sync job

`syncFromWorker` in `Code.gs` runs every minute from a time-based trigger
installed by `installMaintenanceTriggers`, alongside the existing two. It
reads `WORKER_URL`, `EXPORT_SECRET` and the cursor `SYNC_AFTER_EVENT_ID` from
Script Properties, then up to ten times per run:

1. fetches a page from `/export`;
2. under the script lock, writes each current row into `responses` (find the
   row by `response_id` and overwrite, or append) and appends each event whose
   `event_key` is not already present;
3. stores the new cursor.

The Worker has already applied the revision rules, and exported current rows
only ever move forward, so the mirror writes what it receives. A run that
fails midway simply repeats from the saved cursor; rewriting a current row is
harmless and events are deduplicated by `event_key`. The lock now only guards
against two trigger runs overlapping. A fetch or Sheet failure is logged and
reported through the existing rate-limited `notifyOwner_`.

Row building reuses the current code: fixed columns come from the exported
row, answer columns from `flatten_(JSON.parse(raw_json).answers)`, and
`raw_json` is split across the continuation cells by `addRawJson_`.

### Retention

The 48-hour draft promise is kept in both stores with the same rule:

- an hourly Worker cron job deletes `responses` rows with `status = 'draft'`
  and `updated_at` older than 48 hours, together with their `events`;
- the existing hourly `cleanupExpiredDrafts` keeps doing the same in the
  Sheet.

Neither store tells the other about deletions. They converge because they
apply the same rule to the same `updated_at` values, and a draft that becomes
active again produces a new event and is mirrored afresh. Submitted rows are
never deleted by either job. The daily submitted-only CSV backup is unchanged.
D1 additionally keeps 30 days of point-in-time history ("Time Travel"), which
the privacy wording should treat the way it already treats Google's own
service-level retention.

## Repository layout

```
worker/
  wrangler.toml        name, D1 binding, ALLOWED_ORIGINS, hourly cron
  schema.sql           the two tables above
  package.json         type: module; wrangler as the only dev dependency
  src/validate.js      ported validation (pure functions)
  src/write.js         the three-statement write and the export query
  src/index.js         fetch handler (POST, GET /, GET /export, CORS) and scheduled()
  test/*.test.js       node --test; SQL exercised with node:sqlite
apps-script/Code.gs    + syncFromWorker, mirror record builders, third trigger
SETUP.md               new "Write API" section; Apps Script section trimmed
content.js             submit.endpoint → Worker URL
```

Node 23 on the development machine ships `node:sqlite`, so the write path is
tested against real SQLite statements with no fakes. The Worker-specific
binding is a thin adapter: `createStore(d1)` for production and
`createStore(nodeSqlite)` for tests, both exposing `batch(statements)` and
`all(sql, params)`.

## Deployment and configuration

One-time, by the account owner, from `worker/`:

```
npm install
npx wrangler login
npx wrangler d1 create automation-survey        # paste database_id into wrangler.toml
npx wrangler d1 execute automation-survey --remote --file=schema.sql
npx wrangler secret put EXPORT_SECRET           # a long random string
npx wrangler deploy                              # prints https://automation-survey.<account>.workers.dev
```

Then in Apps Script → Script Properties: `WORKER_URL` and the same
`EXPORT_SECRET`; run `installMaintenanceTriggers` once more; push and
redeploy the script with clasp as before. Later code changes to the Worker are
`npx wrangler deploy`; changes to the script are the existing clasp commands.

The free Workers and D1 tiers cover this survey many times over. The five
dollar Workers Paid plan is optional and removes the daily request cap
entirely.

## Switch-over and rollback

1. **Build and prove.** Worker and sync land in the repo with tests. The
   Worker is deployed and the sync trigger installed while `content.js` still
   points at Apps Script. Nothing changes for respondents yet.
2. **Switch.** `content.js` is pointed at the Worker and pushed. GitHub Pages
   caches pages for a few minutes, so for that window some browsers still post
   to Apps Script. Both paths write the same Sheet rows with the same revision
   rules, so a response that straddles the switch simply converges.
3. **Verify.** The 30-tab burst test from 2026-10-07 is run again against the
   Worker, and a real submission from the hosted page is confirmed in the
   Sheet within two minutes.
4. **Retire the old path** in a later change, after a quiet week: `doPost` in
   Apps Script starts answering `{ok: false, code: "moved"}` and the ported
   write code is deleted from `Code.gs`. Until then, rollback is a one-line
   revert of `content.js`.

## Operations

- `npx wrangler tail` streams live Worker logs; the Cloudflare dashboard shows
  request counts, errors and D1 usage.
- `npx wrangler d1 export automation-survey --remote --output=backup.sql`
  takes a full database dump on demand.
- Sync failures email the operator through `notifyOwner_`, at most once an
  hour. A healthy sync logs the number of rows mirrored.
- If `workers.dev` ever proves blocked on a respondent's network, a custom
  subdomain such as `survey-api.arcadiaimpact.org` can be attached in the
  dashboard without code changes.

## Acceptance tests

1. Every validation test from `Code.test.js` passes unchanged against
   `worker/src/validate.js`.
2. Every `decideWrite_` case produces the same accept, idempotent or stale
   outcome, the same stored row and the same event rows through the SQL.
3. `started_at` never changes on update; `submitted_at` keeps its first value;
   a late draft never downgrades a submitted row.
4. Two writes for the same response issued concurrently leave exactly one
   current row at the higher revision and one event per accepted revision.
5. A request from an unlisted origin is refused; one from the Pages origin
   receives the matching CORS header; a command-line request without `Origin`
   is processed.
6. `/export` without the correct secret returns 401 and no data; with it,
   pages follow `after` and `next_after` with no gaps or repeats.
7. `syncFromWorker` writes new rows and events into a fake Sheet, skips events
   already present, advances the cursor only after a successful write, and
   produces rows identical to what `doPost` writes today for the same payload.
8. The hourly Worker job removes drafts idle 48 hours and their events, and
   nothing else.
9. Locally, the real page in headless Chrome against `wrangler dev` saves a
   draft, submits, and shows the thank-you page only after confirmation.
10. Against the deployed Worker, 30 simultaneous submits all save, and the
    median submit-to-thank-you time is under one second. The same test on
    2026-10-07 against Apps Script saved 26 of 30 after retries with a median
    of 27 seconds.
11. A submission made on the hosted page appears in the Sheet within two
    minutes with the same columns and values as today.
