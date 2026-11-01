import type { SessionStore } from "../src/session/sessionStore.ts";
import type { SessionAuth, SessionUser } from "../src/session/sessionAuth.ts";

declare global {
  var eventPrizeSelectionHarness: typeof import("./fixtures/eventPrizeSelectionHarness.tsx").eventPrizeSelectionHarness;
  var eventCreateHarness: typeof import("./fixtures/eventCreateFormHarness.tsx").eventCreateHarness;
  var leaderboardHarness: typeof import("./fixtures/leaderboardHarness.tsx").leaderboardHarness;
  var storageCounts: { opens: number; writes: number; transactions: number };
  var sessionStore: SessionStore;
  var testSessionAuth: SessionAuth;
  var testSessionConnection: typeof import("../src/connection/connection.ts").connection;
  var oldSessionUser: SessionUser;
  var requireSessionUser: (auth?: SessionAuth) => SessionUser;
  var sessionStoreForTest: (auth: SessionAuth) => SessionStore;
  var connectionLoginUidForTest: (
    connection: typeof import("../src/connection/connection.ts").connection,
  ) => string;
  var connectionSubscriptionsForTest: (
    connection: typeof import("../src/connection/connection.ts").connection,
  ) => { metadata: unknown; wagers: unknown; match: unknown };
  var failSessionStorage: (once?: boolean) => () => void;
  var testClockSkew: number;
  var restoreLogoutStorage: () => void;
  var resumeLogoutStorage: (() => void) | undefined;
}

export {};
