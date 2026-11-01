export const APPLICATION_DATA_EPOCH = 1;
export const APPLICATION_DATA_HEADER = "X-Mons-Data-Epoch";
export const APPLICATION_DATA_STATUS_HEADER = "X-Mons-Data-Status";
export const APPLICATION_DATA_SOCKET_PROTOCOL = "mons-data-v1";
export const APPLICATION_RELEASE_PATH = "/release";

export type ApplicationDataEpoch = typeof APPLICATION_DATA_EPOCH;

export type ApplicationReleaseStatus =
  | {
      state: "active";
      dataEpoch: ApplicationDataEpoch;
      generation: number;
    }
  | {
      state: "maintenance";
      dataEpoch: ApplicationDataEpoch;
      generation: number;
      retryAfterSeconds: number;
    };

export type ApplicationContractFailure = {
  ok: false;
  error: "maintenance" | "update-required";
  dataEpoch: ApplicationDataEpoch;
};

export function isApplicationReleaseStatus(
  value: unknown,
): value is ApplicationReleaseStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  if (
    !("state" in value) ||
    !("dataEpoch" in value) ||
    !("generation" in value) ||
    value.dataEpoch !== APPLICATION_DATA_EPOCH ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  )
    return false;
  if (value.state === "active") return Object.keys(value).length === 3;
  return (
    value.state === "maintenance" &&
    Object.keys(value).length === 4 &&
    "retryAfterSeconds" in value &&
    typeof value.retryAfterSeconds === "number" &&
    Number.isSafeInteger(value.retryAfterSeconds) &&
    value.retryAfterSeconds > 0 &&
    value.retryAfterSeconds <= 60
  );
}

export function hasApplicationDataEpoch(headers: Headers): boolean {
  return (
    headers.get(APPLICATION_DATA_HEADER) === String(APPLICATION_DATA_EPOCH)
  );
}

export function hasApplicationSocketEpoch(headers: Headers): boolean {
  return (headers.get("Sec-WebSocket-Protocol") || "")
    .split(",")
    .some((protocol) => protocol.trim() === APPLICATION_DATA_SOCKET_PROTOCOL);
}

export function applicationDataHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set(APPLICATION_DATA_HEADER, String(APPLICATION_DATA_EPOCH));
  return result;
}
