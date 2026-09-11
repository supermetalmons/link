import {
  WAGER_FROZEN_READ_PATH,
  isWagerFrozenReadRequest,
  isWagerFrozenReadResponse,
  isWagerOutcomeResolveRequest,
  isWagerProposalAcceptRequest,
  isWagerProposalSendRequest,
} from "@mons/shared/wagers";
import { AuthApiFailure } from "../authErrors.ts";
import type { GameplayRepository } from "../gameplayRepository.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
} from "../profileOwnership.ts";
import { isSafeRecordKey } from "../recordKeys.ts";
import {
  resolveWagerOutcome,
  WAGER_SETTLEMENT_INITIAL_RETRY_DELAY_SECONDS,
} from "../wagerOutcome.ts";
import {
  acceptWagerProposal,
  removeWagerProposal,
  sendWagerProposal,
} from "../wagerProposal.ts";
import {
  defineGameplayRoute,
  invalidRequest,
  validateBody,
} from "./definition.ts";
import { createGameplayRuntime, type GameplayRuntime } from "./runtime.ts";

function normalizeWagerIds(value: { inviteId: string; matchId: string }) {
  const inviteId = value.inviteId.trim();
  const matchId = value.matchId.trim();
  if (!isSafeRecordKey(inviteId) || !isSafeRecordKey(matchId)) {
    throw invalidRequest();
  }
  return { inviteId, matchId };
}

function parseWagerProposalIds(body: Record<string, unknown>) {
  return normalizeWagerIds(validateBody(body, isWagerProposalAcceptRequest));
}

function runWager<T>(
  runtime: GameplayRuntime,
  work: (
    admittedRepository: GameplayRepository,
    guard: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const { reservations } = runtime;
  if (!reservations) throw new Error("wager-reservation-unavailable");
  return reservations.run(
    runtime.pathname,
    async (admittedRepository, admissionGuard) => {
      await reservations.assertClientVersion(runtime.request);
      return work(admittedRepository, async () => {
        await runtime.assertMutationAllowed();
        await admissionGuard();
      });
    },
  );
}

export const wagerRoutes = [
  defineGameplayRoute({
    path: WAGER_FROZEN_READ_PATH,
    readOnly: true,
    runtime: (context) => context,
    parse: (body) => validateBody(body, isWagerFrozenReadRequest),
    handle: async (body, runtime) => {
      const { identity, repository, reservations } = runtime;
      if (!reservations) throw invalidRequest();
      if (body.playerUid !== identity.uid) {
        const ownership = await requireProfileOwnershipSnapshot(repository, {
          loginUids: [identity.uid, body.playerUid],
          profileIds: [],
        });
        const profileId = getLoginProfileId(ownership, identity.uid);
        if (
          !profileId ||
          profileId !== getLoginProfileId(ownership, body.playerUid)
        ) {
          throw new AuthApiFailure(
            403,
            "permission-denied",
            "wager-player-not-owned",
          );
        }
      }
      const balance = await reservations.readBalance(body.playerUid);
      const response = { ok: true, playerUid: body.playerUid, ...balance };
      if (!isWagerFrozenReadResponse(response)) {
        throw new AuthApiFailure(
          503,
          "unavailable",
          "wager-reservation-unavailable",
        );
      }
      return response;
    },
  }),
  defineGameplayRoute({
    path: "/wagers/proposals/send",
    readOnly: false,
    runtime: createGameplayRuntime,
    parse: (body) => {
      const value = validateBody(body, isWagerProposalSendRequest);
      return {
        ...normalizeWagerIds(value),
        material: value.material,
        count: value.count,
      };
    },
    handle: (body, runtime) =>
      runWager(runtime, (admittedRepository, guard) =>
        sendWagerProposal(runtime.identity, body, admittedRepository, {
          ...runtime.wagerDependencies,
          assertMutationAllowed: guard,
        }),
      ),
  }),
  defineGameplayRoute({
    path: "/wagers/proposals/accept",
    readOnly: false,
    runtime: createGameplayRuntime,
    parse: parseWagerProposalIds,
    handle: (body, runtime) =>
      runWager(runtime, (admittedRepository, guard) =>
        acceptWagerProposal(runtime.identity, body, admittedRepository, {
          ...runtime.wagerDependencies,
          assertMutationAllowed: guard,
        }),
      ),
  }),
  defineGameplayRoute({
    path: "/wagers/proposals/cancel",
    readOnly: false,
    runtime: createGameplayRuntime,
    parse: parseWagerProposalIds,
    handle: (body, runtime) =>
      runWager(runtime, (admittedRepository, guard) =>
        removeWagerProposal(
          runtime.identity,
          body,
          "cancel",
          admittedRepository,
          { ...runtime.wagerDependencies, assertMutationAllowed: guard },
        ),
      ),
  }),
  defineGameplayRoute({
    path: "/wagers/proposals/decline",
    readOnly: false,
    runtime: createGameplayRuntime,
    parse: parseWagerProposalIds,
    handle: (body, runtime) =>
      runWager(runtime, (admittedRepository, guard) =>
        removeWagerProposal(
          runtime.identity,
          body,
          "decline",
          admittedRepository,
          { ...runtime.wagerDependencies, assertMutationAllowed: guard },
        ),
      ),
  }),
  defineGameplayRoute({
    path: "/wagers/outcomes/resolve",
    readOnly: false,
    runtime: createGameplayRuntime,
    parse: (body) =>
      normalizeWagerIds(validateBody(body, isWagerOutcomeResolveRequest)),
    handle: (body, runtime) =>
      runWager(runtime, (admittedRepository, guard) =>
        resolveWagerOutcome(runtime.identity, body, admittedRepository, {
          ...runtime.dependencies.wagerOutcome,
          assertMutationAllowed: guard,
          scheduleRetry:
            runtime.dependencies.wagerOutcome?.scheduleRetry ||
            (async (task) => {
              await runtime.env.WAGER_SETTLEMENT_QUEUE.send(task, {
                delaySeconds: WAGER_SETTLEMENT_INITIAL_RETRY_DELAY_SECONDS,
              });
            }),
          signal:
            runtime.dependencies.wagerOutcome?.signal || runtime.request.signal,
        }),
      ),
  }),
];
