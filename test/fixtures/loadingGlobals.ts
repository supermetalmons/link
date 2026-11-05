import type { SessionAuth } from "../../src/session/sessionAuth.ts";
import type { SessionStore } from "../../src/session/sessionStore.ts";

export type LoadingProbe = {
  backdropFrame: number | null;
  shell: number | null;
  populated: number | null;
  trustedInput?: boolean;
  firstInput?: number;
};

export type GameStateSnapshot = {
  context: ReturnType<
    typeof import("../../src/game/gameControlsStore.ts").getGameControlsSnapshot
  >["context"];
  timer: ReturnType<
    typeof import("../../src/game/gameControlsStore.ts").getGameControlsSnapshot
  >["presentation"]["gameControls"]["timer"];
  playerInfo: ReturnType<
    typeof import("../../src/game/boardUiPort.ts").getBoardPlayerInfoOverlayState
  >;
  wager: ReturnType<
    typeof import("../../src/game/wagerState.ts").getWagerState
  >;
  selectedMatchId: string | undefined;
  activeMatchId: string | null;
  counters: ReturnType<
    typeof import("../../src/lifecycle/lifecycleDiagnostics.ts").getLifecycleCounters
  >;
};

type IdentitySessionStorageProbe = { opens: number; puts: number };
type IdentityCosmeticWrite = {
  key: string;
  value: string;
  time: number;
  nameVisible: boolean;
};
type IdentityMark = {
  name: string;
  time: number;
  sessionStorage: IdentitySessionStorageProbe;
  nameInDom: boolean;
};

declare global {
  var identitySessionStorageProbe: IdentitySessionStorageProbe;
  var identityCosmeticWrites: IdentityCosmeticWrite[];
  var identityQuotaFailures: number;
  var identityMarkProbe: IdentityMark[];
  var releaseIdentityPresentationFrames: () => void;
  var loadingProbe: LoadingProbe;
  var gameStateProbe: () => GameStateSnapshot;
  var oldSessionRequestSettled: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("loading-probe-record-missing");
  return value as Record<string, unknown>;
}

export function loadingOriginalSessionRequest(
  auth: SessionAuth,
  mode: "fresh" | "restored",
): Promise<unknown> | null {
  const value: unknown = Reflect.get(
    auth,
    mode === "fresh" ? "signingIn" : "refreshing",
  );
  if (value === null || value === undefined) return null;
  const request = mode === "fresh" ? value : record(value).promise;
  if (!(request instanceof Promise))
    throw new Error("loading-probe-session-request-invalid");
  return request;
}

export function loadingSessionStore(auth: SessionAuth): SessionStore {
  const dependencies: unknown = Reflect.get(auth, "dependencies");
  const store = record(dependencies).store;
  const isStore = (value: unknown): value is SessionStore =>
    value !== null &&
    typeof value === "object" &&
    "update" in value &&
    typeof value.update === "function";
  if (!isStore(store)) throw new Error("loading-probe-session-store-invalid");
  return store;
}

export function loadingConnectionInternals(
  connection: typeof import("../../src/connection/connection.ts").connection,
) {
  const context: unknown = Reflect.get(connection, "activeContext");
  const match: unknown = Reflect.get(connection, "myMatch");
  return {
    loginUid: context == null ? undefined : record(context).loginUid,
    actorUid: context == null ? undefined : record(context).actorUid,
    color: match == null ? undefined : record(match).color,
    fen: match == null ? undefined : record(match).fen,
  };
}
