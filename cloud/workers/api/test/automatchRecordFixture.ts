import {
  decodeSnapshot,
  parseAutomatchValue,
  createAutomatchMutation,
} from "../src/automatchD1/codec.ts";
import type {
  AutomatchRoot,
  AutomatchRecordValue,
  AutomatchRecordSnapshot,
  AutomatchRecordMutation,
  AutomatchOutboxRoot,
  AutomatchOutboxRecoveryPage,
} from "../src/automatchD1/types.ts";
import type { RecoveryScanPage } from "../src/recoveryScanPage.ts";
import { sessionValueOperationFixture } from "./sessionValueOperationFixture.ts";

function fields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid-automatch-fixture");
  return Object.fromEntries(Object.entries(value));
}
export function canonicalAutomatchFixture<Root extends AutomatchRoot>(
  root: Root,
  value: unknown,
): AutomatchRecordValue<Root> {
  if (value === null || value === undefined) return null;
  const row = fields(value);
  let canonical: unknown;
  if (root === "automatch")
    canonical = {
      uid: "host",
      timestamp: 1,
      rating: 1500,
      hostColor: "white",
      password: "fixture-password",
      gameVariant: "Classic",
      telegramDeliveryVersion: null,
      username: "",
      ethAddress: "",
      solAddress: "",
      emojiId: 1,
      ...row,
      profileId: row.profileId === "" ? null : (row.profileId ?? null),
      schemaVersion: 1,
    };
  else if (root === "telegramAutomatches")
    canonical = {
      version: 2,
      generation: 1,
      lifecycle: "pending",
      waitingText: "Waiting",
      canceledText: "Cancelled",
      waitingInstanceKey: "waiting:fixture",
      matchedText: row.lifecycle === "matched" ? "Matched" : null,
      matchedInstanceKey:
        row.lifecycle === "matched" ? "matched:fixture" : null,
      createdAtMs: 1,
      updatedAtMs: 1,
      results: {},
      ...row,
      schemaVersion: 1,
    };
  else if (root === "telegramProjectionOutbox/automatch")
    canonical =
      row.status === "dead"
        ? {
            status: "dead",
            requestId: "fixture",
            updatedAtMs: null,
            deadAtMs: 1,
            reason: "fixture",
            ...row,
            schemaVersion: 2,
          }
        : {
            status: "pending",
            requestId: "fixture",
            updatedAtMs: 1,
            ...row,
            schemaVersion: 2,
          };
  else if (root === "profileGameProjectionOutbox/automatch")
    canonical = {
      status: "pending",
      requestId: "fixture",
      reason: "automatch-queue",
      sourceUpdatedAtMs: 1,
      lastQueuedAtMs: 1,
      archiveRetry: null,
      ...row,
      schemaVersion: 2,
      historicalMatches: Object.fromEntries(
        Object.entries(
          row.historicalMatches === undefined
            ? {}
            : fields(row.historicalMatches),
        ).map(([id, value]) => [
          id,
          {
            finalizedAtMs: 1,
            hostPlayerId: "host",
            guestPlayerId: "guest",
            source: "transition",
            retryNotBeforeMs: null,
            ...fields(value),
          },
        ]),
      ),
    };
  else if (root === "gameplayMutationReceiptExpirations")
    canonical = { completedAtMs: 1, ...row, schemaVersion: 1 };
  else {
    const inviteId = row.inviteId ?? "fixture";
    const requesterUid = row.requesterUid ?? "host";
    const response = row.response === undefined ? {} : fields(row.response);
    const kind = row.kind ?? "invite-create";
    canonical =
      kind === "automatch-start"
        ? {
            completedAtMs: 1,
            emojiId: 1,
            inviteId,
            operationId: "fixture",
            requesterUid,
            telegramProjection: false,
            ...row,
            schemaVersion: 2,
            effects: row.effects ?? { state: "enabled" },
            aura: row.aura === "" ? "none" : (row.aura ?? "none"),
            profileProjectionRequestId: row.profileProjectionRequestId ?? null,
            response: {
              ok: true,
              inviteId,
              mode: "pending",
              matchedImmediately: false,
              ...response,
            },
          }
        : {
            completedAtMs: 1,
            fingerprint: "fixture",
            inviteId,
            operationId: "fixture",
            requesterUid,
            projectionRequestId: null,
            ...row,
            kind,
            schemaVersion: 2,
            effects: row.effects ?? { state: "enabled" },
            response:
              kind === "invite-create"
                ? {
                    ok: true,
                    inviteId,
                    hostId: requesterUid,
                    matchId: inviteId,
                    ...response,
                  }
                : response,
          };
  }
  return parseAutomatchValue(root, canonical);
}

export function automatchValueFixture<Root extends AutomatchRoot>(
  root: Root,
  value: unknown,
): AutomatchRecordValue<Root> {
  const canonical = canonicalAutomatchFixture(root, value);
  return decodeSnapshot(root, {
    record_key: "fixture",
    payload_json: canonical === null ? null : JSON.stringify(canonical),
    revision: canonical === null ? 0 : 1,
  }).value;
}
export function retainedAutomatchValueFixture<Root extends AutomatchRoot>(
  root: Root,
  value: unknown,
): AutomatchRecordValue<Root> {
  return canonicalAutomatchFixture(root, value);
}
export async function retainedAutomatchReadFixture<Root extends AutomatchRoot>(
  root: Root,
  value: Promise<unknown>,
): Promise<AutomatchRecordValue<Root>> {
  return canonicalAutomatchFixture(root, await value);
}
export function retainedAutomatchRecordsFixture<Root extends AutomatchRoot>(
  root: Root,
  value: unknown,
): Record<string, AutomatchRecordValue<Root>> | null {
  if (value === null || value === undefined) return null;
  return Object.fromEntries(
    Object.entries(fields(value)).map(([key, record]) => [
      key,
      canonicalAutomatchFixture(root, record),
    ]),
  );
}
export function retainedAutomatchPageFixture<Root extends AutomatchOutboxRoot>(
  root: Root,
  page: RecoveryScanPage<unknown>,
): AutomatchOutboxRecoveryPage<Root> {
  return {
    ...page,
    entries: retainedAutomatchRecordsFixture(root, page.entries),
  } as AutomatchOutboxRecoveryPage<Root>;
}
export function retainedAutomatchSnapshotFixture<Root extends AutomatchRoot>(
  root: Root,
  key: string,
  value: unknown,
  revision: number,
): AutomatchRecordSnapshot<Root> {
  return {
    root,
    key,
    value: canonicalAutomatchFixture(root, value),
    revision,
  } as AutomatchRecordSnapshot<Root>;
}
export function retainedAutomatchMutationFixture(
  current: AutomatchRecordSnapshot,
  value: unknown,
): AutomatchRecordMutation {
  return createAutomatchMutation(
    current,
    canonicalAutomatchFixture(current.root, value),
  );
}
export function retainedAutomatchClaimFixture<Root extends AutomatchOutboxRoot>(
  root: Root,
  value: unknown,
): AutomatchRecordSnapshot<Root> {
  const row = fields(value);
  return retainedAutomatchSnapshotFixture(
    root,
    String(row.key),
    row.value,
    Number(row.revision),
  );
}
export function retainedAutomatchPageReaderFixture<
  Root extends AutomatchOutboxRoot,
  Arguments extends unknown[],
>(
  root: Root,
  read: (...args: Arguments) => Promise<RecoveryScanPage<unknown>>,
): (...args: Arguments) => Promise<AutomatchOutboxRecoveryPage<Root>> {
  return async (...args) =>
    retainedAutomatchPageFixture(root, await read(...args));
}

export function automatchCommandFixture<Root extends AutomatchRoot>(
  root: Root,
  value: unknown,
): unknown {
  function resolve(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(resolve);
    if (input === null || typeof input !== "object") return input;
    const row = fields(input);
    if (row.kind === "timestamp" || row.kind === "increment") return 1;
    return Object.fromEntries(
      Object.entries(row).map(([key, child]) => [key, resolve(child)]),
    );
  }
  function restore(canonical: unknown, input: unknown): unknown {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      return canonical;
    const row = fields(input);
    if (row.kind === "timestamp" || row.kind === "increment") return input;
    if (
      canonical === null ||
      typeof canonical !== "object" ||
      Array.isArray(canonical)
    )
      return canonical;
    return Object.fromEntries(
      Object.entries(fields(canonical)).map(([key, child]) => [
        key,
        restore(child, row[key]),
      ]),
    );
  }
  const command = sessionValueOperationFixture(value);
  return restore(canonicalAutomatchFixture(root, resolve(command)), command);
}
