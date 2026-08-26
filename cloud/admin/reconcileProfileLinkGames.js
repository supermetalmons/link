#!/usr/bin/env node

"use strict";

const { randomUUID } = require("node:crypto");
const { isSafeFirebaseKey } = require("@mons/shared/ids");
const { createInviteCandidatesFromMatchId } = require("@mons/shared/rematches");
const { inferAutomatchStateHint } = require("@mons/shared/navigation");
const {
  shouldProjectInvite,
} = require("../functions/events/gameProjectionModel");
const {
  MAX_PROFILE_MERGE_TARGET_HOPS,
} = require("../functions/profileMergeTargets");
const {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  admin,
  cleanupAdmin,
  initAdmin,
} = require("./_admin");

const SAMPLE_SCAN_LIMIT = 100;
const WAIT_INTERVAL_MS = 5000;
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const USAGE =
  "Usage: node cloud/admin/reconcileProfileLinkGames.js (--sample | --login-uid <uid>) [--project <id>] [--database-url <url>] [--dry-run | --execute [--wait]]";

const parseArgs = (argv) => {
  const options = {
    adminArgs: [],
    dryRun: true,
    loginUid: "",
    sample: false,
    wait: false,
  };
  let modeSet = false;
  const seenValueFlags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sample") {
      if (options.sample) throw new TypeError(USAGE);
      options.sample = true;
      continue;
    }
    if (arg === "--wait") {
      if (options.wait) throw new TypeError(USAGE);
      options.wait = true;
      continue;
    }
    if (arg === "--dry-run" || arg === "--execute") {
      if (modeSet) throw new TypeError(USAGE);
      modeSet = true;
      options.dryRun = arg === "--dry-run";
      continue;
    }
    if (!["--database-url", "--login-uid", "--project"].includes(arg)) {
      throw new TypeError(USAGE);
    }
    if (seenValueFlags.has(arg)) throw new TypeError(USAGE);
    seenValueFlags.add(arg);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new TypeError(USAGE);
    if (arg === "--login-uid") options.loginUid = value;
    else options.adminArgs.push(arg, value);
  }
  if (
    options.sample === Boolean(options.loginUid) ||
    (options.loginUid && !isSafeFirebaseKey(options.loginUid)) ||
    (options.wait && options.dryRun)
  ) {
    throw new TypeError(USAGE);
  }
  return options;
};

const selectSampleProfileLink = async (database) => {
  let cursor = "";
  while (true) {
    let query = database.ref("players").orderByKey();
    if (cursor) query = query.startAt(cursor);
    const snapshot = await query
      .limitToFirst(SAMPLE_SCAN_LIMIT + (cursor ? 1 : 0))
      .once("value");
    const entries = [];
    snapshot.forEach((child) => {
      if (child.key !== cursor) entries.push([child.key, child.val()]);
      return false;
    });
    for (const [loginUid, player] of entries) {
      if (
        isSafeFirebaseKey(loginUid) &&
        isSafeFirebaseKey(player?.profile) &&
        player?.matches &&
        typeof player.matches === "object"
      ) {
        return { loginUid, profileId: player.profile };
      }
    }
    if (entries.length < SAMPLE_SCAN_LIMIT) {
      throw new Error("No profile link with matches was found.");
    }
    cursor = entries.at(-1)[0];
  }
};

const readProfileLink = async (database, loginUid) => {
  const snapshot = await database
    .ref(`players/${loginUid}/profile`)
    .once("value");
  const profileId = snapshot.val();
  if (!isSafeFirebaseKey(profileId)) {
    throw new Error(`Profile link ${loginUid} was not found.`);
  }
  return { loginUid, profileId };
};

const findMergeSources = async (firestore, profileId) => {
  const sources = new Set();
  let frontier = [profileId];
  for (let depth = 0; depth < MAX_PROFILE_MERGE_TARGET_HOPS; depth += 1) {
    const next = [];
    for (const targetProfileId of frontier) {
      const snapshot = await firestore
        .collection("profileMergeTargets")
        .where("targetProfileId", "==", targetProfileId)
        .get();
      for (const document of snapshot.docs) {
        if (!sources.has(document.id)) {
          sources.add(document.id);
          next.push(document.id);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return Array.from(sources);
};

const writeProfileLinkOutbox = async ({
  cleanupProfileIds,
  database,
  loginUid,
  profileId,
  requestId,
}) => {
  const path = `profileGameProjectionOutbox/profile/${loginUid}`;
  const result = await database.ref(path).transaction(
    (current) => {
      const record = current && typeof current === "object" ? current : {};
      const cleanup = Object.fromEntries(
        Object.entries(record.cleanupProfileIds || {}).filter(
          ([candidate, included]) =>
            isSafeFirebaseKey(candidate) && included === true,
        ),
      );
      cleanupProfileIds.forEach((candidate) => {
        if (candidate !== profileId) cleanup[candidate] = true;
      });
      return {
        schemaVersion: 1,
        status: "pending",
        requestId,
        profileId,
        cleanupProfileIds: cleanup,
        matchCursor: null,
        sourceUpdatedAtMs: Date.now(),
        lastQueuedAtMs: 0,
      };
    },
    undefined,
    false,
  );
  if (!result.committed)
    throw new Error("Profile link marker was not committed.");
};

const waitForSettlement = async ({
  database,
  loginUid,
  timeoutMs = WAIT_TIMEOUT_MS,
}) => {
  const path = `profileGameProjectionOutbox/profile/${loginUid}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await database.ref(path).once("value");
    if (!snapshot.exists()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  throw new Error("Timed out waiting for profile link reconciliation.");
};

const resolveInviteId = async (database, matchId) => {
  if ((await database.ref(`invites/${matchId}`).once("value")).exists()) {
    return matchId;
  }
  const existing = [];
  for (const candidate of createInviteCandidatesFromMatchId(matchId)) {
    if ((await database.ref(`invites/${candidate}`).once("value")).exists()) {
      existing.push(candidate);
    }
  }
  return existing.length === 1 ? existing[0] : null;
};

const expectedProjectableInviteIds = async (database, loginUid) => {
  const matchesSnapshot = await database
    .ref(`players/${loginUid}/matches`)
    .once("value");
  const matches = matchesSnapshot.val() || {};
  const inviteIds = new Set();
  for (const matchId of Object.keys(matches).sort()) {
    const inviteId = await resolveInviteId(database, matchId);
    if (!inviteId || inviteIds.has(inviteId)) continue;
    const [inviteSnapshot, automatchSnapshot] = await Promise.all([
      database.ref(`invites/${inviteId}`).once("value"),
      database.ref(`automatch/${inviteId}`).once("value"),
    ]);
    const inviteData = inviteSnapshot.val();
    const automatchStateHint = inferAutomatchStateHint({
      inviteId,
      queueValue: automatchSnapshot.val(),
      hasGuest: Boolean(inviteData?.guestId),
      storedStateHint: inviteData?.automatchStateHint,
    });
    if (shouldProjectInvite({ inviteId, inviteData, automatchStateHint })) {
      inviteIds.add(inviteId);
    }
  }
  return Array.from(inviteIds).sort();
};

const verifyCanonicalOwnership = async ({
  database,
  firestore,
  loginUid,
  profileId,
}) => {
  const liveProfileId = (
    await database.ref(`players/${loginUid}/profile`).once("value")
  ).val();
  if (liveProfileId !== profileId) {
    throw new Error(
      `Profile link ${loginUid} no longer points to ${profileId}.`,
    );
  }
  const expectedInviteIds = await expectedProjectableInviteIds(
    database,
    loginUid,
  );
  const canonicalSnapshot = await firestore
    .collection("users")
    .doc(profileId)
    .collection("games")
    .get();
  const canonicalInviteIds = new Set(
    canonicalSnapshot.docs
      .filter((document) => document.data()?.ownerLoginId === loginUid)
      .map((document) => document.id),
  );
  const missing = expectedInviteIds.filter(
    (inviteId) => !canonicalInviteIds.has(inviteId),
  );
  if (missing.length > 0) {
    throw new Error(`Missing profile game projections: ${missing.join(", ")}`);
  }
  const snapshot = await firestore
    .collectionGroup("games")
    .where("ownerLoginId", "==", loginUid)
    .get();
  const stale = snapshot.docs
    .filter((document) => document.ref.parent.parent?.id !== profileId)
    .map((document) => document.ref.path);
  if (stale.length > 0) {
    throw new Error(
      `Stale profile game projections remain: ${stale.join(", ")}`,
    );
  }
  return {
    checked: snapshot.size,
    expectedInviteIds,
    profileId,
  };
};

const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (!initAdmin(options.adminArgs)) throw new Error(ADC_FAILURE_MESSAGE);
  try {
    const database = admin.database();
    const selected = options.sample
      ? await selectSampleProfileLink(database)
      : await readProfileLink(database, options.loginUid);
    const firestore = admin.firestore();
    const cleanupProfileIds = await findMergeSources(
      firestore,
      selected.profileId,
    );
    const summary = { ...selected, cleanupProfileIds, dryRun: options.dryRun };
    if (options.dryRun) {
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    }
    const requestId = `manual-${randomUUID()}`;
    await writeProfileLinkOutbox({
      ...selected,
      cleanupProfileIds,
      database,
      requestId,
    });
    if (options.wait) {
      await waitForSettlement({ database, loginUid: selected.loginUid });
      const verification = await verifyCanonicalOwnership({
        database,
        firestore,
        ...selected,
      });
      const result = { ...summary, requestId, verification };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    const result = { ...summary, requestId };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    throw addApplicationDefaultCredentialHelp(error);
  } finally {
    await cleanupAdmin();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  findMergeSources,
  expectedProjectableInviteIds,
  main,
  parseArgs,
  readProfileLink,
  selectSampleProfileLink,
  verifyCanonicalOwnership,
  waitForSettlement,
  writeProfileLinkOutbox,
};
