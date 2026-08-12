export const HELIUS_TIMEOUT_MS = 10_000;
export const MAX_HELIUS_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ProviderFailureKind = "configuration" | "timeout" | "unavailable";

export interface WorkerDependencies {
  providerFetch: ProviderFetch;
  providerTimeoutMs: number;
  providerMaxResponseBodyBytes: number;
  logProviderFailure: (kind: ProviderFailureKind) => void;
  logRateLimitFailure: () => void;
}

export class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;

  constructor(kind: ProviderFailureKind) {
    super(kind);
    this.kind = kind;
  }
}
