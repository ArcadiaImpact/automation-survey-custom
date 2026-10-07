const assert = require("node:assert/strict");

const {
  DRAFT_TTL_MS,
  isDraftExpired,
  draftEnvelope,
  createAutosaveCoordinator,
} = require("./persistence.js");

const NOW = Date.parse("2026-10-07T09:00:00.000Z");
const snapshot = {
  response_id: "123e4567-e89b-42d3-a456-426614174000",
  revision: 2,
  status: "draft",
  last_completed_step: 1,
  content_version: "abcd1234",
  client_updated_at: "2026-10-07T09:00:00.000Z",
  honeypot: "",
  answers: { email: "private@example.com", ai_usage: "Coding" },
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createScheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    set(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clear(id) {
      timers.delete(id);
    },
    delays() {
      return Array.from(timers.values()).map((timer) => timer.delay);
    },
    runNext() {
      const entry = timers.entries().next();
      assert.equal(entry.done, false, "expected a scheduled timer");
      const [id, timer] = entry.value;
      timers.delete(id);
      timer.fn();
      return timer.delay;
    },
    size() {
      return timers.size;
    },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function coordinatorOptions(send, scheduler, states = []) {
  return {
    send,
    onState: (state) => states.push(state),
    now: () => NOW,
    setTimer: (fn, ms) => scheduler.set(fn, ms),
    clearTimer: (id) => scheduler.clear(id),
    debounceMs: 0,
    minIntervalMs: 0,
    retryDelays: [2000, 5000, 15000],
  };
}

async function run() {
  assert.equal(DRAFT_TTL_MS, 48 * 60 * 60 * 1000);
  assert.equal(
    isDraftExpired({ local_updated_at: NOW - DRAFT_TTL_MS }, NOW),
    true
  );
  assert.equal(
    isDraftExpired({ local_updated_at: NOW - DRAFT_TTL_MS + 1 }, NOW),
    false
  );
  assert.equal(isDraftExpired({}, NOW), true);

  const outgoing = draftEnvelope(snapshot);
  assert.equal("email" in outgoing.answers, false);
  assert.equal(snapshot.answers.email, "private@example.com");
  assert.equal("local_updated_at" in outgoing, false);

  {
    const calls = [];
    const states = [];
    const scheduler = createScheduler();
    const first = deferred();
    let active = 0;
    let maxActive = 0;
    const coordinator = createAutosaveCoordinator(
      coordinatorOptions(async (value) => {
        calls.push(value.revision);
        active++;
        maxActive = Math.max(maxActive, active);
        const ack =
          calls.length === 1
            ? await first.promise
            : { ok: true, accepted_revision: value.revision };
        active--;
        return ack;
      }, scheduler, states)
    );

    coordinator.queue({ ...snapshot, revision: 2 });
    assert.equal(scheduler.runNext(), 0);
    assert.deepEqual(calls, [2]);

    coordinator.queue({ ...snapshot, revision: 3 });
    coordinator.queue({ ...snapshot, revision: 4 });
    assert.equal(scheduler.size(), 0);

    first.resolve({ ok: true, accepted_revision: 2 });
    await settle();
    assert.equal(scheduler.runNext(), 0);
    await settle();
    assert.deepEqual(calls, [2, 4]);
    assert.equal(maxActive, 1);
    assert.deepEqual(states, ["saving", "saved", "saving", "saved"]);
    coordinator.dispose();
  }

  {
    const scheduler = createScheduler();
    const states = [];
    let attempts = 0;
    const coordinator = createAutosaveCoordinator(
      coordinatorOptions(async () => {
        attempts++;
        throw new TypeError("offline");
      }, scheduler, states)
    );

    coordinator.queue({ ...snapshot, revision: 5 });
    scheduler.runNext();
    await settle();
    assert.deepEqual(scheduler.delays(), [2000]);

    scheduler.runNext();
    await settle();
    assert.deepEqual(scheduler.delays(), [5000]);

    scheduler.runNext();
    await settle();
    assert.deepEqual(scheduler.delays(), [15000]);

    scheduler.runNext();
    await settle();
    assert.deepEqual(scheduler.delays(), [15000]);
    assert.equal(attempts, 4);
    assert.equal(states.filter((state) => state === "offline").length, 4);

    coordinator.retry();
    assert.deepEqual(scheduler.delays(), [0]);
    coordinator.dispose();
    assert.equal(scheduler.size(), 0);
  }

  {
    const scheduler = createScheduler();
    const first = deferred();
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const coordinator = createAutosaveCoordinator(
      coordinatorOptions(async (value) => {
        calls.push(value);
        active++;
        maxActive = Math.max(maxActive, active);
        const ack =
          calls.length === 1
            ? await first.promise
            : {
                ok: true,
                accepted_revision: value.revision,
                status: value.status,
              };
        active--;
        return ack;
      }, scheduler)
    );

    coordinator.queue({ ...snapshot, revision: 2 });
    scheduler.runNext();
    coordinator.queue({ ...snapshot, revision: 3 });
    const finalPromise = coordinator.submit({
      ...snapshot,
      revision: 4,
      status: "submitted",
    });

    first.resolve({ ok: true, accepted_revision: 2, status: "draft" });
    await settle();
    scheduler.runNext();
    await settle();
    const finalAck = await finalPromise;

    assert.deepEqual(
      calls.map((value) => [value.revision, value.status]),
      [
        [2, "draft"],
        [4, "submitted"],
      ]
    );
    assert.equal(finalAck.status, "submitted");
    assert.equal(maxActive, 1);

    coordinator.queue({ ...snapshot, revision: 5 });
    assert.equal(scheduler.size(), 0);
  }

  {
    const scheduler = createScheduler();
    let fail = true;
    const coordinator = createAutosaveCoordinator(
      coordinatorOptions(async (value) => {
        if (fail) throw new Error("server unavailable");
        return {
          ok: true,
          accepted_revision: value.revision,
          status: "submitted",
        };
      }, scheduler)
    );

    const firstSubmit = coordinator.submit({
      ...snapshot,
      revision: 8,
      status: "submitted",
    });
    scheduler.runNext();
    await assert.rejects(firstSubmit, /server unavailable/);

    fail = false;
    const secondSubmit = coordinator.submit({
      ...snapshot,
      revision: 8,
      status: "submitted",
    });
    scheduler.runNext();
    const ack = await secondSubmit;
    assert.equal(ack.status, "submitted");
  }

  {
    const scheduler = createScheduler();
    const states = [];
    const coordinator = createAutosaveCoordinator(
      coordinatorOptions(
        async () => ({
          ok: false,
          code: "invalid_points",
          message: "Points must total 100.",
        }),
        scheduler,
        states
      )
    );

    coordinator.queue({ ...snapshot, revision: 9 });
    scheduler.runNext();
    await settle();
    assert.deepEqual(states, ["saving", "failed"]);
    assert.equal(scheduler.size(), 0);
  }

  {
    const scheduler = createScheduler();
    const coordinator = createAutosaveCoordinator(
      coordinatorOptions(async (value) => ({
        ok: true,
        accepted_revision: value.revision,
        status: "submitted",
      }), scheduler)
    );

    coordinator.queue({ ...snapshot, revision: 10 });
    scheduler.runNext();
    await settle();
    coordinator.queue({ ...snapshot, revision: 11 });
    assert.equal(scheduler.size(), 0);
  }

  {
    const scheduler = createScheduler();
    const coordinator = createAutosaveCoordinator(
      coordinatorOptions(async () => ({
        ok: true,
        accepted_revision: 11,
        status: "submitted",
      }), scheduler)
    );

    const finalPromise = coordinator.submit({
      ...snapshot,
      revision: 12,
      status: "submitted",
    });
    scheduler.runNext();
    await assert.rejects(finalPromise, /revision 12/);
  }

  {
    const scheduler = createScheduler();
    const coordinator = createAutosaveCoordinator(
      coordinatorOptions(async () => ({ ok: true }), scheduler)
    );
    coordinator.queue(snapshot);
    assert.equal(scheduler.size(), 1);
    coordinator.dispose();
    assert.equal(scheduler.size(), 0);
  }

  console.log("Browser persistence checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
