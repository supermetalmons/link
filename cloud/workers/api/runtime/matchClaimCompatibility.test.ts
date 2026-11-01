import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runInCanonicalMatchWriterFixture } from "./canonicalMatchTestFixture.ts";
import { readStoredTimerClaim } from "../src/matchClaimCodec.ts";
import { timerClaimFixture } from "../test/matchClaimFixture.ts";

async function fixture(work: (storage: DurableObjectStorage) => void) {
  const room = env.INVITE_REACTIONS.getByName(
    `strict-claim-${crypto.randomUUID()}`,
  );
  await runInCanonicalMatchWriterFixture(room, (_instance, state) =>
    work(state.storage),
  );
}

describe("canonical timer claim storage", () => {
  it.each(
    [
      null,
      false,
      0,
      "",
      [],
      {},
      { status: "claimed" },
      { status: "pending", expiresAtMs: "1000" },
    ].map((value) => [value]),
  )("rejects noncanonical claim %j before persistence", async (value) => {
    await fixture((storage) => {
      const encoded = JSON.stringify(value);
      expect(() =>
        storage.sql.exec(
          "INSERT INTO match_state_claims_canonical(match_id, value_json) VALUES ('invite', ?)",
          encoded,
        ),
      ).toThrow();
      expect(() => readStoredTimerClaim(encoded)).toThrow(
        "match-state-invalid-claim",
      );
      expect(
        storage.sql
          .exec("SELECT COUNT(*) AS count FROM match_state_claims_canonical")
          .one().count,
      ).toBe(0);
    });
  });

  it.each(["pending", "claimed"] as const)(
    "preserves complete %s claims and their absolute timestamps",
    async (status) => {
      await fixture((storage) => {
        const claim = timerClaimFixture({
          status,
          inviteId: "invite",
          playerId: "host",
          opponentId: "guest",
          timer: "7;1000",
          turnNumber: 7,
          claimedAtMs: status === "claimed" ? 1001 : null,
          expiresAtMs: status === "pending" ? 1200 : null,
        });
        storage.sql.exec(
          "INSERT INTO match_state_claims_canonical(match_id, value_json) VALUES ('invite', ?)",
          JSON.stringify(claim),
        );
        const stored = storage.sql
          .exec<{ value_json: string }>(
            "SELECT value_json FROM match_state_claims_canonical",
          )
          .one();
        expect(readStoredTimerClaim(stored.value_json)).toEqual(claim);
        expect(() =>
          readStoredTimerClaim(JSON.stringify({ ...claim, turnNumber: 8 })),
        ).toThrow("match-state-invalid-claim");
        expect(() =>
          readStoredTimerClaim(JSON.stringify({ ...claim, extra: true })),
        ).toThrow("match-state-invalid-claim");
      });
    },
  );
});
