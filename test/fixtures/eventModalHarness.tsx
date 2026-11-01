import { requireValue } from "./browserAssertions";
import {
  parseEventRecord,
  decodeEventMatchView,
  decodeEventRoundView,
  type EventRecordFields,
  type EventRoundFields,
  type EventMatchFields,
} from "@mons/shared/events";
import React, { act, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  EventParticipant,
  EventRecord,
} from "../../src/connection/connectionModels";
import { storage } from "../../src/utils/storage";
import {
  closeEventModal,
  getEventModalState,
  openEventModal,
  syncEventModalToRoute,
} from "../../src/ui/event/modalState";
import { getCurrentRouteState } from "../../src/navigation/routeState";
import {
  useEventModalController,
  type EventModalController,
} from "../../src/ui/event/useEventModalController";
import {
  useEventModalActions,
  type EventModalActionsOptions,
} from "../../src/ui/event/useEventModalActions";
import {
  getEventPrizeConfig,
  LEGACY_CORE_PRIZES_EVENT_ID,
} from "@mons/shared/event-prizes";
import { environment, connection } from "./eventModalEnvironment";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let now = 1_000_000;
Date.now = () => now;
let nextTimer = 0;
const timers = new Map<
  number,
  { callback: () => void; at: number; delay: number; interval: boolean }
>();
Object.defineProperty(window, "setTimeout", {
  value: (callback: () => void, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay, delay, interval: false });
    return id;
  },
});
Object.defineProperty(window, "setInterval", {
  value: (callback: () => void, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay, delay, interval: true });
    return id;
  },
});
window.clearTimeout = window.clearInterval = (id?: unknown) => {
  if (typeof id === "number") timers.delete(id);
};
window.alert = (value) => {
  environment.alerts.push(String(value));
};
window.prompt = (value) => {
  environment.prompts.push(String(value));
  return environment.promptAnswers.shift() ?? null;
};
window.confirm = (value) => {
  environment.confirmations.push(String(value));
  return environment.confirmAnswers.shift() ?? false;
};

const participant = (
  profileId: string,
  loginUid = `${profileId}-login`,
): EventParticipant => ({
  profileId,
  loginUid,
  username: profileId,
  displayName: profileId.toUpperCase(),
  emojiId: 1,
  aura: "none",
  joinedAtMs: 1,
  state: "active",
  eliminatedRoundIndex: null,
  eliminatedByProfileId: null,
});
type MatchPatch = Partial<EventMatchFields>;
type RoundPatch = Partial<Omit<EventRoundFields, "matches">> & {
  matches?: Record<string, MatchPatch>;
};
export type EventPatch = Partial<
  Omit<EventRecordFields, "rounds" | "thirdPlaceMatch">
> & {
  rounds?: Record<string, RoundPatch>;
  thirdPlaceMatch?: MatchPatch | null;
};
export type ActionsPatch = Omit<
  Partial<EventModalActionsOptions>,
  "eventRecord"
> & { eventRecord?: EventPatch | null };
function matchRecord(key: string, patch: MatchPatch = {}) {
  const status = patch.status ?? "upcoming";
  const host =
    patch.hostProfileId ??
    (status !== "upcoming" || patch.hostDisplayName ? "p1" : null);
  const guest =
    patch.guestProfileId ??
    (status !== "upcoming" || patch.guestDisplayName ? "p2" : null);
  return decodeEventMatchView(
    {
      matchKey: key,
      status,
      inviteId: status === "pending" ? "fixture-match" : null,
      resolvedAtMs:
        status === "host" || status === "guest" || status === "bye" ? 1 : null,
      winnerDisqualified: false,
      winnerProfileId:
        status === "host" ? host : status === "guest" ? guest : null,
      loserProfileId:
        status === "host" ? guest : status === "guest" ? host : null,
      hostSlotBlocked: false,
      guestSlotBlocked: false,
      hostProfileId: host,
      hostLoginUid: host ? `${host}-login` : null,
      hostDisplayName: host,
      hostEmojiId: host ? 1 : null,
      hostAura: host ? "none" : null,
      guestProfileId: guest,
      guestLoginUid: guest ? `${guest}-login` : null,
      guestDisplayName: guest,
      guestEmojiId: guest ? 1 : null,
      guestAura: guest ? "none" : null,
      ...patch,
    },
    key,
  );
}
const eventRecord = (id: string, patch: EventPatch = {}): EventRecord => {
  const status = patch.status ?? "scheduled";
  const started = status === "active" || status === "ended";
  const roundCount =
    patch.roundCount ??
    (started ? Math.max(1, Object.keys(patch.rounds ?? {}).length) : 0);
  const bracketSize = patch.bracketSize ?? (started ? 2 ** roundCount : 0);
  const rounds = Object.fromEntries(
    Array.from({ length: roundCount }, (_, index) => {
      const source = patch.rounds?.[index] ?? {};
      const roundStatus =
        source.status ??
        (status === "ended"
          ? "completed"
          : index === 0
            ? "active"
            : "upcoming");
      const matchPatches =
        source.matches ??
        Object.fromEntries(
          Array.from(
            { length: bracketSize / 2 ** (index + 1) },
            (_, matchIndex) => [`${index}_${matchIndex}`, {}],
          ),
        );
      return [
        String(index),
        decodeEventRoundView(
          {
            roundIndex: index,
            status: roundStatus,
            createdAtMs: 1,
            completedAtMs: roundStatus === "completed" ? 2 : null,
            ...source,
            matches: Object.fromEntries(
              Object.entries(matchPatches).map(([key, value]) => [
                key,
                matchRecord(key, value),
              ]),
            ),
          },
          index,
        ),
      ];
    }),
  );
  return parseEventRecord({
    schemaVersion: 3,
    isSundayMons: false,
    eventId: id,
    status,
    createdAtMs: 1,
    updatedAtMs: 1,
    startAtMs: now + 100_000,
    startedAtMs: started ? 1 : null,
    endedAtMs: status === "ended" || status === "dismissed" ? 2 : null,
    createdByProfileId: "p1",
    createdByLoginUid: "p1-login",
    createdByUsername: "p1",
    winnerProfileId: null,
    winnerDisplayName: null,
    currentRoundIndex: started ? 0 : null,
    bracketFormat: "fixed",
    roundByes: {},
    bracketSize,
    roundCount,
    telegramAnnouncements: { invite: false, matches: false, results: false },
    telegramDeliveryVersion: 2,
    supportsThirdPlaceMatch: false,
    thirdPlaceMatch: null,
    prizeSelectionsLockedAtMs: null,
    prizeAssignments: {},
    participants: { p1: participant("p1"), p2: participant("p2") },
    ...patch,
    rounds,
    ...(patch.thirdPlaceMatch
      ? { thirdPlaceMatch: matchRecord("third_place", patch.thirdPlaceMatch) }
      : {}),
  });
};
const root = createRoot(requireValue(document.getElementById("root")));
let controller: EventModalController;
let actionResult: ReturnType<typeof useEventModalActions>;
let updateActions: React.Dispatch<
  React.SetStateAction<EventModalActionsOptions>
>;
let mode = "controller";
type ActionGroup = ReturnType<typeof useEventModalActions>["administration"] &
  ReturnType<typeof useEventModalActions>["participation"] &
  ReturnType<typeof useEventModalActions>["navigation"] & {
    participant: EventModalController["participants"]["openParticipant"];
  };
type ActionName = {
  [Key in keyof ActionGroup]: ActionGroup[Key] extends (
    ...args: never[]
  ) => unknown
    ? Key
    : never;
}[keyof ActionGroup];
let saved: Record<string, ActionGroup[ActionName] | undefined> = {};
const shared: ShareData[] = [];
let rejectShare: ((error: Error) => void) | undefined;

function ControllerHarness() {
  const current = useEventModalController();
  useLayoutEffect(() => {
    controller = current;
  });
  return null;
}
function ActionsHarness({ initial }: { initial: EventModalActionsOptions }) {
  const [options, setOptions] = useState(initial);
  const current = useEventModalActions(options);
  useLayoutEffect(() => {
    actionResult = current;
    updateActions = setOptions;
  });
  return null;
}
function actions(): Partial<ActionGroup> {
  if (mode === "view") return {};
  const source = mode === "actions" ? actionResult : controller;
  return {
    ...source.participation,
    ...source.administration,
    ...source.navigation,
    ...(mode === "controller"
      ? { participant: controller.participants.openParticipant }
      : {}),
  };
}
async function settle(run: () => unknown = () => {}) {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}
async function advance(ms: number) {
  const target = now + ms;
  let count = 0;
  while (true) {
    const next = [...timers]
      .filter(([, timer]) => timer.at <= target)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!next) break;
    if (++count > 10000) throw new Error("timer-loop");
    const [id, timer] = next;
    now = timer.at;
    if (timer.interval) timer.at += timer.delay;
    else timers.delete(id);
    await settle(timer.callback);
  }
  now = target;
}

export const harness = {
  prizeEventId: LEGACY_CORE_PRIZES_EVENT_ID,
  async mount(
    options: {
      mode?: string;
      profileId?: string;
      loginUid?: string;
      username?: string;
      eventId?: string;
      fresh?: boolean;
      strict?: boolean;
      deferredCanonicalIds?: boolean;
      overrides?: ActionsPatch;
    } = {},
  ) {
    await settle(() => root.render(null));
    await closeEventModal();
    for (const key of [
      "requests",
      "events",
      "freshness",
      "selections",
      "popups",
      "cards",
      "copies",
      "connections",
      "alerts",
      "prompts",
      "promptAnswers",
      "confirmations",
      "confirmAnswers",
    ] as const)
      environment[key].length = 0;
    environment.canonicalIds = {};
    environment.stashedProfiles = {};
    environment.deferredCanonicalIds = options.deferredCanonicalIds ?? false;
    environment.fresh = options.fresh ?? true;
    saved = {};
    shared.length = 0;
    now = 1_000_000;
    storage.setProfileId(options.profileId ?? "p2");
    storage.setLoginId(options.loginUid ?? "p2-login");
    storage.setUsername(options.username ?? options.profileId ?? "p2");
    const id = options.eventId ?? "event-a";
    openEventModal(id);
    mode = options.mode ?? "controller";
    const { eventRecord: recordOverride, ...overrides } =
      options.overrides ?? {};
    const initial: EventModalActionsOptions = {
      modalState: getEventModalState(),
      eventRecord:
        recordOverride === undefined
          ? eventRecord(id)
          : recordOverride === null
            ? null
            : eventRecord(id, recordOverride),
      isEventFresh: true,
      isLoading: false,
      nowMs: now,
      currentProfileId: storage.getProfileId(""),
      isJoined: true,
      eventProfileIds: {},
      isResolvingEventProfileIds: false,
      eventPrizeConfig: getEventPrizeConfig(LEGACY_CORE_PRIZES_EVENT_ID),
      isPrizeSelectionPending: () => false,
      togglePrizeSelection: (prizeId) => {
        void connection.toggleEventPrizeSelection(id, prizeId);
      },
      canManageDisqualifications: true,
      removableScheduledParticipants: [participant("p2")],
      ...overrides,
    };
    const element =
      mode === "view" ? (
        React.createElement(
          (await import("../../src/ui/event/EventModalView")).default,
        )
      ) : mode === "actions" ? (
        <ActionsHarness initial={initial} />
      ) : (
        <ControllerHarness />
      );
    await settle(() =>
      root.render(
        options.strict ? (
          <React.StrictMode>{element}</React.StrictMode>
        ) : (
          element
        ),
      ),
    );
  },
  async open(id: string) {
    await settle(() => openEventModal(id));
  },
  async close() {
    await settle(() => {
      void closeEventModal();
    });
  },
  async unmount() {
    await settle(() => root.render(null));
  },
  async receive(id: string, patch: EventPatch = {}) {
    await settle(() =>
      environment.events
        .filter((entry) => entry.active && entry.eventId === id)
        .forEach((entry) => entry.update(eventRecord(id, patch))),
    );
  },
  async fail(id: string) {
    await settle(() =>
      environment.events
        .filter((entry) => entry.active && entry.eventId === id)
        .forEach((entry) => entry.fail()),
    );
  },
  async fresh(id: string, value: boolean) {
    await settle(() =>
      environment.freshness
        .filter((entry) => entry.active && entry.eventId === id)
        .forEach((entry) => entry.update(value)),
    );
  },
  async auth(profileId: string, loginUid = `${profileId}-login`) {
    storage.setProfileId(profileId);
    storage.setLoginId(loginUid);
  },
  async override(patch: ActionsPatch) {
    const { eventRecord: recordPatch, ...fields } = patch;
    await settle(() =>
      updateActions((current) => ({
        ...current,
        ...fields,
        eventRecord:
          recordPatch === undefined
            ? current.eventRecord
            : recordPatch === null
              ? null
              : eventRecord(
                  recordPatch.eventId ??
                    current.eventRecord?.eventId ??
                    "event-a",
                  recordPatch,
                ),
      })),
    );
  },
  async invoke(name: ActionName, ...args: unknown[]) {
    await settle(() => {
      const action = requireValue(actions()[name]);
      void Reflect.apply(action, undefined, args);
    });
  },
  capture(name: ActionName, key: string = name) {
    saved[key] = requireValue(actions()[name]);
  },
  async invokeSaved(key: string, ...args: unknown[]) {
    await settle(() => {
      void Reflect.apply(requireValue(saved[key]), undefined, args);
    });
  },
  async complete(
    kind: string,
    index = 0,
    outcome = "resolve",
    value?: unknown,
  ) {
    const request = environment.requests.filter((entry) => entry.kind === kind)[
      index
    ];
    if (!request) throw new Error(`missing-request:${kind}:${index}`);
    await settle(() =>
      outcome === "reject"
        ? request.reject(new Error(String(value ?? "request-failed")))
        : request.resolve(value),
    );
  },
  async advance(ms: number) {
    await advance(ms);
  },
  setNow(value: number) {
    now = value;
  },
  participant,
  stash(id: string, profile: unknown) {
    environment.stashedProfiles[id] = profile;
  },
  responses(prompts: (string | null)[], confirmations: boolean[]) {
    environment.promptAnswers.push(...prompts);
    environment.confirmAnswers.push(...confirmations);
  },
  setRoute(path: string) {
    history.replaceState(null, "", path);
  },
  async syncRoute() {
    await settle(() => syncEventModalToRoute(getCurrentRouteState()));
  },
  configureShare(behavior: string) {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: behavior === "unsupported" ? () => false : undefined,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value:
        behavior === "unavailable"
          ? undefined
          : async (data: ShareData) => {
              shared.push(data);
              if (behavior === "rejected") throw new Error("share-failed");
              if (behavior === "aborted")
                throw Object.assign(new Error("canceled"), {
                  name: "AbortError",
                });
              if (behavior === "delayed")
                await new Promise<void>((_, reject) => {
                  rejectShare = reject;
                });
            },
    });
  },
  async rejectShare() {
    await settle(() => rejectShare?.(new Error("share-failed")));
  },
  async focus() {
    await settle(() => window.dispatchEvent(new Event("focus")));
  },
  snapshot() {
    const value = actions();
    return {
      now,
      requests: environment.requests.map(({ kind, args }) => ({ kind, args })),
      activeEvents: environment.events
        .filter((entry) => entry.active)
        .map((entry) => entry.eventId),
      activeFreshness: environment.freshness
        .filter((entry) => entry.active)
        .map((entry) => entry.eventId),
      activeSelections: environment.selections.filter((entry) => entry.active)
        .length,
      intervals: [...timers.values()].filter((timer) => timer.interval).length,
      timers: [...timers.values()].map(({ at, delay, interval }) => ({
        at,
        delay,
        interval,
      })),
      modalState: getEventModalState(),
      isJoining: value.isJoining,
      hasAttemptedJoin: value.hasAttemptedJoin,
      isLeaving: value.isLeaving,
      isDisqualifying: value.isDisqualifying,
      isPostponing: value.isPostponing,
      isRemovingParticipant: value.isRemovingParticipant,
      copyState: value.copyState,
      cards: environment.cards,
      popups: environment.popups,
      copies: environment.copies,
      shared,
      connections: environment.connections,
      alerts: environment.alerts,
      prompts: environment.prompts,
      confirmations: environment.confirmations,
      session: mode === "controller" ? controller.session : null,
      resolvingProfiles:
        mode === "controller"
          ? controller.identity.isResolvingEventProfileIds
          : false,
      profileIds:
        mode === "controller" ? controller.identity.eventProfileIds : {},
      selectionPending:
        mode === "controller"
          ? controller.prizes.prizeSelection.isPending()
          : false,
      joinDisabled:
        mode === "controller"
          ? controller.session.eventRecord?.eventId !==
              controller.session.modalState.eventId ||
            controller.session.isLoading ||
            value.isJoining ||
            value.isLeaving ||
            controller.prizes.isUpdatingPrizeSelection
          : false,
      performanceMarks: performance
        .getEntriesByType("measure")
        .map((entry) => entry.name),
    };
  },
};
window.eventHarness = harness;
