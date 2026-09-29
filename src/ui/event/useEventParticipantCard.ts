import { useCallback, useRef } from "react";
import { connection } from "../../connection/connection";
import type {
  EventParticipant,
  PlayerProfile,
} from "../../connection/connectionModels";
import { getStashedPlayerProfile } from "../../utils/playerMetadata";
import { showShinyCard } from "../shinyCardUiPort";
import { PARTICIPANT_PROFILE_CACHE_TTL_MS } from "./eventLayout";
import {
  getParticipantDisplayName,
  getParticipantProfileCacheKey,
} from "./eventPresentation";
import { getEventModalState, type EventModalState } from "./modalState";

type ParticipantLookupGroup = {
  profileId: string;
  loginUid: string;
  modalState: EventModalState;
  displayName: string;
};
type ParticipantProfileCacheEntry = {
  profile: PlayerProfile;
  cachedAtMs: number;
};

export function useEventParticipantCard(modalState: EventModalState) {
  const activeParticipantLookupRef = useRef<ParticipantLookupGroup | null>(
    null,
  );
  const participantProfileCacheRef = useRef<
    Map<string, ParticipantProfileCacheEntry>
  >(new Map());
  const invalidateParticipantLookups = useCallback(() => {
    activeParticipantLookupRef.current = null;
    participantProfileCacheRef.current.clear();
  }, []);
  const resolveParticipantProfile = useCallback(
    async (participant: EventParticipant) => {
      const cachedProfile = participant.loginUid
        ? getStashedPlayerProfile(participant.loginUid)
        : undefined;
      if (cachedProfile && cachedProfile.id === participant.profileId) {
        return cachedProfile;
      }
      const profileCacheKey = getParticipantProfileCacheKey(participant);
      const eventCachedProfile = profileCacheKey
        ? participantProfileCacheRef.current.get(profileCacheKey)
        : undefined;
      if (
        eventCachedProfile &&
        Date.now() - eventCachedProfile.cachedAtMs <=
          PARTICIPANT_PROFILE_CACHE_TTL_MS
      ) {
        return eventCachedProfile.profile;
      }
      if (profileCacheKey) {
        participantProfileCacheRef.current.delete(profileCacheKey);
      }
      let profileById: PlayerProfile | null = null;
      if (participant.profileId) {
        try {
          profileById = await connection.getProfileById(participant.profileId);
        } catch (error) {
          if (!participant.loginUid) {
            throw error;
          }
        }
      }
      if (profileById) {
        return profileById;
      }
      const exactProfile = participant.loginUid
        ? await connection.getProfileByLoginId(participant.loginUid)
        : null;
      return exactProfile ?? null;
    },
    [],
  );

  const handleParticipantClick = useCallback(
    async (participant: EventParticipant) => {
      const lookupModalState = getEventModalState();
      const isCurrentModalRender = lookupModalState === modalState;
      const participantKey = participant.profileId || participant.loginUid;
      if (
        !participantKey ||
        !isCurrentModalRender ||
        !lookupModalState.isOpen ||
        !lookupModalState.eventId
      ) {
        return;
      }
      const displayName = getParticipantDisplayName(participant);
      const profileCacheKey = getParticipantProfileCacheKey(participant);
      let lookupGroup = activeParticipantLookupRef.current;
      if (
        !lookupGroup ||
        lookupGroup.profileId !== participant.profileId ||
        lookupGroup.loginUid !== participant.loginUid ||
        lookupGroup.modalState !== lookupModalState
      ) {
        lookupGroup = {
          profileId: participant.profileId,
          loginUid: participant.loginUid,
          modalState: lookupModalState,
          displayName,
        };
        activeParticipantLookupRef.current = lookupGroup;
      } else {
        lookupGroup.displayName = displayName;
      }
      try {
        const profile = await resolveParticipantProfile(participant);
        if (
          !profile ||
          activeParticipantLookupRef.current !== lookupGroup ||
          getEventModalState() !== lookupGroup.modalState
        ) {
          return;
        }
        const profileCacheEntry = {
          profile,
          cachedAtMs: Date.now(),
        };
        participantProfileCacheRef.current.set(
          profileCacheKey,
          profileCacheEntry,
        );
        if (profile.id) {
          participantProfileCacheRef.current.set(
            `profile:${profile.id}`,
            profileCacheEntry,
          );
        }
        activeParticipantLookupRef.current = null;
        await showShinyCard(profile, lookupGroup.displayName, true);
      } catch {}
    },
    [modalState, resolveParticipantProfile],
  );

  return {
    open: handleParticipantClick,
    invalidate: invalidateParticipantLookups,
  };
}
