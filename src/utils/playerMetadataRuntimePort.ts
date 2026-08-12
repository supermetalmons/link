import type { PlayerProfile } from "../connection/connectionModels";

export type PlayerMetadataRuntime = {
  createSessionGuard(): () => boolean;
  getProfileByLoginId(loginId: string): Promise<PlayerProfile>;
  updateEmoji(
    newId: number,
    matchOnly: boolean,
    aura: string | null | undefined,
  ): void;
  updateEmojiAndAuraIfNeeded(
    emojiId: string,
    aura: string | null | undefined,
    isOpponentSide: boolean,
  ): void;
  isWatchOnly(): boolean;
  updateProfileDisplayName(
    username: string | null,
    ethAddress: string | null,
    solAddress: string | null,
  ): void;
  syncTutorialProgress(
    completedProblemIds: string[],
    isTutorialCompleted: boolean,
  ): void;
  syncOwnProfileMiningState(profile: PlayerProfile): void;
};

let runtime: PlayerMetadataRuntime | null = null;

const getRuntime = (): PlayerMetadataRuntime => {
  if (!runtime) {
    throw new Error("player-metadata-runtime-not-bound");
  }
  return runtime;
};

export const bindPlayerMetadataRuntime = (
  nextRuntime: PlayerMetadataRuntime,
): void => {
  runtime = nextRuntime;
};

export const createPlayerMetadataSessionGuard = (): (() => boolean) =>
  getRuntime().createSessionGuard();

export const getPlayerProfileByLoginId = (
  loginId: string,
): Promise<PlayerProfile> => getRuntime().getProfileByLoginId(loginId);

export const updatePlayerEmoji = (
  newId: number,
  matchOnly: boolean,
  aura: string | null | undefined,
): void => getRuntime().updateEmoji(newId, matchOnly, aura);

export const updatePlayerEmojiAndAura = (
  emojiId: string,
  aura: string | null | undefined,
  isOpponentSide: boolean,
): void =>
  getRuntime().updateEmojiAndAuraIfNeeded(emojiId, aura, isOpponentSide);

export const isPlayerMetadataWatchOnly = (): boolean =>
  getRuntime().isWatchOnly();

export const updatePlayerProfileDisplayName = (
  username: string | null,
  ethAddress: string | null,
  solAddress: string | null,
): void =>
  getRuntime().updateProfileDisplayName(username, ethAddress, solAddress);

export const syncPlayerTutorialProgress = (
  completedProblemIds: string[],
  isTutorialCompleted: boolean,
): void =>
  getRuntime().syncTutorialProgress(completedProblemIds, isTutorialCompleted);

export const syncPlayerMiningState = (profile: PlayerProfile): void =>
  getRuntime().syncOwnProfileMiningState(profile);
