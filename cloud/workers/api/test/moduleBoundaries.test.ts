import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import test from "node:test";
import typescript from "typescript";
import * as entrypoint from "../src/workerHandler.ts";
import { extractIdFromJsonUri } from "../src/helius.ts";
import { handleRequest } from "../src/router.ts";

test("the Worker entrypoint remains a thin exact compatibility facade", () => {
  assert.deepEqual(Object.keys(entrypoint).sort(), [
    "default",
    "extractIdFromJsonUri",
    "handleFetch",
    "handleRequest",
    "handleScheduled",
  ]);
  assert.strictEqual(entrypoint.handleRequest, handleRequest);
  assert.strictEqual(entrypoint.extractIdFromJsonUri, extractIdFromJsonUri);
  assert.equal(typeof entrypoint.default.queue, "function");
  assert.equal(typeof entrypoint.default.scheduled, "function");
});

test("canonical D1 modules have no direct Firestore runtime dependency", () => {
  for (const filename of [
    "authIdentityCanonical.ts",
    "gameplayCanonicalRepository.ts",
    "profileCanonicalD1.ts",
  ]) {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src", filename),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /(?:authFirestore|firestoreRest|createGoogleAccessToken|firestore\.googleapis\.com)/,
      filename,
    );
  }
});

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const runtimeExtensions = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

test("invite source readers cannot construct Firebase or Google clients", () => {
  const violations = reachableRuntimeFiles(
    resolve(import.meta.dirname, "../src/inviteSource.ts"),
  )
    .filter((path) => /\/(?:firebaseRtdb|googleAuth)\.ts$/.test(path))
    .map((path) => relative(repositoryRoot, path));
  assert.deepEqual(violations, []);
});

test("Worker runtime cannot restore retired Firebase credentials", () => {
  const violations = reachableRuntimeFiles(
    resolve(import.meta.dirname, "../src/index.ts"),
  )
    .filter((path) =>
      /\b(?:FIREBASE_IDENTITY_SERVICE_ACCOUNT|TELEGRAM_FIREBASE_SERVICE_ACCOUNT)_(?:EMAIL|PRIVATE_KEY)\b/.test(
        readFileSync(path, "utf8"),
      ),
    )
    .map((path) => relative(repositoryRoot, path));
  assert.deepEqual(violations, []);
});

test("event transition receipts cannot restore Firebase runtime access", () => {
  const sourcePaths = reachableRuntimeFiles(
    resolve(import.meta.dirname, "../src/index.ts"),
  );
  const violations = sourcePaths
    .filter((path) =>
      /eventTransitionReceipts\/|\b(?:ensureIntentEffects|transitionReceiptPath)\b/.test(
        readFileSync(path, "utf8"),
      ),
    )
    .map((path) => relative(repositoryRoot, path));
  assert.deepEqual(violations, []);
  const source = readFileSync(
    resolve(import.meta.dirname, "../src/eventTransitionReceiptsD1.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /firebaseRtdb|createGoogleAccessToken|\bfetch\(/);
});

test("Worker ownership ignores Firebase profile claims and RTDB profile shadows", () => {
  const sourcePaths = reachableRuntimeFiles(
    resolve(import.meta.dirname, "../src/index.ts"),
  );
  const requestClaimViolations = sourcePaths
    .filter((path) =>
      /\b(?:auth\.token\.profileId|identity\.profileId|rawProfileIdClaim)\b/.test(
        readFileSync(path, "utf8"),
      ),
    )
    .map((path) => relative(repositoryRoot, path));
  assert.deepEqual(requestClaimViolations, []);

  const rtdbProfileShadowPattern =
    /players\/(?:\$\{[^}\r\n]+\}|[^/"'`\r\n]+)\/profile\b/g;
  const profileShadowMatches = Object.fromEntries(
    sourcePaths.flatMap((path) => {
      const matches = readFileSync(path, "utf8").match(
        rtdbProfileShadowPattern,
      );
      return matches?.length
        ? [[relative(repositoryRoot, path), matches] as const]
        : [];
    }),
  );
  assert.deepEqual(profileShadowMatches, {});
});

test("browser and Worker runtime cannot restore Firebase profile claims or Admin account access", () => {
  const sourcePaths = new Set([
    ...reachableRuntimeFiles(resolve(import.meta.dirname, "../src/index.ts")),
    ...reachableRuntimeFiles(resolve(repositoryRoot, "src/index.tsx")),
  ]);
  const forbidden =
    /(?:\b(?:getIdTokenResult|customClaims|setCustomUserClaims|createFirebaseAuthAdminClient|FirebaseAuthAdminClient|ensureFirebaseProfileClaim|getCurrentProfileClaimId|getProfileClaimSource|syncProfileClaim)\b|\bclaims\s*(?:(?:\?\.|\.)\s*profileId\b|\[\s*["']profileId["']\s*\])|firebaseAuthAdmin|firebase-admin|identitytoolkit\.googleapis\.com|googleapis\.com\/auth\/identitytoolkit|accounts:(?:lookup|update|delete|batchCreate|batchDelete))/;
  const violations = Array.from(sourcePaths)
    .filter((path) => forbidden.test(readFileSync(path, "utf8")))
    .map((path) => relative(repositoryRoot, path));
  assert.deepEqual(violations, []);
  const verifier = readFileSync(
    resolve(import.meta.dirname, "../src/sessionAuth.ts"),
    "utf8",
  );
  assert.doesNotMatch(verifier, /\bprofileId\b/);
});

test("Worker authentication cannot restore Firebase session acceptance", () => {
  const violations = reachableRuntimeFiles(
    resolve(import.meta.dirname, "../src/index.ts"),
  )
    .filter((path) =>
      /verifyFirebaseRequest|securetoken\.google\.com|securetoken@system\.gserviceaccount\.com/.test(
        readFileSync(path, "utf8"),
      ),
    )
    .map((path) => relative(repositoryRoot, path));
  assert.deepEqual(violations, []);
});

test("profile-link job coordination cannot use the retired Firebase outbox", () => {
  const sourcePaths = reachableRuntimeFiles(
    resolve(import.meta.dirname, "../src/index.ts"),
  );
  const violations = sourcePaths
    .filter((path) => !path.endsWith("/profileGameProjectionOutbox.ts"))
    .filter((path) =>
      /profileGameProjectionOutbox\/profile|\b(?:getProfileLinkProfileGameProjectionOutboxPath|parseProfileLinkProfileGameProjectionOutbox|buildProfileLinkProfileGameProjectionOutbox|PROFILE_LINK_PROFILE_GAME_PROJECTION_OUTBOX_ROOT)\b/.test(
        readFileSync(path, "utf8"),
      ),
    )
    .map((path) => relative(repositoryRoot, path));
  assert.deepEqual(violations, []);
});

test("event progress installs the shared ownership snapshot", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../src/eventProgress.ts"),
    "utf8",
  );
  assert.match(source, /readProfileOwnershipSnapshot:\s*\(query\)\s*=>/);
  assert.match(source, /requireProfileOwnershipSnapshot\(repository, query\)/);
});

test("ownership consumers cannot restore legacy APIs or final fences", () => {
  const sourcePaths = reachableRuntimeFiles(
    resolve(import.meta.dirname, "../src/index.ts"),
  );
  const forbidden =
    /(?:findProfileId|findProfileIds|listProfileLoginUids|getGameplayProfile|getGameplayProfileOwnership|resolveCanonicalProfileId|resolveCanonicalProfileIds|readStableCanonicalLoginOwnerships|readStableCanonicalProfileIds|readStableOwnershipResolution|assertOwnershipResolutionUnchanged|assertAutomatchOwnerUnchanged|ownershipExpectations|cleanupPageMatchCursor|cleanupPageProfileIds|CANONICAL_PROFILE_LOGIN_OWNER_LIMIT|PROFILE_PATH_RESOLVE_CONCURRENCY|resolveProfilePaths)/;
  const violations = sourcePaths
    .filter((path) => forbidden.test(readFileSync(path, "utf8")))
    .map((path) => relative(repositoryRoot, path));
  assert.deepEqual(violations, []);

  const repositorySource = readFileSync(
    resolve(import.meta.dirname, "../src/gameplayRepository.ts"),
    "utf8",
  );
  assert.match(
    repositorySource,
    /export type GameplayRepository = ProfileOwnershipReader/,
  );
  assert.doesNotMatch(
    repositorySource,
    /\b(?:findProfileId|findProfileIds|listProfileLoginUids|getGameplayProfile|getGameplayProfileOwnership|resolveCanonicalProfileId|resolveCanonicalProfileIds)\b/,
  );

  const eventProjectionCore = readFileSync(
    resolve(
      import.meta.dirname,
      "../../../runtime/eventProfileGameProjectionCore.js",
    ),
    "utf8",
  );
  const eventProjectionRepository = readFileSync(
    resolve(import.meta.dirname, "../src/profileGameProjectionRepository.ts"),
    "utf8",
  );
  assert.match(eventProjectionCore, /readProfileOwnershipSnapshot/);
  assert.doesNotMatch(eventProjectionCore, /\b(?:getMergeTarget|getProfile)\b/);
  assert.match(
    eventProjectionRepository,
    /readEventProjectionOwnershipSnapshot/,
  );
  assert.doesNotMatch(
    eventProjectionRepository,
    /\b(?:readCanonicalMergeTarget|readCanonicalProfile)\b/,
  );
});

function isTypeOnlyImport(
  declaration: import("typescript").ImportDeclaration,
): boolean {
  const clause = declaration.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  return (
    !clause.name &&
    clause.namedBindings !== undefined &&
    typescript.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(
  declaration: import("typescript").ExportDeclaration,
): boolean {
  return (
    declaration.isTypeOnly ||
    (declaration.exportClause !== undefined &&
      typescript.isNamedExports(declaration.exportClause) &&
      declaration.exportClause.elements.length > 0 &&
      declaration.exportClause.elements.every((element) => element.isTypeOnly))
  );
}

function runtimeSpecifiers(path: string): string[] {
  const source = typescript.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    typescript.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (
      typescript.isImportDeclaration(statement) &&
      typescript.isStringLiteral(statement.moduleSpecifier) &&
      !isTypeOnlyImport(statement)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (
      typescript.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      typescript.isStringLiteral(statement.moduleSpecifier) &&
      !isTypeOnlyExport(statement)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  function visit(node: import("typescript").Node): void {
    if (
      typescript.isCallExpression(node) &&
      (node.expression.kind === typescript.SyntaxKind.ImportKeyword ||
        (typescript.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      typescript.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    typescript.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

function resolveRuntimeImport(
  importer: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const unresolved = resolve(dirname(importer), specifier);
  const importedExtension = extname(unresolved);
  const base = runtimeExtensions.includes(importedExtension)
    ? unresolved.slice(0, -importedExtension.length)
    : unresolved;
  const candidates = [
    unresolved,
    ...runtimeExtensions.map((extension) => `${base}${extension}`),
    ...runtimeExtensions.map((extension) =>
      resolve(unresolved, `index${extension}`),
    ),
  ];
  return (
    candidates.find(
      (candidate) =>
        candidate.startsWith(repositoryRoot) &&
        runtimeExtensions.includes(extname(candidate)) &&
        existsSync(candidate) &&
        statSync(candidate).isFile(),
    ) || null
  );
}

function reachableRuntimeFiles(entry: string): string[] {
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    for (const specifier of runtimeSpecifiers(path)) {
      const dependency = resolveRuntimeImport(path, specifier);
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return Array.from(visited).sort();
}

test("the final Worker runtime has no Firestore profile transport or retired bindings", () => {
  const forbidden =
    /(?:authFirestore|firestoreRest|firestore\.googleapis\.com|googleapis\.com\/auth\/datastore|__firestoreTimestamp|isSafeFirestoreDocumentId|FIRESTORE_SCOPE|FIRESTORE_SERVICE_ACCOUNT_|RATING_SERVICE_ACCOUNT_|USERNAME_SERVICE_ACCOUNT_|PROFILE_STORAGE_MODE|PROFILE_READ_MODE|PROFILE_ACTIVATION_LOGIN_UID|PROFILE_PROJECTION_QUEUE)/;
  const violations = reachableRuntimeFiles(
    resolve(import.meta.dirname, "../src/index.ts"),
  )
    .filter((path) => forbidden.test(readFileSync(path, "utf8")))
    .map((path) => relative(repositoryRoot, path));
  assert.deepEqual(violations, []);
});

test("canonical auth and recovery cannot construct Firebase clients or access Firebase configuration", () => {
  for (const file of [
    "authIdentity.ts",
    "authIdentityCanonical.ts",
    "authRecovery.ts",
  ]) {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src", file),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /firebaseRtdb|\bStateRepository\b|createEventStateRepository|FIREBASE_[A-Z_]+|\bfetch\s*\(/,
      file,
    );
  }
});
