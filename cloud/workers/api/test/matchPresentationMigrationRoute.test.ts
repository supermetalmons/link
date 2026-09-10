import assert from "node:assert/strict";
import test from "node:test";
import {
  createMatchPresentationMigrationSignature,
  verifyMatchPresentationMigrationSignature,
} from "../src/matchPresentationMigrationAuth.ts";
import {
  handleMatchPresentationMigrationRoute,
  parseMatchPresentationMigrationRequest,
  type MatchPresentationMigrationRequest,
} from "../src/matchPresentationMigrationRoute.ts";
import {
  matchPresentationSeedDigest,
  type MatchPresentationControl,
} from "../src/matchPresentationRegistry.ts";
import { createTelegramBridgeSignature } from "../src/telegramBridgeAuth.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const now = 1_800_000_000_000;
const timestamp = String(now / 1_000);
const secret = TELEGRAM_TEST_ENV.MATCH_PRESENTATION_MIGRATION_SECRET;
const migrationId = "00000000-0000-4000-8000-000000000002";
const sourceDigest = "a".repeat(64);

function control(
  phase: MatchPresentationControl["phase"] = "capture",
): MatchPresentationControl {
  return {
    phase,
    candidateVersionId: "00000000-0000-4000-8000-000000000001",
    migrationId,
    captureStartedAtMs: 1,
    sourceDigest,
    sourceCount: 1,
    verificationDigest: null,
    verifiedAtMs: null,
    activatedAtMs: null,
  };
}

async function input(): Promise<MatchPresentationMigrationRequest> {
  const seed = {
    inviteId: "migration-invite",
    matchId: "migration-invite",
    actorUid: "host",
    emojiId: 1,
    aura: "",
  };
  return {
    schemaVersion: 1,
    operation: "import",
    migrationId,
    sourceDigest,
    rows: [{ ...seed, seedDigest: await matchPresentationSeedDigest(seed) }],
  };
}

async function request(
  body: string,
  signedBody = body,
  time = timestamp,
): Promise<Request> {
  return new Request(
    "https://api.mons.link/internal/match-presentations/migration",
    {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-Mons-Migration-Timestamp": time,
        "X-Mons-Migration-Signature":
          await createMatchPresentationMigrationSignature(
            signedBody,
            secret,
            time,
          ),
      },
    },
  );
}

test("migration signatures bind purpose, exact bytes, secret, and time", async () => {
  const body = JSON.stringify(await input());
  const signature = await createMatchPresentationMigrationSignature(
    body,
    secret,
    timestamp,
  );
  assert.equal(
    await verifyMatchPresentationMigrationSignature(
      body,
      secret,
      timestamp,
      signature,
      now,
    ),
    true,
  );
  assert.equal(
    await verifyMatchPresentationMigrationSignature(
      `${body} `,
      secret,
      timestamp,
      signature,
      now,
    ),
    false,
  );
  assert.equal(
    await verifyMatchPresentationMigrationSignature(
      body,
      `${secret}x`,
      timestamp,
      signature,
      now,
    ),
    false,
  );
  assert.equal(
    await verifyMatchPresentationMigrationSignature(
      body,
      secret,
      timestamp,
      signature,
      now + 301_000,
    ),
    false,
  );
  assert.equal(
    await verifyMatchPresentationMigrationSignature(
      body,
      secret,
      timestamp,
      await createTelegramBridgeSignature(body, secret, timestamp),
      now,
    ),
    false,
  );
});

test("authenticated import/readback passes only verified rows to execution", async () => {
  for (const operation of ["import", "readback"] as const) {
    const value = { ...(await input()), operation };
    let calls = 0;
    const result = await handleMatchPresentationMigrationRoute(
      await request(JSON.stringify(value)),
      TELEGRAM_TEST_ENV,
      {
        now: () => now,
        readControl: async () => control(),
        execute: async (parsed) => {
          calls++;
          assert.deepEqual(parsed, value);
          return [];
        },
      },
    );
    assert.equal(result.status, 200);
    assert.equal(calls, 1);
    assert.equal(result.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(result.headers.get("Cache-Control"), "no-store");
  }
});

test("tampered or expired requests cannot read control or touch storage", async () => {
  const body = JSON.stringify(await input());
  for (const value of [
    await request(`${body} `, body),
    await request(body, body, String(now / 1_000 - 301)),
  ]) {
    const response = await handleMatchPresentationMigrationRoute(
      value,
      TELEGRAM_TEST_ENV,
      {
        now: () => now,
        readControl: async () => {
          assert.fail("unauthenticated request read control");
        },
        execute: async () => {
          assert.fail("unauthenticated request executed");
        },
      },
    );
    assert.equal(response.status, 401);
  }
});

test("migration is unavailable without its own secret and retires after activation", async () => {
  const body = JSON.stringify(await input());
  assert.equal(
    (
      await handleMatchPresentationMigrationRoute(await request(body), {
        ...TELEGRAM_TEST_ENV,
        MATCH_PRESENTATION_MIGRATION_SECRET: "",
      })
    ).status,
    404,
  );
  for (const [state, expected] of [
    [control("legacy"), 409],
    [control("durable"), 410],
    [{ ...control(), migrationId: "another-run" }, 409],
    [{ ...control(), sourceDigest: "b".repeat(64) }, 409],
  ] as const) {
    const result = await handleMatchPresentationMigrationRoute(
      await request(body),
      TELEGRAM_TEST_ENV,
      {
        now: () => now,
        readControl: async () => state,
        execute: async () => {
          assert.fail("inactive or mismatched migration executed");
        },
      },
    );
    assert.equal(result.status, expected);
  }
});

test("migration parser rejects fabricated defaults, duplicate actors, and mismatched digests", async () => {
  const value = await input();
  const invalid = [
    { ...value, arbitrary: true },
    { ...value, rows: [] },
    { ...value, rows: [value.rows[0], value.rows[0]] },
    { ...value, rows: [{ ...value.rows[0], emojiId: 2 }] },
    { ...value, rows: [{ ...value.rows[0], aura: undefined }] },
    { ...value, rows: [{ ...value.rows[0], sourceId: "unexpected" }] },
    { ...value, rows: Array.from({ length: 101 }, () => value.rows[0]) },
  ];
  for (const malformed of invalid)
    await assert.rejects(
      parseMatchPresentationMigrationRequest(JSON.stringify(malformed)),
    );
});

test("oversized input and storage failures return bounded errors", async () => {
  const oversized = await handleMatchPresentationMigrationRoute(
    await request(" ".repeat(256 * 1024 + 1)),
    TELEGRAM_TEST_ENV,
    { now: () => now },
  );
  assert.equal(oversized.status, 400);
  const result = await handleMatchPresentationMigrationRoute(
    await request(JSON.stringify(await input())),
    TELEGRAM_TEST_ENV,
    {
      now: () => now,
      readControl: async () => control(),
      execute: async () => {
        throw new Error("private source data");
      },
    },
  );
  assert.equal(result.status, 503);
  assert.equal((await result.text()).includes("private source data"), false);
});
