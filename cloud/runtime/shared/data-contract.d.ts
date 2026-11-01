// Generated from src/shared/data-contract.ts. Run npm run generate:runtime.
export declare const APPLICATION_DATA_EPOCH = 1;
export declare const APPLICATION_DATA_HEADER = "X-Mons-Data-Epoch";
export declare const APPLICATION_DATA_STATUS_HEADER = "X-Mons-Data-Status";
export declare const APPLICATION_DATA_SOCKET_PROTOCOL = "mons-data-v1";
export declare const APPLICATION_RELEASE_PATH = "/release";
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
export declare function isApplicationReleaseStatus(
  value: unknown,
): value is ApplicationReleaseStatus;
export declare function hasApplicationDataEpoch(headers: Headers): boolean;
export declare function hasApplicationSocketEpoch(headers: Headers): boolean;
export declare function applicationDataHeaders(headers?: HeadersInit): Headers;
