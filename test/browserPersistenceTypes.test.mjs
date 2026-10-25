import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const checks = {
  "src/utils/storage.ts": `
declare const storageAssets: AssetsSet;
declare const storagePending: PendingAutomatchOperation;
declare const storageLogin: string;
getItem("profileId", "fallback") satisfies string;
getItem("playerRating", 0) satisfies number;
getItem("playerEmojiId", "fallback") satisfies EmojiId;
getItem("boardStyleSet", null) satisfies BoardStyleSet | null;
setItem("preferredAssetsSet", storageAssets);
setItem("playerRating", null);
setItem("boardStyleSet", null);
setItem("boardColorSetsByTheme", { light: null, dark: "dark" });
setItem(\`pendingAutomatchOperation:\${storageLogin}\`, storagePending);
// @ts-expect-error A text key cannot infer a numeric fallback.
getItem("profileId", 0);
// @ts-expect-error Numeric keys reject textual fallbacks.
getItem("playerRating", "0");
// @ts-expect-error Structured keys require their own fallback shape.
getItem("boardColorSetsByTheme", []);
// @ts-expect-error Literal keys determine write payloads.
setItem("playerRating", "1");
// @ts-expect-error Boolean keys cannot accept nullable removal values.
setItem("isMuted", null);
// @ts-expect-error A theme entry cannot contain a numeric field.
setItem("boardColorSetsByTheme", { light: 1, dark: null });
// @ts-expect-error Pending-operation keys require the full operation DTO.
setItem("pendingAutomatchOperation:login", { operationId: "operation" });
// @ts-expect-error Pending-operation keys cannot accept unrelated primitive writes.
setItem("pendingAutomatchOperation:login", "operation");
// @ts-expect-error Unknown key names cannot bypass the write registry.
setItem("unknown-browser-key", "value");
// @ts-expect-error Sticker reads use their dedicated serialization boundary.
getItem("cardStickers", "fallback");
const storedUnknown = readStoredValue("profileId", "fallback");
// @ts-expect-error Raw storage evidence is unknown before a key-specific decoder.
storedUnknown.profileId;
`,
  "src/services/navigationGamesCache.ts": `
declare const storedCachePayload: PersistedTopGamesPayload;
storedCachePayload.version satisfies 3;
declare const unknownCachedItems: unknown;
sanitizeNavigationGames(unknownCachedItems) satisfies NavigationItem[];
// @ts-expect-error Cached items are not domain navigation records before sanitation.
unknownCachedItems[0].inviteId;
// @ts-expect-error Fresh cache payloads preserve their version.
const wrongCacheVersion: PersistedTopGamesPayload = { ...storedCachePayload, version: 2 };
void wrongCacheVersion;
`,
  "src/connection/moveDelivery.ts": `
declare const rawStoredMoves: StoredMoveFields;
// @ts-expect-error Stored pending entries remain unknown until their guard.
rawStoredMoves.pending[0].moveFen;
if (hasPendingMoveRecords(rawStoredMoves)) rawStoredMoves.pending[0].fen satisfies string;
if (validState(rawStoredMoves.confirmed)) rawStoredMoves.confirmed.flatMovesString satisfies string;
declare const moveScopeInput: unknown;
// @ts-expect-error Fresh storage keys require the concrete ownership scope.
moveDeliveryStorageKey(moveScopeInput);
declare const freshStoredMoves: StoredMoves;
// @ts-expect-error Fresh journals retain their format version.
const wrongMoveVersion: StoredMoves = { ...freshStoredMoves, version: 2 };
// @ts-expect-error Finished journal markers are true or absent.
const wrongFinishedMarker: StoredMoves = { ...freshStoredMoves, finished: false };
void wrongMoveVersion; void wrongFinishedMarker;
`,
  "src/connection/rematchEndDelivery.ts": `
declare const rawStoredEnd: unknown;
if (isPendingRematchEnd(rawStoredEnd)) rematchEndDeliveryStorageKey(rawStoredEnd) satisfies string;
// @ts-expect-error A stored ownership observation is not a validated operation identifier.
storedRematchEndOperationId("{}").trim();
declare const freshStoredEnd: StoredRematchEnd;
// @ts-expect-error Fresh rematch envelopes keep version 1.
const wrongEndVersion: StoredRematchEnd = { ...freshStoredEnd, version: 2 };
void wrongEndVersion;
`,
  "src/session/sessionStore.ts": `
declare const rawSessionState: unknown;
// @ts-expect-error IndexedDB values are unknown before the session guard.
rawSessionState.session;
if (isSessionState(rawSessionState)) {
  rawSessionState.generation satisfies string;
  rawSessionState.revocations[0].sessionId satisfies string;
  rawSessionState.session?.uid satisfies string | null | undefined;
}
`,
  "src/connection/appleConnection.ts": `
declare const applePersistence: Storage;
parsePendingAppleIntentRecordsFromStorage(applePersistence) satisfies ApplePendingIntentRecord[];
declare const applePendingRecord: ApplePendingIntentRecord;
// @ts-expect-error Fresh intent timestamps cannot use retained string encodings.
storePendingAppleIntentRecord({ ...applePendingRecord, createdAtMs: "1" });
`,
  "src/session/logoutOrchestrator.ts": `
declare const untrustedLogout: unknown;
parseLogoutSignal(untrustedLogout) satisfies LogoutSignal | null;
parseSignInSignal(untrustedLogout) satisfies SignInSignal | null;
parsePendingLogoutWipeMarker(untrustedLogout) satisfies PendingLogoutWipeMarker | null;
// @ts-expect-error Fresh logout signals must name their session generation.
serializeLogoutSignal({ id: "signal" });
// @ts-expect-error Fresh sign-in signals require a textual profile owner.
serializeSignInSignal({ id: "signal", tabId: "tab", profileId: 1, loginId: "login", generation: "generation" });
`,
};

test("browser persistence helpers bind decoded reads and writes to their actual keys", () => {
  const configuration = ts.getParsedCommandLineOfConfigFile(
    resolve(root, "tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: assert.fail },
  );
  assert.ok(configuration);
  assert.deepEqual(configuration.errors, []);
  const replacements = new Map(
    Object.entries(checks).map(([file, appended]) => {
      const path = resolve(root, file);
      return [path, `${readFileSync(path, "utf8")}\n${appended}`];
    }),
  );
  const host = ts.createCompilerHost(configuration.options);
  const readFile = host.readFile;
  host.readFile = (file) => replacements.get(resolve(file)) ?? readFile(file);
  const program = ts.createProgram(
    configuration.fileNames,
    configuration.options,
    host,
  );
  assert.deepEqual(
    ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
      file: diagnostic.file?.fileName,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    })),
    [],
  );
});
