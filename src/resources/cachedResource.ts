export type CachedResource<T> = {
  getCachedValue: () => T | null;
  load: () => Promise<T | null>;
};

export const createCachedResource = <T>(
  loader: () => Promise<T>,
  onError: (error: unknown) => void,
): CachedResource<T> => {
  let cachedValue: T | null = null;
  let loadingPromise: Promise<T | null> | null = null;

  return {
    getCachedValue: () => cachedValue,
    load: () => {
      if (cachedValue !== null) {
        return Promise.resolve(cachedValue);
      }
      if (loadingPromise) {
        return loadingPromise;
      }
      loadingPromise = loader()
        .then((value) => {
          cachedValue = value;
          return value;
        })
        .catch((error: unknown) => {
          onError(error);
          return null;
        })
        .finally(() => {
          loadingPromise = null;
        });
      return loadingPromise;
    },
  };
};
