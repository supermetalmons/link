import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AUTOMATCH_QUEUE_HEAD_SQL,
  isAutomatchQueueSelectionConflict,
  isFifoAutomatchQueue,
  readAutomatchQueueHead,
} from "../src/automatchQueueD1.ts";
import { AUTOMATCH_QUEUE_AUDIT_SQL } from "../src/automatchQueueSql.ts";

const db = env.PROFILE_GAMES_DB;
const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };

function ticket(inviteId: string, timestamp: unknown = 10, uid = inviteId) {
  return db
    .prepare(
      `INSERT INTO automatch_entries (record_key, payload_json, revision, updated_at_ms)
       VALUES (?, ?, 1, 10)`,
    )
    .bind(inviteId, JSON.stringify({ uid, timestamp, profileId: "hint" }));
}

function transition(
  transitionId: string,
  inviteId: string,
  action: "enqueue" | "claim" | "cancel" | "manual" | "replay",
) {
  const mutation = {
    current: {
      root: "automatch",
      key: inviteId,
      value: action === "enqueue" ? null : { uid: inviteId, timestamp: 10 },
      revision: action === "enqueue" ? 0 : 1,
    },
    value: action === "enqueue" ? { uid: inviteId, timestamp: 10 } : null,
  };
  const payload = {
    version: 2,
    transitionId,
    inviteId,
    createdAtMs: 10,
    mutations: [
      ...(action === "replay" ? [] : [mutation]),
      ...(action === "cancel"
        ? []
        : [
            {
              current: {
                root: "gameplayMutationReceipts",
                key: transitionId,
                value: null,
                revision: 0,
              },
              value: {
                kind: action === "manual" ? "join-invite" : "automatch-start",
                response: {
                  mode:
                    action === "enqueue" || action === "replay"
                      ? "pending"
                      : "matched",
                },
              },
            },
          ]),
    ],
  };
  return db
    .prepare(
      `INSERT INTO game_session_transitions
       (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'pending', 10, 10)`,
    )
    .bind(transitionId, inviteId, JSON.stringify(payload));
}

function reserve(transitionId: string, inviteId: string) {
  return db
    .prepare(
      "INSERT INTO game_session_transition_resources (resource_key, transition_id) VALUES (?, ?)",
    )
    .bind(inviteId, transitionId);
}

function activate() {
  return db
    .prepare(
      `UPDATE automatch_runtime_control SET metadata_json = '{"queueSelection":"fifo"}' WHERE singleton = 1`,
    )
    .run();
}

describe("typed FIFO automatch queue", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM game_session_transition_resources"),
      db.prepare("DELETE FROM game_session_transitions"),
      db.prepare("DELETE FROM automatch_entries"),
      db.prepare(
        "UPDATE automatch_runtime_control SET metadata_json = NULL WHERE singleton = 1",
      ),
    ]);
  });

  it("orders ready tickets by timestamp and then invite ID using the FIFO index", async () => {
    await db.batch([
      ticket("a-new", 30),
      ticket("z-old", 10),
      ticket("b-old", 10),
    ]);
    expect(await readAutomatchQueueHead(db)).toMatchObject({
      kind: "ready",
      inviteId: "b-old",
    });
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${AUTOMATCH_QUEUE_HEAD_SQL}`)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_automatch_live_tickets_fifo");
    expect(details).not.toContain("TEMP B-TREE");
  });

  it("projects legacy writes, source updates and tombstones without losing source revisions", async () => {
    await ticket("ticket").run();
    await db
      .prepare(
        "UPDATE automatch_entries SET payload_json = json_set(payload_json, '$.timestamp', 20), revision = 2 WHERE record_key = 'ticket'",
      )
      .run();
    expect(
      await db.prepare("SELECT * FROM automatch_live_tickets").first(),
    ).toEqual({
      invite_id: "ticket",
      uid: "ticket",
      profile_id_hint: "hint",
      source_revision: 2,
      enqueued_at_ms: 20,
    });
    await db
      .prepare(
        "UPDATE automatch_entries SET payload_json = NULL, revision = 3 WHERE record_key = 'ticket'",
      )
      .run();
    expect(await readAutomatchQueueHead(db)).toBeNull();
    expect(
      await db
        .prepare(
          "SELECT revision FROM automatch_entries WHERE record_key = 'ticket'",
        )
        .first("revision"),
    ).toBe(3);
    await db
      .prepare(
        "UPDATE automatch_entries SET payload_json = json_object('uid', 'ticket', 'timestamp', 30), revision = 4 WHERE record_key = 'ticket'",
      )
      .run();
    await db
      .prepare("DELETE FROM automatch_entries WHERE record_key = 'ticket'")
      .run();
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM automatch_live_tickets")
        .first("count"),
    ).toBe(0);
  });

  it("keeps malformed source data visible in the audit instead of silently dropping it", async () => {
    await db.batch([
      ticket("string", "10"),
      ticket("negative", -1),
      ticket("fractional", 1.5),
      ticket("valid", 0),
    ]);
    expect(await db.prepare(AUTOMATCH_QUEUE_AUDIT_SQL).first()).toMatchObject({
      live_tickets: 4,
      malformed_live_tickets: 3,
      live_mismatches: 0,
    });
  });

  it("rejects the second concurrent empty enqueue before publishing either losing journal or resource", async () => {
    await activate();
    const results = await Promise.allSettled([
      db.batch([
        transition("first", "first-invite", "enqueue"),
        reserve("first", "first-invite"),
      ]),
      db.batch([
        transition("second", "second-invite", "enqueue"),
        reserve("second", "second-invite"),
      ]),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(
      failure?.status === "rejected" &&
        isAutomatchQueueSelectionConflict(failure.reason),
    ).toBe(true);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM game_session_transitions")
        .first("count"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM game_session_transition_resources",
        )
        .first("count"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM automatch_pending_enqueues")
        .first("count"),
    ).toBe(1);
  });

  it("uses a pending enqueue only without ready candidates and old-v2 completion clears it atomically", async () => {
    await db.batch([
      transition("pending", "pending-invite", "enqueue"),
      reserve("pending", "pending-invite"),
    ]);
    expect(await readAutomatchQueueHead(db)).toEqual({
      kind: "pending",
      inviteId: "pending-invite",
      transitionId: "pending",
    });
    await ticket("ready", 20).run();
    expect(await readAutomatchQueueHead(db)).toMatchObject({
      kind: "ready",
      inviteId: "ready",
    });
    await db.batch([
      ticket("pending-invite", 10),
      db.prepare(
        "UPDATE game_session_transitions SET status = 'completed' WHERE transition_id = 'pending'",
      ),
      db.prepare(
        "DELETE FROM game_session_transition_resources WHERE transition_id = 'pending'",
      ),
    ]);
    expect(await readAutomatchQueueHead(db)).toMatchObject({
      kind: "ready",
      inviteId: "pending-invite",
    });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM automatch_pending_enqueues")
        .first("count"),
    ).toBe(0);
  });

  it("requires the oldest ready ticket and skips already claimed or canceling invites", async () => {
    await db.batch([ticket("old", 10), ticket("new", 20)]);
    await activate();
    await expect(
      db.batch([transition("wrong", "new", "claim"), reserve("wrong", "new")]),
    ).rejects.toThrow("automatch-selection-stale");
    await db.batch([
      transition("claim", "old", "claim"),
      reserve("claim", "old"),
    ]);
    expect(await readAutomatchQueueHead(db)).toMatchObject({
      kind: "ready",
      inviteId: "new",
    });
    await expect(transition("again", "old", "claim").run()).rejects.toThrow(
      "automatch-selection-stale",
    );
    await db.batch([
      transition("cancel", "new", "cancel"),
      reserve("cancel", "new"),
    ]);
    expect(await readAutomatchQueueHead(db)).toBeNull();
  });

  it("guards stale empty enqueue but permits manual joins and receipt-only replays", async () => {
    await ticket("ready").run();
    await activate();
    await expect(transition("empty", "new", "enqueue").run()).rejects.toThrow(
      "automatch-selection-stale",
    );
    await expect(
      transition("manual", "another", "manual").run(),
    ).resolves.toBeDefined();
    await expect(
      transition("replay", "ready", "replay").run(),
    ).resolves.toBeDefined();
  });

  it("recovers an oldest ticket's non-consuming receipt before allowing a newer match or empty enqueue", async () => {
    await db.batch([ticket("old", 10), ticket("new", 20)]);
    await activate();
    await db.batch([
      transition("receipt", "old", "replay"),
      reserve("receipt", "old"),
    ]);
    expect(await readAutomatchQueueHead(db)).toEqual({
      kind: "pending",
      inviteId: "old",
      transitionId: "receipt",
    });
    await expect(transition("new-claim", "new", "claim").run()).rejects.toThrow(
      "automatch-selection-stale",
    );
    await db
      .prepare("DELETE FROM automatch_entries WHERE record_key = 'new'")
      .run();
    await expect(
      transition("empty", "empty-invite", "enqueue").run(),
    ).rejects.toThrow("automatch-selection-stale");
    await db.batch([
      db.prepare(
        "UPDATE game_session_transitions SET status = 'completed' WHERE transition_id = 'receipt'",
      ),
      db.prepare(
        "DELETE FROM game_session_transition_resources WHERE transition_id = 'receipt'",
      ),
    ]);
    expect(await readAutomatchQueueHead(db)).toMatchObject({
      kind: "ready",
      inviteId: "old",
    });
  });

  it("keeps legacy behavior before activation and checks cancellation around reads", async () => {
    await db.batch([ticket("ready"), transition("legacy", "new", "enqueue")]);
    expect(isFifoAutomatchQueue({ metadata: null })).toBe(false);
    expect(isFifoAutomatchQueue({ metadata: { queueSelection: "fifo" } })).toBe(
      true,
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(readAutomatchQueueHead(db, controller.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(
      isAutomatchQueueSelectionConflict(
        new Error("outer", { cause: new Error("automatch-selection-stale") }),
      ),
    ).toBe(true);
    expect(isAutomatchQueueSelectionConflict(new Error("other"))).toBe(false);
  });

  it("fails closed on a pending intent without its exact recovery resource", async () => {
    await transition("orphan", "orphan-invite", "enqueue").run();
    expect(await db.prepare(AUTOMATCH_QUEUE_AUDIT_SQL).first()).toMatchObject({
      unrecoverable_pending_enqueues: 1,
    });
    await expect(readAutomatchQueueHead(db)).rejects.toThrow(
      "automatch-queue-pending-resource-unavailable",
    );
    await transition("wrong-owner", "other-invite", "manual").run();
    await reserve("wrong-owner", "orphan-invite").run();
    await expect(readAutomatchQueueHead(db)).rejects.toThrow(
      "automatch-queue-pending-resource-unavailable",
    );
    await db
      .prepare(
        "UPDATE game_session_transition_resources SET transition_id = 'orphan' WHERE resource_key = 'orphan-invite'",
      )
      .run();
    expect(await readAutomatchQueueHead(db)).toMatchObject({
      kind: "pending",
      transitionId: "orphan",
    });
  });
});
