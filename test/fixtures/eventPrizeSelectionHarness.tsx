import { requireValue } from "./browserAssertions";
import React, { act, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  getEventPrizeConfig,
  LEGACY_CORE_PRIZES_EVENT_ID,
  COMPRESSED_PRIZES_EVENT_ID,
} from "@mons/shared/event-prizes";
import type {
  EventParticipant,
  EventPrizeId,
  EventPrizeSelections,
  EventRecord,
} from "../../src/connection/connectionModels";
import { useEventPrizeSelection } from "../../src/ui/event/useEventPrizeSelection";
import { EventPrizePanel } from "../../src/ui/event/EventPrizePanel";
import EventModal from "../../src/ui/event/EventModalView";
import { openEventModal, closeEventModal } from "../../src/ui/event/modalState";
import { TopBarStack } from "../../src/ui/event/EventModal.styles";
import { storage } from "../../src/utils/storage";
import { environment } from "./eventPrizeSelectionEnvironment";
import "../../src/index.css";

const catalog = requireValue(getEventPrizeConfig(LEGACY_CORE_PRIZES_EVENT_ID));
const prizeConfig = {
  ...catalog,
  prizes: catalog.prizes.map((prize) => ({
    ...prize,
    imageUrl: `/__prize/${prize.id}.svg`,
  })),
};
const otherConfig = {
  ...prizeConfig,
  eventId: requireValue(getEventPrizeConfig(COMPRESSED_PRIZES_EVENT_ID))
    .eventId,
};
const participant = (
  index: number,
): EventParticipant & { state: "active"; loginUid: string } => ({
  profileId: `p${index}`,
  loginUid: `login${index}`,
  username: `player${index}`,
  displayName: `Player ${index}`,
  emojiId: index,
  aura: "none",
  joinedAtMs: index,
  state: "active",
  eliminatedRoundIndex: null,
  eliminatedByProfileId: null,
});

const finishedEvent = (): EventRecord => {
  const now = Date.now();
  const host = {
    ...participant(1),
    displayName: "Finalist 1",
    state: "winner" as const,
  };
  const guest = {
    ...participant(2),
    displayName: "Finalist 2",
    state: "eliminated" as const,
    eliminatedRoundIndex: 0,
    eliminatedByProfileId: host.profileId,
  };
  return {
    schemaVersion: 3,
    eventId: catalog.eventId,
    isSundayMons: false,
    status: "ended",
    bracketFormat: "fixed",
    createdAtMs: now - 240_000,
    updatedAtMs: now,
    startAtMs: now - 180_000,
    startedAtMs: now - 180_000,
    endedAtMs: now - 10_000,
    createdByProfileId: host.profileId,
    createdByLoginUid: host.loginUid,
    createdByUsername: host.username,
    winnerProfileId: host.profileId,
    winnerDisplayName: host.displayName,
    currentRoundIndex: 0,
    bracketSize: 2,
    roundCount: 1,
    telegramAnnouncements: { invite: false, matches: false, results: false },
    telegramDeliveryVersion: 2,
    supportsThirdPlaceMatch: false,
    thirdPlaceMatch: null,
    prizeSelectionsLockedAtMs: null,
    prizeAssignments: {},
    roundByes: {},
    participants: { [host.profileId]: host, [guest.profileId]: guest },
    rounds: {
      "0": {
        roundIndex: 0,
        status: "completed",
        createdAtMs: now - 120_000,
        completedAtMs: now - 60_000,
        matches: {
          "0_0": {
            matchKey: "0_0",
            inviteId: "final-match",
            status: "host",
            resolvedAtMs: now - 60_000,
            winnerDisqualified: false,
            winnerProfileId: host.profileId,
            loserProfileId: guest.profileId,
            hostSlotBlocked: false,
            hostProfileId: host.profileId,
            hostLoginUid: host.loginUid,
            hostDisplayName: host.displayName,
            hostEmojiId: host.emojiId,
            hostAura: host.aura,
            guestSlotBlocked: false,
            guestProfileId: guest.profileId,
            guestLoginUid: guest.loginUid,
            guestDisplayName: guest.displayName,
            guestEmojiId: guest.emojiId,
            guestAura: guest.aura,
          },
        },
      },
    },
  };
};

const motions: {
  bodyChild: boolean;
  target: string | null;
  frames: Keyframe[] | PropertyIndexedKeyframes | null;
}[] = [];
const animations: Animation[] = [];
const nativeAnimate = Element.prototype.animate;
Element.prototype.animate = function (frames, options) {
  motions.push({
    bodyChild: this.parentElement === document.body,
    target: this.closest("button")?.getAttribute("aria-label") ?? null,
    frames,
  });
  const animation = nativeAnimate.call(this, frames, options);
  animation.pause();
  animations.push(animation);
  return animation;
};

type ViewState = {
  isOpen: boolean;
  currentProfileId: string;
  otherEvent: boolean;
  concealed: boolean;
  canSelect: boolean;
  ended: boolean;
  participantCount: number;
};
let selection: ReturnType<typeof useEventPrizeSelection>;
let updateView: React.Dispatch<React.SetStateAction<ViewState>>;
const root = createRoot(requireValue(document.getElementById("root")));

function Harness() {
  const [view, setView] = useState<ViewState>({
    isOpen: true,
    currentProfileId: "p1",
    otherEvent: false,
    concealed: false,
    canSelect: true,
    ended: false,
    participantCount: 7,
  });
  const participants = React.useMemo(
    () =>
      Array.from({ length: view.participantCount }, (_, i) =>
        participant(i + 1),
      ),
    [view.participantCount],
  );
  const config = view.otherEvent ? otherConfig : prizeConfig;
  const currentSelection = useEventPrizeSelection({
    eventId: config.eventId,
    isOpen: view.isOpen,
    currentProfileId: view.currentProfileId,
    prizeConfig: config,
    concealed: view.concealed,
    participants,
  });
  useLayoutEffect(() => {
    selection = currentSelection;
    updateView = setView;
  });
  return view.isOpen ? (
    <TopBarStack id="prize-panel">
      <EventPrizePanel
        prizes={config.prizes.map((prize) => ({ prize, assignment: null }))}
        participants={participants}
        participantsById={Object.fromEntries(
          participants.map((p) => [p.profileId, p]),
        )}
        currentProfileId={view.currentProfileId}
        eventStatus={view.ended ? "ended" : "scheduled"}
        concealed={view.concealed}
        canSelect={view.canSelect && !view.concealed && !view.ended}
        selection={currentSelection}
        onSelect={currentSelection.toggle}
        onParticipantClick={async (p) => {
          environment.participantClicks.push(p.profileId);
        }}
      />
    </TopBarStack>
  ) : null;
}

flushSync(() =>
  root.render(
    <React.StrictMode>
      <Harness />
    </React.StrictMode>,
  ),
);

const emit = (selections: EventPrizeSelections, subscriptionIndex?: number) => {
  flushSync(() => {
    if (subscriptionIndex !== undefined) {
      requireValue(environment.subscriptions[subscriptionIndex]).update(
        selections,
      );
    } else {
      environment.subscriptions
        .filter((s) => s.active)
        .forEach((s) => s.update(selections));
    }
  });
};

export const eventPrizeSelectionHarness = {
  snapshot: () => ({
    selections: selection.selections,
    isUpdating: selection.isUpdating,
    isPending: selection.isPending(),
    loadedImageIds: [...selection.loadedImageIds],
    subscriptions: environment.subscriptions.map(({ eventId, active }) => ({
      eventId,
      active,
    })),
    mutations: environment.mutations.map(({ eventId, prizeId }) => ({
      eventId,
      prizeId,
    })),
    participantClicks: environment.participantClicks,
    motions,
    exitClones: [...document.body.children].filter(
      (el) =>
        el instanceof HTMLElement &&
        el.style.position === "fixed" &&
        el.getAttribute("aria-hidden") === "true",
    ).length,
  }),
  setView: (patch: Partial<ViewState>) =>
    flushSync(() => updateView((view) => ({ ...view, ...patch }))),
  emit,
  toggleImmediately: (prizeId: EventPrizeId) => {
    let pending = false;
    flushSync(() => {
      selection.toggle(prizeId);
      pending = selection.isPending();
    });
    return pending;
  },
  async settle(index: number, value: EventPrizeId | null, error?: string) {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    try {
      await act(async () => {
        const mutation = requireValue(environment.mutations[index]);
        if (error) mutation.reject(new Error(error));
        else mutation.resolve(value);
      });
    } finally {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
    }
  },
  clearMotions: () => {
    motions.length = 0;
  },
  finishAnimations: () =>
    animations.splice(0).forEach((animation) => {
      if (animation.playState !== "idle") animation.finish();
    }),
  mountModal: () => {
    const ended = finishedEvent();
    const people = Object.values(ended.participants);
    people.forEach((p, index) => {
      p.displayName = `Finalist ${index + 1}`;
    });
    environment.event = {
      ...ended,
      status: "scheduled",
      bracketFormat: "fixed",
      startAtMs: Date.now() + 30 * 60_000,
      startedAtMs: null,
      endedAtMs: null,
      currentRoundIndex: null,
      bracketSize: 0,
      roundCount: 0,
      winnerProfileId: null,
      winnerDisplayName: null,
      participants: Object.fromEntries(
        people.map((person) => [
          person.profileId,
          {
            ...person,
            state: "active" as const,
            eliminatedRoundIndex: null,
            eliminatedByProfileId: null,
          },
        ]),
      ),
      rounds: {},
      prizeAssignments: {},
    };
    environment.initialSelections = {};
    storage.setProfileId(requireValue(people[0]).profileId);
    storage.setLoginId(requireValue(requireValue(people[0]).loginUid));
    openEventModal(catalog.eventId);
    flushSync(() =>
      root.render(
        <React.StrictMode>
          <EventModal />
        </React.StrictMode>,
      ),
    );
  },
  finishEvent: () => {
    const ended = finishedEvent();
    const people = Object.values(ended.participants);
    people.forEach((p, index) => {
      p.displayName = `Finalist ${index + 1}`;
    });
    const winner = requireValue(
      people.find((p) => p.profileId === ended.winnerProfileId),
    );
    const loser = requireValue(people.find((p) => p !== winner));
    ended.prizeAssignments = {
      "1": {
        eventId: catalog.eventId,
        profileId: winner.profileId,
        place: 1,
        prizeId: requireValue(catalog.prizes[0]).id,
        assignedAtMs: Date.now(),
      },
      "2": {
        eventId: catalog.eventId,
        profileId: loser.profileId,
        place: 2,
        prizeId: requireValue(catalog.prizes[1]).id,
        assignedAtMs: Date.now(),
      },
    };
    environment.event = ended;
    flushSync(() =>
      environment.eventListeners.forEach((listener) => listener(ended)),
    );
  },
  closeModal: () => flushSync(() => closeEventModal()),
  dispose: () => flushSync(() => root.unmount()),
};
Object.assign(window, { eventPrizeSelectionHarness });
