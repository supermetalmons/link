import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import {
  acquireEventWriteAdmission,
  releaseEventWriteAdmission,
  commitEventMutations,
  readEvent,
  readEventSnapshot,
} from "../src/eventD1.ts";

const eventDb = env.EVENT_DB;
const migrationEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };

describe("canonical event generation", () => {
  beforeAll(() =>
    applyEventTestMigrations(eventDb, migrationEnv.TEST_EVENT_D1_MIGRATIONS),
  );
  beforeEach(async () => {
    await eventDb.batch([
      eventDb.prepare("DELETE FROM event_records_canonical"),
      eventDb.prepare("DELETE FROM event_write_admissions"),
    ]);
  });

  it("writes only canonical records and preserves explicit nullable fields on patches", async () => {
    const event = eventDocumentFixture({ eventId: "canonical-event" });
    const admission = await acquireEventWriteAdmission(eventDb);
    try {
      await commitEventMutations(
        eventDb,
        [{ kind: "event", eventId: event.eventId, value: event }],
        { admission },
      );
      await commitEventMutations(
        eventDb,
        [
          {
            kind: "event-field",
            eventId: event.eventId,
            field: "winnerProfileId",
            value: null,
          },
        ],
        { admission },
      );
    } finally {
      await releaseEventWriteAdmission(eventDb, admission);
    }
    const snapshot = await readEventSnapshot(eventDb, event.eventId);
    expect(snapshot.revision).toBe(2);
    expect(snapshot.event).toEqual(event);
    expect(Object.hasOwn(snapshot.event!, "winnerProfileId")).toBe(true);
    expect(
      await eventDb
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'event_records'",
        )
        .first("count"),
    ).toBe(0);
  });

  it("rejects nested malformed persisted JSON instead of normalizing a read", async () => {
    const event = eventDocumentFixture({
      eventId: "invalid-nested-event",
      participants: {
        participant: {
          profileId: "participant",
          loginUid: "participant-login",
        },
      },
    });
    const admission = await acquireEventWriteAdmission(eventDb);
    try {
      await commitEventMutations(
        eventDb,
        [{ kind: "event", eventId: event.eventId, value: event }],
        { admission },
      );
    } finally {
      await releaseEventWriteAdmission(eventDb, admission);
    }
    await eventDb
      .prepare(
        "UPDATE event_records_canonical SET record_json = json_set(record_json, '$.participants.participant.emojiId', '1') WHERE event_id = ?",
      )
      .bind(event.eventId)
      .run();
    await expect(readEvent(eventDb, event.eventId)).rejects.toThrow(
      "invalid-event-record",
    );
  });
});
