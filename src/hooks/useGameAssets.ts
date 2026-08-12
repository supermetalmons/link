import { createCachedResource } from "../resources/cachedResource";
import { useCachedResource } from "../resources/useCachedResource";

type GameAssets = Record<string, string>;

const gameAssetsResource = createCachedResource<GameAssets>(
  async () => (await import("../assets/gameAssetsPixel")).gameAssets,
  (error) => {
    console.error("Failed to load game assets:", error);
  },
);

export const useGameAssets = () => {
  const { value: assets, isLoading } = useCachedResource(gameAssetsResource);
  return { assets, isLoading };
};
