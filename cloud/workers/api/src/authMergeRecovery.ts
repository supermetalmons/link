import { AuthApiFailure } from "./authErrors.ts";
import {
  AuthFirestoreConflict,
  authDeleteWrite,
  authDocumentName,
  authUpdateWrite,
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
  type AuthFirestoreWrite,
} from "./authFirestore.ts";
import {
  cleanString,
  finiteNumber,
  PENDING_MERGE_GAME_COPY_FIELD_PATHS,
} from "./authPolicy.ts";
import type { FirebaseRtdbClient } from "./firebaseRtdb.ts";

export const MERGE_GAME_FINALIZE_DELAY_MS = 60 * 1_000;
export const MERGE_PRIZE_RECOVERY_PAGE_SIZE = 20;

type AuthMergeRecoveryDependencies = {
  buildPrizeCopies: (input: {
    sourceProfileId: string;
    sourcePrizes: Record<string, unknown>;
    targetProfileId: string;
    targetPrizes: Record<string, unknown>;
  }) => Record<string, unknown>;
  durableFirestore: AuthFirestoreClient;
  firestore: AuthFirestoreClient;
  getWithdrawalPath: (eventId: string, prizeId: string) => string;
  isCompletedWithdrawal: (
    value: unknown,
    eventId: string,
    prizeId: string,
  ) => boolean;
  isMatchingAssignment: (
    value: unknown,
    eventId: string,
    prizeId: string,
  ) => boolean;
  mergeGameBacklogName: (opId: string) => string;
  now: () => number;
  prizePageSize?: number;
  rtdb: FirebaseRtdbClient;
  signal?: AbortSignal;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getOne(
  values: Map<string, AuthFirestoreDocument | null>,
  name: string,
): AuthFirestoreDocument | null {
  return values.get(name) || null;
}

function timestampMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  const timestamp = cleanString(record(value).__firestoreTimestamp);
  const parsed = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeFreshness(fields: Record<string, unknown>): number {
  return Math.max(
    timestampMillis(fields.updatedAt),
    timestampMillis(fields.listSortAt),
  );
}

export function createAuthMergeRecovery({
  buildPrizeCopies,
  durableFirestore,
  firestore,
  getWithdrawalPath,
  isCompletedWithdrawal,
  isMatchingAssignment,
  mergeGameBacklogName,
  now,
  prizePageSize = MERGE_PRIZE_RECOVERY_PAGE_SIZE,
  rtdb,
  signal,
}: AuthMergeRecoveryDependencies) {
  const boundedPrizePageSize = Math.max(
    1,
    Math.min(MERGE_PRIZE_RECOVERY_PAGE_SIZE, Math.floor(prizePageSize) || 1),
  );
  const copyPrize = async (
    sourceProfileId: string,
    targetProfileId: string,
    eventId: string,
    sourceAssignment: unknown,
  ): Promise<void> => {
    const assignment = record(
      buildPrizeCopies({
        sourceProfileId,
        targetProfileId,
        sourcePrizes: { [eventId]: sourceAssignment },
        targetPrizes: {},
      }),
    )[eventId];
    const prizeId = cleanString(record(assignment).prizeId);
    const targetPath = `profileEventPrizes/${targetProfileId}/${eventId}`;
    const removeIfCompleted = async (): Promise<boolean> => {
      if (!prizeId) {
        return false;
      }
      const withdrawal = await rtdb.getPath(
        getWithdrawalPath(eventId, prizeId),
        undefined,
        signal,
      );
      if (!isCompletedWithdrawal(withdrawal, eventId, prizeId)) {
        return false;
      }
      await rtdb.transactPath(
        targetPath,
        (current) =>
          isMatchingAssignment(current, eventId, prizeId)
            ? { value: null }
            : { commit: false },
        signal,
      );
      return true;
    };
    if (await removeIfCompleted()) {
      return;
    }
    await rtdb.transactPath(
      targetPath,
      (current) => {
        const copy = record(
          buildPrizeCopies({
            sourceProfileId,
            targetProfileId,
            sourcePrizes: { [eventId]: sourceAssignment },
            targetPrizes: current ? { [eventId]: current } : {},
          }),
        )[eventId];
        return copy === undefined ? { commit: false } : { value: copy };
      },
      signal,
    );
    await removeIfCompleted();
  };

  const reconcileProfilePrizes = async ({
    opId,
    sourceProfileId,
    targetName,
    targetProfileId,
  }: {
    opId: string;
    sourceProfileId: string;
    targetName: string;
    targetProfileId: string;
  }): Promise<boolean> => {
    try {
      const target = await firestore.get(targetName);
      if (!target) {
        throw new AuthApiFailure(500, "internal", "target-profile-missing");
      }
      if (
        cleanString(target.fields.pendingMergePrizeCopyCompletedOpId) === opId
      ) {
        return true;
      }
      const cursor = cleanString(target.fields.pendingMergePrizeCopyCursor);
      const source = record(
        await rtdb.getPath(
          `profileEventPrizes/${sourceProfileId}`,
          undefined,
          signal,
        ),
      );
      const remaining = Object.entries(source)
        .filter(([eventId]) => eventId > cursor)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      const page = remaining.slice(0, boundedPrizePageSize);
      for (const [eventId, assignment] of page) {
        await copyPrize(sourceProfileId, targetProfileId, eventId, assignment);
      }
      const complete = remaining.length <= page.length;
      const nextCursor = page.at(-1)?.[0] || cursor;
      return durableFirestore.runTransaction(async (transaction) => {
        const live = getOne(
          await transaction.batchGet([targetName]),
          targetName,
        );
        if (
          !live ||
          cleanString(live.fields.pendingMergeGameCopySourceProfileId) !==
            sourceProfileId ||
          cleanString(live.fields.pendingMergeGameCopyOpId) !== opId
        ) {
          return { result: false, writes: [] };
        }
        return {
          result: complete,
          writes: [
            authUpdateWrite(
              targetName,
              complete
                ? {
                    pendingMergePrizeCopyCompletedAtMs: now(),
                    pendingMergePrizeCopyCompletedOpId: opId,
                  }
                : { pendingMergePrizeCopyCursor: nextCursor },
              complete
                ? [
                    "pendingMergePrizeCopyCursor",
                    "pendingMergePrizeCopyCompletedAtMs",
                    "pendingMergePrizeCopyCompletedOpId",
                  ]
                : ["pendingMergePrizeCopyCursor"],
              live.updateTime ? { updateTime: live.updateTime } : true,
            ),
          ],
        };
      });
    } catch {
      console.error(JSON.stringify({ event: "auth_merge_prize_copy_pending" }));
      return false;
    }
  };

  const reconcileProfileGames = async ({
    opId,
    sourceProfileId,
    targetName,
  }: {
    opId: string;
    sourceProfileId: string;
    targetName: string;
  }): Promise<boolean> => {
    const drainSourceGames = async (): Promise<void> => {
      while (true) {
        let committed = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          const page = await firestore.listPage(
            `users/${sourceProfileId}`,
            "games",
          );
          if (page.documents.length === 0) {
            return;
          }
          const targetNames = page.documents.map(
            (game) => `${targetName}/games/${game.id}`,
          );
          const targets = await firestore.batchGet(targetNames);
          const writes: AuthFirestoreWrite[] = [];
          for (const game of page.documents) {
            const targetGameName = `${targetName}/games/${game.id}`;
            const current = getOne(targets, targetGameName);
            if (
              !current ||
              mergeFreshness(game.fields) >= mergeFreshness(current.fields)
            ) {
              writes.push({
                update: { name: targetGameName, fields: game.rawFields },
                updateMask: { fieldPaths: Object.keys(game.rawFields) },
                currentDocument: current?.updateTime
                  ? { updateTime: current.updateTime }
                  : { exists: false },
              });
            }
            writes.push(
              authDeleteWrite(
                game.name,
                game.updateTime ? { updateTime: game.updateTime } : true,
              ),
            );
          }
          try {
            await firestore.commitWrites(writes);
            committed = true;
            break;
          } catch (error) {
            if (!(error instanceof AuthFirestoreConflict)) {
              throw error;
            }
          }
        }
        if (!committed) {
          throw new AuthFirestoreConflict();
        }
      }
    };

    try {
      await drainSourceGames();
      const pendingTarget = await firestore.get(targetName);
      if (!pendingTarget) {
        throw new AuthApiFailure(500, "internal", "target-profile-missing");
      }
      const pendingSource = cleanString(
        pendingTarget.fields.pendingMergeGameCopySourceProfileId,
      );
      const pendingUpdatedAtMs = finiteNumber(
        pendingTarget.fields.pendingMergeGameCopyUpdatedAtMs,
        0,
      );
      if (
        pendingSource === sourceProfileId &&
        pendingUpdatedAtMs > 0 &&
        now() - pendingUpdatedAtMs < MERGE_GAME_FINALIZE_DELAY_MS
      ) {
        return false;
      }
      const sourceName = authDocumentName("users", sourceProfileId);
      const source = await firestore.get(sourceName);
      if (source) {
        await firestore.commitWrites([
          authDeleteWrite(
            sourceName,
            source.updateTime ? { updateTime: source.updateTime } : true,
          ),
        ]);
      }
      await drainSourceGames();
      await durableFirestore.runTransaction(async (transaction) => {
        const target = getOne(
          await transaction.batchGet([targetName]),
          targetName,
        );
        if (!target) {
          throw new AuthApiFailure(500, "internal", "target-profile-missing");
        }
        const markerSource = cleanString(
          target.fields.pendingMergeGameCopySourceProfileId,
        );
        const markerOp = cleanString(target.fields.pendingMergeGameCopyOpId);
        const writes: AuthFirestoreWrite[] = [
          authDeleteWrite(mergeGameBacklogName(opId)),
        ];
        if (
          markerSource === sourceProfileId &&
          (!markerOp || markerOp === opId)
        ) {
          writes.unshift(
            authUpdateWrite(
              targetName,
              {},
              [...PENDING_MERGE_GAME_COPY_FIELD_PATHS],
              true,
            ),
          );
        }
        return { result: undefined, writes };
      });
      return true;
    } catch {
      console.error(
        JSON.stringify({ event: "auth_merge_game_recovery_pending" }),
      );
      return false;
    }
  };

  return { reconcileProfileGames, reconcileProfilePrizes };
}
