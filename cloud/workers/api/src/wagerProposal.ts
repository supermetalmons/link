import {
  readInviteDocument,
  inviteTrimmedParticipants,
} from "@mons/shared/invite-records";
import type {
  WagerKey,
  ModernProposalLineage,
} from "./wagerStateRepository.ts";
import type { WagerFrozenReadRepository } from "./wagerFrozenStore.ts";
import { isMaterialName, normalizeCount } from "@mons/shared/mining";
import {
  type WagerProposalAcceptRequest,
  type WagerProposalAcceptResponse,
  type WagerProposalRemovalRequest,
  type WagerProposalRemovalResponse,
  type WagerProposalSendRequest,
  type WagerProposalSendResponse,
} from "@mons/shared/wagers";
import {
  readWagerProposal,
  readWagerCount,
  readWagerRemovalReceipt,
  type WagerProposal,
  type WagerRemovalReceipt,
} from "./wagerModel.ts";
import { AuthApiFailure } from "./authErrors.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { GameSessionMutationLockStore } from "./gameplayCoordinationD1.ts";
import type {
  GameplayRepository,
  WagerWriteRepository,
} from "./gameplayRepository.ts";
import { withGameSessionMutationLease } from "./gameSessionMutationRunner.ts";
import { resolveInviteActor } from "./inviteAccess.ts";
import { ensureWagerAgreementLineageReady } from "./wagerAgreementLineage.ts";
import { observeProposalWrite } from "./wagerProposalWrite.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipSnapshot,
} from "./profileOwnership.ts";
import {
  consumeWagerReservationOperation,
  createOperationId,
  createWagerReservationOperationId,
  operationFingerprint,
  readFrozenOperationForUid,
  recoverUnreferencedWagerReservation,
  releaseUnreferencedWagerReservation,
  reserveAcceptedMaterialsOnce,
  reserveFrozenMaterialsOnce,
  type WagerMutationContext,
} from "./wagerReservationOperations.ts";

export type WagerProposalAction = "cancel" | "decline";

export type WagerProposalDependencies = {
  assertMutationAllowed?: () => Promise<void>;
  createCriticalPhaseSignal?: () => AbortSignal;
  logMaterialReleaseFailure?: (record: Record<string, unknown>) => void;
  mutationLocks: GameSessionMutationLockStore;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
};

type WagerParticipantReader = Pick<
  GameplayRepository,
  "readInviteMetadata" | "readProfileOwnershipSnapshot"
>;

type WagerParticipants = {
  opponentProfileId: string;
  opponentUid: string;
  ownership: ProfileOwnershipSnapshot;
  playerProfileId: string;
  playerUid: string;
};

type WagerParticipantUids = Pick<
  WagerParticipants,
  "opponentUid" | "playerUid"
> & {
  ownership: ProfileOwnershipSnapshot | null;
};

type WagerParticipantFailure = {
  ok: false;
  reason: "invite-not-found" | "missing-opponent" | "profile-not-found";
};

const WAGER_CRITICAL_PHASE_TIMEOUT_MS = 30_000;

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function readModernProposalLineage(
  repository: WagerFrozenReadRepository,
  input: {
    inviteId: string;
    matchId: string;
    proposal: WagerProposal | null;
    uid: string;
  },
): Promise<ModernProposalLineage | null> {
  const proposal = input.proposal;
  const material = proposal?.material;
  const count = readWagerCount(proposal);
  if (!proposal || !isMaterialName(material) || count <= 0) return null;
  const reservationOperationId = await createWagerReservationOperationId(
    "send",
    input.inviteId,
    input.matchId,
    input.uid,
  );
  if (proposal.raw.reservationOperationId !== reservationOperationId)
    return null;
  const reservation = await readFrozenOperationForUid(
    repository,
    input.uid,
    reservationOperationId,
  );
  if (
    reservation?.kind !== "send-reserve" ||
    reservation.material !== material ||
    reservation.count !== count
  ) {
    return null;
  }
  const operationId = await createOperationId(
    "send",
    input.inviteId,
    input.matchId,
    input.uid,
    material,
    String(reservation.requestedCount),
  );
  return proposal.raw.operationId === operationId
    ? { material, count, operationId, reservationOperationId }
    : null;
}

export async function resolveWagerParticipantUids(
  identity: RequestIdentity,
  inviteId: string,
  repository: WagerParticipantReader,
): Promise<WagerParticipantUids | WagerParticipants | WagerParticipantFailure> {
  const invite = readInviteDocument(
    await repository.readInviteMetadata(inviteId),
  );
  if (!invite) {
    return { ok: false, reason: "invite-not-found" };
  }
  const { hostId, guestId } = inviteTrimmedParticipants(invite);
  if (!hostId || !guestId) {
    return { ok: false, reason: "missing-opponent" };
  }
  if (!isSafeRecordKey(hostId) || !isSafeRecordKey(guestId)) {
    throw new Error("invalid-wager-participant");
  }
  const actor = await resolveInviteActor(identity, hostId, guestId, repository);
  const { ownership } = actor;
  const isHost = actor.role === "host";
  if (ownership === null) {
    return isHost
      ? { opponentUid: guestId, ownership, playerUid: hostId }
      : { opponentUid: hostId, ownership, playerUid: guestId };
  }
  const hostProfileId = getLoginProfileId(ownership, hostId);
  const guestProfileId = getLoginProfileId(ownership, guestId);
  if (actor.role === "watch") {
    if (!hostProfileId || !guestProfileId) {
      return { ok: false, reason: "profile-not-found" };
    }
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  if (!hostProfileId || !guestProfileId) {
    return isHost
      ? { opponentUid: guestId, ownership, playerUid: hostId }
      : { opponentUid: hostId, ownership, playerUid: guestId };
  }
  return isHost
    ? {
        opponentProfileId: guestProfileId,
        opponentUid: guestId,
        ownership,
        playerProfileId: hostProfileId,
        playerUid: hostId,
      }
    : {
        opponentProfileId: hostProfileId,
        opponentUid: hostId,
        ownership,
        playerProfileId: guestProfileId,
        playerUid: guestId,
      };
}

export async function resolveWagerParticipantProfiles(
  participants: WagerParticipantUids | WagerParticipants,
  repository: Pick<GameplayRepository, "readProfileOwnershipSnapshot">,
): Promise<WagerParticipants | WagerParticipantFailure> {
  if ("playerProfileId" in participants) {
    return participants;
  }
  const ownership =
    participants.ownership ||
    (await requireProfileOwnershipSnapshot(repository, {
      loginUids: [participants.playerUid, participants.opponentUid],
      profileIds: [],
    }));
  const playerProfileId = getLoginProfileId(ownership, participants.playerUid);
  const opponentProfileId = getLoginProfileId(
    ownership,
    participants.opponentUid,
  );
  if (!playerProfileId || !opponentProfileId) {
    return { ok: false, reason: "profile-not-found" };
  }
  return { ...participants, ownership, playerProfileId, opponentProfileId };
}

async function resolveWagerParticipants(
  identity: RequestIdentity,
  inviteId: string,
  repository: WagerParticipantReader,
): Promise<WagerParticipants | WagerParticipantFailure> {
  const participants = await resolveWagerParticipantUids(
    identity,
    inviteId,
    repository,
  );
  if ("ok" in participants) {
    return participants;
  }
  return resolveWagerParticipantProfiles(participants, repository);
}

async function runWagerMutationWithLease<T>(
  identity: RequestIdentity,
  request: { inviteId: string; matchId: string },
  kind: string,
  dependencies: WagerProposalDependencies,
  work: (mutation: WagerMutationContext) => Promise<T>,
): Promise<T> {
  const operationId = await createOperationId(
    "wager-mutation",
    kind,
    request.inviteId,
    request.matchId,
    identity.uid,
  );
  const wait =
    dependencies.wait ||
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withGameSessionMutationLease(
        request.inviteId,
        operationId,
        dependencies.mutationLocks,
        (refreshLease) => {
          const guardedRefreshLease = async () => {
            await dependencies.assertMutationAllowed?.();
            await refreshLease();
          };
          return work({
            createCriticalPhaseSignal:
              dependencies.createCriticalPhaseSignal ||
              (() => AbortSignal.timeout(WAGER_CRITICAL_PHASE_TIMEOUT_MS)),
            refreshLease: guardedRefreshLease,
          });
        },
        { now: dependencies.now },
      );
    } catch (error) {
      if (
        attempt === 2 ||
        !(error instanceof AuthApiFailure) ||
        error.message !== "invite-busy"
      ) {
        throw error;
      }
      await wait(25 * 2 ** attempt);
    }
  }
  throw new Error("wager-mutation-unavailable");
}

export async function sendWagerProposal(
  identity: RequestIdentity,
  request: WagerProposalSendRequest,
  repository: WagerWriteRepository,
  dependencies: WagerProposalDependencies,
): Promise<WagerProposalSendResponse> {
  const authorization = await resolveWagerParticipantUids(
    identity,
    request.inviteId,
    repository,
  );
  if ("ok" in authorization) return authorization;
  return runWagerMutationWithLease(
    identity,
    request,
    "send",
    dependencies,
    (mutation) =>
      sendWagerProposalUnlocked(
        identity,
        request,
        repository,
        dependencies,
        mutation,
      ),
  );
}

async function sendWagerProposalUnlocked(
  identity: RequestIdentity,
  request: WagerProposalSendRequest,
  repository: WagerWriteRepository,
  dependencies: WagerProposalDependencies,
  mutation: WagerMutationContext,
): Promise<WagerProposalSendResponse> {
  const participants = await resolveWagerParticipants(
    identity,
    request.inviteId,
    repository,
  );
  if ("ok" in participants) {
    return participants;
  }
  const now = dependencies.now || Date.now;
  const requestedCount = normalizeCount(request.count);
  const operationId = await createOperationId(
    "send",
    request.inviteId,
    request.matchId,
    participants.playerUid,
    request.material,
    String(requestedCount),
  );
  const reservationOperationId = await createWagerReservationOperationId(
    "send",
    request.inviteId,
    request.matchId,
    participants.playerUid,
  );
  const selfAdjustmentOperationId = await createOperationId(
    operationId,
    "self-adjustment",
  );
  const opponentAdjustmentOperationId = await createOperationId(
    operationId,
    "proposer-adjustment",
  );
  const wagerKey: WagerKey = {
    inviteId: request.inviteId,
    matchId: request.matchId,
  };
  if (participants.playerProfileId === participants.opponentProfileId) {
    await recoverUnreferencedWagerReservation(
      repository,
      {
        playerUid: participants.playerUid,
        mutation,
        reservationOperationId,
        wagerKey,
      },
      "send-reserve",
    );
    return { ok: false, reason: "proposal-unavailable" };
  }
  const existingReservationState = (
    await repository.wagerFrozen.read(
      participants.playerUid,
      reservationOperationId,
    )
  ).operation;
  if (existingReservationState.status === "malformed") {
    throw new Error("wager-operation-unavailable");
  }
  const existingReservation =
    existingReservationState.status === "active"
      ? existingReservationState.operation
      : null;
  if (existingReservation && existingReservation.kind !== "send-reserve") {
    throw new Error("wager-operation-unavailable");
  }
  if (existingReservationState.status === "consumed") {
    const wager = await repository.wagers.readWager(wagerKey);
    const agreementOperation = wager?.agreementOperation.value;
    const agreement = wager?.agreed.value?.agreement;
    if (
      agreement &&
      (agreementOperation?.raw.id === operationId ||
        agreementOperation?.raw.proposerOperationId === operationId)
    ) {
      return { ok: true, count: agreement.count, agreed: agreement };
    }
    const proposal = readWagerProposal(wager, participants.playerUid);
    if (proposal?.raw.operationId === operationId) {
      return { ok: true, count: readWagerCount(proposal) };
    }
    return { ok: false, reason: "proposal-unavailable" };
  }
  const wagerBefore = await repository.wagers.readWager(wagerKey);
  const opponentProposalBefore = readWagerProposal(
    wagerBefore,
    participants.opponentUid,
  );
  const opponentProposalCount = readWagerCount(opponentProposalBefore);
  let opponentProposal: ModernProposalLineage | null = null;
  if (
    opponentProposalBefore?.raw.material === request.material &&
    opponentProposalCount > 0
  ) {
    opponentProposal = await readModernProposalLineage(repository, {
      inviteId: request.inviteId,
      matchId: request.matchId,
      proposal: opponentProposalBefore,
      uid: participants.opponentUid,
    });
    if (!opponentProposal) {
      return { ok: false, reason: "proposal-unavailable" };
    }
  }
  const expectedReservationFingerprint = operationFingerprint(
    "send-reserve",
    request.material,
    requestedCount,
  );
  if (
    existingReservation &&
    existingReservation.fingerprint !== expectedReservationFingerprint
  ) {
    const cleanup = await releaseUnreferencedWagerReservation(repository, {
      playerUid: participants.playerUid,
      mutation,
      reservationOperationId,
      wagerKey,
    });
    if (cleanup === "referenced") {
      return { ok: false, reason: "proposal-unavailable" };
    }
  }
  const totalMaterials = await repository.getMiningMaterials(
    participants.playerProfileId,
  );
  await mutation.refreshLease();
  const reservedCount = await reserveFrozenMaterialsOnce(
    repository,
    participants.playerUid,
    reservationOperationId,
    request.material,
    requestedCount,
    totalMaterials,
    now,
    mutation.createCriticalPhaseSignal(),
  );
  if (reservedCount <= 0) {
    return { ok: false, reason: "insufficient-materials" };
  }

  const { wager: wagerAfter } = await observeProposalWrite({
    refreshLease: () => mutation.refreshLease(),
    command: async () => {
      const result = await repository.wagerWriter.sendProposal(
        wagerKey,
        {
          playerUid: participants.playerUid,
          opponentUid: participants.opponentUid,
          material: request.material,
          opponentAdjustmentOperationId,
          opponentProposal,
          reservedCount,
          operationId,
          now: now(),
          reservationOperationId,
          selfAdjustmentOperationId,
        },
        mutation.createCriticalPhaseSignal(),
      );
      return result.value;
    },
    readback: () => repository.wagers.readWager(wagerKey),
  });
  const agreementOperation = wagerAfter?.agreementOperation.value;
  const removalOperations =
    wagerAfter?.proposalRemovalOperations.value?.entries;
  const ownProposal = readWagerProposal(wagerAfter, participants.playerUid);
  const agreementMatchesAsAccepter = agreementOperation?.raw.id === operationId;
  const agreementMatchesAsProposer =
    agreementOperation?.raw.proposerOperationId === operationId;
  const proposalMatches = ownProposal?.raw.operationId === operationId;
  const removalMatches = Object.values(removalOperations || {}).some(
    (field) => field.value?.raw.proposalOperationId === operationId,
  );
  if (
    !agreementMatchesAsAccepter &&
    !agreementMatchesAsProposer &&
    !proposalMatches &&
    !removalMatches
  ) {
    await releaseUnreferencedWagerReservation(repository, {
      playerUid: participants.playerUid,
      mutation,
      reservationOperationId,
      wagerKey,
    });
    return { ok: false, reason: "proposal-unavailable" };
  }
  if (proposalMatches) {
    return { ok: true, count: readWagerCount(ownProposal) };
  }
  if (removalMatches) {
    await releaseUnreferencedWagerReservation(repository, {
      playerUid: participants.playerUid,
      mutation,
      reservationOperationId,
      wagerKey,
    });
    return { ok: false, reason: "proposal-unavailable" };
  }
  const agreement = wagerAfter?.agreed.value?.agreement;
  if (!agreement) {
    throw new Error("wager-agreement-unavailable");
  }
  await dependencies.assertMutationAllowed?.();
  await ensureWagerAgreementLineageReady(
    repository,
    wagerKey,
    now,
    dependencies.assertMutationAllowed,
  );
  return { ok: true, count: agreement.count, agreed: agreement };
}

export async function acceptWagerProposal(
  identity: RequestIdentity,
  request: WagerProposalAcceptRequest,
  repository: WagerWriteRepository,
  dependencies: WagerProposalDependencies,
): Promise<WagerProposalAcceptResponse> {
  const authorization = await resolveWagerParticipantUids(
    identity,
    request.inviteId,
    repository,
  );
  if ("ok" in authorization) return authorization;
  return runWagerMutationWithLease(
    identity,
    request,
    "accept",
    dependencies,
    (mutation) =>
      acceptWagerProposalUnlocked(
        identity,
        request,
        repository,
        dependencies,
        mutation,
      ),
  );
}

async function acceptWagerProposalUnlocked(
  identity: RequestIdentity,
  request: WagerProposalAcceptRequest,
  repository: WagerWriteRepository,
  dependencies: WagerProposalDependencies,
  mutation: WagerMutationContext,
): Promise<WagerProposalAcceptResponse> {
  const participants = await resolveWagerParticipants(
    identity,
    request.inviteId,
    repository,
  );
  if ("ok" in participants) {
    return participants;
  }
  const now = dependencies.now || Date.now;
  const operationId = await createOperationId(
    "accept",
    request.inviteId,
    request.matchId,
    participants.playerUid,
  );
  const reservationOperationId = await createWagerReservationOperationId(
    "accept",
    request.inviteId,
    request.matchId,
    participants.playerUid,
  );
  const proposerAdjustmentOperationId = await createOperationId(
    operationId,
    "proposer-adjustment",
  );
  const wagerKey: WagerKey = {
    inviteId: request.inviteId,
    matchId: request.matchId,
  };
  const wager = await repository.wagers.readWager(wagerKey);
  const replayOperation = wager?.agreementOperation.value;
  const replayAgreement = wager?.agreed.value?.agreement;
  if (replayOperation?.raw.id === operationId && replayAgreement) {
    await dependencies.assertMutationAllowed?.();
    await ensureWagerAgreementLineageReady(
      repository,
      wagerKey,
      now,
      dependencies.assertMutationAllowed,
    );
    return { ok: true, count: replayAgreement.count };
  }
  await recoverUnreferencedWagerReservation(
    repository,
    {
      playerUid: participants.playerUid,
      mutation,
      reservationOperationId,
      wagerKey,
    },
    "accept-reserve",
  );
  if (participants.playerProfileId === participants.opponentProfileId) {
    return { ok: false, reason: "proposal-unavailable" };
  }
  if (
    !wager?.record ||
    wager.resolved.raw ||
    wager.agreed.raw ||
    wager.settlement.raw
  ) {
    return { ok: false, reason: "proposal-missing" };
  }
  const opponentProposal = readWagerProposal(wager, participants.opponentUid);
  if (!opponentProposal) {
    return { ok: false, reason: "proposal-missing" };
  }
  const material = opponentProposal.material;
  const proposedCount = readWagerCount(opponentProposal);
  if (!isMaterialName(material) || proposedCount <= 0) {
    return { ok: false, reason: "insufficient-materials" };
  }
  const ownProposal = readWagerProposal(wager, participants.playerUid);
  const opponentLineage = await readModernProposalLineage(repository, {
    inviteId: request.inviteId,
    matchId: request.matchId,
    proposal: opponentProposal,
    uid: participants.opponentUid,
  });
  const ownLineage = ownProposal
    ? await readModernProposalLineage(repository, {
        inviteId: request.inviteId,
        matchId: request.matchId,
        proposal: ownProposal,
        uid: participants.playerUid,
      })
    : null;
  if (!opponentLineage || (ownProposal && !ownLineage)) {
    return { ok: false, reason: "proposal-unavailable" };
  }
  const opponentReservationOperationId = opponentLineage.reservationOperationId;
  const opponentProposalOperationId = opponentLineage.operationId;
  const ownReservationOperationId = ownLineage?.reservationOperationId || "";
  const ownProposalOperationId = ownLineage?.operationId || "";
  const totalMaterials = await repository.getMiningMaterials(
    participants.playerProfileId,
  );
  await mutation.refreshLease();
  const reservation = await reserveAcceptedMaterialsOnce(
    repository,
    participants.playerUid,
    reservationOperationId,
    material,
    proposedCount,
    ownProposal?.raw ?? null,
    totalMaterials,
    now,
    mutation.createCriticalPhaseSignal(),
  );
  if (reservation.acceptedCount <= 0 || !reservation.appliedDelta) {
    return { ok: false, reason: "insufficient-materials" };
  }

  const ownMaterial = ownProposal?.material ?? "";
  const ownCount = readWagerCount(ownProposal);
  const { wager: wagerAfter } = await observeProposalWrite({
    refreshLease: () => mutation.refreshLease(),
    command: async () => {
      const result = await repository.wagerWriter.acceptProposal(
        wagerKey,
        {
          playerUid: participants.playerUid,
          opponentUid: participants.opponentUid,
          operationId,
          material,
          proposedCount,
          opponentProposalOperationId,
          opponentReservationOperationId,
          hasOwnProposal: Boolean(ownProposal),
          ownMaterial,
          ownCount,
          ownProposalOperationId,
          ownReservationOperationId,
          acceptedCount: reservation.acceptedCount,
          now: now(),
          proposerAdjustmentOperationId,
          reservationOperationId,
        },
        mutation.createCriticalPhaseSignal(),
      );
      return result.value;
    },
    readback: () => repository.wagers.readWager(wagerKey),
  });
  const agreementOperation = wagerAfter?.agreementOperation.value;
  const agreement = wagerAfter?.agreed.value?.agreement;
  if (agreementOperation?.raw.id !== operationId || !agreement) {
    await releaseUnreferencedWagerReservation(repository, {
      playerUid: participants.playerUid,
      mutation,
      reservationOperationId,
      wagerKey,
    });
    return { ok: false, reason: "proposal-unavailable" };
  }

  await dependencies.assertMutationAllowed?.();
  await ensureWagerAgreementLineageReady(
    repository,
    wagerKey,
    now,
    dependencies.assertMutationAllowed,
  );
  return { ok: true, count: agreement.count };
}

async function removeProposal(
  repository: WagerWriteRepository,
  inviteId: string,
  matchId: string,
  proposalUid: string,
  operationId: string,
  expectedReservationOperationId: string,
  mutation: WagerMutationContext,
): Promise<WagerRemovalReceipt | null> {
  const wagerKey: WagerKey = { inviteId, matchId };
  const wagerBefore = await repository.wagers.readWager(wagerKey);
  const proposalBefore = readWagerProposal(wagerBefore, proposalUid);
  if (
    !wagerBefore?.agreed.raw &&
    !wagerBefore?.resolved.raw &&
    !wagerBefore?.settlement.raw &&
    proposalBefore &&
    !(await readModernProposalLineage(repository, {
      inviteId,
      matchId,
      proposal: proposalBefore,
      uid: proposalUid,
    }))
  ) {
    throw new Error("wager-removal-operation-invalid");
  }
  const observation = await observeProposalWrite({
    refreshLease: () => mutation.refreshLease(),
    command: async () => {
      const result = await repository.wagerWriter.removeProposal(
        wagerKey,
        {
          proposalUid,
          operationId,
          expectedReservationOperationId,
        },
        mutation.createCriticalPhaseSignal(),
      );
      if (result.decision === "proposal-invalid") {
        throw new Error("wager-removal-operation-invalid");
      }
      return result.value;
    },
    readback: () => repository.wagers.readWager(wagerKey),
  });
  if (
    observation.source === "readback" &&
    !readWagerRemovalReceipt(observation.wager, operationId)
  ) {
    throw new Error("wager-removal-unavailable");
  }
  return readWagerRemovalReceipt(observation.wager, operationId);
}

export async function removeWagerProposal(
  identity: RequestIdentity,
  request: WagerProposalRemovalRequest,
  action: WagerProposalAction,
  repository: WagerWriteRepository,
  dependencies: WagerProposalDependencies,
): Promise<WagerProposalRemovalResponse> {
  const authorization = await resolveWagerParticipantUids(
    identity,
    request.inviteId,
    repository,
  );
  if ("ok" in authorization) return authorization;
  return runWagerMutationWithLease(
    identity,
    request,
    action,
    dependencies,
    (mutation) =>
      removeWagerProposalUnlocked(
        identity,
        request,
        action,
        repository,
        dependencies,
        mutation,
      ),
  );
}

async function removeWagerProposalUnlocked(
  identity: RequestIdentity,
  request: WagerProposalRemovalRequest,
  action: WagerProposalAction,
  repository: WagerWriteRepository,
  dependencies: WagerProposalDependencies,
  mutation: WagerMutationContext,
): Promise<WagerProposalRemovalResponse> {
  const participants = await resolveWagerParticipantUids(
    identity,
    request.inviteId,
    repository,
  );
  if ("ok" in participants) {
    return participants;
  }
  const proposalUid =
    action === "cancel" ? participants.playerUid : participants.opponentUid;
  const operationId = await createOperationId(
    action,
    request.inviteId,
    request.matchId,
    proposalUid,
  );
  const proposalReservationOperationId =
    await createWagerReservationOperationId(
      "send",
      request.inviteId,
      request.matchId,
      proposalUid,
    );
  const proposal = await removeProposal(
    repository,
    request.inviteId,
    request.matchId,
    proposalUid,
    operationId,
    proposalReservationOperationId,
    mutation,
  );
  if (!proposal) {
    return { ok: false, reason: "proposal-missing" };
  }
  if (
    proposal.raw.reservationOperationId !== proposalReservationOperationId ||
    !validOperationId(proposal.raw.proposalOperationId)
  ) {
    throw new Error("wager-removal-operation-invalid");
  }
  try {
    const acceptReservationOperationId =
      await createWagerReservationOperationId(
        "accept",
        request.inviteId,
        request.matchId,
        proposalUid,
      );
    await releaseUnreferencedWagerReservation(repository, {
      playerUid: proposalUid,
      mutation,
      reservationOperationId: acceptReservationOperationId,
      wagerKey: { inviteId: request.inviteId, matchId: request.matchId },
    });
    await releaseUnreferencedWagerReservation(repository, {
      playerUid: proposalUid,
      mutation,
      reservationOperationId: proposalReservationOperationId,
      wagerKey: { inviteId: request.inviteId, matchId: request.matchId },
    });
  } catch {
    (
      dependencies.logMaterialReleaseFailure ||
      ((record) => console.error(JSON.stringify(record)))
    )({
      event: "wager_proposal_material_release_failed",
      action,
      inviteId: request.inviteId,
      matchId: request.matchId,
      proposalUid,
    });
    throw new Error("wager-material-release-failed");
  }
  return { ok: true };
}

export {
  consumeWagerReservationOperation,
  createWagerReservationOperationId,
  ensureWagerAgreementLineageReady,
  removeProposal,
  resolveWagerParticipants,
};
