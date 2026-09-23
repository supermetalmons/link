import type {
  GameSessionPort,
  GameSessionChange,
} from "../src/gameSessionContracts.ts";
import type { MatchStatePort } from "../src/repositoryContracts.ts";
import type { StateRepository } from "../test/stateRepositoryTestTypes.ts";
import { encodeSessionChanges } from "../src/gameSessionCodec.ts";

export function legacySessionChanges(
  updates: Record<string, unknown>,
): GameSessionChange[] {
  const changes: GameSessionChange[] = [];
  for (const [path, value] of Object.entries(updates)) {
    const [root, id, field, key] = path.split("/");
    if (root === "gameplayMutationReceiptExpirations") continue;
    if (root === "gameplayMutationReceipts")
      changes.push({
        kind: "mutation-receipt",
        operationId: id,
        value,
        expiration: updates[`gameplayMutationReceiptExpirations/${id}`] || {},
      } as GameSessionChange);
    else if (root === "players")
      changes.push({
        kind: "match-create",
        playerId: id,
        matchId: key,
        value,
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
          value,
        } as GameSessionChange);
      else
        changes.push({
          kind: field ? "invite-fields" : "invite-merge",
          inviteId: id,
          value: field ? { [field]: value } : value,
        } as GameSessionChange);
    } else if (root === "automatch")
      changes.push({
        kind: "automatch-entry",
        inviteId: id,
        value,
      } as GameSessionChange);
    else if (root === "telegramAutomatches")
      changes.push({
        kind: field ? "telegram-source-merge" : "telegram-source",
        inviteId: id,
        value: field ? { [field]: value } : value,
      } as GameSessionChange);
    else if (root === "telegramProjectionOutbox" && id === "automatch")
      changes.push({
        kind: "telegram-outbox",
        inviteId: field,
        value,
      } as GameSessionChange);
    else if (root === "profileGameProjectionOutbox" && id === "automatch")
      changes.push({
        kind: key ? "profile-outbox-merge" : "profile-outbox",
        inviteId: field,
        value: key ? { [key]: value } : value,
      } as GameSessionChange);
    else throw new Error("game-session-transition-unsupported-effect");
  }
  return changes;
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
              value: { ...record.value, sessionCreation: record.marker },
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

export function gameplayTestPort(
  state: StateRepository,
): GameSessionPort & MatchStatePort {
  return {
    ...matchTestPort(state),
    readInviteMetadata: async (id, signal) =>
      (await state.getPath(`invites/${id}`, undefined, signal)) as Record<
        string,
        unknown
      > | null,
    async readInviteMetadataMany(ids, signal) {
      return Promise.all(ids.map((id) => this.readInviteMetadata(id, signal)));
    },
    readAutomatchEntry: (id, signal) =>
      state.getPath(`automatch/${id}`, undefined, signal),
    listAutomatchEntriesByLogin: async (uid, limit, signal) =>
      (await state.getPath(
        "automatch",
        { orderBy: "uid", equalTo: uid, limitToFirst: limit },
        signal,
      )) as Record<string, unknown> | null,
    readFirstAutomatchEntry: async (signal) =>
      (await state.getPath(
        "automatch",
        { orderBy: "$key", limitToFirst: 1 },
        signal,
      )) as Record<string, unknown> | null,
    readMutationReceipt: (id, signal) =>
      state.getPath(`gameplayMutationReceipts/${id}`, undefined, signal),
    commitSessionChanges: (changes, signal) =>
      state.patchRoot(encodeSessionChanges(changes), signal),
    readAutomatchTelegramSource: (id, signal) =>
      state.getPath(`telegramAutomatches/${id}`, undefined, signal),
    transactAutomatchTelegramSource: (id, update, signal) =>
      state.transactPath(`telegramAutomatches/${id}`, update, signal),
    readAutomatchTelegramOutbox: (id, signal) =>
      state.getPath(
        `telegramProjectionOutbox/automatch/${id}`,
        undefined,
        signal,
      ),
    transactAutomatchTelegramOutbox: (id, update, signal) =>
      state.transactPath(
        `telegramProjectionOutbox/automatch/${id}`,
        update,
        signal,
      ),
    listDueAutomatchTelegramOutboxes: async (now, limit, signal) =>
      (await state.getPath(
        "telegramProjectionOutbox/automatch",
        { orderBy: "updatedAtMs", startAt: 0, endAt: now, limitToFirst: limit },
        signal,
      )) as Record<string, unknown> | null,
    readAutomatchProfileOutbox: (id, signal) =>
      state.getPath(
        `profileGameProjectionOutbox/automatch/${id}`,
        undefined,
        signal,
      ),
    transactAutomatchProfileOutbox: (id, update, signal) =>
      state.transactPath(
        `profileGameProjectionOutbox/automatch/${id}`,
        update,
        signal,
      ),
    listDueAutomatchProfileOutboxes: async (now, limit, signal) =>
      (await state.getPath(
        "profileGameProjectionOutbox/automatch",
        { orderBy: "lastQueuedAtMs", endAt: now, limitToFirst: limit },
        signal,
      )) as Record<string, unknown> | null,
    listMalformedAutomatchProfileOutboxes: async (limit, signal) =>
      (await state.getPath(
        "profileGameProjectionOutbox/automatch",
        { orderBy: "lastQueuedAtMs", startAt: "", limitToFirst: limit },
        signal,
      )) as Record<string, unknown> | null,
  };
}

export function legacySessionClient(port: GameSessionPort): StateRepository {
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
      const method =
        root === "telegramAutomatches"
          ? port.transactAutomatchTelegramSource
          : root === "telegramProjectionOutbox"
            ? port.transactAutomatchTelegramOutbox
            : root === "profileGameProjectionOutbox"
              ? port.transactAutomatchProfileOutbox
              : null;
      if (!method) throw new Error("retired-source-path");
      return method(
        root === "telegramAutomatches" ? id : field,
        update as Parameters<typeof method>[1],
        signal,
      );
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
>(source: T): T & GameSessionPort & MatchStatePort {
  const port = gameplayTestPort({
    getPath: (path, query, signal) =>
      /^invites\/[^/]+$/.test(path)
        ? source.readInviteMetadata(path.split("/")[1], signal)
        : source.getStatePath(path, query, signal),
    patchRoot: (updates, signal) => source.patchStateRoot(updates, signal),
    transactPath: (path, updater, signal) =>
      source.transactStatePath(path, updater, signal),
  });
  const readInviteMetadata = source.readInviteMetadata;
  return Object.assign(source, port, { readInviteMetadata });
}
