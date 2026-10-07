import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const TASK_IDS = ["conceptual", "design", "infra", "running", "writing", "collaborating"];

export function validAnswers() {
  const points = Object.fromEntries(TASK_IDS.map((id, i) => [id, i === 0 ? 100 : 0]));
  const hours_active_human = Object.fromEntries(
    TASK_IDS.map((id) => [id, { without_ai: null, one_year_ago: null, now: null, in_6_months: null }])
  );
  return {
    email: null,
    job_title: "Research Lead",
    role_type: "Technical AI Safety",
    experience: "2–5 years",
    ai_usage: "Pair programming",
    points,
    hours_active_human,
    hours_notes: null,
    highest_value_to_automate: "Literature review",
    main_reason: "Context gathering",
    agent_tracking: "Git commits",
  };
}

export function draftAnswers() {
  const answers = validAnswers();
  delete answers.email;
  return answers;
}

export function envelope(overrides = {}) {
  return {
    response_id: "123e4567-e89b-42d3-a456-426614174000",
    revision: 3,
    status: "draft",
    last_completed_step: 2,
    content_version: "abcd1234",
    client_updated_at: "2026-10-07T08:00:00.000Z",
    honeypot: "",
    answers: draftAnswers(),
    ...overrides,
  };
}

export function finalEnvelope(overrides = {}) {
  return envelope({ status: "submitted", answers: validAnswers(), ...overrides });
}

// An in-memory SQLite database with the production schema applied.
export function openDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(here, "..", "schema.sql"), "utf8"));
  return db;
}

// Just enough of the D1 client API (prepare/bind/all/run/first/batch) over
// node:sqlite that the production store adapter is what the tests exercise.
// batch() is one transaction, as D1's is.
export function fakeD1(db) {
  const isSelect = (sql) => /^\s*select/i.test(sql);
  const execute = (sql, params) =>
    isSelect(sql)
      ? { success: true, results: db.prepare(sql).all(...params), meta: {} }
      : { success: true, results: [], meta: db.prepare(sql).run(...params) };
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql,
            params,
            async all() { return execute(sql, params); },
            async run() { return execute(sql, params); },
            async first() { return execute(sql, params).results[0] || null; },
          };
        },
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => execute(s.sql, s.params));
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

// node:sqlite returns null-prototype rows; make them plain for deepEqual.
export function plain(row) {
  return row == null ? row : JSON.parse(JSON.stringify(row));
}
