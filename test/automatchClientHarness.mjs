import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import { withAutomatchOperationLock } from "../src/connection/automatchOperationLock.ts";

registerTypeScriptTestHooks();

const { AutomatchClient } =
  await import("../src/connection/automatchClient.ts");

/** @param {import("../src/connection/automatchClient.ts").AutomatchClientDependencies["storage"]} storage */
export function createAutomatchObservationClient(storage) {
  const unexpected = () => assert.fail("unexpected automatch mutation");
  return new AutomatchClient({
    ensureAuthenticated: async () => unexpected(),
    getCurrentUser: unexpected,
    getUserBoundAuthTokenProvider: unexpected,
    storage,
    getPlayerPresentation: unexpected,
    withOperationLock: withAutomatchOperationLock,
    api: {
      startAutomatchViaApi: async () => unexpected(),
      cancelAutomatchViaApi: async () => unexpected(),
    },
    seedGameBootstrap: unexpected,
    notifyNavigationGamesChanged: unexpected,
    now: unexpected,
    createOperationId: unexpected,
  });
}
