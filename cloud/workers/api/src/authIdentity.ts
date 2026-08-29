import type {
  AuthMethodKey,
  AuthProfileResponse,
  LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import type { AuthStateRepository } from "./authStateD1.ts";
import { createCanonicalAuthIdentityService } from "./authIdentityCanonical.ts";
import type { FirebaseAuthAdminClient } from "./firebaseAuthAdmin.ts";
import type { FirebaseRtdbClient } from "./firebaseRtdb.ts";

export type AuthIntent = {
  consumedByOpId?: string;
  consumedAtMs: number;
  expiresAtMs: number;
  method: AuthMethodKey;
  nonce: string;
  uid: string;
};

export type LinkInput = {
  appleEmailMasked?: string | null;
  consentSource?: "signin" | "settings";
  method: AuthMethodKey;
  methodValueLookupRaw?: string;
  methodValueRaw: string;
  normalizedMethodValue: string;
  intentId?: string;
  opId: string;
  requestAura: string | null;
  requestEmoji: number;
  uid: string;
  xUsername?: string | null;
};

export type AuthIdentityService = {
  consumeIntent: (
    uid: string,
    method: AuthMethodKey,
    intentId: string,
    opId?: string,
  ) => Promise<AuthIntent>;
  readIntent: (
    uid: string,
    method: AuthMethodKey,
    intentId: string,
    opId?: string,
  ) => Promise<AuthIntent>;
  prepareVerifiedMethod: (
    input: LinkInput,
    intent: AuthIntent,
  ) => Promise<AuthProfileResponse | null>;
  linkVerifiedMethod: (input: LinkInput) => Promise<AuthProfileResponse>;
  peekVerifyReplay: (
    opId: string,
    method: AuthMethodKey,
    uid: string,
  ) => Promise<AuthProfileResponse | null>;
  refreshCompletedVerifyResult: (
    result: Pick<AuthProfileResponse, "profileId" | "opId">,
    method: AuthMethodKey,
    uid: string,
    expectedMethodValue: string,
  ) => Promise<AuthProfileResponse | null>;
  syncCurrentCallerProfile: (uid: string) => Promise<LinkedAuthMethodsResponse>;
  unlinkMethod: (
    uid: string,
    method: AuthMethodKey,
    opId: string,
  ) => Promise<LinkedAuthMethodsResponse>;
};

export type ServiceDependencies = {
  authClient?: FirebaseAuthAdminClient;
  authState?: AuthStateRepository;
  now?: () => number;
  randomInteger?: (maximum: number) => number;
  rtdb?: FirebaseRtdbClient;
  signal?: AbortSignal;
};

export function createAuthIdentityService(
  env: Env,
  dependencies: ServiceDependencies = {},
): AuthIdentityService {
  return createCanonicalAuthIdentityService(env, dependencies);
}
