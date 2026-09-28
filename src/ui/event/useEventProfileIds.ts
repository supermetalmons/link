import { useEffect, useMemo, useState } from "react";
import { connection } from "../../connection/connection";
import type { EventRecord } from "../../connection/connectionModels";
import type { EventModalState } from "./modalState";
import {
  getEventParticipant,
  getEventProfileIdsToResolve,
  type EventProfileIds,
} from "./eventState";

const EMPTY_PROFILE_IDS: EventProfileIds = {};

export function useEventProfileIds(
  event: EventRecord | null,
  profileId: string,
  loginUid: string,
  modalState: EventModalState,
) {
  const key =
    event &&
    profileId &&
    modalState.isOpen &&
    event.eventId === modalState.eventId
      ? JSON.stringify([event.eventId, profileId, loginUid])
      : null;
  const lookupKey =
    key && event
      ? JSON.stringify(
          getEventProfileIdsToResolve(event, profileId, loginUid).sort(),
        )
      : null;
  const cache = useMemo(
    () => ({
      key,
      modalState,
      requests: new Map<string, Promise<string>>(),
      profileIds: new Map<string, string>(),
    }),
    [key, modalState],
  );
  const [, refresh] = useState(0);

  useEffect(() => {
    if (!cache.key || !lookupKey) return;
    let canceled = false;
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();
    const ids: string[] = JSON.parse(lookupKey);
    const resolve = async (id: string, retryDelayMs = 2_000) => {
      if (canceled) return;
      let request = cache.requests.get(id);
      if (!request) {
        request = connection
          .resolveProfileId(id)
          .then((profileId) => profileId ?? "");
        cache.requests.set(id, request);
      }
      try {
        const canonicalId = await request;
        if (canceled) return;
        cache.profileIds.set(id, canonicalId);
        refresh((value) => value + 1);
      } catch {
        if (cache.requests.get(id) === request) cache.requests.delete(id);
        if (canceled) return;
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          void resolve(id, Math.min(retryDelayMs * 2, 30_000));
        }, retryDelayMs);
        retryTimers.add(timer);
      }
    };
    for (const id of ids) {
      if (!cache.profileIds.has(id)) void resolve(id);
    }
    return () => {
      canceled = true;
      retryTimers.forEach(clearTimeout);
    };
  }, [cache, lookupKey]);

  const ids: string[] = lookupKey ? JSON.parse(lookupKey) : [];
  const profileIds: EventProfileIds = key
    ? Object.fromEntries(
        [...cache.profileIds].filter(([id]) => ids.includes(id)),
      )
    : EMPTY_PROFILE_IDS;
  const membershipResolved = !!(
    event &&
    getEventParticipant(event, profileId, loginUid, profileIds) &&
    (event.createdByProfileId === profileId ||
      Object.hasOwn(profileIds, event.createdByProfileId))
  );
  return {
    profileIds,
    pending:
      key !== null &&
      !membershipResolved &&
      ids.some((id) => !cache.profileIds.has(id)),
  };
}
