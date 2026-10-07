# Survey Response Persistence Design

## Summary

The survey will remain a static website and use a Google Apps Script web app
as a write-only API. Google Sheets will be the operational datastore and the
analysis interface. This is the simplest architecture that meets the expected
scale of roughly 100 respondents without requiring a separately operated
application server or database.

The design adds anonymous server-side draft saving while preserving the
existing browser-local draft. A stable response ID and monotonic revision make
writes idempotent and prevent stale drafts from replacing newer or submitted
answers. Submitted responses are kept for analysis; abandoned drafts are
removed from active storage 48 hours after their last accepted save.

## Goals

- Do not lose entered answers after refreshes, closed tabs, temporary network
  failures, duplicate requests, or final-submission retries.
- Preserve partial anonymous responses for up to 48 hours.
- Keep the respondent moving through the survey without waiting for background
  saves.
- Store one analysis-friendly row per response while retaining a recoverable,
  lossless representation of accepted writes.
- Keep deployment and operation appropriate for approximately 100 public
  respondents.
- Minimize collection of identifying data and clearly disclose draft saving.

## Non-goals

- Resuming an anonymous draft on another browser or device.
- User accounts, authentication, or emailed resume links.
- Real-time collaborative editing or reliable coordination between multiple
  tabs editing the same response.
- A general-purpose analytics application.
- Building rate-limiting infrastructure before abuse is observed.

## Architecture

The system has four components:

1. **Static survey:** hosted on a static host such as GitHub Pages or
   Cloudflare Pages.
2. **Browser-local draft:** `localStorage` receives every field change
   immediately and remains the fastest recovery path.
3. **Write API:** the existing Google Apps Script deployment validates,
   serializes, and acknowledges draft and final writes.
4. **Google Sheet in a Shared Drive:** stores the latest response state and an
   append-only recovery log. Access is restricted to the research team.

The Apps Script endpoint is public because respondents are not authenticated,
but it never exposes response data. `GET` may return only a health message.

Google Apps Script and Sheets are suitable at this scale. A managed database
such as Supabase would provide stronger querying, constraints, and retention
controls, but those benefits do not justify the additional service and
operational complexity for the expected response volume.

## Respondent disclosure

**Deferred — do not implement in the initial backend work.** Keep the proposed
copy in this design for a later privacy and content review. When enabled, the
introduction should disclose the behavior before server autosaving begins:

> After you start, we save anonymous partial answers so your progress is not
> lost. If you do not submit, the partial response is removed from active
> storage 48 hours after your last activity. Your optional email address is
> not included in partial saves.

The initial implementation still starts server draft saving only after the
respondent presses **Start**. The optional email remains local until final
submission, and drafts are excluded from analysis. Deferring the disclosure
changes only the survey copy; it does not defer these backend privacy controls.

## Response lifecycle

Each browser draft receives:

- `response_id`: a cryptographically random UUID created once.
- `revision`: an integer incremented for each changed snapshot sent.
- `status`: either `draft` or `submitted`.
- `last_completed_step`: the highest step whose validation passed.
- `content_version`: the existing survey-content fingerprint.
- `client_updated_at`: informational client timestamp.

The server supplies authoritative `started_at`, `updated_at`, and
`submitted_at` timestamps, stored as ISO 8601 UTC text so that Sheets never
applies a time-zone conversion to them. Client clocks are never used for
retention or write ordering.

The lifecycle is monotonic:

1. A new response starts as `draft`.
2. A newer accepted draft may replace the current draft snapshot.
3. A valid final write changes the status to `submitted`.
4. A submitted response can never be downgraded by a delayed draft.
5. Repeating an identical final request succeeds without creating a duplicate.

## Client save flow

### Local saving

Every input and change event writes the complete draft to `localStorage`.
Local data includes the response ID, revision, answers, current step, and the
last local-update time.

On page load, a local draft is restored if it is less than 48 hours old.
Expired local drafts are discarded on the next visit. A browser cannot delete
local storage while the site is closed, so this is best-effort expiry on that
device rather than a timed remote deletion.

### Background server saving

After Start, a changed response is queued for server saving:

- three seconds after the last edit, but at most once every two minutes;
- when Next or Back is pressed;
- when the browser returns online; and
- best-effort when the page is hidden.

Normal navigation never waits for a background save. Only one request is in
flight at a time; if more edits occur, only the latest pending full snapshot
is sent next. A minimum interval of two minutes keeps Apps Script traffic
low; Next and Back still save immediately. Sending complete snapshots
keeps recovery and server logic simple.

The UI displays one unobtrusive state:

- **Saving…**
- **Saved**
- **Saved on this device — offline**
- **Could not reach the server — your answers remain on this device**

Network failures retry with bounded exponential backoff while the page is
open. The browser's `online` event causes an immediate retry. Unload-time
network delivery is not treated as reliable; local storage is the fallback.

### Final submission

Final submission performs all client validation and sends the complete
snapshot with `status: submitted`. The submit button is disabled while that
request is active. A background draft save still in flight is abandoned so
the final request does not queue behind it; server-side revision ordering
makes this safe.

The thank-you screen appears only after the server confirms the submitted
revision. The local draft is cleared only after this acknowledgement. On a
timeout or error, answers remain available and the respondent receives a
clear Retry action. A retry uses the same response ID and is idempotent.

## API contract

The request body is JSON sent as `text/plain` to preserve the existing simple
cross-origin request behavior with Apps Script. Its envelope is:

```json
{
  "response_id": "uuid",
  "revision": 12,
  "status": "draft",
  "last_completed_step": 2,
  "content_version": "fingerprint",
  "client_updated_at": "ISO-8601 timestamp",
  "answers": {}
}
```

The final request may include the optional email; draft requests must omit it.

Success replies include `ok`, `response_id`, `accepted_revision`, and
`status`. Rejected stale writes return `ok: true` with the authoritative
revision and status because no retry is needed. Validation and temporary
server failures return `ok: false` with a stable error code and a
respondent-safe message.

## Server validation and ordering

The server validates all data independently of the browser:

- exact top-level keys and known answer fields;
- UUID shape, integer revision, and allowed status;
- string and total body limits;
- numeric types and allowed ranges;
- stable task IDs;
- required answers and a 100-point total for final submissions;
- absence of email in draft writes; and
- a hidden honeypot value remaining empty.

Unknown fields are rejected rather than turned into new Sheet columns. This
prevents arbitrary public requests from changing the analysis schema.

Within a script lock, the server finds the current response and compares
revisions. A draft is accepted only when its revision is newer and the current
status is not `submitted`. Final submission is accepted when its revision is
newer and all final constraints pass. An already accepted final retry returns
success. The server appends the recovery event and updates the current row
before acknowledging success.

## Sheet schema

### `responses`

This sheet contains one current row per `response_id` and is the source for
analysis. Fixed operational columns come first:

- `response_id`
- `status`
- `revision`
- `started_at`
- `updated_at`
- `submitted_at`
- `last_completed_step`
- `content_version`
- `client_updated_at`
- flattened answer columns
- `raw_json` and continuation columns when necessary

Analysis filters `status = submitted`. Stable answer keys remain stable after
launch. Human-readable wording may change because `content_version` records
which survey content produced each response.

### `response_events`

This append-only recovery log contains one row for every changed snapshot
accepted by the server:

- server event timestamp;
- response ID;
- revision;
- status; and
- lossless raw JSON split across cells when necessary.

Duplicate or stale requests are not appended. The log allows reconstruction
if the current row is accidentally changed. If a response is abandoned, all
of its events follow the same 48-hour active-storage cleanup as its current
draft row. Once a response is submitted, its previously accepted events become
part of the submitted response's recovery history.

Formula-like respondent text is always written as plain text to prevent
spreadsheet formula injection.

## Retention and backup

An hourly Apps Script trigger removes active draft rows and their draft events
when the authoritative `updated_at` is more than 48 hours old. Submitted rows
and submitted events are not affected.

Daily backups contain submitted responses only. They are written to a
restricted Shared Drive folder with a documented retention policy. Drafts
must not be copied into long-lived backups because that would defeat the
48-hour policy.

The 48-hour promise describes deletion from the survey's active application
storage. Google may retain service-level revision history or disaster-recovery
copies under its own retention terms; the public privacy language must not
claim immediate deletion from every provider backup.

## Reliability and operations

- The Sheet and script live in a Shared Drive so they do not depend on one
  employee's account ownership.
- Script locking serializes concurrent Sheet writes.
- Response IDs and revisions make all retries idempotent.
- Current rows plus the append-only event log provide two recovery views.
- Submitted-only daily backups protect against accidental Sheet deletion.
- Apps Script execution errors are logged. Repeated failures should trigger an
  owner notification.
- Before launch, run the anonymous desktop, mobile, offline/retry, refresh,
  duplicate-submit, stale-draft, and expiry tests.
- During collection, verify at least daily that recent submitted rows and
  backups exist.

If spam or quota pressure appears, first add a low-friction challenge such as
Cloudflare Turnstile or place a rate-limited edge function in front of the
write API. This is deliberately deferred to avoid adding respondent friction
without evidence of abuse.

## Analysis

Each completed response is one row with numeric values stored as numbers.
Flattened names such as `points.design` and
`hours_active_human.design.now` support direct filtering, pivot tables, CSV
export, and pandas analysis. `raw_json` is a lossless recovery source rather
than the primary analysis format.

Drafts are excluded by filtering for `status = submitted`. Any future decision
to analyze abandoned drafts requires an updated respondent disclosure and
research policy.

## Acceptance tests

1. A partial response survives refresh and browser restart on the same device.
2. A background draft reaches the server without including the respondent's
   email, while same-device restoration continues to use the local copy.
3. Going offline preserves all answers locally and reconnecting saves the
   latest snapshot.
4. Rapid edits do not create overlapping requests or let an older revision
   replace a newer one.
5. A delayed draft cannot downgrade a submitted response.
6. Repeating Submit creates one submitted response and no duplicate event.
7. The thank-you screen never appears before final server acknowledgement.
8. Invalid, oversized, unknown-field, and honeypot requests are rejected
   without changing Sheet headers.
9. A draft and all of its draft events disappear from active server storage
   after 48 hours of inactivity.
10. Submitted-only backups contain no draft rows or draft events.
11. Text beginning with spreadsheet formula characters remains plain text.
12. Completed rows export cleanly to CSV and retain the lossless raw JSON.
