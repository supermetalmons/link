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
getItem("playerEmojiId", 1) satisfies EmojiId;
getItem("boardStyleSet", null) satisfies BoardStyleSet | null;
setItem("preferredAssetsSet", storageAssets);
setItem("playerRating", null);
setItem("boardStyleSet", null);
setItem("boardColorSetsByTheme", { light: null, dark: "dark" });
setItem(\`pendingAutomatchOperation:\${storageLogin}\`, storagePending);
// expect-diagnostic TS2345: A text key cannot infer a numeric fallback.
getItem("profileId", 0);
// expect-diagnostic TS2345: Numeric keys reject textual fallbacks.
getItem("playerRating", "0");
// expect-diagnostic TS2345: Structured keys require their own fallback shape.
getItem("boardColorSetsByTheme", []);
// expect-diagnostic TS2345: Literal keys determine write payloads.
setItem("playerRating", "1");
// expect-diagnostic TS2345: Boolean keys cannot accept nullable removal values.
setItem("isMuted", null);
// expect-diagnostic TS2322: A theme entry cannot contain a numeric field.
setItem("boardColorSetsByTheme", { light: 1, dark: null });
// expect-diagnostic TS2345: Pending-operation keys require the full operation DTO.
setItem("pendingAutomatchOperation:login", { operationId: "operation" });
// expect-diagnostic TS2345: Pending-operation keys cannot accept unrelated primitive writes.
setItem("pendingAutomatchOperation:login", "operation");
// expect-diagnostic TS2345: Unknown key names cannot bypass the write registry.
setItem("unknown-browser-key", "value");
// expect-diagnostic TS2559: Sticker reads require a structured map fallback.
getItem("cardStickers", "fallback");
const storedUnknown = readStoredValue("profileId", "fallback");
// expect-diagnostic TS18046: Raw storage evidence is unknown before a key-specific decoder.
storedUnknown.profileId;
`,
  "src/services/navigationGamesCache.ts": `
declare const storedCachePayload: PersistedTopGamesPayload;
storedCachePayload.version satisfies 3;
declare const unknownCachedItems: unknown;
selectCanonicalNavigationGames(unknownCachedItems) satisfies NavigationItem[];
// expect-diagnostic TS18046: Cached items are not domain navigation records before sanitation.
unknownCachedItems[0].inviteId;
// expect-diagnostic TS2322: Fresh cache payloads preserve their version.
const wrongCacheVersion: PersistedTopGamesPayload = { ...storedCachePayload, version: 2 };
void wrongCacheVersion;
`,
  "src/connection/moveDelivery.ts": `
declare const rawStoredMoves: StoredMoveFields;
// expect-diagnostic TS18046: Stored pending entries remain unknown until their guard.
rawStoredMoves.pending[0].moveFen;
if (hasPendingMoveRecords(rawStoredMoves)) {
  for (const pending of rawStoredMoves.pending) pending.fen satisfies string;
}
if (validState(rawStoredMoves.confirmed)) rawStoredMoves.confirmed.flatMovesString satisfies string;
declare const moveScopeInput: unknown;
// expect-diagnostic TS2345: Fresh storage keys require the concrete ownership scope.
moveDeliveryStorageKey(moveScopeInput);
declare const freshStoredMoves: StoredMoves;
// expect-diagnostic TS2322: Fresh journals retain their format version.
const wrongMoveVersion: StoredMoves = { ...freshStoredMoves, version: 2 };
// expect-diagnostic TS2322: Finished journal markers are true or absent.
const wrongFinishedMarker: StoredMoves = { ...freshStoredMoves, finished: false };
void wrongMoveVersion; void wrongFinishedMarker;
`,
  "src/connection/rematchEndDelivery.ts": `
declare const rawStoredEnd: unknown;
if (isPendingRematchEnd(rawStoredEnd)) rematchEndDeliveryStorageKey(rawStoredEnd) satisfies string;
// expect-diagnostic TS2531: A stored ownership observation is not a validated operation identifier.
storedRematchEndOperationId("{}").trim();
declare const freshStoredEnd: StoredRematchEnd;
// expect-diagnostic TS2322: Fresh rematch envelopes keep version 1.
const wrongEndVersion: StoredRematchEnd = { ...freshStoredEnd, version: 2 };
void wrongEndVersion;
`,
  "src/session/sessionStore.ts": `
declare const rawSessionState: unknown;
// expect-diagnostic TS18046: IndexedDB values are unknown before the session guard.
rawSessionState.session;
if (isSessionState(rawSessionState)) {
  rawSessionState.generation satisfies string;
  for (const revocation of rawSessionState.revocations) revocation.sessionId satisfies string;
  rawSessionState.session?.uid satisfies string | null | undefined;
}
`,
  "src/connection/appleConnection.ts": `
declare const applePersistence: Storage;
parsePendingAppleIntentRecordsFromStorage(applePersistence) satisfies ApplePendingIntentRecord[];
declare const applePendingRecord: ApplePendingIntentRecord;
// expect-diagnostic TS2322: Fresh intent timestamps cannot use retained string encodings.
storePendingAppleIntentRecord({ ...applePendingRecord, createdAtMs: "1" });
`,
  "src/session/logoutOrchestrator.ts": `
declare const untrustedLogout: unknown;
parseLogoutSignal(untrustedLogout) satisfies LogoutSignal | null;
parseSignInSignal(untrustedLogout) satisfies SignInSignal | null;
parsePendingLogoutWipeMarker(untrustedLogout) satisfies PendingLogoutWipeMarker | null;
// expect-diagnostic TS2345: Fresh logout signals must name their session generation.
serializeLogoutSignal({ id: "signal" });
// expect-diagnostic TS2322: Fresh sign-in signals require a textual profile owner.
serializeSignInSignal({ id: "signal", tabId: "tab", profileId: 1, loginId: "login", generation: "generation" });
`,
};

test("browser persistence helpers bind decoded reads and writes to their actual keys", () => {
  const configuration = ts.getParsedCommandLineOfConfigFile(
    resolve(root, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        assert.fail(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  assert.ok(configuration);
  assert.deepEqual(configuration.errors, []);
  /** @type {Map<string, Map<number, { code: number; label: string; reported: boolean }>>} */
  const expectedByFile = new Map();
  const replacements = new Map(
    Object.entries(checks).map(([file, appended]) => {
      const path = resolve(root, file);
      const source = `${readFileSync(path, "utf8")}\n${appended}`;
      /** @type {Map<number, { code: number; label: string; reported: boolean }>} */
      const expected = new Map();
      source.split("\n").forEach((line, index) => {
        const match = /^\s*\/\/ expect-diagnostic TS(\d+): (.+)$/.exec(line);
        if (!match) return;
        const [, code, label] = match;
        assert.ok(code && label);
        expected.set(index + 1, { code: Number(code), label, reported: false });
      });
      assert.ok(expected.size > 0, `Missing rejection cases for ${file}`);
      expectedByFile.set(path, expected);
      return [path, source];
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
  /** @type {import("typescript").Diagnostic[]} */
  const unrelated = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const expected =
      diagnostic.file && diagnostic.start !== undefined
        ? expectedByFile
            .get(resolve(diagnostic.file.fileName))
            ?.get(
              diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
                .line,
            )
        : undefined;
    if (!expected) {
      unrelated.push(diagnostic);
      continue;
    }
    assert.equal(
      diagnostic.category,
      ts.DiagnosticCategory.Error,
      expected.label,
    );
    assert.equal(diagnostic.code, expected.code, expected.label);
    expected.reported = true;
  }
  assert.deepEqual(
    unrelated.map((diagnostic) => ({
      file: diagnostic.file?.fileName,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    })),
    [],
  );
  for (const expected of expectedByFile.values())
    for (const { label, reported } of expected.values())
      assert.ok(reported, `Compiler accepted: ${label}`);
});
