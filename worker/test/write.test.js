import assert from "node:assert/strict";
import { openDatabase, fakeD1, envelope, finalEnvelope, plain } from "./helpers.js";
import { createStore, writeSnapshot, pageSize, exportEvents, deleteExpiredDrafts, DRAFT_RETENTION_MS } from "../src/write.js";

const ID = envelope().response_id;
const t1 = new Date("2026-10-07T09:00:00.000Z");
const t2 = new Date("2026-10-07T09:45:00.000Z");
const t3 = new Date("2026-10-07T10:30:00.000Z");

function fresh() {
  const db = openDatabase();
  return { db, store: createStore(fakeD1(db)) };
}
async function write(store, body, when) {
  return writeSnapshot(store, body, JSON.stringify(body), when);
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(plain);

// A new response is inserted and its event logged; the ack echoes the row.
{
  const { db, store } = fresh();
  const ack = await write(store, envelope({ revision: 7 }), t1);
  assert.deepEqual(ack, { ok: true, response_id: ID, accepted_revision: 7, status: "draft" });
  const [row] = rows(db, "responses");
  assert.equal(row.revision, 7);
  assert.equal(row.started_at, "2026-10-07T09:00:00.000Z");
  assert.equal(row.updated_at, "2026-10-07T09:00:00.000Z");
  assert.equal(row.submitted_at, null);
  assert.equal(row.raw_json, JSON.stringify(envelope({ revision: 7 })), "body stored untouched");
  const events = rows(db, "events");
  assert.equal(events.length, 1);
  assert.equal(events[0].raw_json, row.raw_json);
  assert.equal(events[0].event_at, "2026-10-07T09:00:00.000Z");
}

// Repeating the same write changes nothing and adds no event.
{
  const { db, store } = fresh();
  await write(store, envelope({ revision: 7 }), t1);
  const again = await write(store, envelope({ revision: 7 }), t2);
  assert.equal(again.accepted_revision, 7);
  assert.equal(rows(db, "events").length, 1);
  assert.equal(rows(db, "responses")[0].updated_at, "2026-10-07T09:00:00.000Z", "idempotent repeat does not touch the row");
}

// An older draft is stale: acknowledged with the current state, nothing written.
{
  const { db, store } = fresh();
  await write(store, envelope({ revision: 7 }), t1);
  const stale = await write(store, envelope({ revision: 6 }), t2);
  assert.deepEqual(stale, { ok: true, response_id: ID, accepted_revision: 7, status: "draft" });
  assert.equal(rows(db, "events").length, 1);
}

// A newer draft replaces the draft; started_at is kept, updated_at moves.
{
  const { db, store } = fresh();
  await write(store, envelope({ revision: 1 }), t1);
  const ack = await write(store, envelope({ revision: 2 }), t2);
  assert.equal(ack.accepted_revision, 2);
  const [row] = rows(db, "responses");
  assert.equal(row.started_at, "2026-10-07T09:00:00.000Z", "started_at keeps the first write time");
  assert.equal(row.updated_at, "2026-10-07T09:45:00.000Z");
  assert.deepEqual(rows(db, "events").map((e) => e.revision), [1, 2]);
}

// A final sets submitted_at once; a later draft can never downgrade it.
{
  const { db, store } = fresh();
  await write(store, envelope({ revision: 4 }), t1);
  const final = await write(store, finalEnvelope({ revision: 5 }), t2);
  assert.deepEqual(final, { ok: true, response_id: ID, accepted_revision: 5, status: "submitted" });
  assert.equal(rows(db, "responses")[0].submitted_at, "2026-10-07T09:45:00.000Z");

  const late = await write(store, envelope({ revision: 6 }), t3);
  assert.deepEqual(late, { ok: true, response_id: ID, accepted_revision: 5, status: "submitted" }, "late draft is stale");
  assert.equal(rows(db, "responses")[0].status, "submitted");
  assert.equal(rows(db, "events").length, 2, "no event for the refused draft");

  const retry = await write(store, finalEnvelope({ revision: 5 }), t3);
  assert.equal(retry.accepted_revision, 5, "repeating the final is idempotent");
  assert.equal(rows(db, "events").length, 2);

  const corrected = await write(store, finalEnvelope({ revision: 6 }), t3);
  assert.equal(corrected.accepted_revision, 6, "a higher-revision final is accepted");
  assert.equal(rows(db, "responses")[0].submitted_at, "2026-10-07T09:45:00.000Z", "submitted_at keeps its first value");
  assert.equal(rows(db, "responses")[0].updated_at, "2026-10-07T10:30:00.000Z");
  assert.equal(rows(db, "events").length, 3);
}

// Two responses never interfere.
{
  const { db, store } = fresh();
  const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await write(store, envelope({ revision: 1 }), t1);
  await write(store, envelope({ response_id: other, revision: 9 }), t1);
  assert.deepEqual(rows(db, "responses").map((r) => [r.response_id, r.revision]), [[ID, 1], [other, 9]]);
}

// The batch is one transaction: a failure in the middle leaves nothing behind.
{
  const { db, store } = fresh();
  await write(store, envelope({ revision: 1 }), t1);
  await assert.rejects(
    store.batch([
      { sql: "INSERT INTO events (event_at, response_id, revision, status, raw_json) VALUES (?, ?, ?, ?, ?)", params: ["x", ID, 99, "draft", "{}"] },
      { sql: "INSERT INTO nowhere VALUES (1)", params: [] },
    ])
  );
  assert.equal(rows(db, "events").length, 1, "the first insert was rolled back");
}

// ---- export paging ----
assert.equal(pageSize(undefined), 200);
assert.equal(pageSize(0), 200);
assert.equal(pageSize("abc"), 200);
assert.equal(pageSize(-5), 1);
assert.equal(pageSize(1e9), 200);
assert.equal(pageSize(50), 50);

{
  const { store } = fresh();
  assert.deepEqual(await exportEvents(store, 0, 10), { events: [], responses: [], next_after: 0 });
  assert.deepEqual((await exportEvents(store, 42, 10)).next_after, 42, "an empty page keeps the cursor");
}

// Pages follow next_after with no gaps or repeats, and each page carries the
// current row of every response that appears in it.
{
  const { store } = fresh();
  const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await write(store, envelope({ revision: 1 }), t1);
  await write(store, envelope({ response_id: other, revision: 1 }), t1);
  await write(store, envelope({ revision: 2 }), t2);
  await write(store, finalEnvelope({ revision: 3 }), t3);
  await write(store, envelope({ response_id: other, revision: 2 }), t3);

  const page1 = await exportEvents(store, 0, 2);
  assert.deepEqual(page1.events.map((e) => [e.response_id, e.revision]), [[ID, 1], [other, 1]]);
  assert.equal(page1.next_after, 2);
  assert.deepEqual(page1.responses.map((r) => [r.response_id, r.revision, r.status]).sort(),
    [[ID, 3, "submitted"], [other, 2, "draft"]].sort(), "current rows, not the rows as they were");

  const page2 = await exportEvents(store, page1.next_after, 2);
  assert.deepEqual(page2.events.map((e) => [e.response_id, e.revision]), [[ID, 2], [ID, 3]]);
  assert.deepEqual(page2.responses.map((r) => r.response_id), [ID], "only responses in this page");
  assert.equal(page2.events[1].status, "submitted");
  assert.equal(page2.events[1].raw_json, JSON.stringify(finalEnvelope({ revision: 3 })));

  const page3 = await exportEvents(store, page2.next_after, 2);
  assert.deepEqual(page3.events.map((e) => [e.response_id, e.revision]), [[other, 2]]);
  assert.equal(page3.next_after, 5);
  assert.deepEqual(await exportEvents(store, page3.next_after, 2), { events: [], responses: [], next_after: 5 });
}

// ---- draft expiry ----
{
  const { db, store } = fresh();
  const base = Date.parse("2026-10-09T09:00:00.000Z");
  const now = new Date(base);
  const at = (hoursAgo) => new Date(base - hoursAgo * 3600 * 1000);
  const ids = {
    old: "11111111-1111-4111-8111-111111111111",
    boundary: "22222222-2222-4222-8222-222222222222",
    fresh: "33333333-3333-4333-8333-333333333333",
    done: "44444444-4444-4444-8444-444444444444",
  };
  await write(store, envelope({ response_id: ids.old, revision: 1 }), at(49));
  await write(store, envelope({ response_id: ids.boundary, revision: 1 }), at(48));
  await write(store, envelope({ response_id: ids.fresh, revision: 1 }), at(47));
  await write(store, finalEnvelope({ response_id: ids.done, revision: 1 }), at(100));

  const removed = await deleteExpiredDrafts(store, now);
  assert.deepEqual(removed, { responses: 2, events: 2 });
  assert.deepEqual(rows(db, "responses").map((r) => r.response_id).sort(), [ids.fresh, ids.done].sort());
  assert.deepEqual(rows(db, "events").map((e) => e.response_id).sort(), [ids.fresh, ids.done].sort());
  assert.equal(DRAFT_RETENTION_MS, 48 * 60 * 60 * 1000);
}

console.log("write.test.js passed");
