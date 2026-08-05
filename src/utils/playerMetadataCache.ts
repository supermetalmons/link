import type {
  PlayerMiningData,
  PlayerProfile,
} from "../connection/connectionModels";

export const usernamesForUids: Record<string, string> = {};
export const ethAddressesForUids: Record<string, string> = {};
export const solAddressesForUids: Record<string, string> = {};
export const ensForUids: Record<string, { name: string; avatar: string }> = {};
export const profilesForUids: Record<string, PlayerProfile> = {};

export type PendingOwnProfileMiningState = {
  profileId: string;
  mining: PlayerMiningData;
};

let pendingOwnProfileMiningState: PendingOwnProfileMiningState | null = null;

export const getPendingOwnProfileMiningState = () =>
  pendingOwnProfileMiningState;

export const setPendingOwnProfileMiningState = (
  state: PendingOwnProfileMiningState | null,
) => {
  pendingOwnProfileMiningState = state;
};

export const resetPendingOwnProfileMiningState = () => {
  pendingOwnProfileMiningState = null;
};

export function resetPlayerMetadataCaches() {
  Object.keys(usernamesForUids).forEach((key) => delete usernamesForUids[key]);
  Object.keys(ethAddressesForUids).forEach(
    (key) => delete ethAddressesForUids[key],
  );
  Object.keys(solAddressesForUids).forEach(
    (key) => delete solAddressesForUids[key],
  );
  Object.keys(ensForUids).forEach((key) => delete ensForUids[key]);
  Object.keys(profilesForUids).forEach((key) => delete profilesForUids[key]);
  resetPendingOwnProfileMiningState();
}
