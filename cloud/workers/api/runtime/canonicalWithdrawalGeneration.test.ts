import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createD1EventPrizeWithdrawalStorage } from "../src/eventPrizeWithdrawalD1.ts";
import {
  buildEventPrizeWithdrawalOperationId,
  parseEventPrizeWithdrawalWorkflowParams,
  withdrawalWorkflowInstanceId,
} from "../src/eventPrizeWithdrawal/contracts.ts";
import {
  writeProcessingWithdrawal,
  writeSubmittedWithdrawal,
} from "../../../runtime/eventPrizes/records.js";
import { buildWithdrawalCompletion } from "../../../runtime/eventPrizeWithdrawalState.js";
import {
  LEGACY_CORE_PRIZES_EVENT_ID,
  getEventPrizeDefinitions,
} from "../../../runtime/shared/event-prizes.js";
const testEnv = env as Env & {
  TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS: D1Migration[];
};
const db = testEnv.EVENT_PRIZE_WITHDRAWALS_DB;
const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
const prize = getEventPrizeDefinitions(eventId)[0]!;
const address = "11111111111111111111111111111111";
const claim = {
  eventId,
  prizeId: prize.id,
  assetAddress: prize.assetAddress,
  assetStandard: prize.standard,
  profileId: "profile",
  entitledProfileId: "profile",
  requesterUid: "actor",
  place: 1 as const,
  recipientAddress: address,
  leaseId: "lease",
  leaseExpiresAtMs: 1000,
  startedAtMs: 10,
  updatedAtMs: 10,
};
describe("canonical withdrawal generation", () => {
  beforeAll(async () => {
    await applyCanonicalTestMigrations(
      db,
      testEnv.TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS,
    );
    await db
      .prepare(
        "UPDATE event_prize_withdrawal_runtime_control SET storage_mode='d1',previous_storage_mode=NULL WHERE singleton=1",
      )
      .run();
  });
  it("stores typed lifecycle changes and immutable completion proof in the canonical table", async () => {
    const storage = createD1EventPrizeWithdrawalStorage(db);
    const record = storage.record(eventId, prize.id);
    await record.transaction(() => ({
      value: writeProcessingWithdrawal(claim),
      decision: "claim",
    }));
    const submitted = writeSubmittedWithdrawal(
      writeProcessingWithdrawal(claim),
      {
        transactionSignature: "signature",
        signedTransactionBase64: "AQID",
        blockhash: address,
        lastValidBlockHeight: 500,
      },
      20,
      20,
    );
    await record.transaction(() => ({
      value: submitted,
      decision: "submitted",
    }));
    const completed = buildWithdrawalCompletion({
      withdrawal: submitted,
      profileId: "profile",
      eventId,
      prizeId: prize.id,
      assetAddress: prize.assetAddress,
      recipientAddress: address,
      transactionSignature: "signature",
      completedAtMs: 30,
    });
    await record.transaction(() => ({
      value: completed,
      decision: "completed",
    }));
    expect(await storage.get(eventId, prize.id)).toMatchObject({
      status: "completed",
      signedTransactionBase64: "AQID",
      transactionSignature: "signature",
      leaseId: null,
    });
    await expect(
      record.transaction(() => ({
        value: { ...completed, transactionSignature: "different" },
        decision: "overwrite",
      })),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT count(*) count FROM sqlite_schema WHERE type = 'table' AND name = 'event_prize_withdrawals'",
        )
        .first(),
    ).toEqual({ count: 0 });
  });
  it("rejects unknown documents before storage", async () => {
    const storage = createD1EventPrizeWithdrawalStorage(db);
    await expect(
      storage.record("invalid", "invalid").transaction(() => ({
        value: JSON.parse('{"status":"processing"}'),
        decision: "invalid",
      })),
    ).rejects.toThrow();
  });
  it("uses canonical epoch workflow IDs while preserving public operation identity", async () => {
    const operationId = await buildEventPrizeWithdrawalOperationId(
      eventId,
      prize.id,
    );
    const params = {
      schemaVersion: 2,
      dataEpoch: 1,
      kind: "withdrawal",
      eventId,
      prizeId: prize.id,
      operationId,
      profileId: "profile",
      recipientAddress: address,
      requesterUid: "actor",
    };
    expect(withdrawalWorkflowInstanceId(operationId)).toBe(
      `data1_${operationId}`,
    );
    expect(
      await parseEventPrizeWithdrawalWorkflowParams(
        params,
        withdrawalWorkflowInstanceId(operationId),
      ),
    ).toEqual(params);
    expect(
      await parseEventPrizeWithdrawalWorkflowParams(params, operationId),
    ).toBeNull();
    expect(
      await parseEventPrizeWithdrawalWorkflowParams(
        { ...params, dataEpoch: 0 },
        withdrawalWorkflowInstanceId(operationId),
      ),
    ).toBeNull();
  });
});
