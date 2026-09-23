import React, { act, useCallback, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { EventCreateForm } from "../../src/ui/event/EventCreateForm";
import { useEventCreateForm } from "../../src/ui/event/useEventCreateForm";
import {
  closeEventModal,
  getEventModalState,
  openEventModal,
} from "../../src/ui/eventModalController";
import { bindProfileSurfaceData } from "../../src/ui/profileSurfaceDataPort";
import type { ProfileSurfaceDataPort } from "../../src/ui/profileSurfaceDataPort";

type CreateResult = Awaited<ReturnType<ProfileSurfaceDataPort["createEvent"]>>;
const requests: Array<{
  schedule: Parameters<ProfileSurfaceDataPort["createEvent"]>[0];
  options: Parameters<ProfileSurfaceDataPort["createEvent"]>[1];
  resolve: (result: CreateResult) => void;
  reject: (error: unknown) => void;
}> = [];

bindProfileSurfaceData({
  createEvent: (schedule, options) =>
    new Promise((resolve, reject) => {
      requests.push({ schedule, options, resolve, reject });
    }),
  getLeaderboard: async () => [],
  subscribeToProfileEventPrizes: () => () => {},
  withdrawEventPrize: async () => {
    throw new Error("Unexpected withdrawal");
  },
});

const root = createRoot(document.getElementById("root")!);
let currentForm: ReturnType<typeof useEventCreateForm>;
let setAllowed: (allowed: boolean) => void;
let starts = 0;

function Harness() {
  const [visible, setVisible] = useState(true);
  const [allowed, setCanCreateEvents] = useState(true);
  const onCreateStarted = useCallback(() => {
    starts += 1;
    setVisible(false);
  }, []);
  const form = useEventCreateForm(onCreateStarted);
  useLayoutEffect(() => {
    currentForm = form;
    setAllowed = setCanCreateEvents;
  });
  return (
    <>
      <button onClick={() => setVisible((value) => !value)}>
        {visible ? "Hide form" : "Show form"}
      </button>
      <button
        onClick={() => {
          form.resetForOpen();
          setVisible(true);
        }}
      >
        Open experimental controls
      </button>
      <div id="form">
        {visible && <EventCreateForm form={form} canCreateEvents={allowed} />}
      </div>
    </>
  );
}

flushSync(() =>
  root.render(
    <React.StrictMode>
      <Harness />
    </React.StrictMode>,
  ),
);
Object.assign(window, {
  harness: {
    snapshot: () => ({
      schedule: currentForm.schedule,
      isSundayMons: currentForm.isSundayMons,
      telegramAnnouncements: currentForm.telegramAnnouncements,
      isCreatingEvent: currentForm.isCreatingEvent,
      error: currentForm.error,
      requests: requests.map(({ schedule, options }) => ({
        schedule,
        options,
      })),
      starts,
      modal: getEventModalState(),
    }),
    setAllowed: (allowed: boolean) => flushSync(() => setAllowed(allowed)),
    dismiss: closeEventModal,
    openEvent: openEventModal,
    submitTwice: () => {
      flushSync(() => {
        currentForm.submit();
        currentForm.submit();
      });
    },
    async settle(index: number, result: CreateResult, error?: string) {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      try {
        await act(async () => {
          if (error !== undefined) requests[index].reject(new Error(error));
          else requests[index].resolve(result);
        });
      } finally {
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
      }
    },
    dispose: () => flushSync(() => root.unmount()),
  },
});
