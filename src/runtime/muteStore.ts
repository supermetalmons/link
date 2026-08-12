import { storage } from "../utils/storage";

type MuteListener = () => void;

let isMuted = storage.getIsMuted(false);
const listeners = new Set<MuteListener>();

export const getIsMuted = (): boolean => isMuted;

export const setIsMuted = (nextIsMuted: boolean): void => {
  if (isMuted === nextIsMuted) {
    return;
  }
  isMuted = nextIsMuted;
  listeners.forEach((listener) => listener());
};

export const persistMuteState = (): void => {
  try {
    storage.setIsMuted(isMuted);
  } catch {}
};

export const subscribeToMuteState = (listener: MuteListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
