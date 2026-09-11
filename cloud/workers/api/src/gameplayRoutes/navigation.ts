import {
  inferAutomatchStateHint,
  isReadNavigationGamesRequest,
  isRemoveNavigationGameRequest,
  type RemoveNavigationGameResponse,
} from "@mons/shared/navigation";
import { AuthApiFailure } from "../authErrors.ts";
import { isSafeRecordKey } from "../recordKeys.ts";
import type { RequestIdentity } from "../requestIdentity.ts";
import type { GameplayRepository } from "../gameplayRepository.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
} from "../profileOwnership.ts";
import { readProfileGamesPage } from "../profileGamesD1.ts";
import {
  defineGameplayRoute,
  normalizeString,
  toRecord,
  validateBody,
} from "./definition.ts";
import { createGameplayRuntime } from "./runtime.ts";

export async function resolveProfileId(
  identity: RequestIdentity,
  repository: GameplayRepository,
): Promise<string> {
  const ownership = await requireProfileOwnershipSnapshot(repository, {
    loginUids: [identity.uid],
    profileIds: [],
  });
  return getLoginProfileId(ownership, identity.uid) || "";
}

function skippedNavigationResponse(
  inviteId: string,
  reason: string,
): RemoveNavigationGameResponse {
  return { ok: true, skipped: true, reason, inviteId };
}

export async function removeNavigationGame(
  identity: RequestIdentity,
  inviteId: string,
  repository: GameplayRepository,
): Promise<RemoveNavigationGameResponse> {
  const profileId = await resolveProfileId(identity, repository);
  if (!profileId) {
    return skippedNavigationResponse(inviteId, "profile-unresolved");
  }
  const [inviteValue, automatchValue] = await Promise.all([
    repository.readInviteMetadata(inviteId),
    repository.getStatePath(`automatch/${inviteId}`),
  ]);
  const invite = toRecord(inviteValue);
  if (!invite) {
    return skippedNavigationResponse(inviteId, "invite-missing");
  }
  const guestId = normalizeString(invite.guestId);
  if (guestId) {
    return skippedNavigationResponse(inviteId, "invite-active");
  }
  if (
    inferAutomatchStateHint({
      inviteId,
      queueValue: automatchValue,
      hasGuest: false,
      storedStateHint: invite.automatchStateHint,
    }) === "pending"
  ) {
    return skippedNavigationResponse(inviteId, "pending-automatch");
  }
  const game = await repository.getNavigationGame(profileId, inviteId);
  if (!game) {
    return {
      ...skippedNavigationResponse(inviteId, "not-found"),
      deleted: false,
    };
  }
  if (game.status !== "waiting") {
    return {
      ...skippedNavigationResponse(
        inviteId,
        game.status ? `status-${game.status}` : "status-missing",
      ),
      deleted: false,
    };
  }
  const result = await repository.deleteNavigationGame(profileId, inviteId);
  return result === "deleted"
    ? {
        ok: true,
        skipped: false,
        deleted: true,
        reason: null,
        inviteId,
      }
    : {
        ...skippedNavigationResponse(inviteId, "not-found"),
        deleted: false,
      };
}

export const navigationRoutes = [
  defineGameplayRoute({
    path: "/navigation/games/read",
    readOnly: true,
    runtime: createGameplayRuntime,
    parse: (body) => validateBody(body, isReadNavigationGamesRequest),
    async handle(body, { identity, repository, dependencies, env }) {
      const profileId = await resolveProfileId(identity, repository);
      return profileId
        ? (dependencies.readNavigationPage || readProfileGamesPage)(
            dependencies.profileGamesDb || env.PROFILE_GAMES_DB,
            profileId,
            body.limit,
            body.cursor,
          )
        : { ok: true, items: [], nextCursor: null, hasMore: false };
    },
  }),
  defineGameplayRoute({
    path: "/navigation/games/remove",
    readOnly: false,
    runtime: createGameplayRuntime,
    parse(body) {
      const value = validateBody(body, isRemoveNavigationGameRequest);
      const inviteId = value.inviteId.trim();
      if (!isSafeRecordKey(inviteId)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-invite-id");
      }
      return { inviteId };
    },
    handle: (body, { identity, repository }) =>
      removeNavigationGame(identity, body.inviteId, repository),
  }),
];
