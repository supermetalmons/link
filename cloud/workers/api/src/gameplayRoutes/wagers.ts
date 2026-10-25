import { queueFor } from "../queueProducers.ts";
import {
  WAGER_FROZEN_READ_PATH,
  isWagerFrozenReadRequest,
  isWagerFrozenReadResponse,
  isWagerOutcomeResolveRequest,
  isWagerProposalAcceptRequest,
  isWagerProposalSendRequest,
} from "@mons/shared/wagers";
import { AuthApiFailure } from "../authErrors.ts";
import type { WagerWriteRepository } from "../gameplayRepository.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
} from "../profileOwnership.ts";
import { isSafeRecordKey } from "../recordKeys.ts";
import {
  enforceWagerOutcomeRateLimit,
  resolveWagerOutcome,
  WAGER_SETTLEMENT_INITIAL_RETRY_DELAY_SECONDS,
} from "../wagerOutcome.ts";
import {
  acceptWagerProposal,
  removeWagerProposal,
  sendWagerProposal,
  type WagerProposalDependencies,
} from "../wagerProposal.ts";
import {
  assertWagerClientVersion,
  createWagerReservationRuntime,
  type WagerReservationRuntime,
} from "../wagerReservationRuntime.ts";
import {
  defineGameplayRoute,
  invalidRequest,
  validateBody,
} from "./definition.ts";
import {
  createGameplayMutationLocks,
  gameplayMutationGuard,
  type GameplayRequestContext,
} from "./runtime.ts";

type WagerRequestContext = GameplayRequestContext & {
  reservations: WagerReservationRuntime;
};

function prepareWagerRequest(
  context: GameplayRequestContext,
): WagerRequestContext {
  const reservations =
    context.dependencies.wagerReservations ||
    createWagerReservationRuntime(context.env, context.repository);
  return { ...context, reservations };
}

function prepareWagerMutation(
  context: GameplayRequestContext,
): WagerRequestContext {
  const prepared = prepareWagerRequest(context);
  assertWagerClientVersion(context.request);
  return prepared;
}

function createWagerRuntime(context: WagerRequestContext) {
  return {
    ...context,
    assertMutationAllowed: gameplayMutationGuard(context),
  };
}

function createWagerProposalRuntime(context: WagerRequestContext) {
  const runtime = createWagerRuntime(context);
  const wagerDependencies: WagerProposalDependencies = {
    ...context.dependencies.wager,
    assertMutationAllowed: runtime.assertMutationAllowed,
    mutationLocks: createGameplayMutationLocks(context),
  };
  return { ...runtime, wagerDependencies };
}

function prepareWagerProposalRequest(context: GameplayRequestContext) {
  const prepared = prepareWagerMutation(context);
  return { runtime: () => createWagerProposalRuntime(prepared) };
}

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
  runtime: ReturnType<typeof createWagerRuntime>,
  work: (
    admittedRepository: WagerWriteRepository,
    guard: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const { reservations } = runtime;
  return reservations.run(
    runtime.pathname,
    async (admittedRepository, admissionGuard) => {
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
    prepareRequest(context) {
      const prepared = prepareWagerRequest(context);
      return { runtime: () => prepared };
    },
    parse: (body) => validateBody(body, isWagerFrozenReadRequest),
    handle: async (body, runtime) => {
      const { identity, repository, reservations } = runtime;
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
    prepareRequest: prepareWagerProposalRequest,
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
    prepareRequest: prepareWagerProposalRequest,
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
    prepareRequest: prepareWagerProposalRequest,
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
    prepareRequest: prepareWagerProposalRequest,
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
    prepareRequest(context) {
      const prepared = prepareWagerMutation(context);
      return {
        beforeBody: () =>
          enforceWagerOutcomeRateLimit(
            context.env.AUTH_RATE_LIMITER,
            context.identity.uid,
          ),
        runtime: () => createWagerRuntime(prepared),
      };
    },
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
              await queueFor(runtime.env, "WAGER_SETTLEMENT_QUEUE").send(task, {
                delaySeconds: WAGER_SETTLEMENT_INITIAL_RETRY_DELAY_SECONDS,
              });
            }),
          signal:
            runtime.dependencies.wagerOutcome?.signal || runtime.request.signal,
        }),
      ),
  }),
];
