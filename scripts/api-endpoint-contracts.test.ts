import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
const root = resolve(import.meta.dirname, "..");
const clientChecks: Record<string, string> = {
  "src/services/authApi.ts": `
declare const endpointToken: AuthTokenProvider;
authMutationRequest("/auth/intents", { method: "sol" }, endpointToken, isAuthIntentResponse, 15_000);
authRequest("/auth/methods", { method: "GET" }, endpointToken, isLinkedAuthMethodsResponse);
// @ts-expect-error A GET endpoint cannot be requested with POST.
authRequest("/auth/methods", { method: "POST" }, endpointToken, isLinkedAuthMethodsResponse);
// @ts-expect-error The literal intent path controls the pre-serialization body.
authMutationRequest("/auth/intents", { intentId: "intent" }, endpointToken, isAuthIntentResponse);
// @ts-expect-error A response validator cannot widen the literal endpoint.
authMutationRequest("/auth/intents", { method: "sol" }, endpointToken, isLinkedAuthMethodsResponse);
// @ts-expect-error X flow requests cannot use a verification body.
authMutationRequest("/auth/x/flows", { method: "sol" }, endpointToken, isXRedirectStartResponse);
`,
  "src/services/profileApi.ts": `
declare const endpointToken: AuthTokenProvider;
profileRequest("/profiles/lookup", { kind: "login", id: "login" }, endpointToken, isProfileLookupResponse);
// @ts-expect-error Lookup cannot infer the canonical-id request from the body.
profileRequest("/profiles/lookup", { profileId: "profile" }, endpointToken, isProfileLookupResponse);
// @ts-expect-error A username validator cannot replace the lookup response.
profileRequest("/profiles/lookup", { kind: "login", id: "login" }, endpointToken, isUsernameEditResponse);
`,
  "src/services/gameplayApi.ts": `
declare const endpointToken: AuthTokenProvider;
declare const endpointMove: SubmitMoveRequest;
declare const endpointCreate: CreateEventRequest;
gameplayMutation("/matches/move", endpointMove, endpointToken, isSubmitMoveResponse);
gameplayMutation("/matches/move?existing=1", endpointMove, endpointToken, isSubmitMoveResponse);
retryGameSessionMutation("/matches/move?existing=1", endpointMove, endpointToken, isSubmitMoveResponse, false);
eventMutation("/events/create", endpointCreate, endpointToken, isCreateEventResponse);
gameplayMutation("/events/create?eventSnapshot=v1", endpointCreate, endpointToken, isRecord);
// @ts-expect-error The literal path cannot infer another endpoint's body.
gameplayMutation("/matches/move", {}, endpointToken, isSubmitMoveResponse);
// @ts-expect-error A query suffix cannot widen the request body.
gameplayMutation("/matches/move?existing=1", {}, endpointToken, isSubmitMoveResponse);
// @ts-expect-error The literal path cannot infer another endpoint's validator.
gameplayMutation("/matches/move", endpointMove, endpointToken, isReadMatchSnapshotResponse);
// @ts-expect-error A query suffix cannot widen the response validator.
gameplayMutation("/matches/move?existing=1", endpointMove, endpointToken, isReadMatchSnapshotResponse);
// @ts-expect-error Retry helpers preserve the path/body correlation.
retryGameSessionMutation("/matches/move?existing=1", {}, endpointToken, isSubmitMoveResponse, false);
// @ts-expect-error Raw envelope validation only belongs to event-control reads.
gameplayMutation("/matches/move?eventSnapshot=v1", endpointMove, endpointToken, isRecord);
// @ts-expect-error The event-control envelope still requires its exact request body.
gameplayMutation("/events/create?eventSnapshot=v1", { eventId: "event" }, endpointToken, isRecord);
// @ts-expect-error The raw event envelope is only requested with its existing query.
gameplayMutation("/events/create", endpointCreate, endpointToken, isRecord);
// @ts-expect-error The post-envelope base validator remains endpoint-specific.
eventMutation("/events/create", endpointCreate, endpointToken, isJoinEventResponse);
`,
  "src/services/eventPrizeApi.ts": `
declare const endpointToken: AuthTokenProvider;
declare const endpointStart: import("@mons/shared/api-contracts").ApiRequest<"POST /events/prizes/withdrawals">;
declare const endpointStatus: EventPrizeWithdrawalStatusRequest;
declare const endpointDependencies: Required<Pick<EventPrizeApiDependencies, "fetcher" | "now" | "requestTimeoutMs">>;
postWithdrawalRequest("/events/prizes/withdrawals", endpointStart, endpointToken, 1, endpointDependencies);
postWithdrawalRequest("/events/prizes/withdrawals/status", endpointStatus, endpointToken, 1, endpointDependencies);
// @ts-expect-error A status request cannot become a start request through inference.
postWithdrawalRequest("/events/prizes/withdrawals", endpointStatus, endpointToken, 1, endpointDependencies);
// @ts-expect-error Starting fields do not provide the existing withdrawal operation ID.
postWithdrawalRequest("/events/prizes/withdrawals/status", endpointStart, endpointToken, 1, endpointDependencies);
`,
  "src/services/sessionApi.ts": `
request(SESSION_ANONYMOUS_PATH, { body: "{}" });
request(SESSION_REFRESH_PATH, {});
request(SESSION_LOGOUT_PATH, {});
requestToken(SESSION_ANONYMOUS_PATH, { body: "{}" }, "session");
requestToken(SESSION_REFRESH_PATH, {}, "session");
// @ts-expect-error Refresh preserves its bodyless transport contract.
request(SESSION_REFRESH_PATH, { body: "{}" });
// @ts-expect-error Logout preserves its empty request contract.
request(SESSION_LOGOUT_PATH, { body: "{}" });
// @ts-expect-error Allocation requires a serialized create request.
request(SESSION_ANONYMOUS_PATH, {});
// @ts-expect-error Query suffixes do not permit a refresh body.
request("/auth/session/refresh?bootstrapIdentity=1", { body: "{}" });
// @ts-expect-error The token helper keeps refresh bodyless.
requestToken(SESSION_REFRESH_PATH, { body: "{}" }, "session");
// @ts-expect-error The token helper requires allocation body bytes.
requestToken(SESSION_ANONYMOUS_PATH, {}, "session");
`,
};

function contractDiagnostics(
  configuration: string,
  checks: Record<string, string>,
  overrides: Record<string, string> = {},
): readonly ts.Diagnostic[] {
  const config = ts.getParsedCommandLineOfConfigFile(
    resolve(root, configuration),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  assert.ok(config);
  assert.deepEqual(config.errors, []);
  const replacements = new Map(
    Object.entries(checks).map(([file, appended]) => {
      const path = resolve(root, file);
      return [path, `${readFileSync(path, "utf8")}\n${appended}`];
    }),
  );
  for (const [file, text] of Object.entries(overrides))
    replacements.set(resolve(root, file), text);
  const host = ts.createCompilerHost(config.options);
  const readFile = host.readFile;
  host.readFile = (file) => replacements.get(resolve(file)) ?? readFile(file);
  const program = ts.createProgram(config.fileNames, config.options, host);
  return ts.getPreEmitDiagnostics(program);
}

function assertNoDiagnostics(diagnostics: readonly ts.Diagnostic[]): void {
  assert.deepEqual(
    diagnostics.map((diagnostic) => ({
      file: diagnostic.file?.fileName,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    })),
    [],
  );
}

test("actual client endpoint helpers reject cross-paired requests and validators", () => {
  assertNoDiagnostics(contractDiagnostics("tsconfig.json", clientChecks));
});

test("the event route builder binds each existing parser and handler to its literal path", () => {
  assertNoDiagnostics(
    contractDiagnostics("cloud/workers/api/tsconfig.json", {
      "cloud/workers/api/src/eventRouteDefinitions.ts": `
declare const endpointCreate: CreateEventRequest;
declare const endpointResult: import("@mons/shared/api-contracts").ApiResponse<"POST /events/create">;
defineEventRoute({ path: "/events/create", kind: "control", parse: () => endpointCreate, handle: () => Promise.resolve(endpointResult) });
// @ts-expect-error Participation bodies cannot widen the literal create endpoint.
defineEventRoute({ path: "/events/create", kind: "control", parse: () => ({ eventId: "event" }), handle: () => Promise.resolve(endpointResult) });
// @ts-expect-error A control path cannot register as a participation route.
defineEventRoute({ path: "/events/create", kind: "participation", parse: () => endpointCreate, handle: () => Promise.resolve(endpointResult) });
// @ts-expect-error A successful unrelated body cannot become the create response.
defineEventRoute({ path: "/events/create", kind: "control", parse: () => endpointCreate, handle: () => Promise.resolve({ ok: true, eventId: "event" }) });
`,
    }),
  );
});

test("existing query readers check contract keys and accepted mode values", () => {
  const mutations = [
    {
      file: "cloud/workers/api/src/sessionBootstrap.ts",
      from: '"bootstrapIdentity" satisfies keyof SessionQuery',
      to: '"identity" satisfies keyof SessionQuery',
    },
    {
      file: "cloud/workers/api/src/eventReadRoute.ts",
      from: '"1" satisfies NonNullable<',
      to: '"2" satisfies NonNullable<',
    },
    {
      file: "cloud/workers/api/src/xCallback.ts",
      from: '"state" satisfies keyof ApiQuery<"GET /auth/x/callback">',
      to: '"flow" satisfies keyof ApiQuery<"GET /auth/x/callback">',
    },
  ];
  const changed = Object.fromEntries(
    mutations.map(({ file, from, to }) => {
      const source = readFileSync(resolve(root, file), "utf8");
      assert.ok(source.includes(from), file);
      return [file, source.replace(from, to)];
    }),
  );
  const diagnostics = contractDiagnostics(
    "cloud/workers/api/tsconfig.json",
    {},
    changed,
  );
  for (const { file } of mutations) {
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.file?.fileName === resolve(root, file) &&
          diagnostic.code === 1360,
      ),
      file,
    );
  }
  assert.equal(diagnostics.length, mutations.length);
});
