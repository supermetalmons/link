import {
  APPLICATION_DATA_SOCKET_PROTOCOL,
  APPLICATION_DATA_STATUS_HEADER,
  applicationDataHeaders,
} from "@mons/shared/data-contract";
import {
  applicationDataGate,
  type ApplicationDataGate,
} from "../session/applicationDataLifecycle.ts";

export async function fetchApplicationData(
  input: string | URL,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
  gate: ApplicationDataGate = applicationDataGate,
): Promise<Response> {
  if (new URL(input).origin !== "https://api.mons.link") {
    throw new Error("invalid-application-api-origin");
  }
  gate.assertAvailable();
  const response = await fetcher(input, {
    ...init,
    headers: applicationDataHeaders(init.headers),
  });
  const state = response.headers.get(APPLICATION_DATA_STATUS_HEADER);
  if (state === "maintenance" || state === "update-required") gate.block(state);
  if (gate.blocked) {
    void response.body?.cancel().catch(() => undefined);
    gate.assertAvailable();
  }
  return response;
}

export function applicationSocketProtocols(
  protocols: readonly string[],
): string[] {
  return protocols.includes(APPLICATION_DATA_SOCKET_PROTOCOL)
    ? [...protocols]
    : [...protocols, APPLICATION_DATA_SOCKET_PROTOCOL];
}
