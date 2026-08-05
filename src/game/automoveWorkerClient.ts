import type {
  WorkerAutomovePreference,
  WorkerAutomoveRequest,
  WorkerAutomoveResponse,
  WorkerAutomoveResult,
} from "./automoveWorkerProtocol";

type PendingAutomoveRequest = {
  resolve: (result: WorkerAutomoveResult) => void;
  reject: (error: Error) => void;
};

type PendingRequestPromiseEntry = {
  preference: WorkerAutomovePreference;
  promise: Promise<WorkerAutomoveResult>;
};

let automoveWorker: Worker | null = null;
let nextAutomoveRequestId = 1;
const pendingRequestsById = new Map<number, PendingAutomoveRequest>();
const pendingRequestPromisesByFen = new Map<
  string,
  PendingRequestPromiseEntry
>();
const isAutomoveWorkerClientDebugLoggingEnabled = import.meta.env.DEV;
const debugAutomoveWorkerClient = (
  message: string,
  details?: Record<string, unknown>,
): void => {
  if (!isAutomoveWorkerClientDebugLoggingEnabled) {
    return;
  }
  if (details) {
    console.debug(`[automove-worker-client] ${message}`, details);
    return;
  }
  console.debug(`[automove-worker-client] ${message}`);
};

const requestKeyFor = (fen: string): string => fen;

const rejectAllPendingRequests = (error: Error): void => {
  if (pendingRequestsById.size > 0) {
    debugAutomoveWorkerClient("rejecting all pending requests", {
      pendingRequests: pendingRequestsById.size,
      errorMessage: error.message,
    });
  }
  pendingRequestsById.forEach((pending) => pending.reject(error));
  pendingRequestsById.clear();
};

const handleWorkerFailure = (worker: Worker, message: string): void => {
  debugAutomoveWorkerClient("worker failure", {
    message,
    pendingRequests: pendingRequestsById.size,
  });
  worker.terminate();
  if (automoveWorker !== worker) {
    return;
  }
  automoveWorker = null;
  rejectAllPendingRequests(new Error(message));
};

const isWorkerAutomoveResponse = (
  value: unknown,
): value is WorkerAutomoveResponse => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const response = value as Record<string, unknown>;
  if (typeof response.id !== "number") {
    return false;
  }
  if (response.type === "error") {
    return typeof response.message === "string";
  }
  if (response.type !== "result") {
    return false;
  }
  if (!response.result || typeof response.result !== "object") {
    return false;
  }
  const result = response.result as Record<string, unknown>;
  if (result.kind === "other") {
    return true;
  }
  return result.kind === "events" && typeof result.inputFen === "string";
};

const handleWorkerMessage = (
  worker: Worker,
  event: MessageEvent<unknown>,
): void => {
  if (automoveWorker !== worker) {
    return;
  }
  if (!isWorkerAutomoveResponse(event.data)) {
    handleWorkerFailure(
      worker,
      "received invalid response from automove worker",
    );
    return;
  }
  const response = event.data;
  const pending = pendingRequestsById.get(response.id);
  if (!pending) {
    if (pendingRequestsById.size > 0) {
      debugAutomoveWorkerClient("worker response had unknown id", {
        id: response.id,
        pendingRequests: pendingRequestsById.size,
      });
      handleWorkerFailure(
        worker,
        `received unknown automove worker response id: ${response.id}`,
      );
    }
    return;
  }
  pendingRequestsById.delete(response.id);
  if (response.type === "result") {
    debugAutomoveWorkerClient("worker request resolved", {
      id: response.id,
      resultKind: response.result.kind,
      pendingRequests: pendingRequestsById.size,
    });
    pending.resolve(response.result);
    return;
  }
  debugAutomoveWorkerClient("worker request rejected", {
    id: response.id,
    errorMessage: response.message,
    pendingRequests: pendingRequestsById.size,
  });
  pending.reject(new Error(response.message));
};

const ensureAutomoveWorker = (): Worker => {
  if (automoveWorker) {
    return automoveWorker;
  }
  debugAutomoveWorkerClient("creating worker instance");
  const worker = new Worker(new URL("./automoveWorker.ts", import.meta.url));
  worker.onmessage = (event: MessageEvent<unknown>) => {
    handleWorkerMessage(worker, event);
  };
  worker.onerror = (event: ErrorEvent) => {
    const message = event.message || "automove worker crashed";
    handleWorkerFailure(worker, message);
  };
  worker.onmessageerror = () => {
    handleWorkerFailure(
      worker,
      "received malformed message from automove worker",
    );
  };
  automoveWorker = worker;
  return worker;
};

export const requestSmartAutomoveFromWorker = (
  fen: string,
  preference: WorkerAutomovePreference,
): Promise<WorkerAutomoveResult> => {
  const key = requestKeyFor(fen);
  const pendingEntry = pendingRequestPromisesByFen.get(key);
  if (pendingEntry) {
    debugAutomoveWorkerClient("reusing pending worker request", {
      preference,
      pendingPreference: pendingEntry.preference,
      didPreferenceChange: pendingEntry.preference !== preference,
      fenLength: fen.length,
    });
    return pendingEntry.promise;
  }
  const worker = ensureAutomoveWorker();
  const id = nextAutomoveRequestId;
  nextAutomoveRequestId += 1;
  const request: WorkerAutomoveRequest = {
    id,
    fen,
    preference,
  };

  const promise = new Promise<WorkerAutomoveResult>((resolve, reject) => {
    pendingRequestsById.set(id, {
      resolve,
      reject: (error: Error) => reject(error),
    });
    debugAutomoveWorkerClient("posting worker request", {
      id,
      preference,
      fenLength: fen.length,
      pendingRequests: pendingRequestsById.size,
    });
    try {
      worker.postMessage(request);
    } catch (error) {
      pendingRequestsById.delete(id);
      debugAutomoveWorkerClient("failed to post worker request", {
        id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  pendingRequestPromisesByFen.set(key, {
    preference,
    promise,
  });
  void promise.finally(() => {
    if (pendingRequestPromisesByFen.get(key)?.promise === promise) {
      pendingRequestPromisesByFen.delete(key);
    }
  });
  return promise;
};
