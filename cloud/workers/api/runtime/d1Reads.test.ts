import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { readD1FirstRow } from "../src/d1Reads.ts";
import {
  collectD1Telemetry,
  type D1TelemetrySummary,
} from "../src/d1Telemetry.ts";

const db = env.PROFILE_DB;
const query = "SELECT value FROM d1_reads_test_records WHERE id = ?";

beforeAll(async () => {
  await db.batch([
    db.prepare(
      "CREATE TABLE d1_reads_test_records (id TEXT PRIMARY KEY, value TEXT)",
    ),
    db.prepare(
      "INSERT INTO d1_reads_test_records VALUES ('present', 'stored-value'), ('nullable', NULL)",
    ),
  ]);
});

describe("D1 single-row reads", () => {
  it("matches native first for present, nullable, and missing point reads", async () => {
    for (const id of ["present", "nullable", "missing"]) {
      const statement = db.withSession("first-primary").prepare(query).bind(id);
      expect(await readD1FirstRow(statement)).toEqual(await statement.first());
    }
  });

  it("collects real metadata for successful point reads, including no rows", async () => {
    let summary: D1TelemetrySummary | undefined;
    await collectD1Telemetry(
      env,
      async (measured) => {
        const session = measured.PROFILE_DB.withSession("first-primary");
        expect(
          await readD1FirstRow(session.prepare(query).bind("present")),
        ).toEqual({ value: "stored-value" });
        expect(
          await readD1FirstRow(session.prepare(query).bind("missing")),
        ).toBeNull();
      },
      {
        onComplete: (value) => {
          summary = value;
        },
      },
    );
    expect(summary?.d1).toMatchObject({
      calls: 2,
      failedCalls: 0,
      metadataResults: 2,
      callsWithoutMetadata: 0,
      rowsWritten: 0,
    });
    expect(summary?.d1.rowsRead).toBeTypeOf("number");
    expect(summary?.d1.sqlDurationMs).toBeTypeOf("number");
    expect(summary?.databases.PROFILE_DB).toEqual(summary?.d1);
  });

  it("rejects invalid SQL through the native D1 error path", async () => {
    await expect(
      readD1FirstRow(
        db
          .prepare("SELECT nonexistent FROM d1_reads_test_records WHERE id = ?")
          .bind("present"),
      ),
    ).rejects.toThrow("D1_ERROR");
  });
});
