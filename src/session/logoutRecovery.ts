let required = false;
const listeners = new Set<() => void>();

export const isLogoutRecoveryRequired = (): boolean => required;

export const subscribeToLogoutRecovery = (
  listener: () => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const setLogoutRecoveryRequired = (value: boolean): void => {
  if (required === value) return;
  required = value;
  for (const listener of listeners) listener();
};
