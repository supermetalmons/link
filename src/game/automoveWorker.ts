import * as MonsRules from "mons-rules";
import type {
  WorkerAutomoveRequest,
  WorkerAutomoveResponse,
  WorkerAutomoveResult,
} from "./automoveWorkerProtocol";

type AutomoveWorkerScope = {
  postMessage(response: WorkerAutomoveResponse): void;
  onmessage: ((event: MessageEvent<WorkerAutomoveRequest>) => void) | null;
};

declare const self: AutomoveWorkerScope;

const resolveWorkerAutomove = async (
  fen: string,
  preference: WorkerAutomoveRequest["preference"],
): Promise<WorkerAutomoveResult> => {
  const gameFromFen = MonsRules.Game.fromFen(fen);
  if (!gameFromFen) {
    throw new Error("failed to deserialize automove fen in worker");
  }

  const suggestion = gameFromFen.suggestMove(preference);
  if (suggestion) {
    return {
      kind: "events",
      inputFen: suggestion.inputFen,
    };
  }
  return { kind: "other" };
};

const postResponse = (response: WorkerAutomoveResponse): void => {
  self.postMessage(response);
};

self.onmessage = (event: MessageEvent<WorkerAutomoveRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      const result = await resolveWorkerAutomove(
        request.fen,
        request.preference,
      );
      postResponse({
        type: "result",
        id: request.id,
        result,
      });
    } catch (error) {
      postResponse({
        type: "error",
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};

export {};
