import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import {
  FirebaseRtdbFailure,
  readPublicFirebaseMatch,
} from "../src/firebaseRtdb.ts";

const target = { playerId: "player-1", matchId: "match-1" };
const snapshot = { color: "white", fen: "current-fen" };

describe("public match snapshot Worker runtime", () => {
  it("constructs the upstream request with native runtime fetch options", async () => {
    let reads = 0;
    const value = await readPublicFirebaseMatch(env, target, {
      fetcher: async (input, init) => {
        const upstream = new Request(input, init);
        reads++;
        expect(upstream.method).toBe("GET");
        expect(upstream.url).toBe(
          `${env.FIREBASE_RTDB_URL}/players/player-1/matches/match-1.json`,
        );
        expect(upstream.redirect).toBe("manual");
        expect(upstream.headers.get("Authorization")).toBeNull();
        expect(upstream.signal.aborted).toBe(false);
        return Response.json(snapshot);
      },
    });
    expect(value).toEqual(snapshot);
    expect(reads).toBe(1);
  });

  it("rejects redirects without following the public match request", async () => {
    let reads = 0;
    await expect(
      readPublicFirebaseMatch(env, target, {
        fetcher: async (input, init) => {
          const upstream = new Request(input, init);
          expect(upstream.redirect).toBe("manual");
          reads++;
          return new Response(null, {
            status: 302,
            headers: { Location: "https://example.com/other-record" },
          });
        },
      }),
    ).rejects.toBeInstanceOf(FirebaseRtdbFailure);
    expect(reads).toBe(1);
  });

  it("propagates caller cancellation to the native upstream request", async () => {
    const controller = new AbortController();
    const request = new Request("https://api.mons.link/matches/snapshot", {
      signal: controller.signal,
    });
    let upstreamAborted = false;
    await expect(
      readPublicFirebaseMatch(env, target, {
        signal: request.signal,
        fetcher: async (input, init) => {
          const upstream = new Request(input, init);
          return new Promise<Response>((_resolve, reject) => {
            upstream.signal.addEventListener(
              "abort",
              () => {
                upstreamAborted = true;
                reject(upstream.signal.reason);
              },
              { once: true },
            );
            controller.abort();
          });
        },
      }),
    ).rejects.toBeInstanceOf(FirebaseRtdbFailure);
    expect(upstreamAborted).toBe(true);
  });

  it("dispatches public preflight and validation through the Worker entrypoint", async () => {
    const preflight = await exports.default.fetch(
      new Request("https://api.mons.link/matches/snapshot", {
        method: "OPTIONS",
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const invalid = await exports.default.fetch(
      new Request("https://api.mons.link/matches/snapshot?playerId=player-1"),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      ok: false,
      error: "invalid-argument",
      message: "invalid-request",
    });
  });
});
