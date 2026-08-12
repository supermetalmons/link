import { useEffect, useState } from "react";

import type { CachedResource } from "./cachedResource";

export const useCachedResource = <T>(resource: CachedResource<T>) => {
  const initialValue = resource.getCachedValue();
  const [value, setValue] = useState<T | null>(initialValue);
  const [isLoading, setIsLoading] = useState(initialValue === null);

  useEffect(() => {
    let cancelled = false;
    const cachedValue = resource.getCachedValue();
    if (cachedValue !== null) {
      setValue(cachedValue);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void resource.load().then((loadedValue) => {
      if (cancelled) {
        return;
      }
      setValue(loadedValue);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [resource]);

  return { value, isLoading };
};
