import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

/**
 * @typedef {import("../src/ui/controls/navigationGamesController.ts").NavigationGamesClient} NavigationClient
 * @typedef {Awaited<ReturnType<NavigationClient["getProfileGamesPage"]>>} NavigationPage
 * @typedef {{profileId: string; authStatus: import("../src/connection/authModels.ts").AuthStatus; isOpen: boolean}} NavigationContext
 * @typedef {{limit: number; onItems: Parameters<NavigationClient["subscribeProfileGames"]>[1];
 * onStop: Parameters<NavigationClient["subscribeProfileGames"]>[2]; onPageMeta: Parameters<NavigationClient["subscribeProfileGames"]>[3]; stops: number}} NavigationSubscription
 */
const { createNavigationGamesController } =
  await import("../src/ui/controls/navigationGamesController.ts");
const {
  clearNavigationGamesRuntimeCacheScope,
  readNavigationGamesCacheSnapshot,
  resolveNavigationGamesCacheScope,
  writeNavigationGamesRuntimeCache,
} = await import("../src/services/navigationGamesCache.ts");

/**
 * @template [T=void]
 * @returns {PromiseWithResolvers<T>}
 */
const deferred = () => {
  return Promise.withResolvers();
};

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));
/** @param {readonly {id: string}[]} items */
const ids = (items) => items.map(({ id }) => id);
/** @param {string} id @param {Partial<import("@mons/shared/navigation").NavigationGameItem>} [overrides] @returns {import("@mons/shared/navigation").NavigationGameItem} */
const game = (id, overrides = {}) => ({
  id,
  entityType: "game",
  inviteId: id,
  kind: "direct",
  status: "waiting",
  sortBucket: 30,
  listSortAtMs: 100,
  hostLoginId: null,
  guestLoginId: null,
  opponentProfileId: null,
  opponentName: null,
  opponentEmoji: null,
  automatchStateHint: null,
  isPendingAutomatch: false,
  ...overrides,
});
/** @param {import("@mons/shared/navigation").NavigationItem[]} items @param {boolean} [hasMore] @param {import("@mons/shared/navigation").NavigationGamesCursor | null} [nextCursor] @returns {NavigationPage} */
const page = (items, hasMore = false, nextCursor = null) => ({
  items,
  hasMore,
  nextCursor,
});
const cursor = (/** @type {string} */ id) => ({
  id,
  sortBucket: 30,
  listSortAtMs: 100,
});

/** @param {test.TestContext} t @param {Partial<NavigationContext>} [initial] */
const createHarness = (t, initial = {}) => {
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  /** @type {Map<string, string>} */
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (/** @type {string} */ key) => values.get(key) ?? null,
      setItem: (/** @type {string} */ key, /** @type {string} */ value) =>
        values.set(key, value),
      removeItem: (/** @type {string} */ key) => values.delete(key),
    },
  });
  /** @type {NavigationContext} */
  let context = {
    profileId: "profile-a",
    authStatus: "authenticated",
    isOpen: false,
    ...initial,
  };
  let sessionEpoch = 0;
  const profiles = new Set([context.profileId]);
  /** @type {NavigationSubscription[]} */
  const subscriptions = [];
  /** @type {Array<{limit: number; cursor: import("@mons/shared/navigation").NavigationGamesCursor | null} & PromiseWithResolvers<NavigationPage>>} */
  const pages = [];
  /** @type {Array<{inviteId: string} & PromiseWithResolvers<Awaited<ReturnType<NavigationClient["removeWaitingNavigationGame"]>>>>} */
  const removals = [];
  /** @type {NavigationClient} */
  const client = {
    createSessionGuard: () => {
      const epoch = sessionEpoch;
      return () => epoch === sessionEpoch;
    },
    subscribeProfileGames: (limit, onItems, onStop, onPageMeta) => {
      const subscription = { limit, onItems, onStop, onPageMeta, stops: 0 };
      subscriptions.push(subscription);
      return () => {
        subscription.stops += 1;
      };
    },
    getProfileGamesPage: (limit, nextCursor) => {
      /** @type {PromiseWithResolvers<NavigationPage>} */
      const pending = deferred();
      const request = { limit, cursor: nextCursor, ...pending };
      pages.push(request);
      return request.promise;
    },
    removeWaitingNavigationGame: (inviteId) => {
      /** @type {PromiseWithResolvers<Awaited<ReturnType<NavigationClient["removeWaitingNavigationGame"]>>>} */
      const pending = deferred();
      const request = { inviteId, ...pending };
      removals.push(request);
      return request.promise;
    },
  };
  const controller = createNavigationGamesController({ client, ...context });
  /** @param {Partial<NavigationContext>} [next] */
  const setContext = (next = {}) => {
    context = { ...context, ...next };
    profiles.add(context.profileId);
    controller.setContext(context);
  };
  const seed = (
    /** @type {string} */ profileId,
    /** @type {import("@mons/shared/navigation").NavigationItem[]} */ topGames,
    /** @type {import("@mons/shared/navigation").NavigationItem[]} */ pagedGames = [],
  ) => {
    profiles.add(profileId);
    writeNavigationGamesRuntimeCache(
      resolveNavigationGamesCacheScope(profileId),
      topGames,
      pagedGames,
    );
  };
  t.after(() => {
    controller.dispose();
    for (const profileId of profiles) {
      const scope = resolveNavigationGamesCacheScope(profileId);
      if (scope) clearNavigationGamesRuntimeCacheScope(scope.scopeKey);
    }
    if (originalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
  return {
    controller,
    pages,
    removals,
    subscriptions,
    values,
    setContext,
    seed,
    snapshot: () => controller.getSnapshot(),
    open: () => setContext({ isOpen: true }),
    close: () => setContext({ isOpen: false }),
    invalidateSession: () => {
      sessionEpoch += 1;
    },
    /** @param {import("@mons/shared/navigation").NavigationItem[]} items @param {import("@mons/shared/navigation").NavigationGamesCursor | null} [nextCursor] */
    emit: (items, nextCursor = null, hasMore = false) => {
      const subscription = subscriptions.at(-1);
      assert.ok(subscription);
      subscription.onItems(items);
      subscription.onPageMeta({ items: [], nextCursor, hasMore });
    },
  };
};

test("construction is inert and a disposed controller can activate again", (t) => {
  const h = createHarness(t, { isOpen: true });
  assert.equal(h.subscriptions.length, 0);
  h.seed("profile-a", [game("cached")]);
  const snapshots = [];
  const unsubscribe = h.controller.subscribe(() =>
    snapshots.push(h.snapshot()),
  );
  h.setContext();
  assert.equal(h.subscriptions.length, 1);
  assert.equal(required(h.subscriptions[0]).limit, 80);
  assert.deepEqual(ids(h.snapshot().topGames), ["cached"]);
  assert.equal(h.snapshot().isLoading, true);
  h.emit([game("live")]);
  assert.equal(h.snapshot().isLoading, false);
  assert.ok(snapshots.length > 0);
  assert.strictEqual(h.snapshot(), h.snapshot());
  const oldSubscription = h.subscriptions[0];
  const oldGuard = h.controller.createProfileRequestGuard();
  h.controller.dispose();
  h.controller.dispose();
  assert.equal(required(oldSubscription).stops, 1);
  assert.equal(oldGuard(), false);
  h.setContext();
  assert.equal(h.subscriptions.length, 2);
  h.emit([game("reactivated")]);
  required(oldSubscription).onItems([game("stale")]);
  assert.deepEqual(ids(h.snapshot().topGames), ["reactivated"]);
  unsubscribe();
});

test("polling failure preserves hydrated rows and retires pending paging", async (t) => {
  const h = createHarness(t);
  h.seed("profile-a", [game("cached-top")], [game("cached-tail")]);
  h.open();
  const subscription = h.subscriptions[0];
  required(subscription).onPageMeta({
    items: [],
    nextCursor: cursor("warm"),
    hasMore: true,
  });
  assert.equal(h.pages.length, 1);
  required(subscription).onStop(undefined);
  assert.equal(required(subscription).stops, 1);
  assert.deepEqual(ids(h.snapshot().topGames), ["cached-top"]);
  assert.deepEqual(ids(h.snapshot().pagedGames), ["cached-tail"]);
  assert.equal(h.snapshot().isLoading, false);
  assert.equal(h.snapshot().isLoadingMore, false);
  assert.equal(h.snapshot().hasMore, false);
  required(h.pages[0]).resolve(page([game("late-tail")], true, cursor("late")));
  await flushPromises();
  assert.deepEqual(ids(h.snapshot().pagedGames), ["cached-tail"]);
  h.controller.loadMore();
  assert.equal(h.pages.length, 1);
});

test("profile A to B to A invalidates old subscriptions, pages, and removals", async (t) => {
  const h = createHarness(t);
  h.open();
  h.emit([game("same-invite")], cursor("a"), true);
  const oldSubscription = h.subscriptions[0];
  const guard = h.controller.createProfileRequestGuard();
  h.controller.loadMore();
  h.controller.removeWaitingGame("same-invite");
  h.setContext({ profileId: "profile-b", isOpen: false });
  assert.equal(guard(), false);
  assert.equal(h.snapshot().profileId, "profile-b");
  assert.deepEqual(h.snapshot().topGames, []);
  assert.deepEqual(h.snapshot().pagedGames, []);
  assert.equal(h.snapshot().removingInviteIds.size, 0);
  assert.equal(h.snapshot().isLoadingMore, false);
  h.setContext({ profileId: "profile-a", isOpen: true });
  h.emit([game("same-invite"), game("fresh-a")]);
  required(oldSubscription).onItems([game("stale-a")]);
  required(oldSubscription).onPageMeta({
    items: [],
    nextCursor: cursor("stale"),
    hasMore: true,
  });
  required(h.pages[0]).resolve(
    page([game("stale-page")], true, cursor("stale")),
  );
  required(h.removals[0]).resolve({ ok: true });
  await flushPromises();
  assert.deepEqual(ids(h.snapshot().topGames), ["fresh-a", "same-invite"]);
  assert.deepEqual(h.snapshot().pagedGames, []);
  assert.equal(h.snapshot().hasMore, false);
  assert.equal(guard(), false);
});

test("an old popup request cannot finish the new popup's load-more state", async (t) => {
  const h = createHarness(t);
  h.open();
  h.emit([game("top")], cursor("first"), true);
  const guard = h.controller.createProfileRequestGuard();
  h.controller.loadMore();
  h.controller.loadMore();
  assert.equal(h.pages.length, 1);
  assert.equal(required(h.pages[0]).limit, 50);
  h.close();
  assert.equal(guard(), true);
  assert.equal(required(h.subscriptions[0]).stops, 1);
  assert.deepEqual(ids(h.snapshot().topGames), ["top"]);
  h.open();
  h.emit([game("new-top")], cursor("second"), true);
  h.controller.loadMore();
  assert.equal(h.pages.length, 2);
  required(h.pages[0]).resolve(page([game("stale")], false));
  await flushPromises();
  assert.equal(h.snapshot().isLoadingMore, true);
  assert.deepEqual(h.snapshot().pagedGames, []);
  required(h.pages[1]).resolve(page([game("new-tail")]));
  await flushPromises();
  assert.equal(h.snapshot().isLoadingMore, false);
  assert.deepEqual(ids(h.snapshot().pagedGames), ["new-tail"]);
});

for (const hasMore of [false, true]) {
  test(`warm refresh ${hasMore ? "retains" : "replaces"} the cached tail when hasMore is ${hasMore}`, async (t) => {
    const h = createHarness(t);
    h.seed("profile-a", [game("top")], [game("cached-tail")]);
    h.open();
    h.emit([game("top")], cursor("warm"), true);
    h.emit([game("top")], cursor("warm"), true);
    assert.equal(h.pages.length, 1);
    required(h.pages[0]).resolve(
      page(
        [game("top"), game("new-tail")],
        hasMore,
        hasMore ? cursor("next") : null,
      ),
    );
    await flushPromises();
    assert.deepEqual(
      ids(h.snapshot().pagedGames),
      hasMore ? ["cached-tail", "new-tail"] : ["new-tail"],
    );
    assert.equal(h.snapshot().hasMore, hasMore);
    required(h.subscriptions[0]).onPageMeta({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    assert.deepEqual(h.snapshot().pagedGames, []);
    assert.equal(h.snapshot().hasMore, false);
  });
}

test("paging merges duplicates, promotes top rows, and retains rows on failure", async (t) => {
  const h = createHarness(t);
  h.open();
  h.emit([game("top")], cursor("first"), true);
  h.controller.loadMore();
  required(h.pages[0]).resolve(
    page(
      [game("top"), game("older", { listSortAtMs: 10 })],
      true,
      cursor("next"),
    ),
  );
  await flushPromises();
  assert.deepEqual(ids(h.snapshot().pagedGames), ["older"]);
  h.controller.loadMore();
  required(h.pages[1]).resolve(
    page(
      [
        game("older", { listSortAtMs: 30 }),
        game("newer", { listSortAtMs: 20 }),
      ],
      true,
      cursor("last"),
    ),
  );
  await flushPromises();
  assert.deepEqual(ids(h.snapshot().pagedGames), ["older", "newer"]);
  required(h.subscriptions[0]).onItems([game("top"), game("older")]);
  assert.deepEqual(ids(h.snapshot().pagedGames), ["newer"]);
  h.controller.loadMore();
  required(h.pages[2]).reject(new Error("offline"));
  await flushPromises();
  assert.deepEqual(ids(h.snapshot().pagedGames), ["newer"]);
  assert.equal(h.snapshot().isLoadingMore, false);
  assert.equal(h.snapshot().hasMore, false);
});

test("terminal metadata discards paged rows promoted into the top page", async (t) => {
  const h = createHarness(t);
  h.open();
  h.emit([game("top")], cursor("next"), true);
  h.controller.loadMore();
  required(h.pages[0]).resolve(page([game("older")]));
  await flushPromises();
  assert.deepEqual(ids(h.snapshot().pagedGames), ["older"]);
  h.emit([game("top"), game("older")]);
  assert.deepEqual(h.snapshot().pagedGames, []);
  h.emit([game("top"), game("new")], cursor("new"), true);
  assert.deepEqual(ids(h.snapshot().topGames), ["new", "top"]);
  assert.deepEqual(h.snapshot().pagedGames, []);
  assert.equal(h.snapshot().hasMore, true);
});

test("an expired session cannot apply paging or removal results", async (t) => {
  const h = createHarness(t);
  h.open();
  h.emit([game("waiting")], cursor("next"), true);
  const guard = h.controller.createProfileRequestGuard();
  h.controller.loadMore();
  h.controller.removeWaitingGame("waiting");
  h.invalidateSession();
  assert.equal(guard(), false);
  required(h.pages[0]).resolve(page([game("stale")]));
  required(h.removals[0]).resolve({ ok: true });
  await flushPromises();
  assert.deepEqual(h.snapshot().pagedGames, []);
  assert.equal(h.snapshot().isLoadingMore, false);
  h.close();
  h.open();
  h.emit([game("waiting")]);
  assert.deepEqual(ids(h.snapshot().topGames), ["waiting"]);
  h.controller.removeWaitingGame("waiting");
  assert.equal(h.removals.length, 2);
  required(h.removals[1]).resolve({ ok: true });
  await flushPromises();
  assert.deepEqual(h.snapshot().topGames, []);
});

test("anonymous optimism is ephemeral and authoritative rows replace optimism", (t) => {
  const h = createHarness(t, { profileId: "", authStatus: "unauthenticated" });
  h.open();
  const optimistic = game("pending", {
    status: "pending",
    kind: "auto",
    isOptimistic: true,
  });
  h.controller.setOptimisticPendingAutomatch(optimistic);
  assert.deepEqual(ids(h.snapshot().topGames), ["pending"]);
  assert.equal(h.subscriptions.length, 0);
  assert.equal(h.values.size, 0);
  h.close();
  h.open();
  assert.deepEqual(ids(h.snapshot().topGames), ["pending"]);
  h.setContext({ profileId: "profile-a", authStatus: "authenticated" });
  assert.deepEqual(h.snapshot().topGames, []);
  h.controller.setOptimisticPendingAutomatch(optimistic);
  const scope = resolveNavigationGamesCacheScope("profile-a");
  assert.deepEqual(readNavigationGamesCacheSnapshot(scope).topGames, []);
  assert.ok(
    [...h.values.values()].every((value) => !value.includes('"pending"')),
  );
  h.emit([game("pending", { status: "active", kind: "auto" })]);
  assert.deepEqual(ids(h.snapshot().topGames), ["pending"]);
  assert.equal(required(h.snapshot().topGames[0]).status, "active");
  h.emit([]);
  assert.deepEqual(h.snapshot().topGames, []);
});

for (const result of ["success", "skipped", "failure"]) {
  test(`waiting-row removal handles ${result} without hiding active games`, async (t) => {
    const h = createHarness(t);
    h.open();
    h.emit([
      game("waiting", { inviteId: "shared" }),
      game("active", { inviteId: "shared", status: "active" }),
    ]);
    h.controller.removeWaitingGame("shared");
    h.controller.removeWaitingGame("shared");
    assert.equal(h.removals.length, 1);
    assert.deepEqual(ids(h.snapshot().topGames), ["active"]);
    assert.equal(h.snapshot().removingInviteIds.has("shared"), true);
    if (result === "failure")
      required(h.removals[0]).reject(new Error("offline"));
    else
      required(h.removals[0]).resolve({
        ok: true,
        skipped: result === "skipped",
      });
    await flushPromises();
    assert.deepEqual(
      ids(h.snapshot().topGames),
      result === "success" ? ["active"] : ["waiting", "active"],
    );
    assert.equal(h.snapshot().removingInviteIds.size, 0);
  });
}

test("event previews use the current profile's cache and live navigation rows", (t) => {
  const h = createHarness(t);
  const participant = (/** @type {string} */ profileId) => ({
    profileId,
    displayName: profileId,
    emojiId: 1,
    aura: null,
  });
  /** @param {string} profileId @returns {import("@mons/shared/navigation").NavigationEventItem} */
  const event = (profileId) => ({
    id: "event_tournament",
    entityType: "event",
    eventId: "tournament",
    status: "active",
    sortBucket: 0,
    listSortAtMs: 1,
    startAtMs: null,
    updatedAtMs: null,
    endedAtMs: null,
    participantCount: 1,
    winnerDisplayName: null,
    participantPreview: [participant(profileId)],
  });
  h.seed("profile-a", [], [event("participant-a")]);
  h.seed("profile-b", [event("participant-b")]);
  assert.deepEqual(h.controller.getEventParticipantPreview("tournament"), [
    participant("participant-a"),
  ]);
  h.setContext({ profileId: "profile-b" });
  assert.deepEqual(h.controller.getEventParticipantPreview("tournament"), [
    participant("participant-b"),
  ]);
  h.open();
  h.emit([event("live-participant")]);
  assert.deepEqual(h.controller.getEventParticipantPreview("tournament"), [
    participant("live-participant"),
  ]);
  assert.deepEqual(h.controller.getEventParticipantPreview("missing"), []);
});
