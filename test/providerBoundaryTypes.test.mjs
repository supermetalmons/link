import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const checks = {
  "src/connection/connection.ts": `
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type UsernameResultCheck = Assert<Same<Awaited<ReturnType<typeof connection.editUsername>>, import("@mons/shared/usernames").UsernameEditResponse>>;
export type CancelResultCheck = Assert<Same<Awaited<ReturnType<typeof connection.cancelAutomatch>>, import("@mons/shared/navigation").CancelAutomatchResponse>>;
export type RemoveResultCheck = Assert<Same<Awaited<ReturnType<typeof connection.removeWaitingNavigationGame>>, RemoveWaitingNavigationGameResult>>;
declare const removed: Awaited<ReturnType<typeof connection.removeWaitingNavigationGame>>;
if (!removed.ok) {
  removed.reason satisfies "invalid-invite-id";
  removed.skipped satisfies true;
  // expect-diagnostic TS2339: The local skipped result has no server invite ID.
  removed.inviteId;
} else {
  removed.inviteId satisfies string;
}
`,
  "src/connection/injectedEthereumProviders.ts": `
declare const providerResult: Awaited<ReturnType<EIP1193Provider["request"]>>;
// expect-diagnostic TS18046: Unvalidated provider responses cannot be consumed as accounts.
providerResult.accounts;
// expect-diagnostic TS18046: The legacy global must pass the capability guard.
window.ethereum.request({ method: "eth_accounts" });
const checkedProvider = getLegacyInjectedProvider();
checkedProvider?.request({ method: "eth_accounts", params: [] });
checkedProvider?.request({ method: "wallet_switchEthereumChain", params: { chainId: "0x1" } });
// expect-diagnostic TS2345: The request method is required.
checkedProvider?.request({ params: [] });
`,
  "src/connection/solanaConnection.ts": `
declare const signatureResult: Awaited<ReturnType<InjectedSolanaProvider["signMessage"]>>;
// expect-diagnostic TS18046: Foreign signature responses remain unknown before coercion.
signatureResult.signature;
coerceLegacySolanaSignature(signatureResult) satisfies Uint8Array;
`,
  "src/connection/appleConnection.ts": `
declare const appleSdk: AppleAuthSdk;
const rawAppleResult = appleSdk.signIn();
// expect-diagnostic TS18046: SDK responses must pass popup signal extraction.
rawAppleResult.authorization;
extractApplePopupSignals(rawAppleResult).idToken satisfies string;
declare const rawPopupResult: Awaited<ReturnType<typeof waitForApplePopupResult>>;
// expect-diagnostic TS18046: Popup event and promise values remain unknown until decoding.
rawPopupResult.id_token;
declare const initOptions: AppleAuthOptions;
appleSdk.init(initOptions);
// expect-diagnostic TS2322: This client requests an ID token, not a code response.
appleSdk.init({ ...initOptions, responseType: "code" });
`,
  "src/utils/ensResolver.ts": `
declare const providerProfile: unknown;
const ensProfile = decodeEnsProfile(providerProfile);
if (ensProfile) {
  ensProfile.name satisfies string;
  ensProfile.avatar satisfies string | null | undefined;
  // expect-diagnostic TS1360: Missing or null avatars cannot be consumed as present strings.
  ensProfile.avatar satisfies string;
}
`,
  "src/services/sessionApi.ts": `
declare const tokenClaims: unknown;
// expect-diagnostic TS18046: Parsed claims are not trusted timestamps.
tokenClaims.iat;
if (hasNumericTokenTimestamps(tokenClaims)) {
  tokenClaims.iat satisfies number;
  tokenClaims.exp satisfies number;
}
`,
};

test("public connection and provider boundaries reject trusted use of undecoded values", () => {
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
