import assert from "node:assert/strict";
import { openDatabase, fakeD1, envelope, finalEnvelope, plain } from "./helpers.js";
import { createStore, writeSnapshot } from "../src/write.js";

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

console.log("write.test.js passed");
