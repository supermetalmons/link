import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import ProfileSignIn from "/src/ui/identity/ProfileSignInView";
import { SettingsModal } from "/src/ui/identity/SettingsModalView";
import { environment } from "./walletAuthEnvironment";

const screen = new URLSearchParams(location.search).get("screen");
const root = createRoot(document.getElementById("root")!);
const dispose = () => flushSync(() => root.unmount());
const harness = {
  environment,
  dispose,
  resolveConnection(index: number) {
    const call = environment.connectCalls[index];
    call.resolve({
      message: "signed-message",
      publicKey: "public-key",
      signature: "signature",
      intentId: `${call.method}-intent`,
    });
  },
  rejectConnection(index: number, message: string) {
    environment.connectCalls[index].reject(new Error(message));
  },
  resolveVerification(index: number, ok = true) {
    const call = environment.verificationCalls[index];
    if (ok) environment.linkedMethods[call.method as "eth" | "sol"] = true;
    call.resolve({ ok, profileId: "profile", username: "Player" });
  },
  rejectVerification(index: number) {
    environment.verificationCalls[index].reject(
      new Error("verification failed"),
    );
  },
  advanceTimers() {
    const timers = [...environment.timers.values()];
    environment.timers.clear();
    timers.forEach(({ callback }) => callback());
  },
};
(window as any).harness = harness;
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
