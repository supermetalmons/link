import {
  X_REDIRECT_RESULT_PARAMS,
  normalizeServerXConsentSource,
  type XConsentSource,
} from "@mons/shared/x-redirect";
import {
  AuthStateConflict,
  createAuthStateRepository,
  type XFlowUpdate,
  type XFlowRepository,
  type XRedirectFlow,
} from "./authStateD1.ts";
import {
  createXOAuthProvider,
  XProviderFailure,
  type XOAuthProvider,
} from "./xProvider.ts";
import {
  PROFILE_WRITES_RETRY_AFTER_SECONDS,
  ProfileWritesDisabledFailure,
} from "./authErrors.ts";
import { authMutationsDisabled } from "./authPolicy.ts";
import { assertProfileMutationAllowed } from "./profileCanonicalActivation.ts";
import { safeXReturnUrl, X_FLOW_ID_PATTERN, X_FLOW_TTL_MS } from "./xFlow.ts";

const X_CALLBACK_PROCESSING_LEASE_MS = 60_000;

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export type XCallbackDependencyOverrides = {
  repository?: XFlowRepository;
  provider?: XOAuthProvider;
  now?: () => number;
  logFailure?: (kind: string) => void;
};

function textResponse(body: string, status: number, headers?: HeadersInit) {
  return new Response(body, {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

function redirectResponse({
  returnUrl,
  flowId,
  status,
  errorCode,
  consentSource,
}: {
  returnUrl: string;
  flowId: string;
  status: "ready" | "failed";
  errorCode: string;
  consentSource: XConsentSource;
}): Response {
  const target = new URL(safeXReturnUrl(returnUrl));
  target.searchParams.set(X_REDIRECT_RESULT_PARAMS.flowId, flowId);
  target.searchParams.set(X_REDIRECT_RESULT_PARAMS.status, status);
  if (errorCode) {
    target.searchParams.set(X_REDIRECT_RESULT_PARAMS.error, errorCode);
  } else {
    target.searchParams.delete(X_REDIRECT_RESULT_PARAMS.error);
  }
  target.searchParams.set(
    X_REDIRECT_RESULT_PARAMS.consentSource,
    consentSource,
  );
  return new Response(null, {
    status: 302,
    headers: { ...RESPONSE_HEADERS, Location: target.toString() },
  });
}

function publicErrorCode(error: unknown): string {
  const raw =
    error instanceof XProviderFailure
      ? error.publicCode
      : "x-redirect-verify-failed";
  return raw.trim().slice(0, 120) || "x-redirect-verify-failed";
}

function terminalFlowRedirect(
  flowId: string,
  flow: XRedirectFlow,
): Response | null {
  const returnUrl = safeXReturnUrl(flow.returnUrl);
  const consentSource = normalizeServerXConsentSource(flow.consentSource);
  if (flow.status === "completed" || flow.status === "verified") {
    return redirectResponse({
      returnUrl,
      flowId,
      status: "ready",
      errorCode: "",
      consentSource,
    });
  }
  if (flow.status === "failed") {
    return redirectResponse({
      returnUrl,
      flowId,
      status: "failed",
      errorCode: flow.errorCode || "x-redirect-failed",
      consentSource,
    });
  }
  return null;
}

export async function handleXCallback(
  request: Request,
  env: Env,
  overrides: XCallbackDependencyOverrides = {},
): Promise<Response> {
  if (request.method !== "GET") {
    return textResponse("Method Not Allowed", 405, { Allow: "GET" });
  }
  const flowId = new URL(request.url).searchParams.get("state")?.trim() || "";
  if (!X_FLOW_ID_PATTERN.test(flowId)) {
    return textResponse("Missing or invalid state.", 400);
  }

  const repository =
    overrides.repository || createAuthStateRepository(env.AUTH_STATE_DB);
  const provider = overrides.provider || createXOAuthProvider(env);
  const now = overrides.now || Date.now;
  const logFailure =
    overrides.logFailure ||
    ((kind: string) => {
      console.error(JSON.stringify({ event: "x_callback_failure", kind }));
    });

  let flow;
  try {
    flow = await repository.getXFlow(flowId);
  } catch {
    logFailure("auth-state-read");
    return textResponse("Service Unavailable", 503);
  }
  if (!flow) {
    return textResponse("X auth session not found.", 400);
  }

  const existingRedirect = terminalFlowRedirect(flowId, flow);
  if (existingRedirect) {
    return existingRedirect;
  }
  try {
    await assertProfileMutationAllowed(env);
  } catch (error) {
    if (error instanceof ProfileWritesDisabledFailure) {
      return textResponse("profile-writes-disabled", 503, {
        "Retry-After": String(PROFILE_WRITES_RETRY_AFTER_SECONDS),
      });
    }
    logFailure("profile-storage-mode");
    return textResponse("Service Unavailable", 503);
  }
  if (authMutationsDisabled(env.AUTH_MUTATIONS_DISABLED)) {
    return textResponse("Auth maintenance in progress.", 503, {
      "Retry-After": "60",
    });
  }
  const returnUrl = safeXReturnUrl(flow.returnUrl);
  const consentSource = normalizeServerXConsentSource(flow.consentSource);
  const updateFlow = async (
    expectedFlow: XRedirectFlow,
    updates: XFlowUpdate,
  ): Promise<{ response: Response } | { revision: number }> => {
    let writeError: unknown;
    try {
      return {
        revision: await repository.updateXFlow(
          flowId,
          updates,
          expectedFlow.revision,
        ),
      };
    } catch (error) {
      writeError = error;
    }
    if (
      updates.status !== "processing" &&
      !(writeError instanceof AuthStateConflict)
    ) {
      try {
        return {
          revision: await repository.updateXFlow(
            flowId,
            updates,
            expectedFlow.revision,
          ),
        };
      } catch (error) {
        writeError = error;
      }
    }
    if (writeError instanceof AuthStateConflict) {
      console.info(
        JSON.stringify({
          event: "auth_state_conflict",
          operation: "x_callback",
        }),
      );
    }
    let current: XRedirectFlow | null;
    try {
      current = await repository.getXFlow(flowId);
    } catch {
      logFailure("auth-state-read");
      return { response: textResponse("Service Unavailable", 503) };
    }
    if (!current) {
      return { response: textResponse("X auth session not found.", 400) };
    }
    const authoritativeRedirect = terminalFlowRedirect(flowId, current);
    if (authoritativeRedirect) {
      return { response: authoritativeRedirect };
    }
    if (!(writeError instanceof AuthStateConflict)) {
      logFailure("auth-state-update");
    }
    return {
      response: textResponse("Authorization is still processing.", 503, {
        "Retry-After": "2",
      }),
    };
  };

  const failFlow = async (
    expectedFlow: XRedirectFlow,
    errorCode: string,
  ): Promise<Response> => {
    const outcome = await updateFlow(expectedFlow, {
      status: "failed",
      errorCode,
      ...(expectedFlow.status === "processing"
        ? { processingStartedAtMs: null }
        : {}),
      updatedAtMs: now(),
    });
    if ("response" in outcome) {
      return outcome.response;
    }
    return redirectResponse({
      returnUrl,
      flowId,
      status: "failed",
      errorCode,
      consentSource,
    });
  };

  const nowMs = now();
  if (flow.status !== "created" && flow.status !== "processing") {
    return textResponse("X auth session is invalid.", 400);
  }
  if (
    flow.expiresAtMs <= 0 ||
    flow.expiresAtMs < nowMs ||
    (flow.createdAtMs > 0 && nowMs - flow.createdAtMs > X_FLOW_TTL_MS * 2)
  ) {
    return failFlow(flow, "x-redirect-expired");
  }
  if (
    flow.status === "processing" &&
    flow.processingStartedAtMs > 0 &&
    nowMs <= flow.processingStartedAtMs + X_CALLBACK_PROCESSING_LEASE_MS
  ) {
    return textResponse("Authorization is still processing.", 503, {
      "Retry-After": "2",
    });
  }

  const url = new URL(request.url);
  const oauthError = url.searchParams.get("error")?.trim() || "";
  if (oauthError) {
    return failFlow(flow, `x-oauth-${oauthError}`.slice(0, 120));
  }
  const code = url.searchParams.get("code")?.trim() || "";
  if (!code) {
    return failFlow(flow, "x-oauth-missing-code");
  }
  if (!flow.callbackUri || !flow.codeVerifier) {
    return failFlow(flow, "x-redirect-verify-failed");
  }

  const processingStartedAtMs = now();
  const claim = await updateFlow(flow, {
    status: "processing",
    processingStartedAtMs,
    errorCode: null,
    updatedAtMs: processingStartedAtMs,
  });
  if ("response" in claim) {
    return claim.response;
  }
  flow = {
    ...flow,
    status: "processing" as const,
    processingStartedAtMs,
    revision: claim.revision,
  };

  let authenticatedUser;
  try {
    const accessToken = await provider.exchangeCode({
      code,
      callbackUri: flow.callbackUri,
      codeVerifier: flow.codeVerifier,
    });
    authenticatedUser = await provider.fetchAuthenticatedUser(accessToken);
  } catch (error) {
    const errorCode = publicErrorCode(error);
    logFailure("x-provider");
    return failFlow(flow, errorCode);
  }

  const outcome = await updateFlow(flow, {
    status: "verified",
    xUserId: authenticatedUser.id,
    xUsername: authenticatedUser.username || null,
    errorCode: null,
    processingStartedAtMs: null,
    updatedAtMs: now(),
  });
  if ("response" in outcome) {
    return outcome.response;
  }

  return redirectResponse({
    returnUrl,
    flowId,
    status: "ready",
    errorCode: "",
    consentSource,
  });
}
