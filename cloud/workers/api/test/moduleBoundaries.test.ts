import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import test from "node:test";
import typescript from "typescript";
import * as entrypoint from "../src/workerHandler.ts";
import { extractIdFromJsonUri } from "../src/helius.ts";
import { handleRequest } from "../src/router.ts";
import * as eventProgress from "../src/eventProgress.ts";
import * as eventProgressDispatch from "../src/eventProgressDispatch.ts";

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
    for (const path of reachableRuntimeFiles(
      resolve(import.meta.dirname, "../src", filename),
    )) {
      assert.doesNotMatch(
        readFileSync(path, "utf8"),
        /(?:authFirestore|firestoreRest|createGoogleAccessToken|firestore\.googleapis\.com)/,
        relative(repositoryRoot, path),
      );
    }
  }
});

test("canonical profile internals never import their public facade", () => {
  const facade = resolve(import.meta.dirname, "../src/profileCanonicalD1.ts");
  const internalRoot = resolve(import.meta.dirname, "../src/profileCanonical");
  const violations = reachableRuntimeFiles(facade)
    .filter((path) => path.startsWith(`${internalRoot}/`))
    .filter((path) =>
      runtimeSpecifiers(path).some(
        (specifier) => resolveRuntimeImport(path, specifier) === facade,
      ),
    )
    .map((path) => relative(repositoryRoot, path));
  assert.deepEqual(violations, []);
});

for (const module of [
  "automatch",
  "eventD1",
  "authIdentityCanonical",
  "profileGameProjection",
]) {
  test(`${module} internals have no facade dependencies or runtime cycles`, () => {
    const facade = resolve(import.meta.dirname, `../src/${module}.ts`);
    const internalRoot = resolve(import.meta.dirname, `../src/${module}`);
    const internals = reachableRuntimeFiles(facade).filter((path) =>
      path.startsWith(`${internalRoot}/`),
    );
    assert.ok(internals.length > 0);
    for (const path of internals) {
      const dependencies = runtimeSpecifiers(path)
        .map((specifier) => resolveRuntimeImport(path, specifier))
        .filter((dependency): dependency is string => dependency !== null);
      for (const dependency of dependencies) {
        const reachable = reachableRuntimeFiles(dependency);
        assert.ok(!reachable.includes(facade), relative(repositoryRoot, path));
        assert.ok(!reachable.includes(path), relative(repositoryRoot, path));
      }
    }
  });
}

test("projection processing and recovery have separate dependency boundaries", () => {
  const root = resolve(import.meta.dirname, "../src/profileGameProjection");
  const processing = resolve(root, "processing.ts");
  const recovery = resolve(root, "recovery.ts");
  const queue = resolve(root, "queue.ts");
  assert.ok(!reachableRuntimeFiles(processing).includes(recovery));
  assert.ok(!reachableRuntimeFiles(recovery).includes(processing));
  assert.ok(!reachableRuntimeFiles(recovery).includes(queue));
});

test("event announcement scheduling and dispatch do not depend on recovery orchestration", () => {
  const recovery = resolve(import.meta.dirname, "../src/eventProgress.ts");
  for (const entry of [
    "eventPrizeAnnouncementSchedule.ts",
    "eventProgressDispatch.ts",
  ]) {
    assert.ok(
      !reachableRuntimeFiles(
        resolve(import.meta.dirname, "../src", entry),
      ).includes(recovery),
      entry,
    );
  }
});

test("event progress retains its public dispatch function identities", () => {
  assert.strictEqual(
    eventProgress.ensureEventProgressWorkflow,
    eventProgressDispatch.ensureEventProgressWorkflow,
  );
  assert.strictEqual(
    eventProgress.removeOutbox,
    eventProgressDispatch.removeOutbox,
  );
});

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const runtimeExtensions = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

test("Worker database execution uses domain methods and isolated compatibility codecs", () => {
  const codecPaths = new Set([
    "cloud/workers/api/src/eventCompatibilityCodec.ts",
    "cloud/workers/api/src/eventTransitionCodec.ts",
    "cloud/workers/api/src/gameSessionCodec.ts",
  ]);
  const retiredMethods = new Set([
    "getPath",
    "patchRoot",
    "transactPath",
    "getStatePath",
    "patchStateRoot",
    "transactStatePath",
    "replacePaths",
  ]);
  const databaseRoot =
    /^(?:players|invites|automatch|telegramMessages|telegramAutomatches|telegramProjectionOutbox|profileGameProjectionOutbox|eventLocks|eventSyncThrottles|events|eventPrizeSelections|profileEventPrizes|eventPrizeWithdrawals|eventProgressOutbox|eventProgressOutboxDead|eventTelegramProjections|eventTelegramProjectionGenerations|gameplayMutationReceipts|gameplayMutationReceiptExpirations)\//;
  const violations: string[] = [];
  for (const path of reachableRuntimeFiles(
    resolve(import.meta.dirname, "../src/index.ts"),
  )) {
    const file = relative(repositoryRoot, path);
    const codec = codecPaths.has(file);
    const source = typescript.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      typescript.ScriptTarget.Latest,
      true,
    );
    const report = (node: import("typescript").Node, reason: string) => {
      violations.push(
        `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${reason}`,
      );
    };
    const visit = (node: import("typescript").Node): void => {
      if (typescript.isIdentifier(node) && retiredMethods.has(node.text)) {
        report(node, `retired ${node.text} API`);
      }
      if (
        typescript.isElementAccessExpression(node) &&
        typescript.isStringLiteralLike(node.argumentExpression) &&
        retiredMethods.has(node.argumentExpression.text)
      ) {
        report(node, "retired database method lookup");
      }
      if (
        !codec &&
        typescript.isTemplateExpression(node) &&
        databaseRoot.test(node.head.text)
      ) {
        report(node, "database path constructed outside a compatibility codec");
      }
      if (codec && typescript.isCallExpression(node)) {
        const expression = node.expression;
        if (
          (typescript.isIdentifier(expression) &&
            expression.text === "fetch") ||
          (typescript.isPropertyAccessExpression(expression) &&
            ["prepare", "batch", "getByName"].includes(expression.name.text))
        ) {
          report(node, "I/O inside a compatibility codec");
        }
      }
      typescript.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(violations, []);
});

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

test("event runtimes install the shared ownership snapshot through an independent factory", () => {
  const factory = resolve(import.meta.dirname, "../src/workerEventRuntime.ts");
  const source = readFileSync(factory, "utf8");
  assert.match(source, /readProfileOwnershipSnapshot:\s*\(query\)\s*=>/);
  assert.match(source, /requireProfileOwnershipSnapshot\(repository, query\)/);
  for (const filename of ["eventOperations.ts", "eventProgress.ts"]) {
    const consumer = resolve(import.meta.dirname, "../src", filename);
    assert.ok(reachableRuntimeFiles(consumer).includes(factory));
    assert.ok(!reachableRuntimeFiles(factory).includes(consumer));
  }
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
  const internalRoot = resolve(
    import.meta.dirname,
    "../src/authIdentityCanonical",
  );
  const sources = new Set<string>();
  for (const file of [
    "authIdentity.ts",
    "authIdentityCanonical.ts",
    "authRecovery.ts",
  ]) {
    const entry = resolve(import.meta.dirname, "../src", file);
    sources.add(entry);
    for (const path of reachableRuntimeFiles(entry)) {
      if (path.startsWith(`${internalRoot}/`)) sources.add(path);
    }
  }
  for (const path of sources) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(
      source,
      /firebaseRtdb|\bStateRepository\b|createEventStateRepository|FIREBASE_[A-Z_]+|\bfetch\s*\(/,
      relative(repositoryRoot, path),
    );
  }
});
