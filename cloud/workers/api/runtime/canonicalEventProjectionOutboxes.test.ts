import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  acquireEventWriteAdmission,
  commitEventMutations,
  releaseEventWriteAdmission,
  readEventProfileGameProjectionOutbox,
  readEventTelegramProjectionOutbox,
} from "../src/eventD1.ts";
import { retainEventProjectionOutbox } from "../../../runtime/eventProjectionOutboxRecords.js";
import type { EventMutation } from "../../../runtime/eventCommands.js";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

beforeAll(() =>
  applyEventTestMigrations(
    env.EVENT_DB,
    (env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] })
      .TEST_EVENT_D1_MIGRATIONS,
  ),
);
describe("canonical event projection outboxes", () => {
  it.each(["profile-game", "telegram"] as const)(
    "persists only complete %s state and retains typed dead evidence",
    async (kind) => {
      const eventId = `projection-${crypto.randomUUID()}`;
      const table =
        kind === "profile-game"
          ? "event_profile_game_projection_outboxes_canonical"
          : "event_telegram_projection_outboxes_canonical";
      const pending =
        kind === "profile-game"
          ? {
              schemaVersion: 1,
              status: "pending",
              requestId: "request",
              lastQueuedAtMs: 100,
              cleanupOwnerProfileIds: { owner: true },
            }
          : {
              schemaVersion: 1,
              status: "pending",
              requestId: "request",
              firstQueuedAtMs: 50,
              updatedAtMs: 100,
            };
      const command = (value: unknown): EventMutation =>
        kind === "profile-game"
          ? {
              kind: "profile-game-outbox",
              eventId,
              value: retainEventProjectionOutbox("profile-game", value),
            }
          : {
              kind: "telegram-outbox",
              eventId,
              value: retainEventProjectionOutbox("telegram", value),
            };
      const admission = await acquireEventWriteAdmission(env.EVENT_DB);
      try {
        await commitEventMutations(
          env.EVENT_DB,
          [
            {
              kind: "event",
              eventId,
              value: eventDocumentFixture({ eventId }),
            },
            command(pending),
          ],
          { admission },
        );
        expect(
          await (kind === "profile-game"
            ? readEventProfileGameProjectionOutbox(env.EVENT_DB, eventId)
            : readEventTelegramProjectionOutbox(env.EVENT_DB, eventId)),
        ).toEqual(pending);
        await env.EVENT_DB.prepare(`DELETE FROM ${table} WHERE event_id = ?`)
          .bind(eventId)
          .run();
        const insert = (value: unknown) =>
          kind === "profile-game"
            ? env.EVENT_DB.prepare(
                `INSERT INTO ${table}(event_id, request_id, status, last_queued_at_ms, record_json) VALUES (?, 'request', 'pending', 100, ?)`,
              )
                .bind(eventId, JSON.stringify(value))
                .run()
            : env.EVENT_DB.prepare(
                `INSERT INTO ${table}(event_id, request_id, status, first_queued_at_ms, updated_at_ms, record_json) VALUES (?, 'request', 'pending', 50, 100, ?)`,
              )
                .bind(eventId, JSON.stringify(value))
                .run();
        for (const invalid of [
          {},
          { ...pending, future: true },
          { ...pending, schemaVersion: 9 },
        ])
          await expect(insert(invalid)).rejects.toThrow();
        const dead = {
          schemaVersion: 2,
          status: "dead",
          requestId: "request",
          reason: "invalid-record",
          deadAtMs: 200,
          sourceDigest: "a".repeat(64),
          originalRecord: pending,
        };
        await commitEventMutations(env.EVENT_DB, [command(dead)], {
          admission,
        });
        const stored = await env.EVENT_DB.prepare(
          `SELECT status, record_json FROM ${table} WHERE event_id = ?`,
        )
          .bind(eventId)
          .first<{ status: string; record_json: string }>();
        expect(stored?.status).toBe("dead");
        expect(
          retainEventProjectionOutbox(kind, JSON.parse(stored!.record_json)),
        ).toEqual(dead);
        expect(
          await (kind === "profile-game"
            ? readEventProfileGameProjectionOutbox(env.EVENT_DB, eventId)
            : readEventTelegramProjectionOutbox(env.EVENT_DB, eventId)),
        ).toBeNull();
        await expect(
          env.EVENT_DB.prepare(
            `UPDATE ${table} SET record_json = json_set(record_json, '$.originalRecord.extra', 1) WHERE event_id = ?`,
          )
            .bind(eventId)
            .run(),
        ).rejects.toThrow("invalid-canonical-event-projection-original");
      } finally {
        await releaseEventWriteAdmission(env.EVENT_DB, admission);
      }
    },
  );
});
