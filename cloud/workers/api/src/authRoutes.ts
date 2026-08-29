import {
  normalizeAuthMethod,
  type AuthIntentResponse,
} from "@mons/shared/auth";
import { base64url } from "jose";
import {
  normalizeServerXConsentSource,
  type XRedirectStartResponse,
} from "@mons/shared/x-redirect";
import {
  createAuthProfileRepository,
  type AuthProfileRepository,
} from "./authProfileRepository.ts";
import {
  AuthStateConflict,
  AuthStateFailure,
  createAuthStateRepository,
  type AuthIntentDocument,
  type AuthStateRepository,
  type XRedirectFlowDocument,
} from "./authStateD1.ts";
import {
  verifyFirebaseRequest,
  type FirebaseIdentity,
  type WorkerExecutionContext,
} from "./firebaseAuth.ts";
import {
  AuthApiFailure,
  authErrorResponse,
  isProfileWritesDisabledFailure,
  toAuthApiFailure,
} from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import { readBoundedJson } from "./http.ts";
import {
  buildXAuthorizationUrl,
  safeXReturnUrl,
  X_CALLBACK_URI,
  X_FLOW_TTL_MS,
} from "./xFlow.ts";
import {
  syncProfileClaim,
  type ProfileClaimDependencies,
} from "./profileClaim.ts";
import {
  handleAuthMutation,
  type AuthMutationDependencies,
} from "./authMutations.ts";
import { authMutationsDisabled } from "./authPolicy.ts";
import { secureAlphanumericId, secureRandomBytes } from "./authRandom.ts";
import { assertProfileMutationAllowed } from "./profileCanonicalActivation.ts";

const AUTH_INTENT_TTL_MS = 5 * 60 * 1_000;
const CREATE_ID_ATTEMPTS = 3;
const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export type AuthRouteDependencies = {
  logFailure?: (kind: string) => void;
  now?: () => number;
  profileClaim?: ProfileClaimDependencies;
  randomBytes?: (length: number) => Uint8Array;
  repository?: AuthProfileRepository;
  stateRepository?: AuthStateRepository;
  mutation?: AuthMutationDependencies;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<FirebaseIdentity>;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertMethod(request: Request, expected: string): void {
  if (request.method !== expected) {
    throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
  }
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = toRecord(await readBoundedJson(request));
    if (!value) {
      throw new Error("invalid-body");
    }
    return value;
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
}

async function enforceAuthRateLimit(env: Env, key: string): Promise<void> {
  let outcome: RateLimitOutcome;
  try {
    outcome = await env.AUTH_RATE_LIMITER.limit({ key });
  } catch {
    throw new AuthApiFailure(503, "unavailable", "rate-limit-unavailable");
  }
  if (!outcome.success) {
    throw new AuthApiFailure(
      429,
      "resource-exhausted",
      "Too many auth attempts.",
    );
  }
}

async function handleBeginIntent(
  request: Request,
  env: Env,
  identity: FirebaseIdentity,
  repository: AuthStateRepository,
  dependencies: AuthRouteDependencies,
): Promise<AuthIntentResponse> {
  const body = await parseBody(request);
  const method = normalizeAuthMethod(body.method);
  if (!method || Object.keys(body).length !== 1) {
    throw new AuthApiFailure(
      400,
      "invalid-argument",
      "unsupported-auth-method",
    );
  }
  await enforceAuthRateLimit(env, `auth-intent:${method}:${identity.uid}`);

  const randomBytes = dependencies.randomBytes || secureRandomBytes;
  const nowMs = (dependencies.now || Date.now)();
  for (let attempt = 0; attempt < CREATE_ID_ATTEMPTS; attempt++) {
    const intentId = base64url.encode(randomBytes(18));
    const document: AuthIntentDocument = {
      consumedAtMs: null,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + AUTH_INTENT_TTL_MS,
      intentId,
      method,
      nonce:
        method === "eth"
          ? secureAlphanumericId(24, randomBytes)
          : base64url.encode(randomBytes(18)),
      state: base64url.encode(randomBytes(18)),
      uid: identity.uid,
    };
    if ((await repository.createAuthIntent(document)) === "created") {
      const response: AuthIntentResponse = {
        ok: true,
        intentId,
        nonce: document.nonce,
        state: document.state,
        expiresAtMs: document.expiresAtMs,
      };
      return response;
    }
  }
  throw new AuthApiFailure(503, "unavailable", "auth-intent-unavailable");
}

async function handleBeginXFlow(
  request: Request,
  env: Env,
  identity: FirebaseIdentity,
  repository: AuthStateRepository,
  dependencies: AuthRouteDependencies,
): Promise<XRedirectStartResponse> {
  const body = await parseBody(request);
  const intentId =
    typeof body.intentId === "string" ? body.intentId.trim() : "";
  if (!AUTH_TOKEN_PATTERN.test(intentId)) {
    throw new AuthApiFailure(400, "invalid-argument", "intentId is required.");
  }
  await enforceAuthRateLimit(env, `auth-x-flow:${identity.uid}`);
  const intent = await repository.getAuthIntent(intentId);
  if (!intent) {
    throw new AuthApiFailure(409, "failed-precondition", "x-intent-invalid");
  }
  if (intent.uid !== identity.uid) {
    throw new AuthApiFailure(
      403,
      "permission-denied",
      "x-intent-user-mismatch",
    );
  }
  if (intent.method !== "x") {
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "x-intent-method-mismatch",
    );
  }
  const nowMs = (dependencies.now || Date.now)();
  if (intent.expiresAtMs <= nowMs || intent.consumedAtMs > 0) {
    throw new AuthApiFailure(409, "failed-precondition", "x-intent-invalid");
  }
  const clientId = env.X_CLIENT_ID.trim();
  if (!clientId) {
    throw new AuthApiFailure(503, "unavailable", "x-auth-unavailable");
  }
  const randomBytes = dependencies.randomBytes || secureRandomBytes;
  for (let attempt = 0; attempt < CREATE_ID_ATTEMPTS; attempt++) {
    const flowId = base64url.encode(randomBytes(18));
    const codeVerifier = base64url.encode(randomBytes(48));
    const challengeBytes = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(codeVerifier),
      ),
    );
    const codeChallenge = base64url.encode(challengeBytes);
    const consentSource = normalizeServerXConsentSource(body.consentSource);
    const returnUrl = safeXReturnUrl(
      typeof body.returnUrl === "string" ? body.returnUrl : "",
    );
    const expiresAtMs = Math.min(nowMs + X_FLOW_TTL_MS, intent.expiresAtMs);
    const document: XRedirectFlowDocument = {
      callbackUri: X_CALLBACK_URI,
      codeChallenge,
      codeVerifier,
      consentSource,
      createdAtMs: nowMs,
      errorCode: null,
      expiresAtMs,
      flowId,
      intentId,
      method: "x",
      returnUrl,
      status: "created",
      uid: identity.uid,
      updatedAtMs: nowMs,
      xUserId: null,
      xUsername: null,
    };
    if ((await repository.createXFlow(document)) === "created") {
      return {
        ok: true,
        flowId,
        authUrl: buildXAuthorizationUrl({ clientId, codeChallenge, flowId }),
        expiresAtMs,
      };
    }
  }
  throw new AuthApiFailure(503, "unavailable", "x-auth-unavailable");
}

export async function handleAuthRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: AuthRouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = getAuthCorsHeaders(request);
    if (request.method === "OPTIONS") {
      return authPreflightResponse(corsHeaders);
    }
    const pathname = new URL(request.url).pathname;
    const expectedMethod = pathname === "/auth/methods" ? "GET" : "POST";
    assertMethod(request, expectedMethod);
    const identity = await (
      dependencies.verifyIdentity || verifyFirebaseRequest
    )(request, ctx);
    if (request.method === "POST") {
      await assertProfileMutationAllowed(env);
      if (authMutationsDisabled(env.AUTH_MUTATIONS_DISABLED)) {
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          "auth-mutations-disabled",
        );
      }
    }
    const repository =
      dependencies.repository || createAuthProfileRepository(env);
    const stateRepository =
      dependencies.stateRepository ||
      createAuthStateRepository(env.AUTH_STATE_DB);
    if (
      pathname === "/auth/methods/apple/verify" ||
      pathname === "/auth/methods/eth/verify" ||
      pathname === "/auth/methods/sol/verify" ||
      pathname === "/auth/methods/unlink" ||
      pathname === "/auth/x/flows/complete"
    ) {
      const operation = pathname.split("/").slice(2).join(":");
      await enforceAuthRateLimit(
        env,
        `auth-mutation:${operation}:${identity.uid}`,
      );
      return authJsonResponse(
        await handleAuthMutation(request, identity, env, ctx, {
          ...dependencies.mutation,
          stateRepository:
            dependencies.mutation?.stateRepository || stateRepository,
        }),
        200,
        corsHeaders,
      );
    }
    if (pathname === "/auth/methods") {
      return authJsonResponse(
        await repository.getLinkedAuthMethods(identity.uid),
        200,
        corsHeaders,
      );
    }
    if (pathname === "/auth/intents") {
      return authJsonResponse(
        await handleBeginIntent(
          request,
          env,
          identity,
          stateRepository,
          dependencies,
        ),
        200,
        corsHeaders,
      );
    }
    if (pathname === "/auth/profile-claim/sync") {
      await enforceAuthRateLimit(env, `auth-profile-claim:${identity.uid}`);
      return authJsonResponse(
        await syncProfileClaim(identity, env, {
          ...dependencies.profileClaim,
          repository,
        }),
        200,
        corsHeaders,
      );
    }
    if (pathname === "/auth/x/flows") {
      return authJsonResponse(
        await handleBeginXFlow(
          request,
          env,
          identity,
          stateRepository,
          dependencies,
        ),
        200,
        corsHeaders,
      );
    }
    throw new AuthApiFailure(404, "not-found", "not-found");
  } catch (error) {
    const failure = toAuthApiFailure(error);
    if (failure.status >= 500 && !isProfileWritesDisabledFailure(failure)) {
      const kind =
        error instanceof AuthStateConflict
          ? "auth-state-conflict"
          : error instanceof AuthStateFailure
            ? "auth-state-unavailable"
            : failure.message;
      (
        dependencies.logFailure ||
        ((kind) =>
          console.error(JSON.stringify({ event: "auth_route_failure", kind })))
      )(kind);
    }
    return authErrorResponse(failure, corsHeaders);
  }
}
