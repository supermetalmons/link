import type { EventCreateDateTimePayload } from "@mons/shared/events";
import type {
  EventPrizeAssignment,
  EventPrizeWithdrawalResponse,
  EventRecord,
  PlayerProfile,
  ProfileEventPrizes,
} from "../connection/connectionModels";
import type { LeaderboardType } from "./leaderboardCache";

export type { EventCreateDateTimePayload } from "@mons/shared/events";

export type ProfileSurfaceDataPort = {
  createEvent(
    schedule: number | EventCreateDateTimePayload,
    options?: { announceOnTelegram?: boolean },
  ): Promise<{ ok: boolean; eventId?: string; event?: EventRecord | null }>;
  getLeaderboard(type: LeaderboardType): Promise<PlayerProfile[]>;
  subscribeToProfileEventPrizes(
    profileId: string,
    onUpdate: (prizes: ProfileEventPrizes) => void,
    onError?: (error: unknown) => void,
  ): () => void;
  withdrawEventPrize(
    eventId: string,
    prizeId: EventPrizeAssignment["prizeId"],
    solanaAddress: string,
  ): Promise<EventPrizeWithdrawalResponse>;
};

let port: ProfileSurfaceDataPort | null = null;

const getPort = (): ProfileSurfaceDataPort => {
  if (!port) {
    throw new Error("profile-surface-data-not-bound");
  }
  return port;
};

export const bindProfileSurfaceData = (
  nextPort: ProfileSurfaceDataPort,
): void => {
  port = nextPort;
};

export const createProfileEvent = (
  schedule: number | EventCreateDateTimePayload,
  options?: { announceOnTelegram?: boolean },
) => getPort().createEvent(schedule, options);

export const getLeaderboardProfiles = (type: LeaderboardType) =>
  getPort().getLeaderboard(type);

export const subscribeToProfileEventPrizes = (
  profileId: string,
  onUpdate: (prizes: ProfileEventPrizes) => void,
  onError?: (error: unknown) => void,
) => getPort().subscribeToProfileEventPrizes(profileId, onUpdate, onError);

export const withdrawProfileEventPrize = (
  eventId: string,
  prizeId: EventPrizeAssignment["prizeId"],
  solanaAddress: string,
) => getPort().withdrawEventPrize(eventId, prizeId, solanaAddress);
