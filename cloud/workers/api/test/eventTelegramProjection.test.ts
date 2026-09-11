import { eventReadFixture } from "./eventReadFixture.ts";
import type { EventReads } from "../../../runtime/eventReads.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramDeliveryEngine,
  createTelegramLocalRetryBarrier,
} from "../../../runtime/telegram/deliveryEngine.js";
import { buildTelegramSendDesired } from "../../../runtime/telegram/desiredStateCore.js";
import { buildSundayMonsReminder } from "../../../runtime/telegram/sundayMonsReminder.js";
import type { TelegramResult } from "../../../runtime/telegram/client.js";
import type { TelegramRepository } from "../../../runtime/telegram/deliveryEngine.js";
import type { TelegramAnnouncementRecord } from "../src/telegramD1.ts";
import {
  buildEventTelegramProjection,
  buildEventTelegramProjectionUpdates,
} from "../../../runtime/telegram/eventProjectionCore.js";
import { createTelegramRepository } from "../../../runtime/telegram/repositoryCore.js";
import type { StateRepository } from "../src/stateRepositoryTypes.ts";
import {
  processEventProjectionTask,
  sweepEventTelegramProjections,
} from "../src/eventTelegramProjection.ts";
import {
  getEventTelegramProjectionGenerationPath,
  getEventTelegramProjectionOutboxPath,
} from "../src/eventTelegramProjectionProducer.ts";
import type {
  RatingProjectionRepository,
  RatingUpdateData,
} from "../src/gameplayRepository.ts";
import type { TelegramProjectionTask } from "../src/telegramProjectionTasks.ts";
import { handleTelegramProjectionMessage } from "../src/telegramProjection.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function store(initial: Record<string, unknown>) {
  const values = new Map(Object.entries(initial));
  const client: StateRepository & EventReads = {
    ...eventReadFixture(async (path) => values.get(path) ?? null),
    async getPath(path) {
      assert.ok(!path.startsWith("events/"));
      return values.get(path) ?? null;
    },
    async patchRoot(updates) {
      for (const [path, value] of Object.entries(updates)) {
        values.set(path, value);
      }
    },
    async transactPath(path, updater) {
      const current = values.get(path) ?? null;
      const output = updater(current) as
        | { commit: false; decision?: string }
        | { value: unknown; decision?: string };
      if ("commit" in output && output.commit === false) {
        return {
          committed: false,
          decision: output.decision,
          value: current,
        };
      }
      if (!("value" in output)) {
        throw new Error("invalid-transaction-output");
      }
      values.set(path, output.value);
      return {
        committed: true,
        decision: output.decision,
        value: output.value,
      };
    },
  };
  return {
    client,
    read: (path: string) => values.get(path) ?? null,
    write: (path: string, value: unknown) => values.set(path, value),
  };
}

function ratingRepository(): RatingProjectionRepository {
  return {
    applyFebruaryChallengeReplay: async () => undefined,
    claimRatingTelegramProjection: async () => false,
    finalizeRatingUpdate: async () => ({ status: "lost" }),
    getStatePath: async () => null,
    listDueRatingTelegramProjections: async () => [],
    markRatingTelegramProjection: async () => undefined,
    patchStateRoot: async () => undefined,
    readProfileOwnershipSnapshot: async () => {
      throw new Error("unexpected-profile-ownership-read");
    },
    readRatingUpdate: async (): Promise<RatingUpdateData | null> => null,
    hasCompletedRatingUpdate: async () => false,
    tryAcquireRatingLease: async () => ({ status: "busy", data: null }),
  };
}

const task = {
  kind: "event-telegram-projection" as const,
  eventId: "event-1",
  requestId: "request-1",
};

const marker = {
  schemaVersion: 1,
  status: "pending",
  requestId: "request-1",
  firstQueuedAtMs: 100,
  updatedAtMs: 100,
};

function scheduledEvent() {
  return {
    telegramDeliveryVersion: 2,
    announceOnTelegram: true,
    status: "scheduled",
    startAtMs: Date.UTC(2026, 7, 26, 17),
    participants: {},
    rounds: {},
  };
}

test("event projection persists desired state before delivery and clears its outbox", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
    "events/event-1": scheduledEvent(),
  });
  const deliveries: Array<Record<string, string>> = [];
  assert.equal(
    await processEventProjectionTask(
      task,
      state.client,
      ratingRepository(),
      async (input) => {
        assert.ok(state.read(`telegramMessages/${input.messageKey}/desired`));
        assert.equal(state.read("eventTelegramProjections/event-1"), null);
        deliveries.push(input);
      },
      () => Date.UTC(2026, 7, 25, 12),
    ),
    "projected",
  );
  assert.equal(
    state.read(getEventTelegramProjectionOutboxPath(task.eventId)),
    null,
  );
  assert.ok(state.read("eventTelegramProjections/event-1"));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].producer, "event-projection");
  assert.equal(state.read("eventTelegramProjectionLocks/event-1"), null);
});

test("missing events clear work without creating Telegram messages", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
  });
  let deliveries = 0;
  assert.equal(
    await processEventProjectionTask(
      task,
      state.client,
      ratingRepository(),
      async () => void deliveries++,
      () => 200,
    ),
    "missing",
  );
  assert.equal(deliveries, 0);
  assert.equal(
    state.read(getEventTelegramProjectionOutboxPath(task.eventId)),
    null,
  );
});

test("a published heading survives a failed projection commit and later flag changes", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
    "events/event-1": { ...scheduledEvent(), isSundayMons: true },
  });
  const messagePath = "telegramMessages/event:event-1:upcoming";
  const messages = store({});
  const telegram = createTelegramRepository({
    getPath: messages.client.getPath,
    transactPath: messages.client.transactPath,
  });
  const now = () => Date.UTC(2026, 7, 25, 12);
  await processEventProjectionTask(
    task,
    state.client,
    ratingRepository(),
    async () => undefined,
    now,
    telegram,
  );
  const staleProjection = state.read("eventTelegramProjections/event-1") as {
    upcomingText: string;
  };
  assert.match(staleProjection.upcomingText, /^sunday mons soon\n/);
  state.write("events/event-1", { ...scheduledEvent(), isSundayMons: false });
  state.write(getEventTelegramProjectionOutboxPath(task.eventId), marker);
  await assert.rejects(
    processEventProjectionTask(
      task,
      state.client,
      ratingRepository(),
      async () => {
        const message = messages.read(messagePath) as {
          desired: {
            destination: string;
            instanceKey: string;
            contentHash: string;
            revision: string;
            text: string;
          };
        };
        assert.match(message.desired.text, /^upcoming event\n/);
        messages.write(messagePath, {
          ...message,
          applied: {
            destination: message.desired.destination,
            instanceKey: message.desired.instanceKey,
            contentHash: message.desired.contentHash,
            revision: message.desired.revision,
            messageId: 42,
          },
        });
        throw new Error("delivery-queue-acknowledgement-lost");
      },
      now,
      telegram,
    ),
    /delivery-queue-acknowledgement-lost/,
  );
  assert.deepEqual(
    state.read("eventTelegramProjections/event-1"),
    staleProjection,
  );
  state.write("events/event-1", { ...scheduledEvent(), isSundayMons: true });
  let deliveries = 0;
  assert.equal(
    await processEventProjectionTask(
      task,
      state.client,
      ratingRepository(),
      async () => void deliveries++,
      now,
      telegram,
    ),
    "projected",
  );
  const recovered = messages.read(messagePath) as {
    desired: { operation: string; text: string };
  };
  assert.equal(recovered.desired.operation, "edit");
  assert.match(recovered.desired.text, /^upcoming event\n/);
  assert.equal(deliveries, 1);
  state.write("events/event-1", { ...scheduledEvent(), isSundayMons: false });
  state.write(getEventTelegramProjectionOutboxPath(task.eventId), marker);
  assert.equal(
    await processEventProjectionTask(
      task,
      state.client,
      ratingRepository(),
      async () => void deliveries++,
      now,
      telegram,
    ),
    "unchanged",
  );
  assert.equal(deliveries, 1);
});

test("a legacy send racing projection retains its heading and retries participant updates", async (t) => {
  const now = () => Date.UTC(2026, 7, 25, 12);
  const messagePath = "telegramMessages/event:event-1:upcoming";
  const projectionPath = "eventTelegramProjections/event-1";
  const outboxPath = getEventTelegramProjectionOutboxPath(task.eventId);
  const legacyProjection = buildEventTelegramProjection({
    eventId: task.eventId,
    eventData: { ...scheduledEvent(), isSundayMons: true },
    nowMs: now(),
  });
  assert.equal(legacyProjection.action, "project");
  const legacyUpcomingOperation = legacyProjection.operations.find(
    (operation) => operation.channel === "upcoming",
  );
  assert.ok(legacyUpcomingOperation);
  legacyUpcomingOperation.text = legacyUpcomingOperation.text.replace(
    /^sunday mons soon\n/,
    "join sunday mons\n",
  );
  legacyProjection.state.upcomingText = legacyUpcomingOperation.text;
  const desired = buildEventTelegramProjectionUpdates({
    eventId: task.eventId,
    projection: legacyProjection,
  })[`${messagePath}/desired`] as {
    destination: string;
    instanceKey: string;
    contentHash: string;
    revision: string;
    text: string;
  };
  const deliveryIdentity = {
    destination: desired.destination,
    instanceKey: desired.instanceKey,
    contentHash: desired.contentHash,
    revision: desired.revision,
  };
  const applied = { ...deliveryIdentity, messageId: 42 };
  const sending = {
    desired,
    delivery: {
      sendInFlight: {
        ...deliveryIdentity,
        attemptId: "send-1",
        chatId: "community-chat",
        startedAtMs: now(),
      },
    },
  };
  const delivered = { desired, applied, delivery: { status: "delivered" } };

  for (const race of [
    "already sending",
    "starts before commit",
    "finishes before commit",
    "finishes during transaction replay",
  ]) {
    await t.test(race, async () => {
      const state = store({
        [outboxPath]: marker,
        [projectionPath]: legacyProjection.state,
        "events/event-1": {
          ...scheduledEvent(),
          isSundayMons: false,
          participants: {
            alice: { username: "Alice", joinedAtMs: 1 },
            bob: { username: "Bob", joinedAtMs: 2 },
          },
        },
      });
      const messages = store({
        [messagePath]: race === "already sending" ? sending : { desired },
      });
      let interruptCommit = race !== "already sending";
      const telegram = createTelegramRepository({
        getPath: messages.client.getPath,
        transactPath: async (path, updater) => {
          if (path === messagePath && interruptCommit) {
            interruptCommit = false;
            if (race === "finishes during transaction replay") {
              updater(messages.read(path));
            }
            messages.write(
              path,
              race === "starts before commit" ? sending : delivered,
            );
          }
          return messages.client.transactPath(path, updater);
        },
      });
      let deliveries = 0;
      const project = () =>
        processEventProjectionTask(
          task,
          state.client,
          ratingRepository(),
          async () => void deliveries++,
          now,
          telegram,
        );

      await assert.rejects(project(), /event-telegram-delivery-changed/);
      assert.deepEqual(
        messages.read(messagePath),
        race === "already sending" || race === "starts before commit"
          ? sending
          : delivered,
      );
      const deferred = state.read(projectionPath) as {
        upcomingText: string;
        lastProjectedSignature: string;
      };
      assert.equal(deferred.upcomingText, legacyProjection.state.upcomingText);
      assert.equal(deferred.lastProjectedSignature, "");
      assert.deepEqual(state.read(outboxPath), marker);
      assert.equal(state.read("eventTelegramProjectionLocks/event-1"), null);
      assert.equal(deliveries, 0);

      messages.write(messagePath, delivered);
      assert.equal(await project(), "projected");
      const recovered = messages.read(messagePath) as {
        applied: typeof applied;
        desired: { operation: string; text: string };
      };
      assert.deepEqual(recovered.applied, applied);
      assert.equal(recovered.desired.operation, "edit");
      assert.match(recovered.desired.text, /^join sunday mons\n/);
      assert.match(recovered.desired.text, /Alice Bob$/);
      assert.equal(state.read(outboxPath), null);
      assert.equal(deliveries, 1);

      state.write(outboxPath, marker);
      assert.equal(await project(), "unchanged");
      assert.equal(deliveries, 1);
    });
  }
});

test("uncertain invites preserve lifecycle and manual recovery decisions", async (t) => {
  const scenarios = [
    {
      name: "confirmed applied after lifecycle announcements",
      statuses: ["active", "active", "ended"],
      action: "confirm-send-applied",
    },
    {
      name: "confirmed absent after starting",
      statuses: ["active"],
      action: "confirm-send-absent",
    },
    {
      name: "confirmed absent after ending",
      statuses: ["active", "ended"],
      action: "confirm-send-absent",
    },
    {
      name: "confirmed absent after dismissal",
      statuses: ["dismissed"],
      action: "confirm-send-absent",
    },
    {
      name: "confirmed absent while scheduled",
      statuses: ["scheduled"],
      action: "confirm-send-absent",
    },
    {
      name: "abandoned after a deferred participant update",
      statuses: ["scheduled"],
      action: "abandon",
    },
  ];
  for (const scenario of scenarios) {
    for (const loseInitialProjection of [false, true]) {
      await t.test(
        `${scenario.name}, ${loseInitialProjection ? "missing" : "persisted"} projection state`,
        async () => {
          const outboxPath = getEventTelegramProjectionOutboxPath(task.eventId);
          const projectionPath = "eventTelegramProjections/event-1";
          const upcomingKey = "event:event-1:upcoming";
          const upcomingPath = `telegramMessages/${upcomingKey}`;
          const event = {
            ...scheduledEvent(),
            isSundayMons: false,
            participants: {
              alice: { username: "Alice", joinedAtMs: 1 },
              bob: { username: "Bob", joinedAtMs: 2 },
            },
          };
          const state = store({
            [outboxPath]: marker,
            "events/event-1": event,
          });
          const messages = store({});
          const telegram = createTelegramRepository(messages.client);
          const now = () => Date.UTC(2026, 7, 25, 12);
          const pending: Array<{ messageKey: string; revision: string }> = [];
          let failInitialEnqueue = loseInitialProjection;
          const project = () =>
            processEventProjectionTask(
              task,
              state.client,
              ratingRepository(),
              async (input) => {
                pending.push(input);
                if (failInitialEnqueue) {
                  failInitialEnqueue = false;
                  throw new Error("delivery-queue-acknowledgement-lost");
                }
              },
              now,
              telegram,
            );
          const sentTexts: string[] = [];
          const editedTexts: string[] = [];
          let attemptId = 0;
          const engine = createTelegramDeliveryEngine({
            repository: telegram,
            now,
            createOwnerToken: () => "owner-1",
            createAttemptId: () => `attempt-${++attemptId}`,
            resolveDestination: () => "community-chat",
            scheduleRetry: async () => ({ scheduled: true }),
            localRetryBarrier: createTelegramLocalRetryBarrier(),
            logger: { error() {}, info() {} },
            client: {
              async sendTelegramMessage({ text }) {
                sentTexts.push(String(text));
                return sentTexts.length === 1
                  ? {
                      ok: false,
                      classification: "uncertain",
                      code: "timeout",
                      description: "timeout",
                      httpStatus: null,
                      retryAfterSeconds: null,
                    }
                  : {
                      ok: true,
                      outcome: "sent",
                      httpStatus: 200,
                      messageId: 100 + sentTexts.length,
                    };
              },
              async editTelegramMessage({ text }) {
                editedTexts.push(String(text));
                return { ok: true, outcome: "edited", httpStatus: 200 };
              },
              async deleteTelegramMessage() {
                throw new Error("unexpected-delete");
              },
            },
          });
          const deliver = async (expectedStatuses: string[]) => {
            for (const input of pending.splice(0)) {
              const result = await engine.reconcile({
                messageKey: input.messageKey,
                requestedRevision: input.revision,
              });
              assert.ok(
                expectedStatuses.includes(result.status),
                `${input.messageKey}: ${result.status}`,
              );
            }
          };
          type InviteMessage = {
            desired: {
              operation: string;
              ifMissing?: string;
              text: string;
              revision: string;
              contentHash: string;
              destination: string;
              instanceKey: string;
            };
            applied?: { messageId: number };
            delivery: {
              status: string;
              sendInFlight?: unknown;
              abandonedSend?: unknown;
            };
          };
          const readInvite = () => messages.read(upcomingPath) as InviteMessage;

          if (loseInitialProjection) {
            await assert.rejects(
              project(),
              /delivery-queue-acknowledgement-lost/,
            );
            assert.equal(state.read(projectionPath), null);
          } else {
            assert.equal(await project(), "projected");
          }
          assert.equal(pending.length, 1);
          await deliver(["uncertain"]);
          const uncertain = structuredClone(readInvite());
          assert.equal(uncertain.delivery.status, "uncertain");
          assert.ok(uncertain.delivery.sendInFlight);
          assert.equal(
            (messages.read("telegramDeliveryControl") as { apiGate?: unknown })
              .apiGate,
            undefined,
          );
          const rounds = {
            0: {
              roundIndex: 0,
              matches: {
                "0_0": {
                  inviteId: "match-1",
                  status: "pending",
                  hostProfileId: "alice",
                  guestProfileId: "bob",
                  hostLoginUid: "alice-login",
                  guestLoginUid: "bob-login",
                },
              },
            },
          };
          const updatedParticipants = {
            ...event.participants,
            carol: { username: "Carol", joinedAtMs: 3 },
          };
          for (const status of scenario.statuses) {
            state.write("events/event-1", {
              ...event,
              status,
              rounds: status === "scheduled" ? {} : rounds,
              participants: updatedParticipants,
            });
            state.write(outboxPath, marker);
            await assert.rejects(project(), /event-telegram-delivery-changed/);
            assert.ok(
              pending.every(({ messageKey }) => messageKey !== upcomingKey),
            );
            await deliver(["delivered", "settled"]);
            const deferred = readInvite();
            assert.deepEqual(deferred.delivery, uncertain.delivery);
            assert.equal(deferred.desired.text, uncertain.desired.text);
            assert.equal(
              deferred.desired.contentHash,
              uncertain.desired.contentHash,
            );
            assert.equal(
              deferred.desired.destination,
              uncertain.desired.destination,
            );
            assert.equal(
              deferred.desired.instanceKey,
              uncertain.desired.instanceKey,
            );
            if (status === "scheduled") {
              assert.deepEqual(deferred, uncertain);
            } else {
              assert.equal(deferred.desired.operation, "edit");
              assert.equal(deferred.desired.ifMissing, "skip");
            }
            assert.deepEqual(state.read(outboxPath), marker);
            assert.equal(
              state.read("eventTelegramProjectionLocks/event-1"),
              null,
            );
            const progress = state.read(projectionPath) as {
              startedText: string;
              endedText: string;
              endedAnnouncementArmed: boolean;
            };
            if (status === "active" || status === "ended") {
              assert.match(progress.startedText, /^event started\n/);
              assert.equal(progress.endedAnnouncementArmed, true);
            }
            if (status === "ended") {
              assert.match(progress.endedText, /^event complete\n/);
            }
          }
          const expectedHeadings = [
            "upcoming event",
            ...(scenario.statuses.includes("active") ? ["event started"] : []),
            ...(scenario.statuses.includes("ended") ? ["event complete"] : []),
          ];
          assert.deepEqual(
            sentTexts.map((text) => text.split("\n", 1)[0]),
            expectedHeadings,
          );

          const beforeRecovery = structuredClone(readInvite());
          messages.write(upcomingPath, {
            ...beforeRecovery,
            manualRecovery: {
              requestId: "recovery-1",
              action: scenario.action,
              ...(scenario.action === "confirm-send-applied"
                ? { messageId: 42 }
                : {}),
            },
          });
          const recovery = await engine.reconcile({ messageKey: upcomingKey });
          assert.equal(
            recovery.status,
            scenario.action === "abandon" ? "terminal" : "delivered",
          );
          const stillScheduled = scenario.statuses.at(-1) === "scheduled";
          if (scenario.action === "confirm-send-absent" && !stillScheduled) {
            assert.equal(recovery.reason, "missing-skipped");
          }
          assert.equal(await project(), "projected");
          await deliver(["delivered", "settled"]);
          const recovered = readInvite();
          assert.equal(recovered.delivery.sendInFlight, undefined);
          assert.equal(state.read(outboxPath), null);
          if (scenario.action === "abandon") {
            assert.deepEqual(recovered.desired, beforeRecovery.desired);
            assert.equal(recovered.delivery.status, "terminal");
            assert.ok(recovered.delivery.abandonedSend);
            assert.equal(
              (await engine.reconcile({ messageKey: upcomingKey })).status,
              "settled",
            );
            const participantsAfterAbandon = {
              ...updatedParticipants,
              dave: { username: "Dave", joinedAtMs: 4 },
            };
            state.write("events/event-1", {
              ...event,
              participants: participantsAfterAbandon,
            });
            state.write(outboxPath, marker);
            assert.equal(await project(), "projected");
            assert.equal(pending.length, 0);
            assert.deepEqual(readInvite(), recovered);
            assert.equal(state.read(outboxPath), null);
            assert.equal(
              (await engine.reconcile({ messageKey: upcomingKey })).status,
              "settled",
            );
            assert.equal(sentTexts.length, 1);
            assert.deepEqual(editedTexts, []);

            messages.write(upcomingPath, {
              ...readInvite(),
              desired: buildTelegramSendDesired({
                ...recovered.desired,
                sourceRevision: "admin-resend-1",
              }),
            });
            assert.equal(
              (await engine.reconcile({ messageKey: upcomingKey })).status,
              "delivered",
            );
            const resent = readInvite();
            assert.equal(resent.delivery.status, "delivered");
            assert.equal(resent.applied?.messageId, 102);
            assert.deepEqual(
              resent.delivery.abandonedSend,
              recovered.delivery.abandonedSend,
            );
            expectedHeadings.push("upcoming event");
            state.write("events/event-1", {
              ...event,
              participants: {
                ...participantsAfterAbandon,
                erin: { username: "Erin", joinedAtMs: 5 },
              },
            });
            state.write(outboxPath, marker);
            assert.equal(await project(), "projected");
            assert.equal(pending.length, 1);
            assert.equal(pending[0].messageKey, upcomingKey);
            await deliver(["delivered"]);
            const resumed = readInvite();
            assert.equal(resumed.desired.operation, "edit");
            assert.match(resumed.desired.text, /Alice Bob Carol Dave Erin$/);
            assert.equal(resumed.applied?.messageId, resent.applied?.messageId);
            assert.deepEqual(editedTexts, [resumed.desired.text]);
            assert.deepEqual(
              resumed.delivery.abandonedSend,
              recovered.delivery.abandonedSend,
            );
            assert.equal(sentTexts.length, 2);
            assert.equal(state.read(outboxPath), null);
          } else {
            assert.equal(recovered.desired.operation, "edit");
            if (stillScheduled) {
              expectedHeadings.push("upcoming event");
              assert.match(recovered.desired.text, /Alice Bob Carol$/);
              assert.deepEqual(editedTexts, [recovered.desired.text]);
              assert.equal(recovered.applied?.messageId, 102);
            } else {
              assert.equal(recovered.desired.text, uncertain.desired.text);
              assert.equal(
                recovered.applied?.messageId,
                scenario.action === "confirm-send-applied" ? 42 : undefined,
              );
            }
          }
          assert.deepEqual(
            sentTexts.map((text) => text.split("\n", 1)[0]),
            expectedHeadings,
          );
          if (!stillScheduled) {
            assert.deepEqual(editedTexts, []);
          }
          state.write(outboxPath, marker);
          assert.equal(await project(), "unchanged");
          assert.equal(pending.length, 0);
        },
      );
    }
  }
});

test("a manual invite receipt unlocks an edit through the Telegram repository and retries safely", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
    "events/event-1": {
      ...scheduledEvent(),
      telegramAnnouncements: { invite: false, matches: true, results: true },
    },
  });
  const messageKey = "event:event-1:upcoming";
  const messagePath = `telegramMessages/${messageKey}`;
  const messages = store({});
  const telegram = createTelegramRepository({
    getPath: messages.client.getPath,
    transactPath: messages.client.transactPath,
  });
  let deliveries = 0;
  await processEventProjectionTask(
    task,
    state.client,
    ratingRepository(),
    async () => void deliveries++,
    () => 200,
    telegram,
  );
  assert.equal(deliveries, 0);
  const hiddenProjection = state.read("eventTelegramProjections/event-1");
  const applied = {
    destination: "community",
    instanceKey: "event:event-1:upcoming:v2",
    messageId: 42,
  };
  messages.write(messagePath, { applied, delivery: { status: "pending" } });
  state.write(getEventTelegramProjectionOutboxPath(task.eventId), marker);
  await assert.rejects(
    processEventProjectionTask(
      task,
      state.client,
      ratingRepository(),
      async () => {
        throw new Error("delivery-queue-unavailable");
      },
      () => 200,
      telegram,
    ),
    /delivery-queue-unavailable/,
  );
  const pendingMessage = messages.read(messagePath) as {
    applied: typeof applied;
    desired: { operation: string; ifMissing: string; revision: string };
  };
  assert.equal(pendingMessage.desired.operation, "edit");
  assert.equal(pendingMessage.desired.ifMissing, "skip");
  assert.deepEqual(pendingMessage.applied, applied);
  assert.deepEqual(
    state.read("eventTelegramProjections/event-1"),
    hiddenProjection,
  );
  assert.deepEqual(
    state.read(getEventTelegramProjectionOutboxPath(task.eventId)),
    marker,
  );
  await processEventProjectionTask(
    task,
    state.client,
    ratingRepository(),
    async (delivery) => {
      assert.equal(delivery.revision, pendingMessage.desired.revision);
      deliveries++;
    },
    () => 200,
    telegram,
  );
  assert.equal(deliveries, 1);
  assert.equal(state.read(messagePath), null);
  assert.equal(
    state.read(getEventTelegramProjectionOutboxPath(task.eventId)),
    null,
  );
});

test("final score reads follow the results preference independently of the legacy flag", async (t) => {
  for (const results of [false, true]) {
    await t.test(String(results), async () => {
      const state = store({
        [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
        "events/event-1": {
          ...scheduledEvent(),
          announceOnTelegram: !results,
          telegramAnnouncements: { invite: false, matches: false, results },
          status: "ended",
          participants: {
            alice: { username: "Alice" },
            bob: { username: "Bob" },
          },
          rounds: {
            0: {
              matches: {
                "0_0": {
                  inviteId: "match-1",
                  status: "host",
                  hostProfileId: "alice",
                  guestProfileId: "bob",
                  hostLoginUid: "alice-login",
                  guestLoginUid: "bob-login",
                },
              },
            },
          },
        },
        "eventTelegramProjections/event-1": { endedAnnouncementArmed: true },
      });
      const reads: string[] = [];
      const rating = ratingRepository();
      rating.readRatingUpdate = async (operationId) => {
        reads.push(operationId);
        return null;
      };
      const deliveries: string[] = [];
      await processEventProjectionTask(
        task,
        state.client,
        rating,
        async ({ messageKey }) => void deliveries.push(messageKey),
        () => 200,
      );
      assert.deepEqual(reads, results ? ["match-1__match-1"] : []);
      assert.deepEqual(deliveries, results ? ["event:event-1:ended"] : []);
    });
  }
});

test("rating read failures retain pending event work for a successful retry", async () => {
  const outboxPath = getEventTelegramProjectionOutboxPath(task.eventId);
  const projectionPath = "eventTelegramProjections/event-1";
  const armed = { endedAnnouncementArmed: true };
  const state = store({
    [outboxPath]: marker,
    [projectionPath]: armed,
    "events/event-1": {
      ...scheduledEvent(),
      status: "ended",
      rounds: {
        0: {
          matches: {
            "0_0": {
              inviteId: "match-1",
              hostLoginUid: "alice-login",
              guestLoginUid: "bob-login",
              hostDisplayName: "Alice",
              guestDisplayName: "Bob",
            },
          },
        },
      },
    },
  });
  const messages = store({});
  const telegram = createTelegramRepository({
    getPath: messages.client.getPath,
    transactPath: messages.client.transactPath,
  });
  const messageKey = "event:event-1:ended";
  const rating = ratingRepository();
  let failRead = true;
  let reads = 0;
  rating.readRatingUpdate = async () => {
    reads++;
    if (failRead) throw new Error("rating-read-failed");
    return null;
  };
  const deliveries: string[] = [];
  const project = () =>
    processEventProjectionTask(
      task,
      state.client,
      rating,
      async ({ messageKey }) => void deliveries.push(messageKey),
      () => 200,
      telegram,
    );

  await assert.rejects(project(), /rating-read-failed/);
  assert.deepEqual(state.read(outboxPath), marker);
  assert.deepEqual(state.read(projectionPath), armed);
  assert.equal(await telegram.getMessage(messageKey), null);
  assert.equal(state.read("eventTelegramProjectionLocks/event-1"), null);
  assert.deepEqual(deliveries, []);

  failRead = false;
  assert.equal(await project(), "projected");
  assert.equal(reads, 2);
  assert.deepEqual(deliveries, [messageKey]);
  assert.equal(state.read(outboxPath), null);
  const message = (await telegram.getMessage(messageKey)) as {
    desired: { text: string };
  };
  assert.equal(
    message.desired.text,
    "event complete\n\nhttps://mons.link/event/event-1\n\nAlice vs. Bob",
  );
  assert.equal(
    (state.read(projectionPath) as { endedText: string }).endedText,
    message.desired.text,
  );
});

test("a successor marker survives completion of older work", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
    "events/event-1": scheduledEvent(),
  });
  await processEventProjectionTask(
    task,
    state.client,
    ratingRepository(),
    async () => {
      state.write(getEventTelegramProjectionOutboxPath(task.eventId), {
        ...marker,
        requestId: "request-2",
        updatedAtMs: 200,
      });
    },
    () => 200,
  );
  assert.deepEqual(
    state.read(getEventTelegramProjectionOutboxPath(task.eventId)),
    {
      ...marker,
      requestId: "request-2",
      updatedAtMs: 200,
    },
  );
});

test("projection lock contention is retryable", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
    "events/event-1": scheduledEvent(),
    "eventTelegramProjectionLocks/event-1": {
      lockId: "foreign",
      ownerUid: "foreign",
      expiresAtMs: Date.now() + 60_000,
    },
  });
  await assert.rejects(
    () =>
      processEventProjectionTask(
        task,
        state.client,
        ratingRepository(),
        async () => undefined,
        Date.now,
      ),
    /event-telegram-lock-busy/,
  );
});

test("a newer generation fences stale desired and state commits", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath(task.eventId)]: marker,
    [getEventTelegramProjectionGenerationPath(task.eventId)]: 1,
    "events/event-1": scheduledEvent(),
    "eventTelegramProjections/event-1": {
      eventTelegramProjectionGuard: { generation: 2 },
    },
    "telegramMessages/event:event-1:upcoming/desired": {
      eventTelegramProjectionGuard: { generation: 2 },
      revision: "newer",
    },
  });
  let deliveries = 0;
  assert.equal(
    await processEventProjectionTask(
      task,
      state.client,
      ratingRepository(),
      async () => void deliveries++,
      () => 200,
    ),
    "superseded",
  );
  assert.equal(deliveries, 0);
  assert.equal(
    (
      state.read("telegramMessages/event:event-1:upcoming/desired") as {
        revision: string;
      }
    ).revision,
    "newer",
  );
});

test("event sweep claims valid markers and dead-letters malformed records", async () => {
  const state = store({
    [getEventTelegramProjectionOutboxPath("event-1")]: marker,
    [getEventTelegramProjectionOutboxPath("event-bad")]: {
      status: "pending",
      updatedAtMs: 100,
    },
  });
  const getPath = state.client.getPath;
  state.client.getPath = async (path, query) => {
    if (path === "telegramProjectionOutbox/event") {
      assert.deepEqual(query, {
        orderBy: "updatedAtMs",
        startAt: 0,
        endAt: 200,
        limitToFirst: 100,
      });
      return {
        "event-1": marker,
        "event-bad": { status: "pending", updatedAtMs: 100 },
      };
    }
    return getPath(path, query);
  };
  const batches: TelegramProjectionTask[][] = [];
  const queue = {
    ...TELEGRAM_TEST_ENV.TELEGRAM_PROJECTION_QUEUE,
    sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
      batches.push(
        Array.from(messages).map(({ body }) => body as TelegramProjectionTask),
      );
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  } satisfies Queue<TelegramProjectionTask>;
  assert.equal(
    await sweepEventTelegramProjections(queue, state.client, 200),
    1,
  );
  assert.deepEqual(batches.flat(), [task]);
  assert.deepEqual(
    state.read(getEventTelegramProjectionOutboxPath("event-1")),
    { ...marker, updatedAtMs: 200 },
  );
  assert.deepEqual(
    state.read(getEventTelegramProjectionOutboxPath("event-bad")),
    {
      status: "dead",
      reason: "invalid-record",
      updatedAtMs: null,
      deadAtMs: 200,
    },
  );
});

function reminderProjectionFixture() {
  const messageKey = `event:${task.eventId}:reminder`;
  const messagePath = `telegramMessages/${messageKey}`;
  const outboxPath = getEventTelegramProjectionOutboxPath(task.eventId);
  const projectionPath = `eventTelegramProjections/${task.eventId}`;
  const event = {
    ...scheduledEvent(),
    isSundayMons: true,
    telegramAnnouncements: { invite: false, matches: false, results: false },
    participants: {
      alice: { username: "Alice", joinedAtMs: 1 },
      bob: { username: "Bob", joinedAtMs: 2 },
    },
  };
  const state = store({
    [outboxPath]: marker,
    [`events/${task.eventId}`]: event,
  });
  const messages = store({});
  const telegram = createTelegramRepository({
    getPath: messages.client.getPath,
    transactPath: messages.client.transactPath,
  });
  const receipt: TelegramAnnouncementRecord = {
    kind: "reminder",
    eventId: task.eventId,
    createdAtMs: 100,
    updatedAtMs: 100,
    payloadDigest: "original-payload-digest",
    messageIds: [23001],
    status: "sent",
    payload: {
      chatId: "community-chat",
      text: buildSundayMonsReminder({ eventId: task.eventId }).text,
      parseMode: "HTML",
      silent: false,
    },
  };
  const edits: Record<string, unknown>[] = [];
  const deliveries: string[] = [];
  let nowMs = 200;
  const controls: {
    editResult: TelegramResult;
    failDispatch: boolean;
    readReceipts: number;
  } = {
    editResult: { ok: true, outcome: "edited", httpStatus: 200 },
    failDispatch: false,
    readReceipts: 0,
  };
  const engine = createTelegramDeliveryEngine({
    repository: telegram,
    client: {
      sendTelegramMessage: async () => {
        assert.fail("reminder projection must never send a new message");
      },
      deleteTelegramMessage: async () => {
        assert.fail("reminder projection must never delete a message");
      },
      editTelegramMessage: async (input) => {
        edits.push(input);
        return controls.editResult;
      },
    },
    resolveDestination: () => "community-chat",
    now: () => nowMs,
    localRetryBarrier: createTelegramLocalRetryBarrier(),
    scheduleRetry: async () => ({}),
    logger: { error: () => undefined, info: () => undefined },
  });
  const readMessage = () =>
    messages.read(messagePath) as {
      desired: {
        operation: string;
        ifMissing: string;
        text: string;
        revision: string;
        contentHash: string;
      };
      applied?: {
        messageId: number;
        contentHash: string;
        revision: string;
      };
      delivery: Record<string, unknown>;
    };
  const project = (
    telegramRepository: TelegramRepository = telegram,
    projectionTask = task,
  ) =>
    processEventProjectionTask(
      projectionTask,
      state.client,
      ratingRepository(),
      async (delivery) => {
        if (controls.failDispatch) throw new Error("queue-unavailable");
        deliveries.push(delivery.messageKey);
      },
      () => nowMs,
      telegramRepository,
      {
        chatId: "community-chat",
        repository: {
          async get(requestId) {
            assert.equal(requestId, `event:${task.eventId}:reminder:v1`);
            controls.readReceipts++;
            return receipt;
          },
        },
      },
    );
  return {
    controls,
    deliveries,
    edits,
    event,
    messageKey,
    messagePath,
    messages,
    outboxPath,
    project,
    projectionPath,
    readMessage,
    receipt,
    state,
    telegram,
    deliver: () => {
      nowMs += 2_000;
      return engine.reconcile({ messageKey });
    },
  };
}

test("a confirmed reminder is edited in place and follows joins with invites disabled", async () => {
  const f = reminderProjectionFixture();
  const receipt = structuredClone(f.receipt);
  assert.equal(await f.project(), "projected");
  assert.deepEqual(f.deliveries, [f.messageKey]);
  assert.equal(f.readMessage().desired.operation, "edit");
  assert.equal(f.readMessage().desired.ifMissing, "skip");
  assert.match(f.readMessage().desired.text, /Alice Bob$/);
  assert.equal((await f.deliver()).status, "delivered");
  assert.equal(f.edits[0].messageId, 23001);
  assert.equal(f.readMessage().applied?.messageId, 23001);
  assert.equal(
    f.readMessage().applied?.contentHash,
    f.readMessage().desired.contentHash,
  );

  f.state.write(`events/${task.eventId}`, {
    ...f.event,
    participants: {
      ...f.event.participants,
      carol: { username: "Carol", joinedAtMs: 3 },
    },
  });
  f.state.write(f.outboxPath, marker);
  assert.equal(await f.project(), "projected");
  assert.equal((await f.deliver()).status, "delivered");
  assert.match(String(f.edits[1].text), /Alice Bob Carol$/);
  assert.equal(f.edits[1].messageId, 23001);
  assert.equal(f.controls.readReceipts, 1);
  assert.deepEqual(f.receipt, receipt);
  assert.equal(
    f.messages.read(`telegramMessages/event:${task.eventId}:upcoming`),
    null,
  );
  f.state.write(f.outboxPath, marker);
  assert.equal(await f.project(), "unchanged");
  assert.equal(f.edits.length, 2);
});

test("the projection queue supplies announcement receipts for reminder adoption", async () => {
  const f = reminderProjectionFixture();
  let acknowledged = false;
  await handleTelegramProjectionMessage(
    {
      id: "reminder-projection",
      timestamp: new Date(200),
      body: task,
      attempts: 1,
      ack: () => {
        acknowledged = true;
      },
      retry: () => assert.fail("reminder projection should be acknowledged"),
    },
    { ...TELEGRAM_TEST_ENV, TELEGRAM_EXTRA_CHAT_ID: "community-chat" },
    {
      createStateRepository: () => f.state.client,
      createTelegram: () => f.telegram,
      createRating: ratingRepository,
      createAnnouncements: () => ({ get: async () => f.receipt }),
      readStorageMode: async () => "d1",
      enqueueDelivery: async ({ messageKey }) => {
        f.deliveries.push(messageKey);
      },
      now: () => 200,
      logger: { error: () => undefined, info: () => undefined },
    },
  );
  assert.equal(acknowledged, true);
  assert.deepEqual(f.deliveries, [f.messageKey]);
  assert.equal((await f.deliver()).status, "delivered");
  assert.equal(f.edits[0].messageId, 23001);
  assert.match(String(f.edits[0].text), /Alice Bob$/);
});

test("a reminder recovers after adoption and desired persistence without a queue acknowledgment", async () => {
  const f = reminderProjectionFixture();
  f.controls.failDispatch = true;
  await assert.rejects(f.project(), /queue-unavailable/);
  const pending = structuredClone(f.readMessage());
  assert.equal(pending.applied?.messageId, 23001);
  assert.equal(f.state.read(f.projectionPath), null);
  assert.deepEqual(f.state.read(f.outboxPath), marker);
  f.controls.failDispatch = false;
  assert.equal(await f.project(), "projected");
  assert.equal(f.readMessage().desired.revision, pending.desired.revision);
  assert.equal((await f.deliver()).status, "delivered");
  assert.equal(f.edits.length, 1);
  assert.equal(f.controls.readReceipts, 1);
});

test("a reminder delivery racing the next projection defers and retries its participant text", async () => {
  const f = reminderProjectionFixture();
  await f.project();
  await f.deliver();
  const previousText = f.readMessage().desired.text;
  f.state.write(`events/${task.eventId}`, {
    ...f.event,
    participants: {
      ...f.event.participants,
      carol: { username: "Carol", joinedAtMs: 3 },
    },
  });
  f.state.write(f.outboxPath, marker);
  let race = true;
  const telegram = {
    ...f.telegram,
    async transactMessage(messageKey, updater) {
      if (messageKey === f.messageKey && race) {
        race = false;
        const current = f.readMessage();
        f.messages.write(f.messagePath, {
          ...current,
          applied: { ...current.applied, revision: "concurrent-edit" },
        });
      }
      return f.telegram.transactMessage(messageKey, updater);
    },
  } satisfies TelegramRepository;
  await assert.rejects(f.project(telegram), /event-telegram-delivery-changed/);
  const deferred = f.state.read(f.projectionPath) as {
    reminderText: string;
    lastProjectedSignature: string;
  };
  assert.equal(deferred.reminderText, previousText);
  assert.equal(deferred.lastProjectedSignature, "");
  assert.deepEqual(f.state.read(f.outboxPath), marker);
  assert.equal(await f.project(), "projected");
  assert.equal((await f.deliver()).status, "delivered");
  assert.match(String(f.edits.at(-1)?.text), /Alice Bob Carol$/);
});

test("a deleted reminder is never adopted again or replaced on later joins", async () => {
  const f = reminderProjectionFixture();
  await f.project();
  f.controls.editResult = {
    ok: false,
    classification: "missing",
    code: "message-not-found",
    description: "message to edit not found",
    httpStatus: 400,
    retryAfterSeconds: null,
  };
  await f.deliver();
  assert.equal(f.readMessage().applied, undefined);
  const deleted = structuredClone(f.readMessage());
  f.state.write(`events/${task.eventId}`, {
    ...f.event,
    participants: {
      ...f.event.participants,
      carol: { username: "Carol", joinedAtMs: 3 },
    },
  });
  f.state.write(f.outboxPath, marker);
  await f.project();
  await f.deliver();
  assert.deepEqual(f.readMessage(), deleted);
  assert.equal(f.controls.readReceipts, 1);
  assert.equal(f.edits.length, 1);
});
