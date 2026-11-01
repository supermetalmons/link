import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAutomatchD1Store } from "../src/automatchD1.ts";
import { readAutomatchQueueHead } from "../src/automatchQueueD1.ts";
import { buildAutomatchReplayTasks } from "../src/automatch/receipts.ts";
import { buildPendingAutomatchPlan } from "../src/automatch/plans.ts";
import { createStoredPlayerProfile } from "../src/profileCanonical/contracts.ts";
import { createDefaultProfileAppearance } from "../../../runtime/shared/appearance.js";
import {
  createAutomatchProjectionCommands,
  readAutomatchProfileRecoveryEntries,
  readAutomatchTelegramRecoveryEntries,
} from "../src/automatchProjectionRecords.ts";
import {
  commitProfileGameProjectionWrites,
  getProfileGameProjections,
  readProfileGamesPage,
} from "../src/profileGamesD1.ts";
import {
  parseAutomatchRecord,
  type AutomatchEntryRecord,
  type AutomatchProfileOutboxRecord,
  type AutomatchReceiptView,
} from "../../../runtime/automatchRecords.js";
import type { GameProjectionWrite } from "../../../runtime/profileGameProjectionRecords.js";

const db = env.PROFILE_GAMES_DB;
const migrations = (env as Env & { TEST_D1_MIGRATIONS: D1Migration[] })
  .TEST_D1_MIGRATIONS;
const retirement = {
  state: "retired" as const,
  retiredAtMs: 2000,
  sourceDigest: "a".repeat(64),
};
const store = () =>
  createAutomatchD1Store(db, { writeGuards: () => [], now: () => 3000 });
const entry = (uid: string, timestamp: number): AutomatchEntryRecord => ({
  schemaVersion: 1,
  uid,
  profileId: null,
  timestamp,
  rating: 1500,
  hostColor: "white",
  password: "fixture",
  gameVariant: "Classic",
  telegramDeliveryVersion: 2,
  username: "",
  ethAddress: "",
  solAddress: "",
  emojiId: 1,
});
const descriptor = {
  finalizedAtMs: 10,
  hostPlayerId: "host",
  guestPlayerId: "guest",
  source: "transition" as const,
  retryNotBeforeMs: 9000,
};
const profilePending = (
  requestId: string,
): Extract<AutomatchProfileOutboxRecord, { status: "pending" }> => ({
  schemaVersion: 2,
  status: "pending",
  requestId,
  reason: "history",
  sourceUpdatedAtMs: 1000,
  lastQueuedAtMs: 1000,
  historicalMatches: {},
  archiveRetry: null,
});
const projection = (): GameProjectionWrite => ({
  schemaVersion: 3,
  projectorVersion: 3,
  source: "game-projector",
  entityType: "game",
  inviteId: "invite",
  kind: "direct",
  hostLoginId: "host",
  guestLoginId: "guest",
  hostProfileId: "profile-host",
  guestProfileId: "profile-guest",
  status: "ended",
  sortBucket: 50,
  isPendingAutomatch: false,
  automatchStateHint: null,
  automatchCanceledAt: null,
  latestMatchId: "invite",
  ownerProfileId: "profile-host",
  ownerRole: "host",
  ownerLoginId: "host",
  opponentProfileId: "profile-guest",
  opponentLoginId: "guest",
  opponentName: "Guest",
  opponentEmoji: 1,
  listSortAt: 1000,
  createdAt: 1000,
  updatedAt: 1000,
  endedAt: 1000,
  lastEventFingerprint: "stable-event",
  lastEventType: "rating",
  lastEventReason: "rating",
  lastEventAt: 1000,
});

describe("canonical gameplay record boundaries", () => {
  beforeAll(async () => {
    await applyCanonicalTestMigrations(db, migrations);
    await db
      .prepare(
        "UPDATE automatch_runtime_control SET backend='d1', state='active', metadata_json=NULL WHERE singleton=1",
      )
      .run();
  });
  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM game_session_transition_resources_canonical"),
      db.prepare("DELETE FROM automatch_pending_enqueues_canonical"),
      db.prepare("DELETE FROM game_session_transitions_canonical"),
      db.prepare("DELETE FROM automatch_entries_canonical"),
      db.prepare("DELETE FROM automatch_telegram_sources_canonical"),
      db.prepare("DELETE FROM automatch_telegram_projection_outbox_canonical"),
      db.prepare("DELETE FROM game_session_projection_outbox_canonical"),
      db.prepare("DELETE FROM game_session_mutation_receipts_canonical"),
      db.prepare("DELETE FROM profile_game_projections_canonical"),
    ]);
  });
  it.each([1512.5, 0, Number.MAX_VALUE, Number.MIN_VALUE])(
    "preserves profile rating %s through the automatch writer and D1 readback",
    async (rating) => {
      const profile = createStoredPlayerProfile(
        "profile-host",
        createDefaultProfileAppearance(1),
        { rating },
      );
      const plan = buildPendingAutomatchPlan(
        {
          requesterUid: "host",
          request: {
            operationId: "00000000-0000-4000-8000-000000000001",
            emojiId: profile.emoji,
            aura: profile.aura,
          },
          profile: {
            profileId: profile.id,
            rating: profile.rating,
            emoji: profile.emoji,
            aura: profile.aura,
            username: "Host",
            eth: "",
            sol: "",
          },
          emojiId: profile.emoji,
          aura: profile.aura,
          name: "Host",
          random: () => 0.25,
        },
        () => "projection",
      );
      const change = plan.changes.find(
        (change) => change.kind === "automatch-entry",
      );
      if (!change || change.value === null)
        throw new Error("automatch-entry-required");
      const expected = { ...change.value, timestamp: 3000 };
      expect(parseAutomatchRecord("automatch", expected)?.rating).toBe(rating);
      const current = store();
      expect(await current.commit(await current.prepareChanges([change]))).toBe(
        true,
      );
      expect((await current.read("automatch", change.inviteId)).value).toEqual(
        expected,
      );
      expect(await readAutomatchQueueHead(db)).toEqual({
        kind: "ready",
        inviteId: change.inviteId,
        value: expected,
      });
    },
  );
  it.each([NaN, Infinity, -Infinity, -1, "1512.5", "1500", null])(
    "rejects invalid canonical automatch rating %s",
    (rating) => {
      expect(() =>
        parseAutomatchRecord("automatch", { ...entry("host", 1000), rating }),
      ).toThrow("invalid-canonical-automatch");
    },
  );
  it.each(["-1", '"1512.5"', "null", "1e999"])(
    "rejects a stored automatch rating encoded as %s",
    async (rating) => {
      const payload = JSON.stringify(entry("host", 1000)).replace(
        '"rating":1500',
        `"rating":${rating}`,
      );
      await expect(
        db
          .prepare(
            "INSERT INTO automatch_entries_canonical(record_key,payload_json,revision,updated_at_ms) VALUES(?,?,1,1000)",
          )
          .bind("auto_invalid", payload)
          .run(),
      ).rejects.toThrow();
    },
  );
  it("writes exact canonical queue records and preserves FIFO without old source reads or writes", async () => {
    const current = store();
    await current.commit(
      await current.prepareChanges([
        {
          kind: "automatch-entry",
          inviteId: "auto_newer",
          value: entry("newer", 2000),
        },
        {
          kind: "automatch-entry",
          inviteId: "auto_older",
          value: entry("older", 1000),
        },
      ]),
    );
    expect((await readAutomatchQueueHead(db))?.inviteId).toBe("auto_older");
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'automatch_entries'",
        )
        .first("n"),
    ).toBe(0);
    expect((await current.read("automatch", "auto_older")).value).toEqual(
      entry("older", 1000),
    );
    await expect(
      db
        .prepare(
          "INSERT INTO automatch_entries_canonical(record_key,payload_json,revision,updated_at_ms) VALUES('invalid','{}',1,1)",
        )
        .run(),
    ).rejects.toThrow();
  });
  it("cancelled outboxes cannot be claimed, acknowledged, repaired, or returned for recovery", async () => {
    const current = store();
    const telegram = {
      schemaVersion: 2 as const,
      status: "cancelled" as const,
      requestId: "retired",
      updatedAtMs: null,
      sourceUpdatedAtMs: 1000,
      retirement,
    };
    const profile: AutomatchProfileOutboxRecord = {
      ...profilePending("retired"),
      status: "cancelled",
      retirement,
      historicalMatches: { old: descriptor },
      archiveRetry: { requestId: "retired", notBeforeMs: 9000 },
    };
    await current.commit([
      {
        current: await current.read(
          "telegramProjectionOutbox/automatch",
          "invite",
        ),
        value: telegram,
      },
      {
        current: await current.read(
          "profileGameProjectionOutbox/automatch",
          "invite",
        ),
        value: profile,
      },
    ]);
    expect(
      await current.claimAutomatchTelegramOutbox(
        "invite",
        "retired",
        1000,
        3000,
      ),
    ).toBe(false);
    expect(
      await current.acknowledgeAutomatchTelegramOutbox("invite", "retired"),
    ).toBe(false);
    expect(
      await current.claimAutomatchProfileOutbox(
        "invite",
        "retired",
        1000,
        3000,
      ),
    ).toBe(false);
    expect(
      await current.acknowledgeAutomatchProfileOutbox("invite", "retired"),
    ).toBe(false);
    expect(
      await current.finishAutomatchProfileOutbox("invite", "retired", 3000),
    ).toBe("superseded");
    const commands = createAutomatchProjectionCommands(current);
    expect(
      await commands.repairInvalidAutomatchProfileOutbox("invite", 3000, () => {
        throw new Error("must-not-create-request");
      }),
    ).toEqual({ kind: "changed" });
    await commands.repairInvalidAutomatchTelegramOutbox("invite", 3000);
    expect(readAutomatchTelegramRecoveryEntries({ invite: telegram })).toEqual(
      [],
    );
    expect(readAutomatchProfileRecoveryEntries({ invite: profile })).toEqual(
      [],
    );
    expect(
      (await current.read("telegramProjectionOutbox/automatch", "invite"))
        .value,
    ).toEqual(telegram);
    expect(
      (await current.read("profileGameProjectionOutbox/automatch", "invite"))
        .value,
    ).toEqual(profile);
  });
  it("a fresh projection request does not resurrect retired work and a live retry keeps its absolute deadline", async () => {
    const current = store();
    const retired: AutomatchProfileOutboxRecord = {
      ...profilePending("old"),
      status: "cancelled",
      retirement,
      historicalMatches: { old: descriptor },
    };
    await current.commit([
      {
        current: await current.read(
          "profileGameProjectionOutbox/automatch",
          "invite",
        ),
        value: retired,
      },
    ]);
    await current.commit(
      await current.prepareChanges([
        {
          kind: "profile-outbox-merge",
          inviteId: "invite",
          value: profilePending("fresh"),
          historicalMatches: {
            next: { ...descriptor, retryNotBeforeMs: null },
          },
        },
      ]),
    );
    const fresh = (
      await current.read("profileGameProjectionOutbox/automatch", "invite")
    ).value;
    expect(fresh?.status).toBe("pending");
    expect(fresh?.historicalMatches).toEqual({
      next: { ...descriptor, retryNotBeforeMs: null },
    });
    await current.commit([
      {
        current: await current.read(
          "profileGameProjectionOutbox/automatch",
          "invite",
        ),
        value: {
          ...profilePending("live"),
          historicalMatches: { next: descriptor },
        },
      },
    ]);
    await current.commit(
      await current.prepareChanges([
        {
          kind: "profile-outbox-merge",
          inviteId: "invite",
          value: profilePending("live"),
          historicalMatches: {
            next: { ...descriptor, retryNotBeforeMs: null },
          },
        },
      ]),
    );
    expect(
      (await current.read("profileGameProjectionOutbox/automatch", "invite"))
        .value?.historicalMatches.next?.retryNotBeforeMs,
    ).toBe(9000);
  });
  it("retired automatch receipts preserve idempotent responses without scheduling old projections", async () => {
    const current = store();
    const receipt: AutomatchReceiptView = {
      schemaVersion: 2,
      kind: "automatch-start",
      aura: "none",
      completedAtMs: 1000,
      emojiId: 1,
      inviteId: "auto_invite",
      operationId: "operation",
      profileProjectionRequestId: "old-job",
      requesterUid: "host",
      response: {
        ok: true,
        inviteId: "auto_invite",
        mode: "pending",
        matchedImmediately: false,
      },
      telegramProjection: true,
      effects: retirement,
    };
    await current.commit([
      {
        current: await current.read("gameplayMutationReceipts", "operation"),
        value: receipt,
      },
    ]);
    const stored = (await current.read("gameplayMutationReceipts", "operation"))
      .value;
    expect(stored).toEqual(receipt);
    expect(buildAutomatchReplayTasks(receipt)).toBeNull();
  });
  it("projection rows retain canonical identity, appearance, and scalar ordering columns", async () => {
    const value = projection();
    await commitProfileGameProjectionWrites(db, [
      {
        type: "create",
        profileId: value.ownerProfileId,
        projectionId: value.inviteId,
        data: value,
      },
    ]);
    expect(
      (
        await getProfileGameProjections(db, value.ownerProfileId, [
          value.inviteId,
        ])
      ).get(value.inviteId)?.data,
    ).toEqual(value);
    expect(
      (await readProfileGamesPage(db, value.ownerProfileId, 10, null)).items[0]
        ?.id,
    ).toBe("invite");
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'profile_game_projections'",
        )
        .first("n"),
    ).toBe(0);
    await expect(
      commitProfileGameProjectionWrites(db, [
        {
          type: "update",
          profileId: "other-owner",
          projectionId: value.inviteId,
          data: value,
        },
      ]),
    ).rejects.toThrow("identity");
  });
});
