import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAutomatchAdmissionAudit,
  readAutomatchAdmissionAudit,
} from "../src/automatchAdmissionAudit.ts";
import {
  acquireAutomatchWriteAdmission,
  releaseAutomatchWriteAdmission,
} from "../src/automatchD1.ts";
import { createAutomatchPersistence } from "../src/automatchPersistence.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const nowMs = 1_800_000_000_000;

async function audit() {
  const admission = await acquireAutomatchWriteAdmission(db, "raw-patch", {
    now: () => nowMs,
  });
  return {
    admission,
    audit: createAutomatchAdmissionAudit(db, admission, { now: () => nowMs }),
  };
}

function interceptRuns(
  intercept: (query: string, run: () => Promise<D1Result>) => Promise<D1Result>,
): D1Database {
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        if (property === "run")
          return () => intercept(query, () => target.run());
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => wrap(target.prepare(query), query);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("automatch admission audit", () => {
  beforeAll(() => applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS));
  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM automatch_write_admissions"),
      db.prepare("DELETE FROM automatch_runtime_control"),
      db.prepare(
        `INSERT INTO automatch_runtime_control
           (singleton, backend, state, epoch, freeze_generation)
         VALUES (1, 'rtdb', 'active', 1, 0)`,
      ),
    ]);
  });

  it("captures the immutable exact patch before dispatch and retains uncertain proof", async () => {
    const { audit: state } = await audit();
    const updates = {
      "automatch/invite": { uid: "host", timestamp: { ".sv": "timestamp" } },
      "telegramAutomatches/invite/generation": { ".sv": { increment: 1 } },
    };
    await state.preparePatch(updates);
    updates["automatch/invite"].uid = "mutated-after-capture";
    expect(await state.read()).toMatchObject({
      phase: "prepared",
      auditRevision: 1,
      proof: {
        kind: "patch",
        updates: {
          "automatch/invite": {
            uid: "host",
            timestamp: { ".sv": "timestamp" },
          },
        },
      },
    });
    await state.markDispatching();
    expect(await state.releaseIfSafe()).toBe(false);
    await state.markUncertain();
    expect(await state.read()).toMatchObject({
      phase: "uncertain",
      auditRevision: 3,
    });
    expect(await state.releaseIfSafe()).toBe(false);
  });

  it("safely releases proven pre-dispatch failures, including failed proof preparation", async () => {
    const { audit: state } = await audit();
    await expect(state.preparePatch({ "bad//path": true })).rejects.toThrow(
      "invalid-audit-path",
    );
    await state.markUncertain();
    expect(await state.read()).toMatchObject({
      phase: "prepared",
      proof: null,
    });
    expect(await state.releaseIfSafe()).toBe(true);
    expect(await state.read()).toBeNull();
  });

  it("cannot dispatch a prepared admission that was reconciled or released", async () => {
    const { audit: state } = await audit();
    await state.preparePatch({ "automatch/invite": null });
    expect(await state.releaseIfSafe()).toBe(true);
    await expect(state.markDispatching()).rejects.toThrow("audit-missing");
  });

  it("persists each conditional transaction proposal with its expected source and ETag", async () => {
    const { audit: state } = await audit();
    await state.prepareTransaction("telegramAutomatches/invite");
    await state.markDispatching();
    await state.recordTransactionAttempt({
      current: { generation: 1 },
      proposed: { generation: 2 },
      etag: '"first"',
    });
    await state.recordTransactionAttempt({
      current: { generation: 3 },
      proposed: { generation: 4 },
      etag: '"second"',
    });
    const snapshot = await state.read();
    expect(snapshot?.proof).toMatchObject({
      kind: "transaction",
      path: "telegramAutomatches/invite",
      attempts: [
        {
          current: { generation: 1 },
          proposed: { generation: 2 },
          etag: '"first"',
          atMs: nowMs,
        },
        {
          current: { generation: 3 },
          proposed: { generation: 4 },
          etag: '"second"',
          atMs: nowMs,
        },
      ],
    });
    if (snapshot?.proof?.kind !== "transaction")
      throw new Error("missing transaction proof");
    expect(
      new Set(snapshot.proof.attempts.map(({ attemptId }) => attemptId)).size,
    ).toBe(2);
    await state.markCompleted();
    expect(await state.read()).toMatchObject({
      phase: "completed",
      completedAtMs: nowMs,
    });
    expect(await state.releaseIfSafe()).toBe(true);
  });

  it("records completion for a logical transaction abort without a write attempt", async () => {
    const { audit: state } = await audit();
    await state.prepareTransaction("telegramProjectionOutbox/automatch/invite");
    await state.markDispatching();
    await state.markCompleted();
    expect(await state.read()).toMatchObject({
      phase: "completed",
      proof: { attempts: [] },
    });
    await state.markUncertain();
    expect(await state.releaseIfSafe()).toBe(true);
  });

  it("reconciles a lost audit-write response without duplicating a transaction attempt", async () => {
    const { admission, audit: state } = await audit();
    await state.prepareTransaction("telegramAutomatches/invite");
    let lost = false;
    const observed = interceptRuns(async (query, run) => {
      const result = await run();
      if (!lost && query.startsWith("UPDATE automatch_write_admissions")) {
        lost = true;
        throw new Error("response-lost-after-commit");
      }
      return result;
    });
    await createAutomatchAdmissionAudit(
      observed,
      admission,
    ).recordTransactionAttempt({ current: null, proposed: { generation: 1 } });
    expect(await state.read()).toMatchObject({
      phase: "dispatching",
      auditRevision: 2,
    });
    const proof = (await state.read())?.proof;
    expect(proof?.kind === "transaction" && proof.attempts.length).toBe(1);
  });

  it("persists completion before retrying a lost release response", async () => {
    const { admission, audit: state } = await audit();
    await state.preparePatch({ "automatch/invite": null });
    await state.markDispatching();
    await state.markCompleted();
    let deletes = 0;
    const observed = interceptRuns(async (query, run) => {
      const result = await run();
      if (query.startsWith("DELETE FROM automatch_write_admissions")) {
        deletes++;
        throw new Error("release-response-lost");
      }
      return result;
    });
    expect(
      await createAutomatchAdmissionAudit(observed, admission).releaseIfSafe(),
    ).toBe(true);
    expect(deletes).toBe(1);
    expect(await state.read()).toBeNull();
  });

  it("retains a completed marker when all release attempts fail before applying", async () => {
    const { admission, audit: state } = await audit();
    await state.preparePatch({ "automatch/invite": null });
    await state.markDispatching();
    await state.markCompleted();
    const observed = interceptRuns(async (query, run) => {
      if (query.startsWith("DELETE FROM automatch_write_admissions"))
        throw new Error("release-unavailable");
      return run();
    });
    await expect(
      createAutomatchAdmissionAudit(observed, admission).releaseIfSafe(),
    ).rejects.toThrow("audit-release-unavailable");
    expect(await state.read()).toMatchObject({
      phase: "completed",
      proof: { kind: "patch" },
      completedAtMs: nowMs,
    });
  });

  it("does not release a prepared row that starts dispatching between read and delete", async () => {
    const { admission, audit: state } = await audit();
    await state.preparePatch({ "automatch/invite": null });
    let changed = false;
    const observed = interceptRuns(async (query, run) => {
      if (
        !changed &&
        query.startsWith("DELETE FROM automatch_write_admissions")
      ) {
        changed = true;
        await state.markDispatching();
      }
      return run();
    });
    expect(
      await createAutomatchAdmissionAudit(observed, admission).releaseIfSafe(),
    ).toBe(false);
    expect(await state.read()).toMatchObject({ phase: "dispatching" });
  });

  it("fails closed for pre-audit rows and refuses replacing an attached proof", async () => {
    const { admission, audit: state } = await audit();
    await db
      .prepare(
        "UPDATE automatch_write_admissions SET phase = 'uncertain' WHERE admission_id = ?",
      )
      .bind(admission.admissionId)
      .run();
    expect(await state.releaseIfSafe()).toBe(false);
    await expect(
      state.preparePatch({ "automatch/invite": null }),
    ).rejects.toThrow("already-dispatched");
    const next = await audit();
    await next.audit.preparePatch({ "automatch/invite": null });
    await expect(
      next.audit.preparePatch({ "automatch/other": null }),
    ).rejects.toThrow("proof-conflict");
    expect(
      await readAutomatchAdmissionAudit(db, { ...admission, epoch: 100 }),
    ).toBeNull();
  });

  it("retries the ordinary known-complete release idempotently", async () => {
    const { admission } = await audit();
    let deletes = 0;
    const observed = interceptRuns(async (query, run) => {
      const result = await run();
      if (
        query.startsWith("DELETE FROM automatch_write_admissions") &&
        deletes++ === 0
      )
        throw new Error("release-response-lost");
      return result;
    });
    await releaseAutomatchWriteAdmission(observed, admission);
    expect(deletes).toBe(2);
    expect(await readAutomatchAdmissionAudit(db, admission)).toBeNull();
  });

  it("retains exact staging patch scope after a raw response becomes uncertain", async () => {
    const updates = {
      "automatch/invite": { uid: "host", timestamp: { ".sv": "timestamp" } },
    };
    const raw: FirebaseRtdbClient = {
      async getPath() {
        return null;
      },
      async patchRoot() {
        throw new Error("raw-response-lost");
      },
      async transactPath() {
        throw new Error("unexpected transaction");
      },
    };
    const runtime = createAutomatchPersistence(db, raw, { now: () => nowMs });
    await expect(runtime.client.patchRoot(updates)).rejects.toThrow(
      "raw-response-lost",
    );
    const row = await db
      .prepare(
        "SELECT phase, proof_json, completed_at_ms FROM automatch_write_admissions",
      )
      .first<{
        phase: string;
        proof_json: string;
        completed_at_ms: number | null;
      }>();
    expect(row?.phase).toBe("uncertain");
    expect(JSON.parse(row?.proof_json || "null")).toEqual({
      schemaVersion: 1,
      kind: "patch",
      updates,
    });
    expect(row?.completed_at_ms).toBeNull();
  });

  it("records staging transaction proposals before raw dispatch and cleans up proven no-dispatch failures", async () => {
    let rawWrites = 0;
    const raw: FirebaseRtdbClient = {
      async getPath() {
        return null;
      },
      async patchRoot() {
        rawWrites++;
      },
      async transactPath(_path, _updater, _signal, beforeWrite) {
        await beforeWrite?.({
          current: { generation: 1 },
          proposed: { generation: 2 },
          etag: '"etag"',
        });
        const phase = await db
          .prepare("SELECT phase FROM automatch_write_admissions")
          .first("phase");
        expect(phase).toBe("dispatching");
        rawWrites++;
        throw new Error("transaction-response-lost");
      },
    };
    const runtime = createAutomatchPersistence(db, raw, { now: () => nowMs });
    await expect(
      runtime.client.patchRoot({ "automatch/invite": undefined }),
    ).rejects.toThrow("invalid-audit-json");
    expect(rawWrites).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM automatch_write_admissions")
        .first("count"),
    ).toBe(0);
    await expect(
      runtime.client.transactPath("telegramAutomatches/invite", () => ({
        value: { generation: 2 },
      })),
    ).rejects.toThrow("transaction-response-lost");
    const row = await db
      .prepare("SELECT phase, proof_json FROM automatch_write_admissions")
      .first<{ phase: string; proof_json: string }>();
    expect(row?.phase).toBe("uncertain");
    expect(JSON.parse(row?.proof_json || "null")).toMatchObject({
      kind: "transaction",
      path: "telegramAutomatches/invite",
      attempts: [
        {
          current: { generation: 1 },
          proposed: { generation: 2 },
          etag: '"etag"',
        },
      ],
    });
    expect(rawWrites).toBe(1);
  });
});
