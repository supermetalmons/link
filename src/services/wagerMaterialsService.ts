import {
  applyMaterialDeltas,
  computeAvailableMaterials as computeSharedAvailableMaterials,
  createEmptyMaterials as createSharedEmptyMaterials,
  normalizeMaterials as normalizeSharedMaterials,
} from "@mons/shared/mining";
import type { MaterialName } from "./rocksMiningService";

type FrozenMaterials = Record<MaterialName, number>;

export type FrozenMaterialsStatus =
  "idle" | "loading" | "ready" | "updating" | "unavailable";

type FrozenListener = (
  materials: FrozenMaterials,
  status: FrozenMaterialsStatus,
  hasConfirmedSnapshot: boolean,
) => void;

const createEmptyMaterials = (): FrozenMaterials =>
  createSharedEmptyMaterials();

const normalizeMaterials = (
  source?: Partial<Record<MaterialName, number>> | null,
): FrozenMaterials => normalizeSharedMaterials(source);

let frozenMaterials = createEmptyMaterials();
let status: FrozenMaterialsStatus = "idle";
let hasConfirmedSnapshot = false;

const listeners = new Set<FrozenListener>();

const notify = () => {
  const snapshot = getFrozenMaterials();
  listeners.forEach((listener) =>
    listener(snapshot, status, hasConfirmedSnapshot),
  );
};

export const getFrozenMaterials = (): FrozenMaterials => {
  return { ...frozenMaterials };
};

export const getFrozenMaterialsStatus = (): FrozenMaterialsStatus => status;

export const hasConfirmedFrozenMaterials = (): boolean => hasConfirmedSnapshot;

export const setFrozenMaterials = (
  source?: Partial<Record<MaterialName, number>> | null,
  nextStatus = status,
): void => {
  frozenMaterials = normalizeMaterials(source);
  status = nextStatus;
  if (status === "ready") hasConfirmedSnapshot = true;
  else if (status === "loading" || status === "idle") {
    hasConfirmedSnapshot = false;
  }
  notify();
};

export const setFrozenMaterialsStatus = (
  nextStatus: FrozenMaterialsStatus,
): void => {
  status = nextStatus;
  notify();
};

export const subscribeToFrozenMaterials = (listener: FrozenListener) => {
  listeners.add(listener);
  listener(getFrozenMaterials(), status, hasConfirmedSnapshot);
  return () => {
    listeners.delete(listener);
  };
};

export const applyFrozenMaterialsDelta = (
  deltas?: Partial<Record<MaterialName, number>> | null,
): FrozenMaterials => {
  const next = applyMaterialDeltas(getFrozenMaterials(), deltas);
  setFrozenMaterials(next);
  return getFrozenMaterials();
};

export const computeAvailableMaterials = (
  total: FrozenMaterials,
  frozen: FrozenMaterials,
): FrozenMaterials => computeSharedAvailableMaterials(total, frozen);

export const resetWagerMaterialsState = () => {
  frozenMaterials = createEmptyMaterials();
  status = "idle";
  hasConfirmedSnapshot = false;
  notify();
};
