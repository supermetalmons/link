import {
  MATERIAL_KEYS,
  createDropsForMiningEvent,
  formatMiningDateLocal,
} from "@mons/shared/mining";
import {
  MiningMaterialName,
  PlayerMiningData,
  PlayerMiningMaterials,
} from "../connection/connectionModels";
import { storage } from "../utils/storage";
import { getMiningConnection } from "../island/miningConnectionPort";
import {
  cloneMiningMaterials,
  createEmptyMiningMaterials,
  getRockVariantIndex,
  isAnonymousProfile,
  loadStoredMiningState,
  normalizeMiningState,
  shouldShowMiningRock,
} from "../island/miningState";

const getActiveProfileId = (): string => {
  return storage.getProfileId("");
};

type MiningListener = (snapshot: PlayerMiningData) => void;

type DidBreakRockResult = {
  drops: MiningMaterialName[];
  delta: PlayerMiningMaterials;
  date: string;
};

export type MaterialName = MiningMaterialName;

export const MATERIALS = MATERIAL_KEYS;

const createEmptyMaterials = (): PlayerMiningMaterials =>
  createEmptyMiningMaterials();

const cloneMaterials = (source: PlayerMiningMaterials): PlayerMiningMaterials =>
  cloneMiningMaterials(source);

const normalizeSnapshot = (
  source?: PlayerMiningData | null,
): PlayerMiningData => normalizeMiningState(source);

const formatMiningDate = formatMiningDateLocal;

const loadInitialSnapshot = (profileId: string): PlayerMiningData => {
  const materials = isAnonymousProfile(profileId)
    ? undefined
    : storage.getMiningMaterials(createEmptyMaterials());
  return loadStoredMiningState({
    profileId,
    lastRockDate: storage.getMiningLastRockDate(null),
    materials,
  });
};

const initialProfileId = getActiveProfileId();
const initialSnapshot = loadInitialSnapshot(initialProfileId);

let snapshot: PlayerMiningData = {
  lastRockDate: initialSnapshot.lastRockDate,
  materials: cloneMaterials(initialSnapshot.materials),
};

let serverSnapshotLoaded = isAnonymousProfile(initialProfileId);

const listeners = new Set<MiningListener>();

const notify = () => {
  const current = getSnapshot();
  listeners.forEach((listener) => listener(current));
};

const setSnapshot = (
  next: PlayerMiningData,
  persist: boolean,
  notifyListeners: boolean = true,
) => {
  const profileId = getActiveProfileId();
  const isAnon = isAnonymousProfile(profileId);
  const materials = isAnon
    ? createEmptyMaterials()
    : cloneMaterials(next.materials);
  snapshot = {
    lastRockDate: next.lastRockDate,
    materials,
  };
  if (isAnon) {
    serverSnapshotLoaded = true;
  }
  if (persist) {
    storage.setMiningLastRockDate(snapshot.lastRockDate);
    storage.setMiningMaterials(materials);
  }
  if (notifyListeners) {
    notify();
  }
};

const createDrops = (
  profileId: string,
  date: string,
  currentSnapshot: PlayerMiningData,
): { drops: MiningMaterialName[]; delta: PlayerMiningMaterials } =>
  createDropsForMiningEvent(profileId, date, currentSnapshot);

type MiningSubscription = () => void;

export const rocksMiningService = {
  MATERIALS,
  getSnapshot,
  subscribe,
  setFromServer,
  didBreakRock,
  formatMiningDate,
  shouldShowRock,
  getRockImageUrl,
  resetProfileMiningState,
};

function getSnapshot(): PlayerMiningData {
  const profileId = getActiveProfileId();
  const isAnon = isAnonymousProfile(profileId);
  return {
    lastRockDate: snapshot.lastRockDate,
    materials: isAnon
      ? createEmptyMaterials()
      : cloneMaterials(snapshot.materials),
  };
}

function subscribe(listener: MiningListener): MiningSubscription {
  listeners.add(listener);
  listener(getSnapshot());
  return () => {
    listeners.delete(listener);
  };
}

function setFromServer(
  data?: PlayerMiningData | null,
  options?: { persist?: boolean; notify?: boolean },
): void {
  const normalized = normalizeSnapshot(data);
  serverSnapshotLoaded = true;
  const shouldNotify = options?.notify !== false;
  setSnapshot(normalized, options?.persist !== false, shouldNotify);
}

function didBreakRock(): DidBreakRockResult {
  const date = formatMiningDate(new Date());
  const profileId = getActiveProfileId();
  const isAnon = isAnonymousProfile(profileId);
  const dropsData = isAnon
    ? {
        drops: [] as MiningMaterialName[],
        delta: createEmptyMaterials(),
      }
    : createDrops(profileId, date, snapshot);
  const { drops, delta } = dropsData;
  const baseMaterials = isAnon
    ? createEmptyMaterials()
    : cloneMaterials(snapshot.materials);
  const nextSnapshot: PlayerMiningData = {
    lastRockDate: date,
    materials: baseMaterials,
  };
  setSnapshot(nextSnapshot, true, true);
  const payload = {
    date,
    materials: cloneMaterials(delta),
  };
  if (!isAnon) {
    const profileIdAtRequest = profileId;
    const connection = getMiningConnection();
    const sessionGuard = connection.createSessionGuard();
    connection
      .mineRock(payload.date, payload.materials)
      .then((response) => {
        if (!sessionGuard() || getActiveProfileId() !== profileIdAtRequest) {
          return;
        }
        if (response && response.ok && response.mining) {
          setSnapshot(normalizeSnapshot(response.mining), true, false);
        }
      })
      .catch(() => {});
  }
  return { drops, delta, date };
}

function shouldShowRock(dateOverride?: string): boolean {
  const profileId = getActiveProfileId();
  const today = dateOverride ?? formatMiningDate(new Date());
  return shouldShowMiningRock({
    testingMode: false,
    profileId,
    serverSnapshotLoaded,
    snapshot,
    today,
  });
}

function getRockImageUrl(dateOverride?: string): string {
  const today = dateOverride ?? formatMiningDate(new Date());
  const profileId = getActiveProfileId();
  const index = getRockVariantIndex(profileId, today);
  return `https://cdn.lil.org/mons/rocks/gan/${index}.webp`;
}

export function resetProfileMiningState() {
  const profileId = getActiveProfileId();
  const initial = loadInitialSnapshot(profileId);
  snapshot = {
    lastRockDate: initial.lastRockDate,
    materials: cloneMaterials(initial.materials),
  };
  serverSnapshotLoaded = isAnonymousProfile(profileId);
  notify();
}
