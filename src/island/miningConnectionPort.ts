import type {
  PlayerMiningData,
  PlayerMiningMaterials,
} from "../connection/connectionModels";

export type MiningConnectionPort = {
  createSessionGuard: () => () => boolean;
  mineRock: (
    date: string,
    materials: PlayerMiningMaterials,
  ) => Promise<{ ok?: boolean; mining?: PlayerMiningData } | null>;
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
