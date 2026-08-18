import {
  X_REDIRECT_RESULT_PARAMS,
  normalizeServerXConsentSource,
  type XConsentSource,
} from "@mons/shared/x-redirect";
import { createXFlowRepository, type XFlowRepository } from "./firestore.ts";
import {
  createXOAuthProvider,
  XProviderFailure,
  type XOAuthProvider,
} from "./xProvider.ts";
import { safeXReturnUrl, X_FLOW_ID_PATTERN, X_FLOW_TTL_MS } from "./xFlow.ts";

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

  const repository = overrides.repository || createXFlowRepository(env);
  const provider = overrides.provider || createXOAuthProvider(env);
  const now = overrides.now || Date.now;
  const logFailure =
    overrides.logFailure ||
    ((kind: string) => {
      console.error(JSON.stringify({ event: "x_callback_failure", kind }));
    });

  let flow;
  try {
    flow = await repository.getFlow(flowId);
  } catch {
    logFailure("firestore-read");
    return textResponse("Service Unavailable", 503);
  }
  if (!flow) {
    return textResponse("X auth session not found.", 400);
  }

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

  const failFlow = async (errorCode: string): Promise<Response> => {
    try {
      await repository.updateFlow(flowId, {
        status: "failed",
        errorCode,
        updatedAtMs: now(),
      });
    } catch {
      logFailure("firestore-update");
      return textResponse("Service Unavailable", 503);
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
  if (
    flow.expiresAtMs <= 0 ||
    flow.expiresAtMs < nowMs ||
    (flow.createdAtMs > 0 && nowMs - flow.createdAtMs > X_FLOW_TTL_MS * 2)
  ) {
    return failFlow("x-redirect-expired");
  }

  const url = new URL(request.url);
  const oauthError = url.searchParams.get("error")?.trim() || "";
  if (oauthError) {
    return failFlow(`x-oauth-${oauthError}`.slice(0, 120));
  }
  const code = url.searchParams.get("code")?.trim() || "";
  if (!code) {
    return failFlow("x-oauth-missing-code");
  }
  if (!flow.callbackUri || !flow.codeVerifier) {
    return failFlow("x-redirect-verify-failed");
  }

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
    return failFlow(errorCode);
  }

  try {
    await repository.updateFlow(flowId, {
      status: "verified",
      xUserId: authenticatedUser.id,
      xUsername: authenticatedUser.username || null,
      errorCode: null,
      updatedAtMs: now(),
    });
  } catch {
    logFailure("firestore-update");
    return textResponse("Service Unavailable", 503);
  }

  return redirectResponse({
    returnUrl,
    flowId,
    status: "ready",
    errorCode: "",
    consentSource,
  });
}
