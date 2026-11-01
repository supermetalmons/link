import type { DecodedWager } from "./wagerModel.ts";
import type { WagerKey } from "./wagerStateRepository.ts";
import {
  readStoredSettlement,
  WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON,
  type WagerSettlement,
  type SettlementRelease,
  type WagerSettlementResolution,
} from "./wagerStateCommands.ts";
import { readGameplayMatchPair } from "./gameplayMatchReads.ts";
import { movesFromFlatString } from "@mons/shared/match-protocol";
import { parseInviteMatchIndex } from "@mons/shared/rematches";
import type {
  WagerOutcomeResolveRequest,
  WagerOutcomeResolveResponse,
} from "@mons/shared/wagers";
import type { GameSessionMatch } from "@mons/shared/game-sessions";
import { readMatchDocument } from "./matchRecordCodec.ts";
import { resolveMatch } from "mons-rules";
import { AuthApiFailure } from "./authErrors.ts";
import { enforceRateLimit } from "./rateLimit.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import type {
  GameplayRepository,
  WagerWriteRepository,
} from "./gameplayRepository.ts";
import {
  consumeWagerReservationOperation,
  createWagerReservationOperationId,
  ensureWagerAgreementLineageReady,
  resolveWagerParticipants,
} from "./wagerProposal.ts";

export { WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON } from "./wagerStateCommands.ts";
export const WAGER_SETTLEMENT_INITIAL_RETRY_DELAY_SECONDS = 60;

type MatchRecord = Pick<
  GameSessionMatch,
  "color" | "fen" | "flatMovesString" | "status" | "timer"
>;

export type WagerOutcomeDependencies = {
  assertMutationAllowed?: () => Promise<void>;
  now?: () => number;
  resolveResult?: (
    player: MatchRecord,
    opponent: MatchRecord,
  ) => "gg" | "none" | "win";
  scheduleRetry?: (task: WagerSettlementRetryTask) => Promise<void>;
  signal?: AbortSignal;
};

export type { WagerSettlementResolution } from "./wagerStateCommands.ts";

export type WagerSettlementRetryTask = {
  inviteId: string;
  kind: "wager-settlement";
  matchId: string;
  operationId: string;
  resolution?: WagerSettlementResolution;
};

export type WagerSettlementRetryState =
  "completed" | "pending" | "stale" | "unclaimed";

function parseMatchRecord(value: unknown): MatchRecord | null {
  if (value === null) return null;
  const match = readMatchDocument(value);
  if (!match)
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "match-result-unavailable",
    );
  return match;
}

export function resolveWagerMatchResult(
  player: MatchRecord,
  opponent: MatchRecord,
): "gg" | "none" | "win" {
  if (player.status === "surrendered" || opponent.timer.state === "finished") {
    return "gg";
  }
  if (opponent.status === "surrendered" || player.timer.state === "finished") {
    return "win";
  }
  if (
    !player.color ||
    !opponent.color ||
    player.color === opponent.color ||
    !player.fen ||
    !opponent.fen
  ) {
    return "none";
  }
  const playerSubmission = {
    fen: player.fen,
    moves: movesFromFlatString(player.flatMovesString),
  };
  const opponentSubmission = {
    fen: opponent.fen,
    moves: movesFromFlatString(opponent.flatMovesString),
  };
  const resolution = resolveMatch(
    player.color === "white"
      ? { white: playerSubmission, black: opponentSubmission }
      : { white: opponentSubmission, black: playerSubmission },
  );
  if (resolution.kind !== "winner") {
    return "none";
  }
  return resolution.winner === player.color ? "win" : "gg";
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function createSettlementId(
  inviteId: string,
  matchId: string,
): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `wager-settlement\u0000${inviteId}\u0000${matchId}`,
      ),
    ),
  );
}

async function readMatchPair(
  inviteId: string,
  playerUid: string,
  opponentUid: string,
  matchId: string,
  repository: Pick<GameplayRepository, "readMatchPair">,
  signal?: AbortSignal,
): Promise<[MatchRecord | null, MatchRecord | null]> {
  const values = await readGameplayMatchPair(
    repository,
    {
      inviteId,
      matchId,
      playerId: playerUid,
      opponentId: opponentUid,
    },
    signal,
  );
  return [parseMatchRecord(values[0]), parseMatchRecord(values[1])];
}

async function createAcceptReservationOperationIdByUid(
  inviteId: string,
  matchId: string,
  uids: readonly string[],
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      [...new Set(uids)].map(async (uid) => [
        uid,
        await createWagerReservationOperationId(
          "accept",
          inviteId,
          matchId,
          uid,
        ),
      ]),
    ),
  );
}

async function claimSettlement(
  wagerKey: WagerKey,
  resolution: WagerSettlementResolution,
  operationId: string,
  nowMs: number,
  acceptReservationOperationIdByUid: Readonly<Record<string, string>>,
  repository: WagerWriteRepository,
  signal?: AbortSignal,
  assertMutationAllowed?: () => Promise<void>,
): Promise<
  | "already-resolved"
  | "insufficient-materials"
  | "no-wager"
  | "manual-required"
  | WagerSettlement
> {
  let current: DecodedWager | null;
  await assertMutationAllowed?.();
  try {
    const transaction = await repository.wagerWriter.claimSettlement(
      wagerKey,
      {
        resolution,
        operationId,
        now: nowMs,
        acceptReservationOperationIdByUid,
      },
      signal,
    );
    if (transaction.decision === "manual-required") return "manual-required";
    if (transaction.decision === "no-wager") {
      return "no-wager";
    }
    if (transaction.decision === "already-resolved") {
      return "already-resolved";
    }
    if (
      transaction.decision === WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
    ) {
      return WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON;
    }
    current = transaction.value;
  } catch {
    current = await repository.wagers.readWager(wagerKey, signal);
  }
  if (current?.state === "blocked") return "manual-required";
  const settlement = readStoredSettlement(current);
  if (
    settlement?.operationId === operationId &&
    settlement.state === "completed"
  ) {
    return settlement.failureReason ===
      WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
      ? WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
      : "already-resolved";
  }
  if (
    !settlement ||
    settlement.operationId !== operationId ||
    settlement.state !== "pending"
  ) {
    throw new Error("wager-settlement-unavailable");
  }
  return settlement;
}

async function completeSettlement(
  inviteId: string,
  matchId: string,
  settlement: WagerSettlement,
  repository: WagerWriteRepository,
  now: () => number,
  signal?: AbortSignal,
  assertMutationAllowed?: () => Promise<void>,
): Promise<null | typeof WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON> {
  const wagerKey: WagerKey = { inviteId, matchId };
  let insufficientMaterials = false;
  const release = async (entry: SettlementRelease) => {
    for (const reservationOperationId of entry.reservationOperationIds) {
      await assertMutationAllowed?.();
      await consumeWagerReservationOperation(
        repository,
        entry.uid,
        reservationOperationId,
        true,
      );
    }
  };
  if (settlement.kind === "agreed") {
    await assertMutationAllowed?.();
    const transfer = await repository.applyWagerTransferOnce({
      operationId: settlement.operationId,
      fingerprint: settlement.fingerprint,
      winnerProfileId: settlement.winnerProfileId,
      loserProfileId: settlement.loserProfileId,
      material: settlement.material,
      count: settlement.count,
      appliedAtMs: now(),
    });
    insufficientMaterials = transfer === "insufficient-materials";
    for (const entry of settlement.releases) await release(entry);
  } else {
    for (const entry of settlement.releases) await release(entry);
  }

  const completedAtMs = now();
  await assertMutationAllowed?.();
  await repository.wagerWriter.completeSettlement(
    wagerKey,
    {
      settlement,
      completedAtMs,
      insufficientMaterials,
    },
    signal,
  );
  return insufficientMaterials
    ? WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
    : null;
}

async function readWagerSettlementRetry(
  task: WagerSettlementRetryTask,
  repository: Pick<GameplayRepository, "wagers">,
): Promise<
  | { state: "completed" | "stale" }
  | { state: "unclaimed" }
  | { settlement: WagerSettlement; state: "pending" }
> {
  if (
    parseInviteMatchIndex(task.inviteId, task.matchId) === null ||
    !/^[a-f0-9]{64}$/.test(task.operationId)
  ) {
    return { state: "stale" };
  }
  const wager = await repository.wagers.readWager({
    inviteId: task.inviteId,
    matchId: task.matchId,
  });
  if (wager === null || wager.state === "blocked") {
    return { state: "stale" };
  }
  const settlement = readStoredSettlement(wager);
  if (!settlement) {
    if (wager.resolved) return { state: "stale" };
    return task.resolution ? { state: "unclaimed" } : { state: "stale" };
  }
  if (settlement.operationId !== task.operationId) return { state: "stale" };
  if (settlement.state === "completed") {
    return { state: "completed" };
  }
  return { settlement, state: "pending" };
}

export async function classifyWagerSettlementRetry(
  task: WagerSettlementRetryTask,
  repository: Pick<GameplayRepository, "wagers">,
): Promise<WagerSettlementRetryState> {
  return (await readWagerSettlementRetry(task, repository)).state;
}

export async function resumeWagerSettlement(
  task: WagerSettlementRetryTask,
  repository: WagerWriteRepository,
  now: () => number = Date.now,
  assertMutationAllowed?: () => Promise<void>,
): Promise<"completed" | "stale"> {
  const retry = await readWagerSettlementRetry(task, repository);
  let settlement: WagerSettlement;
  if (retry.state === "unclaimed") {
    if (!task.resolution) return "stale";
    await ensureWagerAgreementLineageReady(
      repository,
      { inviteId: task.inviteId, matchId: task.matchId },
      now,
      assertMutationAllowed,
    );
    const claimed = await claimSettlement(
      { inviteId: task.inviteId, matchId: task.matchId },
      task.resolution,
      task.operationId,
      now(),
      await createAcceptReservationOperationIdByUid(
        task.inviteId,
        task.matchId,
        [task.resolution.winnerUid, task.resolution.loserUid],
      ),
      repository,
      undefined,
      assertMutationAllowed,
    );
    if (claimed === WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON) {
      return "completed";
    }
    if (
      claimed === "already-resolved" ||
      claimed === "no-wager" ||
      claimed === "manual-required"
    ) {
      return "stale";
    }
    settlement = claimed;
  } else if (retry.state === "pending") {
    settlement = retry.settlement;
  } else {
    return retry.state;
  }
  await completeSettlement(
    task.inviteId,
    task.matchId,
    settlement,
    repository,
    now,
    undefined,
    assertMutationAllowed,
  );
  return "completed";
}

export async function enforceWagerOutcomeRateLimit(
  rateLimiter: RateLimit,
  uid: string,
): Promise<void> {
  return enforceRateLimit(
    rateLimiter,
    `wager-resolve:${uid}`,
    "Too many wager resolution attempts.",
  );
}

export async function resolveWagerOutcome(
  identity: RequestIdentity,
  request: WagerOutcomeResolveRequest,
  repository: WagerWriteRepository,
  dependencies: WagerOutcomeDependencies = {},
): Promise<WagerOutcomeResolveResponse> {
  if (parseInviteMatchIndex(request.inviteId, request.matchId) === null) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  const participants = await resolveWagerParticipants(
    identity,
    request.inviteId,
    repository,
  );
  if ("ok" in participants) {
    return participants;
  }
  const [playerMatch, opponentMatch] = await readMatchPair(
    request.inviteId,
    participants.playerUid,
    participants.opponentUid,
    request.matchId,
    repository,
    dependencies.signal,
  );
  if (!playerMatch || !opponentMatch) {
    return { ok: false, reason: "match-not-found" };
  }
  const result = (dependencies.resolveResult || resolveWagerMatchResult)(
    playerMatch,
    opponentMatch,
  );
  if (result === "none") {
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "match-result-unavailable",
    );
  }
  await dependencies.assertMutationAllowed?.();

  const mining = () =>
    repository.getMiningSnapshot(participants.playerProfileId);
  const wagerKey: WagerKey = {
    inviteId: request.inviteId,
    matchId: request.matchId,
  };
  const snapshot = await repository.wagers.readWagerSnapshot(
    wagerKey,
    dependencies.signal,
  );
  if (snapshot.wager?.state === "blocked")
    return { ok: false, reason: "manual-review-required" };
  if (snapshot.resolutionMarker === true) {
    const markedWager = snapshot.wager;
    const markedSettlement = readStoredSettlement(markedWager);
    const proposals = markedWager?.proposals;
    if (
      markedSettlement?.state === "completed" &&
      markedSettlement.failureReason ===
        WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
    ) {
      return {
        ok: true,
        reason: "no-wager",
        mining: await mining(),
      };
    }
    if (
      !markedWager ||
      markedWager.resolved ||
      markedSettlement?.state === "completed" ||
      (!markedWager.agreed && Object.keys(proposals || {}).length === 0)
    ) {
      return { ok: true, reason: "already-resolved", mining: await mining() };
    }
    if (!markedSettlement || markedSettlement.state !== "pending") {
      throw new AuthApiFailure(
        503,
        "unavailable",
        "wager-settlement-uncertain",
      );
    }
  }

  const operationId = await createSettlementId(
    request.inviteId,
    request.matchId,
  );
  const now = dependencies.now || Date.now;
  const resolution: WagerSettlementResolution =
    result === "win"
      ? {
          winnerUid: participants.playerUid,
          winnerProfileId: participants.playerProfileId,
          loserUid: participants.opponentUid,
          loserProfileId: participants.opponentProfileId,
        }
      : {
          winnerUid: participants.opponentUid,
          winnerProfileId: participants.opponentProfileId,
          loserUid: participants.playerUid,
          loserProfileId: participants.playerProfileId,
        };
  const task: WagerSettlementRetryTask = {
    kind: "wager-settlement",
    inviteId: request.inviteId,
    matchId: request.matchId,
    operationId,
    resolution,
  };
  const acceptReservationOperationIdByUid =
    await createAcceptReservationOperationIdByUid(
      request.inviteId,
      request.matchId,
      [participants.playerUid, participants.opponentUid],
    );
  await dependencies.scheduleRetry?.(task);
  await ensureWagerAgreementLineageReady(
    repository,
    wagerKey,
    now,
    dependencies.assertMutationAllowed,
  );
  const settlement = await claimSettlement(
    wagerKey,
    resolution,
    operationId,
    now(),
    acceptReservationOperationIdByUid,
    repository,
    dependencies.signal,
    dependencies.assertMutationAllowed,
  );
  if (settlement === "manual-required")
    return { ok: false, reason: "manual-review-required" };
  if (settlement === "no-wager") {
    return { ok: true, reason: "no-wager", mining: await mining() };
  }
  if (settlement === "already-resolved") {
    return { ok: true, reason: "already-resolved", mining: await mining() };
  }
  if (settlement === WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON) {
    return {
      ok: true,
      reason: "no-wager",
      mining: await mining(),
    };
  }
  const completion = await completeSettlement(
    request.inviteId,
    request.matchId,
    settlement,
    repository,
    now,
    dependencies.signal,
    dependencies.assertMutationAllowed,
  );
  return completion
    ? { ok: true, reason: "no-wager", mining: await mining() }
    : { ok: true, mining: await mining() };
}
