import {
  emptyAutomatchEntryFields,
  type AutomatchEntryRead,
} from "../../../../runtime/automatchRecords.js";
import { getDisplayNameFromAddress } from "../../../../runtime/telegramDisplay.js";
import { measureAutomatchPhase } from "../automatchTelemetry.ts";
import type { AutomatchRepository } from "../gameplayContracts.ts";
import type { GameplayProfile } from "../gameplayRepository.ts";
import {
  getLoginProfileId,
  getOwnershipProfile,
  getProfileLoginUids,
  loginsShareProfile,
  profileOwnershipUnavailable,
  requireProfileOwnershipSnapshot,
} from "../profileOwnership.ts";
import { profileOrFallback } from "./plans.ts";
import { AUTOMATCH_OWNER_LOGIN_UID_LIMIT } from "./policy.ts";
import type {
  AutomatchPlanInput,
  AutomatchRequesterSnapshot,
  QueuedAutomatch,
  StartAutomatchOperationRequest,
} from "./types.ts";

type AutomatchDisplay = Pick<AutomatchPlanInput, "emojiId" | "aura" | "name">;

export type AutomatchSelection =
  | {
      kind: "create-pending";
      profile: GameplayProfile;
      display: AutomatchDisplay;
    }
  | {
      kind: "reuse-owned";
      inviteId: string;
      ownerUids: readonly string[];
    }
  | {
      kind: "match";
      queued: QueuedAutomatch;
      existingUid: string;
      display: AutomatchDisplay;
    }
  | { kind: "reselect" };

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getFirstQueuedAutomatch(
  value: Record<string, AutomatchEntryRead> | null,
): QueuedAutomatch | null {
  const queue = value;
  if (!queue) {
    return null;
  }
  const first = Object.entries(queue)[0];
  if (!first) {
    return null;
  }
  const [inviteId, data] = first;
  return { inviteId, data: data.record || emptyAutomatchEntryFields() };
}

export async function selectAutomatchAttempt(
  {
    requesterUid,
    request,
    requester,
    signal,
  }: {
    requesterUid: string;
    request: StartAutomatchOperationRequest;
    requester: AutomatchRequesterSnapshot;
    signal: AbortSignal;
  },
  {
    repository,
    convergeOwnedQueues,
  }: {
    repository: Pick<
      AutomatchRepository,
      "readFirstAutomatchEntry" | "readProfileOwnershipSnapshot"
    >;
    convergeOwnedQueues: (
      loginUids: readonly string[],
      signal: AbortSignal,
    ) => Promise<QueuedAutomatch | null>;
  },
): Promise<AutomatchSelection> {
  const queued = getFirstQueuedAutomatch(
    await measureAutomatchPhase("selection", () =>
      repository.readFirstAutomatchEntry(signal),
    ),
  );
  let profile = profileOrFallback(requester.profile, request);
  const existingUid = queued ? normalizeString(queued.data.uid) : "";
  if (queued && existingUid !== requesterUid) {
    const pairOwnership = await measureAutomatchPhase("ownership", () =>
      requireProfileOwnershipSnapshot(repository, {
        loginUids: [requesterUid, existingUid],
        profileIds: [],
      }),
    );
    const existingProfileId = getLoginProfileId(pairOwnership, existingUid);
    const existingLoginUids = existingProfileId
      ? getProfileLoginUids(pairOwnership, existingProfileId)
      : [existingUid];
    if (existingLoginUids.length > AUTOMATCH_OWNER_LOGIN_UID_LIMIT) {
      throw profileOwnershipUnavailable();
    }
    const existingSurvivor = await convergeOwnedQueues(
      existingLoginUids,
      signal,
    );
    if (!existingSurvivor) {
      return { kind: "reselect" };
    }
    if (loginsShareProfile(pairOwnership, requesterUid, existingUid)) {
      return {
        kind: "reuse-owned",
        inviteId: existingSurvivor.inviteId,
        ownerUids: existingLoginUids,
      };
    }
    if (existingSurvivor.inviteId !== queued.inviteId) {
      return { kind: "reselect" };
    }
    const profileId = getLoginProfileId(pairOwnership, requesterUid);
    profile = profileOrFallback(
      profileId
        ? getOwnershipProfile(pairOwnership, profileId)?.profile || null
        : null,
      request,
    );
  }
  const hasProfile = profile.profileId !== "";
  const emojiId = hasProfile ? profile.emoji : request.emojiId;
  const aura = (hasProfile ? profile.aura : request.aura) || null;
  const name = getDisplayNameFromAddress(
    profile.username,
    profile.eth,
    profile.sol,
    profile.rating,
    emojiId,
  );
  const display = { emojiId, aura, name };

  if (!queued) {
    return { kind: "create-pending", profile, display };
  }
  if (existingUid === requesterUid) {
    return {
      kind: "reuse-owned",
      inviteId: queued.inviteId,
      ownerUids: [requesterUid],
    };
  }
  return { kind: "match", queued, existingUid, display };
}
