import { requireValue } from "./browserAssertions";
import { createDefaultProfileAppearance } from "@mons/shared/appearance";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import ProfileSignIn from "/src/ui/identity/ProfileSignInView";
import { SettingsModal } from "/src/ui/identity/SettingsModalView";
import {
  closeTransientUi,
  registerBoardTransientUiHandler,
  registerBottomControlsTransientUiHandler,
  registerMainMenuTransientUiHandler,
} from "/src/ui/uiSession";
import {
  environment,
  publishXAuthUiFeedback,
  setEventModalState,
  setPendingXRedirectResult,
} from "./walletAuthEnvironment";

const params = new URLSearchParams(location.search);
const screen = params.get("screen");
if (params.has("pendingTransientCleanup")) {
  const noop = () => {};
  registerBoardTransientUiHandler(noop);
  registerBottomControlsTransientUiHandler(noop);
  registerMainMenuTransientUiHandler(noop);
  closeTransientUi();
}
const root = createRoot(requireValue(document.getElementById("root")));
const dispose = () => flushSync(() => root.unmount());
export const walletAuthHarness = {
  requireValue,
  environment,
  dispose,
  publishXAuthUiFeedback,
  setEventModalState,
  setPendingXRedirectResult,
  resolveXIntent(index: number) {
    requireValue(environment.xIntentCalls[index]).resolve({
      ok: true,
      intentId: `x-intent-${index}`,
      nonce: "nonce",
      state: "state",
      expiresAtMs: Date.now() + 60_000,
    });
  },
  rejectXIntent(
    index: number,
    message: string,
    details?: Pick<
      Extract<
        import("@mons/shared/api-errors").AuthCooldownDetails,
        { scope: "method" }
      >,
      "method" | "reason"
    >,
  ) {
    requireValue(environment.xIntentCalls[index]).reject(
      Object.assign(
        new Error(message),
        details
          ? {
              code: "failed-precondition",
              details: {
                scope: "method",
                retryAtMs: 0,
                cooldownMs: 86_400_000,
                ...details,
              },
            }
          : {},
      ),
    );
  },
  rejectXRedirect(index: number, message: string) {
    requireValue(environment.xRedirectCalls[index]).reject(new Error(message));
  },
  setVisibilityState(state: "hidden" | "visible") {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  },
  resolveConnection(index: number) {
    const call = requireValue(environment.connectCalls[index]);
    call.resolve({
      message: "signed-message",
      address: "address",
      publicKey: "public-key",
      signature: "signature",
      intentId: `${call.method}-intent`,
    });
  },
  rejectConnection(index: number, message: string) {
    requireValue(environment.connectCalls[index]).reject(new Error(message));
  },
  resolveVerification(index: number, ok = true) {
    const call = requireValue(environment.verificationCalls[index]);
    if (ok) environment.linkedMethods[call.method] = true;
    call.resolve(
      ok
        ? {
            ...createDefaultProfileAppearance(),
            ok: true,
            uid: "viewer",
            profileId: "profile",
            username: "Player",
            linkedMethods: { ...environment.linkedMethods },
            appleLinked: environment.linkedMethods.apple,
            opId: "verification",
          }
        : { ok: false },
    );
  },
  rejectVerification(index: number) {
    requireValue(environment.verificationCalls[index]).reject(
      new Error("verification failed"),
    );
  },
  advanceTimers(delay?: number) {
    const timers = [...environment.timers.entries()].filter(
      ([, timer]) => delay === undefined || timer.delay === delay,
    );
    timers.forEach(([id, { callback }]) => {
      environment.timers.delete(id);
      callback();
    });
  },
};
window.walletAuthHarness = walletAuthHarness;

declare global {
  interface Window {
    walletAuthHarness: typeof walletAuthHarness;
  }
}
flushSync(() =>
  root.render(
    <React.StrictMode>
      {screen === "settings" ? (
        <SettingsModal onClose={dispose} />
      ) : (
        <ProfileSignIn
          authState={{
            authStatus: "unauthenticated",
            profileId: "",
            ethAddress: "",
            solAddress: "",
          }}
        />
      )}
    </React.StrictMode>,
  ),
);
