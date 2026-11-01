import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runInCanonicalMatchWriterFixture } from "./canonicalMatchTestFixture.ts";
import { matchDocumentFixture } from "../test/matchRecordFixture.ts";
import { readStoredMatchJson } from "../src/matchRecordCodec.ts";

async function fixture(work: (storage: DurableObjectStorage) => void) {
  const room = env.INVITE_REACTIONS.getByName(
    `strict-match-${crypto.randomUUID()}`,
  );
  await runInCanonicalMatchWriterFixture(room, (_instance, state) =>
    work(state.storage),
  );
}

describe("canonical match record storage", () => {
  it.each(
    [null, false, 0, "", [], {}, { fen: "initial" }, { schemaVersion: 2 }].map(
      (value) => [value],
    ),
  )(
    "rejects noncanonical record %j at the SQL and decoder boundaries",
    async (value) => {
      await fixture((storage) => {
        expect(() =>
          storage.sql.exec(
            "INSERT INTO match_state_records_canonical(match_id, player_id, value_json) VALUES ('invite', 'host', ?)",
            JSON.stringify(value),
          ),
        ).toThrow();
        expect(() =>
          readStoredMatchJson({ value_json: JSON.stringify(value) }, "durable"),
        ).toThrow("match-state-invalid-record");
        expect(
          storage.sql
            .exec("SELECT COUNT(*) AS count FROM match_state_records_canonical")
            .one().count,
        ).toBe(0);
      });
    },
  );

  it("preserves complete known fields and rejects unknown fields on reads", async () => {
    await fixture((storage) => {
      const document = matchDocumentFixture({
        color: "white",
        fen: "position",
        status: "surrendered",
        timer: "7;2000",
        sessionCreation: "creation",
        reaction: {
          uuid: "11111111-1111-4111-8111-111111111111",
          kind: "gg",
          variation: 1,
        },
      });
      storage.sql.exec(
        "INSERT INTO match_state_records_canonical(match_id, player_id, value_json) VALUES ('invite', 'host', ?)",
        JSON.stringify(document),
      );
      const row = storage.sql
        .exec<{ value_json: string }>(
          "SELECT value_json FROM match_state_records_canonical",
        )
        .one();
      expect(readStoredMatchJson(row, "durable")).toEqual({
        kind: "stored",
        source: "durable",
        value: document,
      });
      expect(() =>
        readStoredMatchJson(
          {
            value_json: JSON.stringify({
              ...document,
              unknownBusinessField: true,
            }),
          },
          "durable",
        ),
      ).toThrow("match-state-invalid-record");
    });
  });
});
