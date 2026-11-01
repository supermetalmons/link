import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApplicationAdmissionTasks } from "../src/applicationAdmissions.ts";

test("closing the global gate between observation and insert denies the admission", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL(
          "../migrations/0028_application_data_control.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    db.exec(
      "INSERT INTO application_data_admissions VALUES ('before', 1, 0, 'http', 1, 'running', NULL, NULL)",
    );
    db.exec(
      "UPDATE application_data_control SET phase = 'closing', migration_id = 'migration'",
    );
    assert.throws(() =>
      db.exec(
        "INSERT INTO application_data_admissions VALUES ('after', 1, 0, 'http', 2, 'running', NULL, NULL)",
      ),
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM application_data_admissions").get()
        ?.n,
      1,
    );
    db.exec(
      "DELETE FROM application_data_admissions WHERE operation_id = 'before'",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM application_data_admissions").get()
        ?.n,
      0,
    );
  } finally {
    db.close();
  }
});

test("admission remains open until all tracked background tasks settle", async () => {
  const outcomes: string[] = [];
  const tasks = new ApplicationAdmissionTasks(
    async () => {
      outcomes.push("complete");
    },
    async () => {
      outcomes.push("blocked");
    },
  );
  const pending = Promise.withResolvers<void>();
  const tracked = tasks.track(pending.promise);
  await tasks.finish(false);
  assert.deepEqual(outcomes, []);
  pending.resolve();
  await tracked;
  assert.deepEqual(outcomes, ["complete"]);
});

test("closing admits only tracked child RPCs and retains them after their parent completes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL(
          "../migrations/0028_application_data_control.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    db.exec(
      "INSERT INTO application_data_admissions VALUES ('parent', 1, 0, 'http', 1, 'running', NULL, NULL)",
    );
    db.exec(
      "UPDATE application_data_control SET phase = 'closing', migration_id = 'migration'",
    );
    db.exec(
      "INSERT INTO application_data_admissions VALUES ('child', 1, 0, 'rpc', 2, 'running', NULL, 'parent')",
    );
    assert.throws(() =>
      db.exec(
        "INSERT INTO application_data_admissions VALUES ('untracked', 1, 0, 'rpc', 2, 'running', NULL, 'missing')",
      ),
    );
    assert.throws(() =>
      db.exec(
        "INSERT INTO application_data_admissions VALUES ('new-workflow', 1, 0, 'workflow', 2, 'running', NULL, 'parent')",
      ),
    );
    db.exec(
      "DELETE FROM application_data_admissions WHERE operation_id = 'parent'",
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM application_data_admissions WHERE status = 'running'",
        )
        .get()?.n,
      1,
    );
    assert.throws(() =>
      db.exec(
        "INSERT INTO application_data_admissions VALUES ('late', 1, 0, 'rpc', 3, 'running', NULL, 'parent')",
      ),
    );
  } finally {
    db.close();
  }
});

test("a failed background task preserves a blocked admission instead of claiming drain", async () => {
  const outcomes: string[] = [];
  const tasks = new ApplicationAdmissionTasks(
    async () => {
      outcomes.push("complete");
    },
    async () => {
      outcomes.push("blocked");
    },
  );
  const pending = Promise.withResolvers<void>();
  const tracked = tasks.track(pending.promise);
  const failed = assert.rejects(tracked, /uncertain-effect/);
  await tasks.finish(false);
  pending.reject(new Error("uncertain-effect"));
  await failed;
  assert.deepEqual(outcomes, ["blocked"]);
});
