import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_DATA_HEADER,
  APPLICATION_DATA_STATUS_HEADER,
  APPLICATION_DATA_SOCKET_PROTOCOL,
  isApplicationReleaseStatus,
} from "@mons/shared/data-contract";
import { gateApplicationRequest } from "../src/applicationDataHttp.ts";
import type { ApplicationDataControl } from "../src/applicationDataControl.ts";

const active: ApplicationDataControl = {
  generation: 3,
  dataEpoch: 1,
  phase: "active",
  migrationId: null,
};
const request = (path: string, init?: RequestInit) =>
  new Request(`https://api.mons.link${path}`, init);

test("first-party reads, writes, sessions and operator requests require the exact epoch", () => {
  for (const path of [
    "/auth/session/anonymous",
    "/auth/session/refresh",
    "/auth/session/logout",
    "/matches/snapshot",
    "/events/snapshot",
    "/nfts",
    "/internal/telegram/command",
  ]) {
    assert.equal(gateApplicationRequest(request(path), active)?.status, 426);
    assert.equal(
      gateApplicationRequest(
        request(path, { headers: { [APPLICATION_DATA_HEADER]: "1" } }),
        active,
      ),
      null,
    );
    for (const epoch of ["0", "2", "01", "1, 1"])
      assert.equal(
        gateApplicationRequest(
          request(path, { headers: { [APPLICATION_DATA_HEADER]: epoch } }),
          active,
        )?.status,
        426,
      );
  }
});

test("maintenance closes callbacks and sockets while leaving preflight and release readable", async () => {
  const closed = {
    ...active,
    phase: "closed",
    migrationId: "cutover",
  } as const;
  assert.equal(
    gateApplicationRequest(request("/auth/x/callback?state=flow"), closed)
      ?.status,
    503,
  );
  assert.equal(
    gateApplicationRequest(request("/nfts", { method: "OPTIONS" }), closed),
    null,
  );
  const response = gateApplicationRequest(request("/release"), closed);
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control") || "", /no-store/);
  const value: unknown = await response.json();
  assert.ok(isApplicationReleaseStatus(value));
  assert.equal(value.state, "maintenance");
  assert.equal(
    gateApplicationRequest(request("/auth/x/callback"), active),
    null,
  );
});

test("WebSockets need their epoch protocol and contract errors expose a status without changing CORS policy", () => {
  assert.equal(
    gateApplicationRequest(
      request("/invites/invite/reactions/socket", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "mons-reactions-v2",
        },
      }),
      active,
    )?.status,
    426,
  );
  assert.equal(
    gateApplicationRequest(
      request("/invites/invite/reactions/socket", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": `mons-reactions-v2, ${APPLICATION_DATA_SOCKET_PROTOCOL}`,
        },
      }),
      active,
    ),
    null,
  );
  const denied = gateApplicationRequest(
    request("/events/snapshot", { headers: { Origin: "https://mons.link" } }),
    active,
  );
  assert.equal(
    denied?.headers.get(APPLICATION_DATA_STATUS_HEADER),
    "update-required",
  );
  assert.equal(
    denied?.headers.get("Access-Control-Allow-Origin"),
    "https://mons.link",
  );
  const foreign = gateApplicationRequest(
    request("/events/snapshot", {
      headers: { Origin: "https://foreign.example" },
    }),
    active,
  );
  assert.equal(foreign?.headers.get("Access-Control-Allow-Origin"), null);
});
