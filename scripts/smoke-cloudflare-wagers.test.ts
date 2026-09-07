import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { WebSocket } from "ws";
import { createEmptyMaterials, formatMiningDateUtc } from "@mons/shared/mining";
import type {
  InviteWagersSnapshot,
  PublicMatchWagerState,
} from "@mons/shared/invite-wagers";
import {
  activeLifecycle,
  createFixture,
  frozenRead,
  openSocket,
  parseArgs,
  prepare,
  readFixture,
  requestJson,
  runSmoke,
  saveFixture,
  smokeSnapshots,
} from "./smoke-cloudflare-wagers.ts";
import type { Dependencies, Fixture } from "./smoke-cloudflare-wagers.ts";

const API_ROOT = "https://api.mons.link";
const NOW = Date.parse("2026-09-07T12:00:00Z");
const ROLES = ["host", "guest"] as const;
type Role = (typeof ROLES)[number];
type RequestRecord = {
  url: URL;
  method: string;
  body: Record<string, unknown> | string | null;
};
const clone = <T>(value: T): T => structuredClone(value);
const token = (uid: string) =>
  `header.${Buffer.from(JSON.stringify({ sub: uid })).toString("base64url")}.signature`;
const materials = (dust: number) => ({ ...createEmptyMaterials(), dust });
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

class FakeSocket extends EventEmitter {
  protocol = "mons-invite-wagers-v1";
  terminated = false;
  sent: string[] = [];
  readonly inviteId: string;
  constructor(inviteId: string) {
    super();
    this.inviteId = inviteId;
  }
  send(value: string, callback: (error?: Error) => void): void {
    this.sent.push(value);
    callback();
    queueMicrotask(() => this.emit("message", Buffer.from("pong"), false));
  }
  terminate(): void {
    this.terminated = true;
  }
}

function model({ fresh = false, failFirstResolve = false } = {}) {
  const fixture = createFixture(NOW);
  if (!fresh) {
    fixture.stage = "prepared";
    for (const role of ROLES)
      Object.assign(fixture.actors[role], {
        uid: `${role}-smoke`,
        profileId: `${role}-profile`,
        idToken: token(`${role}-smoke`),
        refreshToken: `${role}-refresh-secret`,
      });
  }
  const totals: Record<Role, number> = {
    host: fresh ? 0 : 1,
    guest: fresh ? 0 : 1,
  };
  const frozen: Record<Role, number> = { host: fresh ? 0 : 1, guest: 0 };
  const linked: Record<Role, boolean> = { host: !fresh, guest: !fresh };
  const miningDates: Record<Role, string | null> = {
    host: fresh ? null : fixture.miningDate,
    guest: fresh ? null : fixture.miningDate,
  };
  const states = new Map<string, InviteWagersSnapshot>();
  const createdInvites = new Set<string>();
  const joinedInvites = new Set<string>();
  const removed = new Set<string>();
  const sockets: FakeSocket[] = [];
  const requests: RequestRecord[] = [];
  const logs: string[] = [];
  let signups = 0;
  let transfers = 0;
  let surrendered = false;
  let failedResolve = false;
  const proposal = (): PublicMatchWagerState => ({
    proposals: {
      [fixture.actors.host.uid!]: {
        material: "dust",
        count: 1,
        createdAt: NOW,
      },
    },
    proposedBy: { [fixture.actors.host.uid!]: true },
  });
  for (const scenario of ["cancel", "decline", "settle"] as const) {
    const inviteId = fixture.invites[scenario].id;
    if (!fresh) {
      createdInvites.add(inviteId);
      joinedInvites.add(inviteId);
    }
    states.set(inviteId, {
      inviteId,
      revision: 1,
      wagers: !fresh && scenario === "cancel" ? { [inviteId]: proposal() } : {},
    });
    fixture.preparedSnapshots[scenario] = clone(states.get(inviteId)!);
  }
  const publish = (id: string) => {
    const snapshot = states.get(id)!;
    snapshot.revision++;
    for (const socket of sockets.filter(
      (value) => value.inviteId === id && !value.terminated,
    ))
      queueMicrotask(() =>
        socket.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              type: "snapshot",
              snapshot: clone(snapshot),
            }),
          ),
          false,
        ),
      );
  };
  const mining = (role: Role) => ({
    lastRockDate: miningDates[role],
    materials: materials(totals[role]),
  });
  const metadata = (inviteId: string, role: Role | null) => ({
    ok: true,
    snapshot: {
      inviteId,
      revision: 1,
      hostId: fixture.actors.host.uid,
      guestId: joinedInvites.has(inviteId) ? fixture.actors.guest.uid : null,
      hostColor: "white",
      hostRematches: "",
      guestRematches: "",
      automatchStateHint: null,
      eventId: null,
      eventOwned: false,
    },
    viewer: {
      role: role || "watch",
      actorUid: role ? fixture.actors[role].uid : null,
      automatchOperationId: null,
    },
  });
  const roleFromToken = (headers: Headers) =>
    ROLES.find(
      (role) =>
        headers.get("Authorization") ===
        `Bearer ${fixture.actors[role].idToken}`,
    ) || null;
  const dependencies: Dependencies = {
    now: () => NOW,
    log: (message) => logs.push(message),
    connect(url, protocols, options) {
      assert.equal(new URL(url).host, "api.mons.link");
      assert.equal(options.followRedirects, false);
      assert.equal(options.origin, "https://mons.link");
      assert.equal(protocols[0], "mons-invite-wagers-v1");
      const socket = new FakeSocket(new URL(url).pathname.split("/")[2]);
      sockets.push(socket);
      queueMicrotask(() =>
        socket.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              type: "snapshot",
              snapshot: clone(states.get(socket.inviteId)!),
            }),
          ),
          false,
        ),
      );
      return socket as unknown as WebSocket;
    },
    async fetch(input, init) {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      const headers = new Headers(init?.headers);
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const body =
        rawBody &&
        headers.get("Content-Type") !== "application/x-www-form-urlencoded"
          ? (JSON.parse(rawBody) as Record<string, unknown> | string)
          : null;
      requests.push({ url, method, body });
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      if (url.origin !== API_ROOT) {
        assert.equal(headers.get("Origin"), "https://mons.link");
        assert.equal(headers.get("Referer"), "https://mons.link/");
      }
      if (url.hostname === "identitytoolkit.googleapis.com") {
        assert.equal(url.pathname, "/v1/accounts:signUp");
        assert.deepEqual(body, { returnSecureToken: true });
        const role = ROLES[signups++];
        assert.ok(role);
        return response({
          localId: `${role}-smoke`,
          idToken: token(`${role}-smoke`),
          refreshToken: `${role}-refresh-secret`,
        });
      }
      if (url.hostname === "securetoken.googleapis.com") {
        const role = ROLES.find((value) =>
          rawBody.includes(`${value}-refresh-secret`),
        );
        assert.ok(role);
        return response({
          id_token: token(`${role}-smoke`),
          refresh_token: `${role}-refresh-secret`,
          user_id: `${role}-smoke`,
        });
      }
      if (url.hostname === "mons-link-default-rtdb.firebaseio.com") {
        const id = fixture.invites.settle.id;
        const role = ROLES.find(
          (value) =>
            fixture.actors[value].idToken === url.searchParams.get("auth"),
        );
        assert.ok(role);
        if (method === "GET") {
          const matchId = url.pathname
            .split("/")
            .at(-1)!
            .replace(/\.json$/, "");
          assert.ok(createdInvites.has(matchId));
          assert.equal(
            url.pathname,
            `/players/${role}-smoke/matches/${matchId}.json`,
          );
          return response({
            version: 2,
            color: role === "host" ? "white" : "black",
            emojiId: 1,
            aura: "",
            gameVariant: "Classic",
            fen: "seed",
            status:
              role === "guest" && matchId === id && surrendered
                ? "surrendered"
                : "",
            flatMovesString: "",
            timer: "",
          });
        }
        assert.equal(role, "guest");
        assert.equal(method, "PUT");
        assert.equal(
          url.pathname,
          `/players/guest-smoke/matches/${id}/status.json`,
        );
        assert.equal(body, "surrendered");
        surrendered = true;
        return response("surrendered");
      }
      assert.equal(url.origin, API_ROOT);
      assert.equal(headers.get("Origin"), "https://mons.link");
      const role = roleFromToken(headers);
      if (url.pathname === "/auth/methods") {
        assert.ok(role);
        return response({
          ok: true,
          profileId: linked[role] ? `${role}-profile` : null,
          linkedMethods: {
            apple: false,
            eth: false,
            sol: linked[role],
            x: false,
          },
          appleLinked: false,
        });
      }
      if (url.pathname === "/auth/intents")
        return response({
          ok: true,
          intentId: "a".repeat(24),
          nonce: "b".repeat(24),
          state: "c".repeat(24),
          expiresAtMs: NOW + 300_000,
        });
      if (url.pathname === "/auth/methods/sol/verify") {
        assert.ok(role);
        const data = body as Record<string, unknown>;
        const address = String(data.address);
        assert.ok(
          nacl.sign.detached.verify(
            Buffer.from(
              `Sign in mons.link with Solana nonce ${"b".repeat(24)}`,
            ),
            Buffer.from(String(data.signature), "base64"),
            bs58.decode(address),
          ),
        );
        linked[role] = true;
        return response({
          ok: true,
          uid: `${role}-smoke`,
          profileId: `${role}-profile`,
          username: null,
          sol: address,
          linkedMethods: { apple: false, eth: false, sol: true, x: false },
          appleLinked: false,
          emoji: 1,
          aura: "",
          mining: mining(role),
          opId: "intent:test",
        });
      }
      if (url.pathname === "/mining/rock") {
        assert.ok(role);
        assert.deepEqual(body, {
          date: formatMiningDateUtc(new Date(dependencies.now())),
          materials: materials(1),
        });
        assert.equal(miningDates[role], null);
        totals[role] = 1;
        miningDates[role] = (body as { date: string }).date;
        return response({ ok: true, mining: mining(role) });
      }
      if (url.pathname === "/profiles/lookup") {
        assert.ok(role);
        assert.deepEqual(body, { kind: "login", id: fixture.actors[role].uid });
        const key = nacl.sign.keyPair.fromSeed(
          Buffer.from(fixture.actors[role].seed, "base64"),
        );
        return response({
          ok: true,
          profile: {
            id: fixture.actors[role].profileId,
            nonce: 0,
            rating: 0,
            totalManaPoints: 0,
            win: false,
            emoji: 1,
            username: null,
            eth: null,
            sol: bs58.encode(key.publicKey),
            mining: mining(role),
          },
        });
      }
      if (url.pathname.endsWith("/metadata")) {
        const inviteId = url.pathname.split("/")[2];
        return createdInvites.has(inviteId)
          ? response(metadata(inviteId, role))
          : response({ error: "invite-not-found" }, 404);
      }
      if (url.pathname.endsWith("/wagers"))
        return response({
          ok: true,
          snapshot: clone(states.get(url.pathname.split("/")[2])!),
        });
      if (url.pathname === "/wagers/frozen/read") {
        assert.ok(role);
        assert.deepEqual(body, { playerUid: fixture.actors[role].uid });
        return response({
          ok: true,
          playerUid: fixture.actors[role].uid,
          revision: 1,
          frozen: materials(frozen[role]),
        });
      }
      const data = body as Record<string, unknown>;
      const inviteId = String(data.inviteId);
      if (url.pathname === "/invites/create") {
        assert.equal(role, "host");
        if (createdInvites.has(inviteId))
          return response({ error: "invite-already-exists" }, 409);
        createdInvites.add(inviteId);
        return response({
          ok: true,
          inviteId,
          hostId: fixture.actors.host.uid,
          matchId: inviteId,
        });
      }
      if (url.pathname === "/invites/join") {
        assert.equal(role, "guest");
        joinedInvites.add(inviteId);
        return response({
          ok: true,
          inviteId,
          guestId: fixture.actors.guest.uid,
          matchId: inviteId,
          joined: true,
        });
      }
      assert.ok(url.pathname.startsWith("/wagers/"));
      assert.equal(headers.get("X-Mons-Wager-Storage-Version"), "1");
      assert.equal(data.matchId, inviteId);
      const snapshot = states.get(inviteId)!;
      const wager = snapshot.wagers[inviteId];
      if (url.pathname === "/wagers/proposals/send") {
        assert.equal(role, "host");
        if (removed.has(inviteId))
          return response({ ok: false, reason: "proposal-unavailable" });
        if (!wager?.proposals) {
          assert.equal(frozen.host, 0);
          frozen.host++;
          snapshot.wagers[inviteId] = proposal();
          publish(inviteId);
        }
        return response({ ok: true, count: 1 });
      }
      if (
        ["/wagers/proposals/cancel", "/wagers/proposals/decline"].includes(
          url.pathname,
        )
      ) {
        assert.equal(role, url.pathname.endsWith("cancel") ? "host" : "guest");
        if (!removed.has(inviteId)) {
          assert.ok(wager?.proposals?.[fixture.actors.host.uid!]);
          frozen.host--;
          removed.add(inviteId);
          snapshot.wagers[inviteId] = {
            proposedBy: { [fixture.actors.host.uid!]: true },
          };
          publish(inviteId);
        }
        return response({ ok: true });
      }
      if (url.pathname === "/wagers/proposals/accept") {
        assert.equal(role, "guest");
        if (!wager.agreed) {
          frozen.guest++;
          snapshot.wagers[inviteId] = {
            agreed: {
              material: "dust",
              count: 1,
              total: 2,
              proposerId: fixture.actors.host.uid!,
              accepterId: fixture.actors.guest.uid!,
              acceptedAt: NOW,
            },
          };
          publish(inviteId);
        }
        return response({ ok: true, count: 1 });
      }
      if (url.pathname === "/wagers/outcomes/resolve") {
        assert.equal(role, "host");
        assert.equal(surrendered, true);
        const replay = !!wager.resolved;
        if (!replay) {
          totals.host++;
          totals.guest--;
          frozen.host = 0;
          frozen.guest = 0;
          transfers++;
          wager.resolved = {
            material: "dust",
            count: 1,
            total: 2,
            winnerId: fixture.actors.host.uid!,
            loserId: fixture.actors.guest.uid!,
            resolvedAt: NOW,
          };
          publish(inviteId);
        }
        if (failFirstResolve && !failedResolve) {
          failedResolve = true;
          return response({ credential: "never-log-this-body" }, 503);
        }
        return response({
          ok: true,
          ...(replay ? { reason: "already-resolved" } : {}),
          mining: mining("host"),
        });
      }
      throw new Error(`Unexpected test request: ${url.pathname}`);
    },
  };
  return {
    fixture,
    dependencies,
    states,
    createdInvites,
    joinedInvites,
    miningDates,
    sockets,
    requests,
    logs,
    totals,
    frozen,
    get transfers() {
      return transfers;
    },
    get signups() {
      return signups;
    },
  };
}

test("wager smoke restricts phases and credential destinations before I/O", () => {
  const options = parseArgs([
    "--base-url",
    API_ROOT,
    "--prepare-fixtures",
    "--fixture",
    "/secure/wager-smoke.json",
  ]);
  assert.equal(options.mode, "prepare-fixtures");
  for (const args of [
    [
      "--base-url",
      "https://evil.example",
      "--read-only",
      "--invite-id",
      "invite",
    ],
    [
      "--base-url",
      API_ROOT,
      "--active-lifecycle",
      "--auth-token-fixture",
      "/secure/user-token.json",
    ],
    [
      "--base-url",
      API_ROOT,
      "--prepare-fixtures",
      "--fixture",
      "relative.json",
    ],
    ["--base-url", API_ROOT, "--read-only", "--invite-id", "bad/id"],
    [
      "--base-url",
      API_ROOT,
      "--frozen-read",
      "--active-lifecycle",
      "--fixture",
      "/secure/test.json",
    ],
  ])
    assert.throws(() => parseArgs(args), /Usage/);
});

test("protected fixtures reject readable files, symlinks, and overlapping identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "wager-smoke-test-"));
  try {
    const path = join(directory, "fixture.json");
    const fixture = createFixture(NOW);
    saveFixture(path, fixture);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFixture(path).purpose, "mons-wager-smoke");
    chmodSync(path, 0o644);
    assert.throws(() => readFixture(path), /protected regular file/);
    chmodSync(path, 0o600);
    const link = join(directory, "link.json");
    symlinkSync(path, link);
    assert.throws(() => readFixture(link), /protected regular file/);
    fixture.actors.host.uid = "same";
    fixture.actors.guest.uid = "same";
    saveFixture(path, fixture);
    assert.throws(() => readFixture(path), /actors must be distinct/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepare uses new wallet proofs, one first rock each, three manual invites, and retains a pending wager", async () => {
  const h = model({ fresh: true });
  let saves = 0;
  await prepare(
    h.fixture,
    () => {
      saves++;
    },
    h.dependencies,
  );
  assert.equal(h.fixture.stage, "prepared");
  assert.equal(h.signups, 2);
  assert.equal(
    h.requests.filter((request) => request.url.pathname === "/mining/rock")
      .length,
    2,
  );
  assert.deepEqual(h.totals, { host: 1, guest: 1 });
  assert.deepEqual(h.frozen, { host: 1, guest: 0 });
  assert.equal(
    h.requests.filter((request) => request.url.pathname === "/invites/create")
      .length,
    3,
  );
  assert.ok(saves >= 7);
  assert.equal(
    h.fixture.preparedSnapshots.cancel?.wagers[h.fixture.invites.cancel.id]
      ?.proposals?.[h.fixture.actors.host.uid!]?.count,
    1,
  );
  assert.ok(
    h.sockets.every(
      (socket) =>
        socket.terminated && socket.sent.every((frame) => frame === "ping"),
    ),
  );
  assert.ok(
    !h.requests.some((request) =>
      /automatch|events|rating|telegram/i.test(request.url.pathname),
    ),
  );
  for (const actor of Object.values(h.fixture.actors))
    assert.ok(!h.logs.join("\n").includes(actor.seed));
});

test("preparation funds an old, unfunded fixture with the current date", async () => {
  const h = model({ fresh: true });
  h.dependencies.now = () => NOW + 3 * 86_400_000;
  await prepare(h.fixture, () => undefined, h.dependencies);
  assert.equal(h.fixture.miningDate, "2026-09-07");
  assert.deepEqual(h.miningDates, { host: "2026-09-10", guest: "2026-09-10" });
  for (const actor of Object.values(h.fixture.actors))
    assert.equal(actor.miningDate, "2026-09-10");
  assert.equal(h.fixture.stage, "prepared");
});

test("delayed preparation preserves legacy host funding and funds only its unfinished guest", async () => {
  const h = model({ fresh: true });
  const originalFetch = h.dependencies.fetch;
  h.dependencies.fetch = async (input, init) => {
    if (
      new URL(String(input)).pathname === "/mining/rock" &&
      new Headers(init?.headers).get("Authorization") ===
        `Bearer ${h.fixture.actors.guest.idToken}`
    )
      return response({ error: "temporarily-unavailable" }, 503);
    return originalFetch(input, init);
  };
  await assert.rejects(
    prepare(h.fixture, () => undefined, h.dependencies),
    /HTTP 503/,
  );
  for (const actor of Object.values(h.fixture.actors)) delete actor.miningDate;
  h.dependencies.now = () => NOW + 3 * 86_400_000;
  h.dependencies.fetch = originalFetch;
  await prepare(h.fixture, () => undefined, h.dependencies);
  assert.deepEqual(h.miningDates, { host: "2026-09-07", guest: "2026-09-10" });
  assert.equal(h.fixture.actors.host.miningDate, "2026-09-07");
  assert.equal(h.fixture.actors.guest.miningDate, "2026-09-10");
  assert.equal(
    h.requests.filter((request) => request.url.pathname === "/mining/rock")
      .length,
    2,
  );
  assert.deepEqual(h.totals, { host: 1, guest: 1 });
});

test("an uncertain first-rock response resumes from its saved actor date without mining twice", async () => {
  const h = model({ fresh: true });
  const originalFetch = h.dependencies.fetch;
  let saved: Fixture | undefined;
  const save = () => {
    saved = clone(h.fixture);
  };
  h.dependencies.now = () => NOW + 3 * 86_400_000;
  h.dependencies.fetch = async (input, init) => {
    const result = await originalFetch(input, init);
    if (new URL(String(input)).pathname === "/mining/rock") {
      assert.equal(saved?.actors.host.miningDate, "2026-09-10");
      throw new Error("first-rock-response-lost");
    }
    return result;
  };
  await assert.rejects(
    prepare(h.fixture, save, h.dependencies),
    /request failed/,
  );
  assert.equal(h.totals.host, 1);
  Object.assign(h.fixture, saved);
  h.dependencies.fetch = originalFetch;
  h.dependencies.now = () => NOW + 6 * 86_400_000;
  await prepare(h.fixture, save, h.dependencies);
  assert.deepEqual(h.miningDates, { host: "2026-09-10", guest: "2026-09-13" });
  assert.equal(
    h.requests.filter((request) => request.url.pathname === "/mining/rock")
      .length,
    2,
  );
  assert.equal(h.signups, 2);
  assert.equal(saved?.stage, "prepared");
});

test("preparation reuses owned invites after create receipts expire and joins only its unpaired invite", async () => {
  const h = model();
  h.fixture.stage = "preparing";
  h.joinedInvites.delete(h.fixture.invites.decline.id);
  h.dependencies.now = () => NOW + 8 * 86_400_000;
  await prepare(h.fixture, () => undefined, h.dependencies);
  assert.equal(h.fixture.stage, "prepared");
  assert.ok(
    !h.requests.some((request) =>
      ["/invites/create", "/mining/rock"].includes(request.url.pathname),
    ),
  );
  const joins = h.requests.filter(
    (request) => request.url.pathname === "/invites/join",
  );
  assert.equal(joins.length, 1);
  assert.equal(
    (joins[0].body as { inviteId: string }).inviteId,
    h.fixture.invites.decline.id,
  );
  assert.equal(h.signups, 0);
});

test("preparation rejects foreign, event, advanced, or unreadable invites before gameplay writes", async () => {
  const cases = [
    { hostId: "other-host" },
    { guestId: "other-guest" },
    { eventId: "other-event" },
    { eventOwned: true },
    { automatchStateHint: "matched" },
    { hostRematches: "1" },
    "terminal-wager",
    "played-match",
    "unreadable",
    "null-metadata",
  ] as const;
  for (const altered of cases) {
    const h = model();
    h.fixture.stage = "preparing";
    const originalFetch = h.dependencies.fetch;
    if (altered === "terminal-wager")
      h.states.get(h.fixture.invites.cancel.id)!.wagers = {
        [h.fixture.invites.cancel.id]: {
          proposedBy: { [h.fixture.actors.host.uid!]: true },
        },
      };
    h.dependencies.fetch = async (input, init) => {
      const result = await originalFetch(input, init);
      const url = new URL(String(input));
      if (url.pathname.endsWith("/metadata")) {
        if (altered === "unreadable") return response({ error: "denied" }, 403);
        if (altered === "null-metadata") return response(null);
        if (typeof altered === "object") {
          const body = await result.json();
          return response({
            ...body,
            snapshot: { ...body.snapshot, ...altered },
          });
        }
      }
      if (
        altered === "played-match" &&
        url.hostname === "mons-link-default-rtdb.firebaseio.com"
      )
        return response({
          ...(await result.json()),
          flatMovesString: "played",
        });
      return result;
    };
    await assert.rejects(
      prepare(h.fixture, () => undefined, h.dependencies),
      /unchanged manual test invite|Unused test invite|unexpected gameplay state|HTTP 403/,
    );
    assert.ok(
      h.requests.every(
        (request) =>
          request.method === "GET" ||
          request.url.hostname === "securetoken.googleapis.com" ||
          request.url.pathname === "/profiles/lookup",
      ),
    );
  }
});

test("frozen reads prove imported proposal and balance parity without a gameplay write", async () => {
  const h = model();
  await frozenRead(h.fixture, h.dependencies);
  assert.ok(
    h.requests.every(
      (request) =>
        request.method === "GET" ||
        ["/profiles/lookup", "/wagers/frozen/read"].includes(
          request.url.pathname,
        ),
    ),
  );
  assert.equal(h.sockets.length, 6);
  h.fixture.preparedSnapshots.cancel!.wagers[
    h.fixture.invites.cancel.id
  ].proposals![h.fixture.actors.host.uid!].count = 2;
  await assert.rejects(
    frozenRead(h.fixture, h.dependencies),
    /Imported wager snapshot/,
  );
});

test("read-only mode accepts an existing invite and cannot call mutation routes", async () => {
  const h = model();
  await runSmoke(
    {
      mode: "read-only",
      baseUrl: API_ROOT,
      inviteId: h.fixture.invites.cancel.id,
    },
    h.dependencies,
  );
  assert.ok(
    h.requests.every(
      (request) => request.method === "GET" && request.url.origin === API_ROOT,
    ),
  );
  assert.equal(h.sockets.length, 2);
});

test("active lifecycle uses separate proposal lineages, verifies broadcasts and applies one transfer across replay", async () => {
  const h = model();
  await activeLifecycle(h.fixture, () => undefined, h.dependencies);
  assert.equal(h.fixture.stage, "complete");
  assert.deepEqual(h.totals, { host: 2, guest: 0 });
  assert.deepEqual(h.frozen, { host: 0, guest: 0 });
  assert.equal(h.transfers, 1);
  const mutations = h.requests.filter(
    (request) =>
      request.method !== "GET" &&
      !["/profiles/lookup", "/wagers/frozen/read"].includes(
        request.url.pathname,
      ),
  );
  assert.equal(
    mutations.filter((request) => request.method === "PUT").length,
    1,
  );
  assert.equal(
    mutations.filter(
      (request) => request.url.pathname === "/wagers/outcomes/resolve",
    ).length,
    2,
  );
  assert.ok(
    mutations.every(
      (request) =>
        request.url.pathname.startsWith("/wagers/") ||
        request.url.hostname === "mons-link-default-rtdb.firebaseio.com",
    ),
  );
  const before = mutations.length;
  const requestsBefore = h.requests.length;
  await activeLifecycle(h.fixture, () => undefined, h.dependencies);
  assert.equal(h.transfers, 1);
  assert.ok(
    h.requests
      .slice(requestsBefore)
      .every(
        (request) =>
          request.method === "GET" ||
          ["/profiles/lookup", "/wagers/frozen/read"].includes(
            request.url.pathname,
          ),
      ),
  );
  assert.ok(before > 0);
});

test("an ambiguous settlement preserves the fixture and resumes only its idempotent resolution", async () => {
  const h = model({ failFirstResolve: true });
  let saved: Fixture | undefined;
  await assert.rejects(
    activeLifecycle(
      h.fixture,
      () => {
        saved = clone(h.fixture);
      },
      h.dependencies,
    ),
    /HTTP 503/,
  );
  assert.equal(h.transfers, 1);
  assert.equal(saved?.stage, "active");
  assert.equal(saved?.steps.includes("settle:resolve"), false);
  const requestsBefore = h.requests.length;
  await activeLifecycle(h.fixture, () => undefined, h.dependencies);
  assert.equal(h.transfers, 1);
  const mutations = h.requests
    .slice(requestsBefore)
    .filter(
      (request) =>
        request.url.pathname.startsWith("/wagers/") &&
        request.url.pathname !== "/wagers/frozen/read",
    );
  assert.equal(mutations.length, 2);
  assert.ok(
    mutations.every(
      (request) => request.url.pathname === "/wagers/outcomes/resolve",
    ),
  );
  assert.ok(!h.logs.join("\n").includes("never-log-this-body"));
});

test("journaled lifecycle runs still reject missing settlement history without repeating mutations", async () => {
  const h = model();
  await activeLifecycle(h.fixture, () => undefined, h.dependencies);
  const settlement = h.states.get(h.fixture.invites.settle.id)!;
  settlement.wagers = {};
  settlement.revision++;
  for (const stage of ["active", "complete"] as const) {
    h.fixture.stage = stage;
    const requestsBefore = h.requests.length;
    await assert.rejects(
      activeLifecycle(h.fixture, () => undefined, h.dependencies),
      /Final settlement wager did not match/,
    );
    assert.ok(
      h.requests
        .slice(requestsBefore)
        .every(
          (request) =>
            request.method === "GET" ||
            ["/profiles/lookup", "/wagers/frozen/read"].includes(
              request.url.pathname,
            ),
        ),
    );
    assert.equal(h.transfers, 1);
  }
});

test("journaled cancellation and decline still require retained terminal history", async () => {
  const h = model();
  await activeLifecycle(h.fixture, () => undefined, h.dependencies);
  for (const scenario of ["cancel", "decline"] as const) {
    const snapshot = h.states.get(h.fixture.invites[scenario].id)!;
    const wager = snapshot.wagers[snapshot.inviteId];
    wager.proposals = {
      [h.fixture.actors.host.uid!]: {
        material: "dust",
        count: 1,
        createdAt: NOW,
      },
    };
    snapshot.revision++;
    await assert.rejects(
      activeLifecycle(h.fixture, () => undefined, h.dependencies),
      new RegExp(`${scenario} final proposals did not match`),
    );
    delete wager.proposals;
    snapshot.revision++;
    delete snapshot.wagers[snapshot.inviteId];
    await assert.rejects(
      activeLifecycle(h.fixture, () => undefined, h.dependencies),
      new RegExp(`${scenario} final wager did not match`),
    );
    snapshot.wagers[snapshot.inviteId] = wager;
    snapshot.revision++;
  }
  assert.equal(h.transfers, 1);
});

test("HTTP/WebSocket parity aligns a legitimate concurrent revision", async () => {
  const h = model();
  const originalFetch = h.dependencies.fetch;
  const inviteId = h.fixture.invites.cancel.id;
  let reads = 0;
  h.dependencies.fetch = async (input, init) => {
    if (
      new URL(String(input)).pathname === `/invites/${inviteId}/wagers` &&
      ++reads === 2
    ) {
      const snapshot = h.states.get(inviteId)!;
      snapshot.revision++;
      for (const socket of h.sockets.filter((value) => !value.terminated))
        socket.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              type: "snapshot",
              snapshot: clone(snapshot),
            }),
          ),
          false,
        );
    }
    return originalFetch(input, init);
  };
  const snapshot = await smokeSnapshots(
    inviteId,
    h.fixture.actors.host.idToken,
    h.dependencies,
  );
  assert.equal(snapshot.revision, 2);
  assert.equal(reads, 4);
  assert.equal(h.sockets.length, 2);
  assert.ok(h.sockets.every((socket) => socket.terminated));
});

test("HTTP/WebSocket parity still rejects different content at a matching revision", async () => {
  const h = model();
  const originalFetch = h.dependencies.fetch;
  const inviteId = h.fixture.invites.cancel.id;
  let reads = 0;
  h.dependencies.fetch = async (input, init) => {
    if (
      new URL(String(input)).pathname === `/invites/${inviteId}/wagers` &&
      ++reads === 2
    )
      return response({
        ok: true,
        snapshot: { ...h.states.get(inviteId)!, wagers: {} },
      });
    return originalFetch(input, init);
  };
  await assert.rejects(
    smokeSnapshots(inviteId, h.fixture.actors.host.idToken, h.dependencies),
    /HTTP\/WebSocket snapshot parity did not match/,
  );
  assert.ok(h.sockets.every((socket) => socket.terminated));
});

test("HTTP/WebSocket parity rejects changed content at the same revision", async () => {
  const h = model();
  const originalConnect = h.dependencies.connect;
  h.dependencies.connect = (url, protocols, options) => {
    const socket = originalConnect(url, protocols, options);
    queueMicrotask(() => {
      const snapshot = clone(h.states.get(h.fixture.invites.cancel.id)!);
      snapshot.wagers = {};
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({ schemaVersion: 1, type: "snapshot", snapshot }),
        ),
        false,
      );
    });
    return socket;
  };
  await assert.rejects(
    smokeSnapshots(
      h.fixture.invites.cancel.id,
      h.fixture.actors.host.idToken,
      h.dependencies,
    ),
    /WebSocket frame was invalid/,
  );
  assert.ok(h.sockets.every((socket) => socket.terminated));
});

test("socket protocol failures and oversized HTTP bodies fail without echoing response data", async () => {
  const h = model();
  const originalConnect = h.dependencies.connect;
  h.dependencies.connect = (url, protocols, options) => {
    const socket = originalConnect(url, protocols, options);
    Object.assign(socket, { protocol: "incorrect" });
    return socket;
  };
  const socket = openSocket(
    h.fixture.invites.cancel.id,
    undefined,
    h.dependencies,
  );
  try {
    await assert.rejects(
      socket.wait(() => true),
      /frame was invalid/,
    );
  } finally {
    socket.close();
  }
  await assert.rejects(
    requestJson(
      {
        ...h.dependencies,
        fetch: async () => response({ secret: "private-response" }),
      },
      "bounded",
      API_ROOT,
      {},
      1,
    ),
    (error: unknown) =>
      error instanceof Error &&
      /oversized JSON/.test(error.message) &&
      !error.message.includes("private-response"),
  );
});

test("fixture runner refuses an existing lock without remote requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wager-smoke-lock-"));
  try {
    const path = join(directory, "fixture.json");
    const h = model();
    saveFixture(path, h.fixture);
    writeFileSync(`${path}.lock`, "", { mode: 0o600 });
    await assert.rejects(
      runSmoke(
        { mode: "active-lifecycle", baseUrl: API_ROOT, fixture: path },
        h.dependencies,
      ),
      /Fixture is locked/,
    );
    assert.equal(h.requests.length, 0);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).stage, "prepared");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("existing fixtures refresh Firebase credentials with the allowed referrer without creating identities", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wager-smoke-refresh-"));
  try {
    const path = join(directory, "fixture.json");
    const h = model();
    saveFixture(path, h.fixture);
    await runSmoke(
      { mode: "frozen-read", baseUrl: API_ROOT, fixture: path },
      h.dependencies,
    );
    assert.equal(h.signups, 0);
    assert.equal(
      h.requests.filter(
        (request) => request.url.hostname === "securetoken.googleapis.com",
      ).length,
      2,
    );
    assert.ok(
      h.requests.every(
        (request) =>
          request.url.hostname === "securetoken.googleapis.com" ||
          request.method === "GET" ||
          ["/profiles/lookup", "/wagers/frozen/read"].includes(
            request.url.pathname,
          ),
      ),
    );
    const saved = readFixture(path);
    assert.equal(saved.actors.host.uid, "host-smoke");
    assert.equal(saved.actors.guest.uid, "guest-smoke");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
