type PresentationWrite = {
  read: () => unknown;
  write: () => void;
};

type PresentationIdentity = {
  profileId: string;
  displayName: string;
};

type Dependencies = {
  isHidden: () => boolean;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  scheduleTask: (callback: () => void) => number;
  cancelTask: (id: number) => void;
  subscribeVisibility: (callback: () => void) => () => void;
  reportError: (error: unknown) => void;
};

type PendingPresentation = {
  revision: number;
  identity: PresentationIdentity;
  isCurrent: () => boolean;
  writes: Array<PresentationWrite & { baseline: unknown }>;
};

export function createDeferredProfilePresentation(dependencies: Dependencies) {
  let revision = 0;
  let pending: PendingPresentation | null = null;
  let committedName: {
    identity: PresentationIdentity;
    isCurrent: () => boolean;
  } | null = null;
  let cancelScheduled: (() => void) | null = null;
  let unsubscribeVisibility: (() => void) | null = null;

  const reportError = (error: unknown) => {
    if (!(error instanceof DOMException) || error.name !== "QuotaExceededError")
      dependencies.reportError(error);
  };
  const cancelSchedule = () => {
    cancelScheduled?.();
    cancelScheduled = null;
  };
  const clear = () => {
    cancelSchedule();
    unsubscribeVisibility?.();
    unsubscribeVisibility = null;
    pending = null;
  };
  const isCurrent = (job: PendingPresentation): boolean => {
    try {
      return job.revision === revision && job.isCurrent();
    } catch (error) {
      reportError(error);
      return false;
    }
  };
  const flush = () => {
    const job = pending;
    clear();
    if (!job) return;
    for (const field of job.writes) {
      if (!isCurrent(job)) return;
      try {
        if (Object.is(field.read(), field.baseline)) field.write();
      } catch (error) {
        reportError(error);
      }
    }
  };
  const isNameCurrent = (job: PendingPresentation): boolean => {
    try {
      return (
        committedName?.identity.profileId === job.identity.profileId &&
        committedName.identity.displayName === job.identity.displayName &&
        committedName.isCurrent()
      );
    } catch (error) {
      reportError(error);
      return false;
    }
  };
  const schedule = () => {
    cancelSchedule();
    const job = pending;
    if (!job) return;
    if (!isCurrent(job)) {
      clear();
      return;
    }
    if (dependencies.isHidden()) {
      const task = dependencies.scheduleTask(flush);
      cancelScheduled = () => dependencies.cancelTask(task);
      return;
    }
    if (!isNameCurrent(job)) return;
    let frame = dependencies.requestFrame(() => {
      frame = dependencies.requestFrame(() => {
        cancelScheduled = null;
        if (pending === job && isNameCurrent(job)) flush();
      });
    });
    cancelScheduled = () => dependencies.cancelFrame(frame);
  };

  return {
    beginApplication: (): number => {
      revision += 1;
      clear();
      return revision;
    },
    queue: (
      applicationRevision: number,
      identity: PresentationIdentity,
      isApplicationCurrent: () => boolean,
      writes: PresentationWrite[],
    ): void => {
      if (applicationRevision !== revision) return;
      const fields: PendingPresentation["writes"] = [];
      for (const field of writes) {
        try {
          fields.push({ ...field, baseline: field.read() });
        } catch (error) {
          reportError(error);
        }
      }
      if (!fields.length) return;
      clear();
      pending = {
        revision: applicationRevision,
        identity,
        isCurrent: isApplicationCurrent,
        writes: fields,
      };
      unsubscribeVisibility = dependencies.subscribeVisibility(schedule);
      schedule();
    },
    nameCommitted: (
      identity: PresentationIdentity,
      isCommittedNameCurrent: () => boolean,
    ): (() => void) => {
      const registration = {
        identity,
        isCurrent: isCommittedNameCurrent,
      };
      committedName = registration;
      schedule();
      return () => {
        if (committedName === registration) {
          committedName = null;
          cancelSchedule();
          if (dependencies.isHidden()) schedule();
        }
      };
    },
    flush,
  };
}

const deferredProfilePresentation = createDeferredProfilePresentation({
  isHidden: () => document.visibilityState === "hidden",
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (id) => window.cancelAnimationFrame(id),
  scheduleTask: (callback) => window.setTimeout(callback, 0),
  cancelTask: (id) => window.clearTimeout(id),
  subscribeVisibility: (callback) => {
    document.addEventListener("visibilitychange", callback);
    return () => document.removeEventListener("visibilitychange", callback);
  },
  reportError: (error) => {
    console.error("Deferred profile presentation cache failed:", error);
  },
});

export const beginVerifiedProfileApplication =
  deferredProfilePresentation.beginApplication;
export const queueDeferredProfilePresentation =
  deferredProfilePresentation.queue;
export const notifyVerifiedProfileNameCommitted =
  deferredProfilePresentation.nameCommitted;
export const flushDeferredProfilePresentation =
  deferredProfilePresentation.flush;
