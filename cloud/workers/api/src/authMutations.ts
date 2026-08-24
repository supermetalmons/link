import {
  isAppleAuthVerificationRequest,
  isAuthMethodUnlinkRequest,
  isEthereumAuthVerificationRequest,
  isSolanaAuthVerificationRequest,
  isXAuthCompletionRequest,
  type AuthVerificationResponse,
  type AuthProfileResponse,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import bs58 from "bs58";
import { getAddress, verifyMessage } from "ethers";
import nacl from "tweetnacl";
import { verifyAppleIdToken } from "./appleAuth.ts";
import { AuthApiFailure } from "./authErrors.ts";
import { isAllowedAuthOrigin } from "./authHttp.ts";
import {
  authDocumentName,
  authUpdateWrite,
  AuthFirestoreConflict,
  createAuthFirestoreClient,
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
} from "./authFirestore.ts";
import {
  createAuthIdentityService,
  type AuthIdentityService,
} from "./authIdentity.ts";
import type { FirebaseIdentity } from "./firebaseAuth.ts";
import { readBoundedJson } from "./http.ts";
import {
  cleanString,
  featureDisabled,
  normalizeMethodValue,
  readStoredFirebaseUid,
} from "./authPolicy.ts";
import { parseSiweMessage, type ParsedSiweMessage } from "./siweAuth.ts";
import { X_FLOW_TTL_MS } from "./xFlow.ts";

const AUTH_MUTATION_MAX_BODY_BYTES = 16 * 1024;
const AUTH_MUTATION_DEADLINE_MS = 40_000;

export type AuthMutationDependencies = {
  firestore?: AuthFirestoreClient;
  identityService?: AuthIdentityService;
  now?: () => number;
  operationDeadlineMs?: number;
  verifyApple?: typeof verifyAppleIdToken;
};

type AuthProfileReference = Pick<AuthProfileResponse, "profileId" | "opId">;

function authProfileReference(
  value: unknown,
  fallbackOpId = "",
): AuthProfileReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const fields = value as Record<string, unknown>;
  const profileId = cleanString(fields.profileId);
  const opId = cleanString(fields.opId) || cleanString(fallbackOpId);
  return profileId && opId ? { profileId, opId } : null;
}

function invalidRequest(): never {
  throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
}

async function body(request: Request): Promise<unknown> {
  try {
    return await readBoundedJson(request, AUTH_MUTATION_MAX_BODY_BYTES);
  } catch {
    invalidRequest();
  }
}

async function consumeRejectedIntent(
  service: AuthIdentityService,
  uid: string,
  method: "eth" | "sol",
  intentId: string,
  consumedAtMs: number,
): Promise<void> {
  if (consumedAtMs <= 0) {
    await service.consumeIntent(uid, method, intentId);
  }
}

function validateSiweLocation(
  data: {
    domain?: string;
    uri?: string;
  },
  env: Env,
): void {
  const allowed = new Set(
    env.SIWE_ALLOWED_DOMAINS.split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const domain = cleanString(data.domain).toLowerCase();
  const bareDomain = domain.includes(":") ? domain.split(":")[0] : domain;
  if (
    !domain ||
    (!allowed.has(domain) &&
      !allowed.has(bareDomain) &&
      !isAllowedAuthOrigin(`https://${domain}`))
  ) {
    throw new AuthApiFailure(
      403,
      "permission-denied",
      "siwe-domain-not-allowed",
    );
  }
  const uri = cleanString(data.uri);
  if (!uri) {
    throw new AuthApiFailure(403, "permission-denied", "siwe-uri-not-allowed");
  }
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new AuthApiFailure(403, "permission-denied", "siwe-uri-not-allowed");
  }
  const host = url.host.toLowerCase();
  const bareHost = host.includes(":") ? host.split(":")[0] : host;
  const isLocal = bareHost === "localhost" || bareHost === "127.0.0.1";
  if (
    !host ||
    (!allowed.has(host) &&
      !allowed.has(bareHost) &&
      !isAllowedAuthOrigin(url.origin)) ||
    url.username !== "" ||
    url.password !== "" ||
    (isLocal
      ? url.protocol !== "http:" && url.protocol !== "https:"
      : url.protocol !== "https:")
  ) {
    throw new AuthApiFailure(403, "permission-denied", "siwe-uri-not-allowed");
  }
}

function isExpiredFlow(
  fields: Record<string, unknown>,
  nowMs: number,
): boolean {
  const expiresAtMs = Number(fields.expiresAtMs);
  const createdAtMs = Number(fields.createdAtMs);
  return (
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= 0 ||
    expiresAtMs < nowMs ||
    (Number.isFinite(createdAtMs) &&
      createdAtMs > 0 &&
      nowMs - createdAtMs > X_FLOW_TTL_MS * 2)
  );
}

async function executeAuthMutation(
  request: Request,
  identity: FirebaseIdentity,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  dependencies: AuthMutationDependencies,
  operationSignal: AbortSignal,
): Promise<AuthVerificationResponse | LinkedAuthMethodsResponse> {
  const pathname = new URL(request.url).pathname;
  const payload = await body(request);
  const service =
    dependencies.identityService ||
    createAuthIdentityService(env, {
      deferRecovery: true,
      signal: operationSignal,
    });
  if (pathname === "/auth/methods/sol/verify") {
    if (!isSolanaAuthVerificationRequest(payload)) {
      invalidRequest();
    }
    const opId = `intent:${payload.intentId}`;
    const replay = await service.peekVerifyReplay(opId, "sol", identity.uid);
    if (replay) {
      return replay;
    }
    const intent = await service.readIntent(
      identity.uid,
      "sol",
      payload.intentId,
      opId,
    );
    const target = `Sign in mons.link with Solana nonce ${intent.nonce}`;
    let valid = false;
    try {
      const publicKey = bs58.decode(payload.address);
      const signature = Uint8Array.from(
        Buffer.from(payload.signature, "base64"),
      );
      if (publicKey.byteLength !== 32 || signature.byteLength !== 64) {
        throw new Error("invalid-solana-proof");
      }
      valid = nacl.sign.detached.verify(
        new TextEncoder().encode(target),
        signature,
        publicKey,
      );
    } catch {
      await consumeRejectedIntent(
        service,
        identity.uid,
        "sol",
        payload.intentId,
        intent.consumedAtMs,
      );
      throw new AuthApiFailure(
        400,
        "invalid-argument",
        "Invalid Solana address.",
      );
    }
    if (!valid) {
      await consumeRejectedIntent(
        service,
        identity.uid,
        "sol",
        payload.intentId,
        intent.consumedAtMs,
      );
      return { ok: false };
    }
    const normalized = normalizeMethodValue("sol", payload.address);
    const input = {
      uid: identity.uid,
      method: "sol",
      methodValueRaw: payload.address,
      normalizedMethodValue: normalized,
      intentId: payload.intentId,
      requestEmoji: payload.emoji,
      requestAura: payload.aura,
      preferredAddress: payload.address,
      opId,
    } as const;
    const concurrentReplay = await service.prepareVerifiedMethod(input, intent);
    return concurrentReplay || service.linkVerifiedMethod(input);
  }
  if (pathname === "/auth/methods/eth/verify") {
    if (!isEthereumAuthVerificationRequest(payload)) {
      invalidRequest();
    }
    const opId = `intent:${payload.intentId}`;
    const replay = await service.peekVerifyReplay(opId, "eth", identity.uid);
    if (replay) {
      return replay;
    }
    let message: ParsedSiweMessage;
    try {
      message = parseSiweMessage(payload.message);
      getAddress(message.address);
    } catch {
      throw new AuthApiFailure(
        400,
        "invalid-argument",
        "Invalid SIWE message.",
      );
    }
    let recoveredAddress: string;
    try {
      recoveredAddress = verifyMessage(payload.message, payload.signature);
    } catch {
      return { ok: false };
    }
    if (
      normalizeMethodValue("eth", recoveredAddress) !==
      normalizeMethodValue("eth", message.address)
    ) {
      return { ok: false };
    }
    const intent = await service.readIntent(
      identity.uid,
      "eth",
      payload.intentId,
      opId,
    );
    if (
      message.nonce !== intent.nonce ||
      message.statement !== "mons ftw" ||
      (message.expirationTime !== undefined &&
        Date.parse(message.expirationTime) <= Date.now()) ||
      (message.notBefore !== undefined &&
        Date.parse(message.notBefore) > Date.now())
    ) {
      await consumeRejectedIntent(
        service,
        identity.uid,
        "eth",
        payload.intentId,
        intent.consumedAtMs,
      );
      return { ok: false };
    }
    try {
      validateSiweLocation(message, env);
    } catch (error) {
      await consumeRejectedIntent(
        service,
        identity.uid,
        "eth",
        payload.intentId,
        intent.consumedAtMs,
      );
      throw error;
    }
    const address = normalizeMethodValue("eth", message.address);
    const input = {
      uid: identity.uid,
      method: "eth",
      methodValueRaw: address,
      methodValueLookupRaw: message.address,
      normalizedMethodValue: address,
      intentId: payload.intentId,
      requestEmoji: payload.emoji,
      requestAura: payload.aura,
      preferredAddress: address,
      opId,
    } as const;
    const concurrentReplay = await service.prepareVerifiedMethod(input, intent);
    return concurrentReplay || service.linkVerifiedMethod(input);
  }
  if (pathname === "/auth/methods/apple/verify") {
    if (!isAppleAuthVerificationRequest(payload)) {
      invalidRequest();
    }
    if (featureDisabled(env.AUTH_DISABLE_APPLE_VERIFY)) {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "apple-auth-disabled",
      );
    }
    const opId = `intent:${payload.intentId}`;
    const replay = await service.peekVerifyReplay(opId, "apple", identity.uid);
    if (replay) {
      return replay;
    }
    const intent = await service.readIntent(
      identity.uid,
      "apple",
      payload.intentId,
      opId,
    );
    const verified = await (dependencies.verifyApple || verifyAppleIdToken)(
      payload.idToken,
      intent.nonce,
      env,
      ctx,
    );
    const input = {
      uid: identity.uid,
      method: "apple",
      methodValueRaw: verified.sub,
      normalizedMethodValue: normalizeMethodValue("apple", verified.sub),
      intentId: payload.intentId,
      requestEmoji: payload.emoji,
      requestAura: payload.aura,
      appleEmailMasked: verified.emailMasked,
      consentSource: payload.consentSource,
      preferredAddress: null,
      opId,
    } as const;
    const concurrentReplay = await service.prepareVerifiedMethod(input, intent);
    return concurrentReplay || service.linkVerifiedMethod(input);
  }
  if (pathname === "/auth/methods/unlink") {
    if (!isAuthMethodUnlinkRequest(payload)) {
      invalidRequest();
    }
    return service.unlinkMethod(identity.uid, payload.method, payload.opId);
  }
  if (pathname !== "/auth/x/flows/complete") {
    throw new AuthApiFailure(404, "not-found", "not-found");
  }
  if (!isXAuthCompletionRequest(payload)) {
    invalidRequest();
  }
  if (featureDisabled(env.AUTH_DISABLE_X_VERIFY)) {
    throw new AuthApiFailure(409, "failed-precondition", "x-auth-disabled");
  }
  const firestore =
    dependencies.firestore ||
    createAuthFirestoreClient(env, { signal: operationSignal });
  const flowName = authDocumentName("xAuthRedirectFlows", payload.flowId);
  const loadFlow = async (): Promise<AuthFirestoreDocument> => {
    const flow = await firestore.get(flowName);
    if (!flow) {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "x-redirect-flow-not-found",
      );
    }
    return flow;
  };
  const completedFlowResult = async (
    flow: AuthFirestoreDocument,
  ): Promise<AuthProfileResponse> => {
    const xUserId = cleanString(flow.fields.xUserId);
    const opId = `x-redirect:${payload.flowId}`;
    const storedResult = authProfileReference(flow.fields.result, opId);
    if (!xUserId || !storedResult) {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "x-redirect-result-stale",
      );
    }
    const candidate =
      (await service.peekVerifyReplay(opId, "x", identity.uid)) || storedResult;
    const result = await service.refreshCompletedVerifyResult(
      candidate,
      "x",
      identity.uid,
      xUserId,
    );
    if (result) {
      return result;
    }
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "x-redirect-result-stale",
    );
  };
  const writeTerminalFlow = (
    flow: AuthFirestoreDocument,
    fields: Record<string, unknown>,
    fieldPaths: string[],
  ) =>
    firestore.commitWrites([
      authUpdateWrite(flowName, fields, fieldPaths, {
        updateTime: flow.updateTime,
      }),
    ]);
  const commitTerminalFlow = async (
    flow: AuthFirestoreDocument,
    fields: Record<string, unknown>,
    fieldPaths: string[],
  ): Promise<AuthProfileResponse | null> => {
    try {
      await writeTerminalFlow(flow, fields, fieldPaths);
      return null;
    } catch (error) {
      if (!(error instanceof AuthFirestoreConflict)) {
        throw error;
      }
      const current = await loadFlow();
      if (readStoredFirebaseUid(current.fields.uid) !== identity.uid) {
        throw new AuthApiFailure(
          403,
          "permission-denied",
          "x-redirect-flow-user-mismatch",
        );
      }
      const status = cleanString(current.fields.status);
      if (status === "completed") {
        return completedFlowResult(current);
      }
      if (status === "failed") {
        if (
          fields.status === "completed" &&
          cleanString(current.fields.errorCode) === "x-redirect-flow-expired"
        ) {
          await writeTerminalFlow(current, fields, fieldPaths);
          return null;
        }
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          cleanString(current.fields.errorCode) || "x-redirect-failed",
        );
      }
      if (
        status === "verified" &&
        cleanString(current.fields.intentId) ===
          cleanString(flow.fields.intentId) &&
        cleanString(current.fields.xUserId) ===
          cleanString(flow.fields.xUserId) &&
        cleanString(current.fields.xUsername) ===
          cleanString(flow.fields.xUsername) &&
        current.fields.consentSource === flow.fields.consentSource
      ) {
        await writeTerminalFlow(current, fields, fieldPaths);
        return null;
      }
      throw error;
    }
  };
  let flow = await loadFlow();
  let refreshedFlow = false;
  while (true) {
    if (readStoredFirebaseUid(flow.fields.uid) !== identity.uid) {
      throw new AuthApiFailure(
        403,
        "permission-denied",
        "x-redirect-flow-user-mismatch",
      );
    }
    const status = cleanString(flow.fields.status);
    if (status === "completed") {
      return completedFlowResult(flow);
    }
    if (status === "failed") {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        cleanString(flow.fields.errorCode) || "x-redirect-failed",
      );
    }
    if (status === "verified") {
      break;
    }
    const expiredAtMs = (dependencies.now || Date.now)();
    if (!isExpiredFlow(flow.fields, expiredAtMs)) {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "x-redirect-not-ready",
      );
    }
    try {
      await writeTerminalFlow(
        flow,
        {
          status: "failed",
          errorCode: "x-redirect-flow-expired",
          updatedAtMs: expiredAtMs,
        },
        ["status", "errorCode", "updatedAtMs"],
      );
    } catch (error) {
      if (error instanceof AuthFirestoreConflict && !refreshedFlow) {
        refreshedFlow = true;
        flow = await loadFlow();
        continue;
      }
      throw error;
    }
    throw new AuthApiFailure(
      504,
      "deadline-exceeded",
      "x-redirect-flow-expired",
    );
  }
  const nowMs = (dependencies.now || Date.now)();
  const xUserId = cleanString(flow.fields.xUserId);
  const intentId = cleanString(flow.fields.intentId);
  if (!intentId || !xUserId) {
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "x-redirect-missing-verified-data",
    );
  }
  const opId = `x-redirect:${payload.flowId}`;
  const replay = await service.peekVerifyReplay(opId, "x", identity.uid);
  if (replay) {
    return (
      (await commitTerminalFlow(
        flow,
        {
          status: "completed",
          result: replay,
          completedAtMs: nowMs,
          updatedAtMs: nowMs,
          errorCode: null,
        },
        ["status", "result", "completedAtMs", "updatedAtMs", "errorCode"],
      )) || replay
    );
  }
  const input = {
    uid: identity.uid,
    method: "x",
    methodValueRaw: xUserId,
    methodValueLookupRaw: xUserId,
    normalizedMethodValue: normalizeMethodValue("x", xUserId),
    intentId,
    requestEmoji: payload.emoji,
    requestAura: payload.aura,
    xUsername: cleanString(flow.fields.xUsername) || null,
    consentSource:
      flow.fields.consentSource === "settings" ? "settings" : "signin",
    preferredAddress: null,
    opId,
  } as const;
  let response: AuthProfileResponse;
  try {
    const intent = await service.readIntent(identity.uid, "x", intentId, opId);
    response =
      (await service.prepareVerifiedMethod(input, intent)) ||
      (await service.linkVerifiedMethod(input));
  } catch (error) {
    if (error instanceof AuthApiFailure && error.message === "intent-expired") {
      const racedResult = await commitTerminalFlow(
        flow,
        {
          status: "failed",
          errorCode: "x-redirect-flow-expired",
          updatedAtMs: nowMs,
        },
        ["status", "errorCode", "updatedAtMs"],
      );
      if (racedResult) {
        return racedResult;
      }
      throw new AuthApiFailure(
        504,
        "deadline-exceeded",
        "x-redirect-flow-expired",
      );
    }
    throw error;
  }
  const completedAtMs = (dependencies.now || Date.now)();
  return (
    (await commitTerminalFlow(
      flow,
      {
        status: "completed",
        result: response,
        completedAtMs,
        updatedAtMs: completedAtMs,
        errorCode: null,
      },
      ["status", "result", "completedAtMs", "updatedAtMs", "errorCode"],
    )) || response
  );
}

export async function handleAuthMutation(
  request: Request,
  identity: FirebaseIdentity,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  dependencies: AuthMutationDependencies = {},
): Promise<AuthVerificationResponse | LinkedAuthMethodsResponse> {
  const operationSignal = AbortSignal.timeout(
    dependencies.operationDeadlineMs ?? AUTH_MUTATION_DEADLINE_MS,
  );
  try {
    return await executeAuthMutation(
      request,
      identity,
      env,
      ctx,
      dependencies,
      operationSignal,
    );
  } catch (error) {
    if (operationSignal.aborted) {
      throw new AuthApiFailure(
        504,
        "deadline-exceeded",
        "auth-operation-timeout",
      );
    }
    throw error;
  }
}

export { isExpiredFlow, validateSiweLocation };
