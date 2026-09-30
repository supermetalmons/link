import React, { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import type { PlayerProfile } from "../../src/connection/connectionModels";
import {
  beginVerifiedProfileApplication,
  queueDeferredProfilePresentation,
} from "../../src/connection/deferredProfilePresentation";
import { Leaderboard } from "../../src/ui/Leaderboard";
import {
  leaderboardCache,
  resetLeaderboardCache,
  type LeaderboardType,
} from "../../src/ui/leaderboardCache";
import { profilesToLeaderboardEntries } from "../../src/ui/leaderboardModels";
import { bindProfileSurfaceData } from "../../src/ui/profileSurfaceDataPort";
import { bindShinyCardUi } from "../../src/ui/shinyCardUiPort";
import { useLeaderboard } from "../../src/ui/useLeaderboard";
import { profilesForUids } from "../../src/utils/playerMetadataCache";
import { storage } from "../../src/utils/storage";
import { environment } from "./leaderboardEnvironment";

const requests: Array<{
  type: LeaderboardType;
  resolve: (profiles: PlayerProfile[]) => void;
  reject: (error: Error) => void;
}> = [];
const cards: unknown[][] = [];
let cosmeticWrites = 0;

bindProfileSurfaceData({
  getLeaderboard: (type) =>
    new Promise((resolve, reject) => {
      requests.push({ type, resolve, reject });
    }),
  createEvent: async () => {
    throw new Error("Unexpected event creation");
  },
  subscribeToProfileEventPrizes: () => () => {},
  withdrawEventPrize: async () => {
    throw new Error("Unexpected withdrawal");
  },
});
bindShinyCardUi({
  show: async (...args) => {
    cards.push(args);
  },
  hide: () => {},
  updateDisplayName: () => {},
  getActiveInventoryItemSelection: () => ({
    avatarId: null,
    specialIds: new Set(),
  }),
  setOwnershipVerifiedSpecialItem: () => {},
  setOwnershipVerifiedIdCardEmoji: () => {},
});

let holdScrollResets = false;
const scrollResets: (() => void)[] = [];
const nativeSetTimeout = window.setTimeout.bind(window);
window.setTimeout = ((
  callback: TimerHandler,
  delay?: number,
  ...args: any[]
) => {
  if (holdScrollResets && delay === 5 && typeof callback === "function") {
    scrollResets.push(() => callback(...args));
    return -scrollResets.length;
  }
  return nativeSetTimeout(callback, delay, ...args);
}) as typeof window.setTimeout;

type Options = {
  show: boolean;
  leaderboardType: LeaderboardType;
  mode: "hook" | "view";
};
let options: Options = {
  show: false,
  leaderboardType: "rating",
  mode: "hook",
};
let current: ReturnType<typeof useLeaderboard> | null = null;
let commits = 0;
const root = createRoot(document.getElementById("root")!);

function Probe(props: Options) {
  const result = useLeaderboard(props);
  useLayoutEffect(() => {
    current = result;
    commits += 1;
  });
  return null;
}

async function update(run: () => void) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  try {
    await act(run);
  } finally {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
}

const writeStorage = (values: Record<string, unknown>) => {
  Object.entries(values).forEach(([key, value]) => {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  });
};
const wrapper = () => document.querySelector("table")?.parentElement;

Object.assign(window, {
  leaderboardHarness: {
    snapshot: () => ({
      ...current,
      commits,
      requests: requests.map(({ type }) => type),
      ensRequests: environment.ensRequests.map(({ address }) => address),
      cache: Object.fromEntries(leaderboardCache),
      cards,
      cosmeticWrites,
      scrollTop: wrapper()?.scrollTop ?? null,
      scrollResets: scrollResets.length,
    }),
    render: (patch: Partial<Options> = {}) =>
      update(() => {
        options = { ...options, ...patch };
        root.render(
          <React.StrictMode>
            {options.mode === "view" ? (
              <Leaderboard {...options} />
            ) : (
              <Probe {...options} />
            )}
          </React.StrictMode>,
        );
      }),
    writeStorage,
    stashProfile: (loginId: string, profile: PlayerProfile) => {
      profilesForUids[loginId] = profile;
    },
    seedCache: (type: LeaderboardType, profiles: PlayerProfile[]) => {
      leaderboardCache.set(type, profilesToLeaderboardEntries(profiles));
    },
    resetCache: resetLeaderboardCache,
    queueCosmetics: (values: Record<string, unknown>) => {
      const revision = beginVerifiedProfileApplication();
      queueDeferredProfilePresentation(
        revision,
        {
          profileId: storage.getProfileId(""),
          displayName: storage.getUsername(""),
        },
        () => true,
        Object.entries(values).map(([key, value]) => ({
          read: () => localStorage.getItem(key),
          write: () => {
            writeStorage({ [key]: value });
            cosmeticWrites += 1;
          },
        })),
      );
    },
    complete: (index: number, profiles: PlayerProfile[]) =>
      update(() => requests[index].resolve(profiles)),
    reject: (index: number) =>
      update(() =>
        requests[index].reject(new Error("leaderboard-unavailable")),
      ),
    resolveEns: (index: number, name: string | null) =>
      update(() => environment.ensRequests[index].resolve(name)),
    holdScrollResets: () => {
      holdScrollResets = true;
    },
    flushScrollResets: () =>
      update(() => scrollResets.splice(0).forEach((callback) => callback())),
    scrollTo: (top: number) => {
      const element = wrapper();
      if (element) {
        element.scrollTop = top;
        element.dispatchEvent(new Event("scroll"));
      }
    },
    dispose: () => update(() => root.unmount()),
  },
});
