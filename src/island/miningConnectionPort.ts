import type { PlayerMiningMaterials } from "../connection/connectionModels";
import type { MineRockResponse } from "@mons/shared/mining";

export type MiningConnectionPort = {
  createSessionGuard: () => () => boolean;
  mineRock: (
    date: string,
    materials: PlayerMiningMaterials,
  ) => Promise<MineRockResponse>;
};

let miningConnectionPort: MiningConnectionPort | null = null;

export const bindMiningConnection = (port: MiningConnectionPort): void => {
  miningConnectionPort = port;
};

export const getMiningConnection = (): MiningConnectionPort => {
  if (!miningConnectionPort) {
    throw new Error("Mining connection port is not bound.");
  }
  return miningConnectionPort;
};
