import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  APPLE_INTENT_REFRESH_BUFFER_MS,
  getAppleButtonLabel,
  getSettingsAppleFlowInProgress,
  getXButtonLabel,
  isAppleIntentUsable,
  setSettingsAppleFlowInProgress,
  subscribeSettingsAppleFlowProgress,
} = await import("../src/ui/identity/authFlowState.ts");
const {
  closeProfilePopupIfAny,
  formatProfileDisplayName,
  getInitialProfileDisplayName,
  handleEditDisplayName,
  handleLogout,
  hasProfilePopupVisible,
  hideNotificationBanner,
  openProfileSignInPopup,
  openProfileSignInPopupForEvent,
  registerProfileDisplayNameHandlers,
  registerProfileSignInApi,
  registerSignInInlineAuthErrorHandler,
  setSignInInlineAuthError,
  showNotificationBanner,
  showSettings,
  updateProfileDisplayName,
} = await import("../src/ui/identity/profileUiPort.ts");
const {
  beginLogoutAttempt,
  didFinalizeLogoutAttempt,
  isLatestLogoutAttempt,
  isLogoutUiLocked,
  markLogoutAttemptFinalized,
  reconcileLogoutUiLockWithAuthStatus,
  subscribeToLogoutUiLock,
} = await import("../src/ui/identity/logoutUiLock.ts");
const { formatAuthCooldownErrorMessage } =
  await import("../src/connection/authCooldownErrors.ts");

const intent = (expiresAtMs) => ({
  ok: true,
  intentId: "intent",
  nonce: "nonce",
  state: "state",
  expiresAtMs,
});

test("preserves Apple intent validity and auth button labels", () => {
  const nowMs = 1_000_000;
  assert.equal(
    isAppleIntentUsable(
      intent(nowMs + APPLE_INTENT_REFRESH_BUFFER_MS + 1),
      nowMs,
    ),
    true,
  );
  assert.equal(
    isAppleIntentUsable(intent(nowMs + APPLE_INTENT_REFRESH_BUFFER_MS), nowMs),
    false,
  );
  assert.equal(
    isAppleIntentUsable({ ...intent(nowMs + 60_000), nonce: "" }, nowMs),
    false,
  );
  assert.equal(getAppleButtonLabel("preparing"), "Preparing...");
  assert.equal(getAppleButtonLabel("confirm"), "Apple");
  assert.equal(getAppleButtonLabel("connecting"), "Apple");
  assert.equal(getAppleButtonLabel("verifying"), "Verifying...");
  assert.equal(getXButtonLabel("idle"), "X");
  assert.equal(getXButtonLabel("connecting"), "Connecting...");
});

test("publishes settings Apple flow changes once per transition", () => {
  setSettingsAppleFlowInProgress(false);
  const values = [];
  const unsubscribe = subscribeSettingsAppleFlowProgress((value) => {
    values.push(value);
  });

  setSettingsAppleFlowInProgress(true);
  setSettingsAppleFlowInProgress(true);
  setSettingsAppleFlowInProgress(false);
  unsubscribe();
  setSettingsAppleFlowInProgress(true);

  assert.deepEqual(values, [true, false]);
  assert.equal(getSettingsAppleFlowInProgress(), true);
  setSettingsAppleFlowInProgress(false);
});

test("routes stable profile commands through the registered UI port", () => {
  const calls = [];
  let visible = true;
  const unregister = registerProfileSignInApi({
    close: () => calls.push(["close"]),
    editDisplayName: () => calls.push(["edit"]),
    requestLogout: (returnFocusId) => calls.push(["logout", returnFocusId]),
    openSettings: (returnFocusId) => calls.push(["settings", returnFocusId]),
    hideNotificationBanner: () => calls.push(["hide-notification"]),
    showNotificationBanner: (...args) => calls.push(["notification", ...args]),
    openSignInPopup: (mode) => calls.push(["sign-in", mode]),
    hasVisiblePopup: () => visible,
  });
  const successHandler = () => {};

  closeProfilePopupIfAny();
  handleEditDisplayName();
  handleLogout("logout-trigger");
  showSettings("settings-trigger");
  hideNotificationBanner();
  showNotificationBanner("Title", "Subtitle", "emoji", successHandler);
  openProfileSignInPopup();
  openProfileSignInPopupForEvent();

  assert.equal(hasProfilePopupVisible(), true);
  visible = false;
  assert.equal(hasProfilePopupVisible(), false);
  assert.deepEqual(calls, [
    ["close"],
    ["edit"],
    ["logout", "logout-trigger"],
    ["settings", "settings-trigger"],
    ["hide-notification"],
    ["notification", "Title", "Subtitle", "emoji", successHandler],
    ["sign-in", "inline"],
    ["sign-in", "event"],
  ]);

  unregister();
  assert.equal(hasProfilePopupVisible(), false);
});

test("retains pending identity and inline errors until their views bind", () => {
  const inlineErrors = [];
  setSignInInlineAuthError("pending");
  const unregisterInline = registerSignInInlineAuthErrorHandler((message) => {
    inlineErrors.push(message);
  });
  setSignInInlineAuthError(null);
  unregisterInline();
  setSignInInlineAuthError("after-unmount");
  const unregisterNextInline = registerSignInInlineAuthErrorHandler(
    (message) => {
      inlineErrors.push(message);
    },
  );

  const displayNames = [];
  const cardNames = [];
  updateProfileDisplayName("mons", null, null);
  const initialDisplayName = getInitialProfileDisplayName();
  updateProfileDisplayName("latest", null, null);
  const unregisterDisplay = registerProfileDisplayNameHandlers(
    (name) => displayNames.push(name),
    (name) => cardNames.push(name),
  );
  updateProfileDisplayName(null, "0x1234567890abcdef", null);

  assert.deepEqual(inlineErrors, ["pending", null, "after-unmount"]);
  assert.equal(initialDisplayName, "mons");
  assert.deepEqual(displayNames, [
    "latest",
    formatProfileDisplayName(null, "0x1234567890abcdef", null),
  ]);
  assert.deepEqual(cardNames, displayNames);

  unregisterNextInline();
  unregisterDisplay();

  updateProfileDisplayName(null, null, null);
  const clearedDisplayNames = [];
  const unregisterClearedDisplay = registerProfileDisplayNameHandlers(
    (name) => clearedDisplayNames.push(name),
    () => {},
  );
  assert.deepEqual(clearedDisplayNames, ["anon"]);
  unregisterClearedDisplay();
});

test("keeps logout attempts locked, ordered, and idempotent", () => {
  reconcileLogoutUiLockWithAuthStatus("unauthenticated");
  const lockStates = [];
  const unsubscribe = subscribeToLogoutUiLock((isLocked) => {
    lockStates.push(isLocked);
  });

  const firstAttempt = beginLogoutAttempt();
  assert.equal(isLogoutUiLocked(), true);
  assert.equal(isLatestLogoutAttempt(firstAttempt), true);
  assert.equal(markLogoutAttemptFinalized(firstAttempt), true);
  assert.equal(didFinalizeLogoutAttempt(firstAttempt), true);
  assert.equal(markLogoutAttemptFinalized(firstAttempt), false);

  const secondAttempt = beginLogoutAttempt();
  assert.equal(isLatestLogoutAttempt(firstAttempt), false);
  assert.equal(markLogoutAttemptFinalized(firstAttempt), false);
  assert.equal(markLogoutAttemptFinalized(secondAttempt), true);
  reconcileLogoutUiLockWithAuthStatus("loading");
  assert.equal(isLogoutUiLocked(), true);
  reconcileLogoutUiLockWithAuthStatus("authenticated");
  assert.equal(isLogoutUiLocked(), false);

  unsubscribe();
  assert.deepEqual(lockStates, [true, false]);
});

test("preserves cooldown messaging for sign-in and profile linking", () => {
  assert.equal(
    formatAuthCooldownErrorMessage({
      details: { reason: "method-reuse-cooldown", method: "apple" },
    }),
    "This Apple sign-in was recently unlinked. Try again in up to 24 hours.",
  );
  assert.equal(
    formatAuthCooldownErrorMessage({
      details: { reason: "profile-method-cooldown", method: "x" },
    }),
    "You recently unlinked X on this profile. You can link it again in up to 24 hours.",
  );
  assert.equal(formatAuthCooldownErrorMessage(new Error("unrelated")), null);
});
