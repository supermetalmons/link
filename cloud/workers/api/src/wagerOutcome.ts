import {
  isMaterialName,
  normalizeCount,
  type MiningMaterialName,
} from "@mons/shared/mining";
import {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
  movesFromFlatString,
} from "@mons/shared/match-protocol";
import { parseInviteMatchIndex } from "@mons/shared/rematches";
import type {
  WagerOutcomeResolveRequest,
  WagerOutcomeResolveResponse,
} from "@mons/shared/wagers";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import { resolveMatch } from "mons-rules";
import { AuthApiFailure } from "./authErrors.ts";
import type { FirebaseIdentity } from "./firebaseAuth.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import {
  releaseWagerSettlementReservation,
  resolveWagerParticipants,
} from "./wagerProposal.ts";

const SETTLEMENT_VERSION = 1;
export const WAGER_SETTLEMENT_INITIAL_RETRY_DELAY_SECONDS = 60;
export const WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON =
  "insufficient-materials";

type WagerSettlementFailureReason =
  typeof WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON;

type MatchRecord = {
  color: "black" | "white" | null;
  fen: string;
  flatMovesString: string;
  status: string;
  timer: string;
};

type SettlementRelease = {
  count: number;
  material: MiningMaterialName;
  uid: string;
};

type SettlementBase = {
  claimedAtMs: number;
  completedAtMs: number | null;
  failureReason: WagerSettlementFailureReason | null;
  fingerprint: string;
  operationId: string;
  state: "completed" | "pending";
  version: typeof SETTLEMENT_VERSION;
};

type AgreedSettlement = SettlementBase & {
  count: number;
  kind: "agreed";
  loserProfileId: string;
  loserUid: string;
  material: MiningMaterialName;
  winnerProfileId: string;
  winnerUid: string;
};

type ProposalSettlement = SettlementBase & {
  kind: "proposals";
  releases: SettlementRelease[];
};

type WagerSettlement = AgreedSettlement | ProposalSettlement;

export type WagerOutcomeDependencies = {
  now?: () => number;
  resolveResult?: (
    player: MatchRecord,
    opponent: MatchRecord,
  ) => "gg" | "none" | "win";
  scheduleRetry?: (task: WagerSettlementRetryTask) => Promise<void>;
  signal?: AbortSignal;
};

export type WagerSettlementResolution = {
  loserProfileId: string;
  loserUid: string;
  winnerProfileId: string;
  winnerUid: string;
};

export type WagerSettlementRetryTask = {
  inviteId: string;
  kind: "wager-settlement";
  matchId: string;
  operationId: string;
  resolution?: WagerSettlementResolution;
};

export type WagerSettlementRetryState =
  "completed" | "pending" | "stale" | "unclaimed";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseMatchRecord(value: unknown): MatchRecord | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }
  const color =
    record.color === "white" || record.color === "black" ? record.color : null;
  const fen = typeof record.fen === "string" ? record.fen : "";
  const flatMovesString =
    typeof record.flatMovesString === "string" ? record.flatMovesString : "";
  if (
    !isMatchFenWithinLimit(fen) ||
    !isMatchHistoryWithinLimits(flatMovesString)
  ) {
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "match-result-unavailable",
    );
  }
  return {
    color,
    fen,
    flatMovesString,
    status: normalizeString(record.status),
    timer: normalizeString(record.timer),
  };
}

export function resolveWagerMatchResult(
  player: MatchRecord,
  opponent: MatchRecord,
): "gg" | "none" | "win" {
  if (
    player.status === "surrendered" ||
    opponent.timer === MATCH_TIMER_TERMINAL
  ) {
    return "gg";
  }
  if (
    opponent.status === "surrendered" ||
    player.timer === MATCH_TIMER_TERMINAL
  ) {
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

function settlementFingerprint(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function parseRelease(value: unknown): SettlementRelease | null {
  const release = toRecord(value);
  const uid = normalizeString(release?.uid);
  const material = normalizeString(release?.material);
  const count = normalizeCount(release?.count);
  return uid && isMaterialName(material) && count > 0
    ? { uid, material, count }
    : null;
}

function parseSettlement(value: unknown): WagerSettlement | null {
  const settlement = toRecord(value);
  const state = settlement?.state;
  const completedAtMs = settlement?.completedAtMs;
  const failureReason = settlement?.failureReason;
  if (
    settlement?.version !== SETTLEMENT_VERSION ||
    (state !== "pending" && state !== "completed") ||
    typeof settlement.fingerprint !== "string" ||
    !settlement.fingerprint ||
    typeof settlement.operationId !== "string" ||
    !settlement.operationId ||
    !Number.isSafeInteger(settlement.claimedAtMs) ||
    (completedAtMs !== undefined &&
      completedAtMs !== null &&
      !Number.isSafeInteger(completedAtMs)) ||
    (failureReason !== undefined &&
      failureReason !== null &&
      failureReason !== WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON) ||
    (state === "pending" &&
      failureReason !== undefined &&
      failureReason !== null) ||
    (state === "completed" && !Number.isSafeInteger(completedAtMs))
  ) {
    return null;
  }
  const base: SettlementBase = {
    version: SETTLEMENT_VERSION,
    state,
    fingerprint: settlement.fingerprint,
    operationId: settlement.operationId,
    claimedAtMs: Number(settlement.claimedAtMs),
    completedAtMs: Number.isSafeInteger(completedAtMs)
      ? Number(completedAtMs)
      : null,
    failureReason:
      failureReason === WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
        ? failureReason
        : null,
  };
  if (settlement.kind === "agreed") {
    const winnerUid = normalizeString(settlement.winnerUid);
    const loserUid = normalizeString(settlement.loserUid);
    const winnerProfileId = normalizeString(settlement.winnerProfileId);
    const loserProfileId = normalizeString(settlement.loserProfileId);
    const material = normalizeString(settlement.material);
    const count = normalizeCount(settlement.count);
    return winnerUid &&
      loserUid &&
      winnerProfileId &&
      loserProfileId &&
      isMaterialName(material) &&
      count > 0
      ? {
          ...base,
          kind: "agreed",
          winnerUid,
          loserUid,
          winnerProfileId,
          loserProfileId,
          material,
          count,
        }
      : null;
  }
  const storedReleases = settlement.releases ?? [];
  if (
    settlement.kind !== "proposals" ||
    !Array.isArray(storedReleases) ||
    base.failureReason
  ) {
    return null;
  }
  const releases = storedReleases.map(parseRelease);
  if (releases.some((release) => release === null)) {
    return null;
  }
  return {
    ...base,
    kind: "proposals",
    releases: releases.filter(
      (release): release is SettlementRelease => release !== null,
    ),
  };
}

function readStoredSettlement(
  wager: Record<string, unknown> | null,
): WagerSettlement | null {
  const rawSettlement = wager?.settlement;
  const settlement = parseSettlement(rawSettlement);
  if (rawSettlement !== null && rawSettlement !== undefined && !settlement) {
    throw new Error("wager-settlement-malformed");
  }
  return settlement;
}

async function readMatchPair(
  playerUid: string,
  opponentUid: string,
  matchId: string,
  repository: Pick<GameplayRepository, "getRtdbPath">,
  signal?: AbortSignal,
): Promise<[MatchRecord | null, MatchRecord | null]> {
  const paths = [
    `players/${playerUid}/matches/${matchId}`,
    `players/${opponentUid}/matches/${matchId}`,
  ];
  const first = await Promise.allSettled(
    paths.map((path) => repository.getRtdbPath(path, undefined, signal)),
  );
  const values = await Promise.all(
    first.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : repository.getRtdbPath(paths[index], undefined, signal),
    ),
  );
  return [parseMatchRecord(values[0]), parseMatchRecord(values[1])];
}

function createSettlement(
  wager: Record<string, unknown>,
  resolution: WagerSettlementResolution,
  operationId: string,
  nowMs: number,
): WagerSettlement {
  const base = {
    version: 1 as const,
    state: "pending" as const,
    operationId,
    claimedAtMs: nowMs,
    completedAtMs: null,
  };
  const agreement = toRecord(wager.agreed);
  const material = normalizeString(agreement?.material);
  const count = normalizeCount(agreement?.count);
  if (isMaterialName(material) && count > 0) {
    const candidate = {
      ...base,
      kind: "agreed" as const,
      ...resolution,
      material,
      count,
    };
    return {
      ...candidate,
      failureReason: null,
      fingerprint: settlementFingerprint(candidate),
    };
  }
  const proposals = toRecord(wager.proposals) || {};
  const releases = [resolution.winnerUid, resolution.loserUid]
    .map((uid) => parseRelease({ uid, ...toRecord(proposals[uid]) }))
    .filter((release): release is SettlementRelease => release !== null);
  const candidate = {
    ...base,
    kind: "proposals" as const,
    releases,
  };
  return {
    ...candidate,
    failureReason: null,
    fingerprint: settlementFingerprint(candidate),
  };
}

async function claimSettlement(
  wagerPath: string,
  resolution: WagerSettlementResolution,
  operationId: string,
  nowMs: number,
  repository: GameplayRepository,
  signal?: AbortSignal,
): Promise<
  "already-resolved" | "insufficient-materials" | "no-wager" | WagerSettlement
> {
  let current: unknown;
  try {
    const transaction = await repository.transactRtdbPath(
      wagerPath,
      (value) => {
        const wager = toRecord(value);
        if (!wager) {
          return { commit: false, decision: "no-wager" };
        }
        const existing = readStoredSettlement(wager);
        if (wager.resolved) {
          return { commit: false, decision: "already-resolved" };
        }
        if (existing) {
          return {
            commit: false,
            decision:
              existing.state !== "completed"
                ? "resume"
                : existing.failureReason ===
                    WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
                  ? WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
                  : "already-resolved",
          };
        }
        const settlement = createSettlement(
          wager,
          resolution,
          operationId,
          nowMs,
        );
        return { value: { ...wager, settlement } };
      },
      signal,
    );
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
    current = await repository.getRtdbPath(wagerPath, undefined, signal);
  }
  const wager = toRecord(current);
  const settlement = readStoredSettlement(wager);
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
  repository: GameplayRepository,
  now: () => number,
  signal?: AbortSignal,
): Promise<null | typeof WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON> {
  const wagerPath = `invites/${inviteId}/wagers/${matchId}`;
  let insufficientMaterials = false;
  if (settlement.kind === "agreed") {
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
    await releaseWagerSettlementReservation(
      repository,
      {
        operationId: settlement.operationId,
        uid: settlement.winnerUid,
        material: settlement.material,
        count: settlement.count,
      },
      now,
    );
    await releaseWagerSettlementReservation(
      repository,
      {
        operationId: settlement.operationId,
        uid: settlement.loserUid,
        material: settlement.material,
        count: settlement.count,
      },
      now,
    );
  } else {
    for (const release of settlement.releases) {
      await releaseWagerSettlementReservation(
        repository,
        { operationId: settlement.operationId, ...release },
        now,
      );
    }
  }

  const completedAtMs = now();
  const updates: Record<string, unknown> = {
    [`${wagerPath}/settlement/state`]: "completed",
    [`${wagerPath}/settlement/completedAtMs`]: completedAtMs,
    [`${wagerPath}/proposals`]: null,
    [`invites/${inviteId}/matchesWagerResolutions/${matchId}`]: true,
  };
  if (insufficientMaterials) {
    updates[`${wagerPath}/settlement/failureReason`] =
      WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON;
    updates[`${wagerPath}/agreed`] = null;
  } else if (settlement.kind === "agreed") {
    updates[`${wagerPath}/resolved`] = {
      winnerId: settlement.winnerUid,
      loserId: settlement.loserUid,
      material: settlement.material,
      count: settlement.count,
      total: settlement.count * 2,
      resolvedAt: completedAtMs,
    };
  }
  await repository.patchRtdbRoot(updates, signal);
  return insufficientMaterials
    ? WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
    : null;
}

async function readWagerSettlementRetry(
  task: WagerSettlementRetryTask,
  repository: Pick<GameplayRepository, "getRtdbPath">,
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
  const rawWager = await repository.getRtdbPath(
    `invites/${task.inviteId}/wagers/${task.matchId}`,
  );
  if (rawWager === null || rawWager === undefined) {
    return { state: "stale" };
  }
  const wager = toRecord(rawWager);
  if (!wager) throw new Error("wager-settlement-malformed");
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
  repository: Pick<GameplayRepository, "getRtdbPath">,
): Promise<WagerSettlementRetryState> {
  return (await readWagerSettlementRetry(task, repository)).state;
}

export async function resumeWagerSettlement(
  task: WagerSettlementRetryTask,
  repository: GameplayRepository,
  now: () => number = Date.now,
): Promise<"completed" | "stale"> {
  const retry = await readWagerSettlementRetry(task, repository);
  let settlement: WagerSettlement;
  if (retry.state === "unclaimed") {
    if (!task.resolution) return "stale";
    const claimed = await claimSettlement(
      `invites/${task.inviteId}/wagers/${task.matchId}`,
      task.resolution,
      task.operationId,
      now(),
      repository,
    );
    if (claimed === WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON) {
      return "completed";
    }
    if (claimed === "already-resolved" || claimed === "no-wager") {
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
  );
  return "completed";
}

export async function enforceWagerOutcomeRateLimit(
  rateLimiter: RateLimit,
  uid: string,
): Promise<void> {
  let outcome: RateLimitOutcome;
  try {
    outcome = await rateLimiter.limit({ key: `wager-resolve:${uid}` });
  } catch {
    throw new AuthApiFailure(503, "unavailable", "rate-limit-unavailable");
  }
  if (!outcome.success) {
    throw new AuthApiFailure(
      429,
      "resource-exhausted",
      "Too many wager resolution attempts.",
    );
  }
}

export async function resolveWagerOutcome(
  identity: FirebaseIdentity,
  request: WagerOutcomeResolveRequest,
  repository: GameplayRepository,
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

  const mining = () =>
    repository.getMiningSnapshot(participants.playerProfileId);
  const wagerPath = `invites/${request.inviteId}/wagers/${request.matchId}`;
  const markerPath = `invites/${request.inviteId}/matchesWagerResolutions/${request.matchId}`;
  if (
    (await repository.getRtdbPath(
      markerPath,
      undefined,
      dependencies.signal,
    )) === true
  ) {
    const markedWager = toRecord(
      await repository.getRtdbPath(wagerPath, undefined, dependencies.signal),
    );
    const markedSettlement = readStoredSettlement(markedWager);
    const proposals = toRecord(markedWager?.proposals);
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
  await dependencies.scheduleRetry?.(task);
  const settlement = await claimSettlement(
    wagerPath,
    resolution,
    operationId,
    now(),
    repository,
    dependencies.signal,
  );
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
  );
  return completion
    ? { ok: true, reason: "no-wager", mining: await mining() }
    : { ok: true, mining: await mining() };
}

export {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
};
