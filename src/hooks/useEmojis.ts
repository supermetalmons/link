import { createCachedResource } from "../resources/cachedResource";
import { useCachedResource } from "../resources/useCachedResource";

type Emojis = (typeof import("../content/emojis"))["emojis"] &
  Record<string, any>;

const emojisResource = createCachedResource<Emojis>(
  async () => (await import("../content/emojis")).emojis as Emojis,
  (error) => {
    console.error("Failed to load emojis:", error);
  },
);

export const useEmojis = () => {
  const { value: emojis, isLoading } = useCachedResource(emojisResource);
  return { emojis, isLoading };
};
