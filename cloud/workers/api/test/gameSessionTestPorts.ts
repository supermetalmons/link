import type {
  AutomatchRecordMap,
  AutomatchRecordRoot,
} from "../../../runtime/automatchRecords.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../src/repositoryContracts.ts";
import { validateTelegramTransactionDecision } from "../src/telegramTransaction.ts";
import { publicMatchFixture } from "./matchRecordFixture.ts";
import {
  canonicalAutomatchFixture,
  automatchCommandFixture,
  retainedAutomatchReadFixture,
  retainedAutomatchRecordsFixture,
  retainedAutomatchPageFixture,
} from "./automatchRecordFixture.ts";
import {
  retainedInviteSourceFixture,
  inviteDocumentFixture,
  rematchSeriesFixture,
} from "./inviteDocumentFixture.ts";
import { matchCreationWireValue } from "../src/matchRecordCodec.ts";
import type {
  GameSessionPort,
  GameSessionChange,
  GameSessionRecoveryContext,
  RawGameSessionPort,
} from "../src/gameSessionContracts.ts";
import type { MatchStatePort } from "../src/repositoryContracts.ts";
import type { StateRepository } from "../test/stateRepositoryTestTypes.ts";
import { createTypedGameSessionPort } from "../src/gameSessionRecordAdapter.ts";
import { encodeSessionChanges } from "../src/gameSessionCodec.ts";
import {
  decideAutomatchProfileOutboxCompletion,
  parseAutomatchProfileGameProjectionOutbox,
} from "../src/profileGameProjectionOutbox.ts";
import { parseAutomatchTelegramProjectionOutbox } from "../src/telegramProjectionOutbox.ts";
import { recoveryRecordPageFixture } from "./recoveryScanPageFixture.ts";
import { sessionValueOperationFixture } from "./sessionValueOperationFixture.ts";

export function legacySessionChanges(
  updates: Record<string, unknown>,
): GameSessionChange[] {
  const changes: GameSessionChange[] = [];
  for (const [path, original] of Object.entries(updates)) {
    const value = sessionValueOperationFixture(original);
    const [root, id, field, key, nestedKey] = path.split("/");
    if (root === "gameplayMutationReceiptExpirations") continue;
    if (root === "gameplayMutationReceipts")
      changes.push({
        kind: "mutation-receipt",
        operationId: id,
        value: automatchCommandFixture("gameplayMutationReceipts", value),
        expiration: automatchCommandFixture(
          "gameplayMutationReceiptExpirations",
          updates[`gameplayMutationReceiptExpirations/${id}`] || {},
        ),
      } as GameSessionChange);
    else if (root === "players")
      changes.push({
        kind: "match-create",
        playerId: id,
        matchId: key,
        value: publicMatchFixture(Object(value)),
      } as GameSessionChange);
    else if (root === "invites") {
      if (field === "automatchOperationIds" && key)
        changes.push({
          kind: "invite-operation",
          inviteId: id,
          loginUid: key,
          operationId: value,
        } as GameSessionChange);
      else if (field === "hostRematches" || field === "guestRematches")
        changes.push({
          kind: "invite-rematches",
          inviteId: id,
          role: field === "hostRematches" ? "host" : "guest",
          value: rematchSeriesFixture(value),
        } as GameSessionChange);
      else
        changes.push({
          kind: field ? "invite-fields" : "invite-merge",
          inviteId: id,
          value: field
            ? { [field]: value }
            : inviteDocumentFixture(Object(value)),
        } as GameSessionChange);
    } else if (root === "automatch")
      changes.push({
        kind: "automatch-entry",
        inviteId: id,
        value: automatchCommandFixture("automatch", value),
      } as GameSessionChange);
    else if (root === "telegramAutomatches")
      changes.push({
        kind: field ? "telegram-source-merge" : "telegram-source",
        inviteId: id,
        value: field
          ? { [field]: value }
          : automatchCommandFixture("telegramAutomatches", value),
      } as GameSessionChange);
    else if (root === "telegramProjectionOutbox" && id === "automatch")
      changes.push({
        kind: "telegram-outbox",
        inviteId: field,
        value: automatchCommandFixture(
          "telegramProjectionOutbox/automatch",
          value,
        ),
      } as GameSessionChange);
    else if (
      root === "profileGameProjectionOutbox" &&
      id === "automatch" &&
      key === "historicalMatches" &&
      nestedKey
    )
      changes.push({
        kind: "profile-outbox-merge",
        inviteId: field,
        value: automatchCommandFixture(
          "profileGameProjectionOutbox/automatch",
          {},
        ),
        historicalMatches: {
          [nestedKey]: { retryNotBeforeMs: null, ...Object(value) },
        },
      } as GameSessionChange);
    else if (root === "profileGameProjectionOutbox" && id === "automatch")
      changes.push({
        kind: key ? "profile-outbox-merge" : "profile-outbox",
        inviteId: field,
        value: automatchCommandFixture(
          "profileGameProjectionOutbox/automatch",
          key ? { [key]: value } : value,
        ),
      } as GameSessionChange);
    else throw new Error("game-session-transition-unsupported-effect");
  }
  const grouped: GameSessionChange[] = [];
  for (const change of changes) {
    if (change.kind === "invite-fields") {
      const previous = grouped.find(
        (entry) =>
          entry.kind === "invite-fields" && entry.inviteId === change.inviteId,
      );
      if (previous?.kind === "invite-fields") {
        previous.value = { ...previous.value, ...change.value };
        continue;
      }
    }
    grouped.push(change);
  }
  return grouped;
}

export function matchTestPort(
  state: Pick<StateRepository, "getPath" | "transactPath">,
): MatchStatePort {
  return {
    readMatchRecord: async ({ playerId, matchId }, signal) =>
      (await state.getPath(
        `players/${playerId}/matches/${matchId}`,
        undefined,
        signal,
      )) as Awaited<ReturnType<MatchStatePort["readMatchRecord"]>>,
    async readMatchRecords(inputs, signal) {
      return Promise.all(
        inputs.map((input) => this.readMatchRecord(input, signal)),
      );
    },
    async readMatchPair(input, signal) {
      return {
        ...input,
        epoch: 1,
        revision: 1,
        playerMatch: (await this.readMatchRecord(input, signal)) as
          import("../src/matchStateTypes.ts").MatchStateRecord | null,
        opponentMatch: input.opponentId
          ? ((await this.readMatchRecord(
              { playerId: input.opponentId, matchId: input.matchId },
              signal,
            )) as import("../src/matchStateTypes.ts").MatchStateRecord | null)
          : null,
        claim: null,
      };
    },
    async readMatchPairs(inputs, signal) {
      return Promise.all(
        inputs.map((input) => this.readMatchPair(input, signal)),
      );
    },
    async createMatchRecords(input, signal) {
      for (const record of input.records)
        await state.transactPath(
          `players/${record.playerId}/matches/${record.matchId}`,
          (current) => {
            if (current !== null && current !== undefined) {
              if (
                typeof current === "object" &&
                (current as Record<string, unknown>).sessionCreation ===
                  record.marker
              )
                return { commit: false, decision: "applied" };
              throw new Error(
                "game-session-transition-match-creation-conflict",
              );
            }
            return {
              value: {
                ...Object(matchCreationWireValue(record.value)),
                sessionCreation: record.marker,
              },
              decision: "created",
            };
          },
          signal,
        );
    },
    async applyMatchEventEffects() {
      throw new Error("unexpected-test-match-effects");
    },
  };
}

export function rawGameplayTestPort(
  state: StateRepository,
): RawGameSessionPort & MatchStatePort {
  async function transact<Root extends AutomatchRecordRoot>(
    root: Root,
    id: string,
    update: (
      value: AutomatchRecordMap[Root] | null,
    ) => TransactionDecision<AutomatchRecordMap[Root]>,
    signal?: AbortSignal,
  ): Promise<TransactionResult<AutomatchRecordMap[Root]>> {
    const result = await state.transactPath(
      `${root}/${id}`,
      (value) => update(canonicalAutomatchFixture(root, value)),
      signal,
    );
    return {
      committed: result.committed,
      ...(result.decision === undefined ? {} : { decision: result.decision }),
      value: canonicalAutomatchFixture(root, result.value),
    };
  }
  return {
    ...matchTestPort(state),
    readInviteMetadata: async (id, signal) =>
      retainedInviteSourceFixture(
        (await state.getPath(`invites/${id}`, undefined, signal)) as Record<
          string,
          unknown
        > | null,
      ),
    async readInviteMetadataMany(ids, signal) {
      return Promise.all(ids.map((id) => this.readInviteMetadata(id, signal)));
    },
    readAutomatchEntry: (id, signal) =>
      retainedAutomatchReadFixture(
        "automatch",
        state.getPath(`automatch/${id}`, undefined, signal),
      ),
    listAutomatchEntriesByLogin: async (uid, limit, signal) =>
      retainedAutomatchRecordsFixture(
        "automatch",
        (await state.getPath(
          "automatch",
          { orderBy: "uid", equalTo: uid, limitToFirst: limit },
          signal,
        )) as Record<string, unknown> | null,
      ),
    readFirstAutomatchEntry: async (signal) =>
      retainedAutomatchRecordsFixture(
        "automatch",
        (await state.getPath(
          "automatch",
          { orderBy: "$key", limitToFirst: 1 },
          signal,
        )) as Record<string, unknown> | null,
      ),
    readMutationReceipt: (id, signal) =>
      retainedAutomatchReadFixture(
        "gameplayMutationReceipts",
        state.getPath(`gameplayMutationReceipts/${id}`, undefined, signal),
      ),
    commitSessionChanges: (changes, signal) =>
      state.patchRoot(encodeSessionChanges(changes), signal),
    readAutomatchTelegramSource: (id, signal) =>
      retainedAutomatchReadFixture(
        "telegramAutomatches",
        state.getPath(`telegramAutomatches/${id}`, undefined, signal),
      ),
    transactAutomatchTelegramSource: (id, update, signal) =>
      transact("telegramAutomatches", id, update, signal),
    readAutomatchTelegramOutbox: (id, signal) =>
      retainedAutomatchReadFixture(
        "telegramProjectionOutbox/automatch",
        state.getPath(
          `telegramProjectionOutbox/automatch/${id}`,
          undefined,
          signal,
        ),
      ),
    transactAutomatchTelegramOutbox: (id, update, signal) =>
      transact("telegramProjectionOutbox/automatch", id, update, signal),
    async claimAutomatchTelegramOutbox(
      id,
      requestId,
      expectedUpdatedAtMs,
      nowMs,
      signal,
    ) {
      const result = await state.transactPath(
        `telegramProjectionOutbox/automatch/${id}`,
        (current) => {
          const outbox = parseAutomatchTelegramProjectionOutbox(current);
          if (
            !outbox ||
            outbox.requestId !== requestId ||
            outbox.updatedAtMs !== expectedUpdatedAtMs ||
            outbox.updatedAtMs > nowMs
          ) {
            return { commit: false, decision: "not-due" };
          }
          return {
            value: {
              ...(current as Record<string, unknown>),
              updatedAtMs: nowMs,
            },
            decision: "claimed",
          };
        },
        signal,
      );
      return result.committed;
    },
    async acknowledgeAutomatchTelegramOutbox(id, requestId, signal) {
      const result = await state.transactPath(
        `telegramProjectionOutbox/automatch/${id}`,
        (current) => {
          const record =
            current && typeof current === "object" && !Array.isArray(current)
              ? (current as Record<string, unknown>)
              : null;
          return record?.requestId === requestId
            ? { value: null, decision: "cleared" }
            : { commit: false, decision: "stale" };
        },
        signal,
      );
      return result.committed;
    },
    listDueAutomatchTelegramOutboxes: async (now, limit, signal) =>
      retainedAutomatchRecordsFixture(
        "telegramProjectionOutbox/automatch",
        (await state.getPath(
          "telegramProjectionOutbox/automatch",
          {
            orderBy: "updatedAtMs",
            startAt: 0,
            endAt: now,
            limitToFirst: limit,
          },
          signal,
        )) as Record<string, unknown> | null,
      ),
    listDueAutomatchTelegramOutboxesPage: async (
      now,
      limit,
      excludedIdentities = [],
      signal,
    ) =>
      retainedAutomatchPageFixture(
        "telegramProjectionOutbox/automatch",
        recoveryRecordPageFixture(
          (await state.getPath(
            "telegramProjectionOutbox/automatch",
            {
              orderBy: "updatedAtMs",
              startAt: 0,
              endAt: now,
              limitToFirst: limit + excludedIdentities.length,
            },
            signal,
          )) as Record<string, unknown> | null,
          limit,
          excludedIdentities,
        ),
      ),
    readAutomatchProfileOutbox: (id, signal) =>
      retainedAutomatchReadFixture(
        "profileGameProjectionOutbox/automatch",
        state.getPath(
          `profileGameProjectionOutbox/automatch/${id}`,
          undefined,
          signal,
        ),
      ),
    transactAutomatchProfileOutbox: (id, update, signal) =>
      transact("profileGameProjectionOutbox/automatch", id, update, signal),
    async claimAutomatchProfileOutbox(
      id,
      requestId,
      expectedLastQueuedAtMs,
      nowMs,
      signal,
    ) {
      const result = await state.transactPath(
        `profileGameProjectionOutbox/automatch/${id}`,
        (current) => {
          const outbox = parseAutomatchProfileGameProjectionOutbox(current);
          if (
            !outbox ||
            outbox.requestId !== requestId ||
            outbox.lastQueuedAtMs !== expectedLastQueuedAtMs ||
            outbox.lastQueuedAtMs > nowMs
          ) {
            return { commit: false, decision: "not-due" };
          }
          return {
            value: {
              ...(current as Record<string, unknown>),
              lastQueuedAtMs: nowMs,
            },
            decision: "claimed",
          };
        },
        signal,
      );
      return result.committed;
    },
    async acknowledgeAutomatchProfileOutbox(id, requestId, signal) {
      const result = await state.transactPath(
        `profileGameProjectionOutbox/automatch/${id}`,
        (current) => {
          const outbox = parseAutomatchProfileGameProjectionOutbox(current);
          return outbox?.requestId === requestId
            ? { value: null, decision: "cleared" }
            : { commit: false, decision: "stale" };
        },
        signal,
      );
      return result.committed;
    },
    async finishAutomatchProfileOutbox(id, requestId, nowMs, signal) {
      const result = await state.transactPath(
        `profileGameProjectionOutbox/automatch/${id}`,
        (current) => {
          const decision = decideAutomatchProfileOutboxCompletion(
            current,
            requestId,
            nowMs,
          );
          if (
            decision.status === "continued" ||
            decision.status === "superseded"
          ) {
            return { commit: false, decision: decision.status };
          }
          return {
            value:
              decision.status === "deferred"
                ? {
                    ...(current as Record<string, unknown>),
                    lastQueuedAtMs: nowMs,
                    archiveRetry: decision.archiveRetry,
                  }
                : null,
            decision: decision.status,
          };
        },
        signal,
      );
      if (result.decision === "continued") return "continued";
      if (!result.committed) return "superseded";
      return result.decision === "deferred" ? "deferred" : "projected";
    },
    listDueAutomatchProfileOutboxes: async (now, limit, signal) =>
      retainedAutomatchRecordsFixture(
        "profileGameProjectionOutbox/automatch",
        (await state.getPath(
          "profileGameProjectionOutbox/automatch",
          { orderBy: "lastQueuedAtMs", endAt: now, limitToFirst: limit },
          signal,
        )) as Record<string, unknown> | null,
      ),
    listDueAutomatchProfileOutboxesPage: async (
      now,
      limit,
      excludedIdentities = [],
      signal,
    ) =>
      retainedAutomatchPageFixture(
        "profileGameProjectionOutbox/automatch",
        recoveryRecordPageFixture(
          (await state.getPath(
            "profileGameProjectionOutbox/automatch",
            {
              orderBy: "lastQueuedAtMs",
              endAt: now,
              limitToFirst: limit + excludedIdentities.length,
            },
            signal,
          )) as Record<string, unknown> | null,
          limit,
          excludedIdentities,
        ),
      ),
    listMalformedAutomatchProfileOutboxes: async (limit, signal) =>
      retainedAutomatchRecordsFixture(
        "profileGameProjectionOutbox/automatch",
        (await state.getPath(
          "profileGameProjectionOutbox/automatch",
          { orderBy: "lastQueuedAtMs", startAt: "", limitToFirst: limit },
          signal,
        )) as Record<string, unknown> | null,
      ),
    listMalformedAutomatchProfileOutboxesPage: async (
      limit,
      excludedIdentities = [],
      signal,
    ) =>
      retainedAutomatchPageFixture(
        "profileGameProjectionOutbox/automatch",
        recoveryRecordPageFixture(
          (await state.getPath(
            "profileGameProjectionOutbox/automatch",
            {
              orderBy: "lastQueuedAtMs",
              startAt: "",
              limitToFirst: limit + excludedIdentities.length,
            },
            signal,
          )) as Record<string, unknown> | null,
          limit,
          excludedIdentities,
        ),
      ),
  };
}

export function gameplayTestPort(
  state: StateRepository,
): GameSessionPort & GameSessionRecoveryContext & MatchStatePort {
  const raw = rawGameplayTestPort(state);
  return { ...matchTestPort(state), ...createTypedGameSessionPort(raw) };
}

export function legacySessionClient(port: RawGameSessionPort): StateRepository {
  return {
    async getPath(path, query, signal) {
      const [root, id, field, ...nested] = path.split("/");
      let value: unknown;
      let fields: string[];
      if (root === "automatch" && !id)
        return query?.orderBy === "uid"
          ? port.listAutomatchEntriesByLogin(
              String(query.equalTo),
              query.limitToFirst || 2,
              signal,
            )
          : port.readFirstAutomatchEntry(signal);
      if (!id) throw new Error("retired-source-path");
      if (root === "invites") {
        value = await port.readInviteMetadata(id, signal);
        fields = field ? [field, ...nested] : [];
      } else if (root === "automatch") {
        value = await port.readAutomatchEntry(id, signal);
        fields = field ? [field, ...nested] : [];
      } else if (root === "gameplayMutationReceipts") {
        value = await port.readMutationReceipt(id, signal);
        fields = field ? [field, ...nested] : [];
      } else if (root === "telegramAutomatches") {
        value = await port.readAutomatchTelegramSource(id, signal);
        fields = field ? [field, ...nested] : [];
      } else if (root === "telegramProjectionOutbox" && field) {
        value = await port.readAutomatchTelegramOutbox(field, signal);
        fields = nested;
      } else if (root === "profileGameProjectionOutbox" && field) {
        value = await port.readAutomatchProfileOutbox(field, signal);
        fields = nested;
      } else throw new Error("retired-source-path");
      for (const key of fields)
        value =
          value && typeof value === "object"
            ? ((value as Record<string, unknown>)[key] ?? null)
            : null;
      return value;
    },
    patchRoot: (updates, signal) =>
      port.commitSessionChanges(legacySessionChanges(updates), signal),
    transactPath(path, update, signal) {
      const [root, id, field] = path.split("/");
      function decision<Root extends AutomatchRecordRoot>(
        root: Root,
        current: AutomatchRecordMap[Root] | null,
      ): TransactionDecision<AutomatchRecordMap[Root]> {
        const result = validateTelegramTransactionDecision(update(current));
        return result.commit === false
          ? result
          : {
              value: canonicalAutomatchFixture(root, result.value),
              ...(result.decision === undefined
                ? {}
                : { decision: result.decision }),
            };
      }
      if (root === "telegramAutomatches" && id)
        return port.transactAutomatchTelegramSource(
          id,
          (current) => decision("telegramAutomatches", current),
          signal,
        );
      if (root === "telegramProjectionOutbox" && field)
        return port.transactAutomatchTelegramOutbox(
          field,
          (current) => decision("telegramProjectionOutbox/automatch", current),
          signal,
        );
      if (root === "profileGameProjectionOutbox" && field)
        return port.transactAutomatchProfileOutbox(
          field,
          (current) =>
            decision("profileGameProjectionOutbox/automatch", current),
          signal,
        );
      throw new Error("retired-source-path");
    },
  };
}

export type LegacyGameplayTestMethods = {
  getStatePath: StateRepository["getPath"];
  patchStateRoot: StateRepository["patchRoot"];
  transactStatePath: StateRepository["transactPath"];
};

export function attachGameplayTestPorts<
  T extends LegacyGameplayTestMethods & {
    readInviteMetadata(
      id: string,
      signal?: AbortSignal,
    ): Promise<Record<string, unknown> | null>;
  },
>(
  source: T,
): T & GameSessionPort & GameSessionRecoveryContext & MatchStatePort {
  const port = gameplayTestPort({
    getPath: (path, query, signal) =>
      /^invites\/[^/]+$/.test(path)
        ? source.readInviteMetadata(path.split("/")[1]!, signal)
        : source.getStatePath(path, query, signal),
    patchRoot: (updates, signal) => source.patchStateRoot(updates, signal),
    transactPath: (path, updater, signal) =>
      source.transactStatePath(path, updater, signal),
  });
  const readInviteMetadata = source.readInviteMetadata;
  return Object.assign(source, port, { readInviteMetadata });
}
