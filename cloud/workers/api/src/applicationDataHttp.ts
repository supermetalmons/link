import {
  APPLICATION_DATA_EPOCH,
  APPLICATION_DATA_HEADER,
  APPLICATION_DATA_STATUS_HEADER,
  APPLICATION_RELEASE_PATH,
  hasApplicationDataEpoch,
  hasApplicationSocketEpoch,
  type ApplicationContractFailure,
  type ApplicationReleaseStatus,
} from "@mons/shared/data-contract";
import type { ApplicationDataControl } from "./applicationDataControl.ts";
import { isAllowedAuthOrigin } from "./authHttp.ts";

export function applicationContractResponse(
  request: Request,
  error: ApplicationContractFailure["error"],
): Response {
  const body: ApplicationContractFailure = {
    ok: false,
    error,
    dataEpoch: APPLICATION_DATA_EPOCH,
  };
  const origin = request.headers.get("Origin") || "";
  return Response.json(body, {
    status: error === "maintenance" ? 503 : 426,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      [APPLICATION_DATA_HEADER]: String(APPLICATION_DATA_EPOCH),
      [APPLICATION_DATA_STATUS_HEADER]: error,
      "Access-Control-Expose-Headers": APPLICATION_DATA_STATUS_HEADER,
      ...(error === "maintenance" ? { "Retry-After": "60" } : {}),
      ...(isAllowedAuthOrigin(origin)
        ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
        : {}),
    },
  });
}

function applicationReleaseResponse(
  request: Request,
  control: ApplicationDataControl,
): Response {
  if (request.method !== "GET")
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET", "Cache-Control": "no-store" },
    });
  const active =
    control.phase === "active" && control.dataEpoch === APPLICATION_DATA_EPOCH;
  const status: ApplicationReleaseStatus = active
    ? {
        state: "active",
        dataEpoch: APPLICATION_DATA_EPOCH,
        generation: control.generation,
      }
    : {
        state: "maintenance",
        dataEpoch: APPLICATION_DATA_EPOCH,
        generation: control.generation,
        retryAfterSeconds: 60,
      };
  return Response.json(status, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function gateApplicationRequest(
  request: Request,
  control: ApplicationDataControl,
): Response | null {
  const pathname = new URL(request.url).pathname;
  if (pathname === APPLICATION_RELEASE_PATH)
    return applicationReleaseResponse(request, control);
  if (request.method === "OPTIONS") return null;
  if (
    control.phase !== "active" ||
    control.dataEpoch !== APPLICATION_DATA_EPOCH
  )
    return applicationContractResponse(request, "maintenance");
  if (pathname === "/auth/x/callback" && request.method === "GET") return null;
  const socket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  if (
    socket
      ? !hasApplicationSocketEpoch(request.headers)
      : !hasApplicationDataEpoch(request.headers)
  )
    return applicationContractResponse(request, "update-required");
  return null;
}
