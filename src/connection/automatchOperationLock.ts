export type AutomatchOperationLockManager = {
  request<T>(
    name: string,
    callback: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T>;
};

export type AutomatchOperationLockRuntime = {
  isBrowser: boolean;
  lockManager: AutomatchOperationLockManager | null;
};

const getRuntime = (): AutomatchOperationLockRuntime => {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { isBrowser: false, lockManager: null };
  }
  return {
    isBrowser: true,
    lockManager: navigator.locks || null,
  };
};

export async function withAutomatchOperationLock<T>(
  uid: string,
  work: () => Promise<T>,
  runtime: AutomatchOperationLockRuntime = getRuntime(),
): Promise<T> {
  if (!runtime.isBrowser) {
    return work();
  }
  if (!runtime.lockManager) {
    throw new Error("automatch-coordination-unavailable");
  }
  return runtime.lockManager.request(`mons-automatch:${uid}`, work);
}
