#!/usr/bin/env node

"use strict";

const { stdout } = require("node:process");
const {
  buildProfileEventPrizeMergeCopies,
} = require("../functions/eventPrizeAwards");
const {
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
} = require("../functions/eventPrizeProjectionState");
const {
  resolveProfileMergeTargetPath,
} = require("../functions/profileMergeTargets");
const {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  admin,
  cleanupAdmin,
  initAdmin,
} = require("./_admin");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const USAGE =
  "Usage: node cloud/admin/reconcileProfileEventPrizes.js [--project <id>] [--database-url <url>] [--after <source-profile-id>] [--limit <1-100>] [--dry-run | --execute]";

const parseArgs = (argv) => {
  const options = {
    adminArgs: [],
    after: "",
    dryRun: true,
    limit: DEFAULT_LIMIT,
  };
  let modeSet = false;
  const seenValueFlags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run" || arg === "--execute") {
      if (modeSet) throw new TypeError(USAGE);
      modeSet = true;
      options.dryRun = arg === "--dry-run";
      continue;
    }
    if (!["--after", "--database-url", "--limit", "--project"].includes(arg)) {
      throw new TypeError(USAGE);
    }
    if (seenValueFlags.has(arg)) throw new TypeError(USAGE);
    seenValueFlags.add(arg);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new TypeError(USAGE);
    if (arg === "--after") options.after = value;
    else if (arg === "--limit") {
      const limit = Number(value);
      if (!/^\d+$/.test(value) || limit < 1 || limit > MAX_LIMIT) {
        throw new TypeError(USAGE);
      }
      options.limit = limit;
    } else options.adminArgs.push(arg, value);
  }
  return options;
};

const equivalent = (left, right) =>
  left?.eventId === right?.eventId &&
  left?.profileId === right?.profileId &&
  Number(left?.place) === Number(right?.place) &&
  left?.prizeId === right?.prizeId &&
  Number(left?.assignedAtMs) === Number(right?.assignedAtMs);

const reconcileProfileEventPrizesPage = async (
  options,
  { database = admin.database(), firestore = admin.firestore() } = {},
) => {
  let query = firestore
    .collection("profileMergeTargets")
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(options.limit + 1);
  if (options.after) query = query.startAfter(options.after);
  const snapshot = await query.get();
  const mappings = snapshot.docs.slice(0, options.limit);
  const changes = [];
  const conflicts = [];
  for (const mapping of mappings) {
    const path = await resolveProfileMergeTargetPath({
      profileId: mapping.id,
      readMergeTarget: async (profileId) => {
        const candidate = await firestore
          .collection("profileMergeTargets")
          .doc(profileId)
          .get();
        return candidate.exists ? candidate.data() || null : null;
      },
    });
    const targetProfileId = path.at(-1);
    if (!targetProfileId || targetProfileId === mapping.id) continue;
    const sourceSnapshot = await database
      .ref(`profileEventPrizes/${mapping.id}`)
      .once("value");
    const sourcePrizes = sourceSnapshot.val() || {};
    for (const [eventId, sourceAssignment] of Object.entries(sourcePrizes)) {
      const targetRef = database.ref(
        `profileEventPrizes/${targetProfileId}/${eventId}`,
      );
      const withdrawalRef = database.ref(
        `eventPrizeWithdrawals/${eventId}/${sourceAssignment?.prizeId || "_"}`,
      );
      const [targetSnapshot, withdrawalSnapshot] = await Promise.all([
        targetRef.once("value"),
        withdrawalRef.once("value"),
      ]);
      const targetAssignment = targetSnapshot.val();
      if (
        isCompletedEventPrizeWithdrawal(
          withdrawalSnapshot.val(),
          eventId,
          sourceAssignment?.prizeId,
        )
      ) {
        changes.push({
          action: "remove-completed",
          eventId,
          sourceProfileId: mapping.id,
          targetProfileId,
        });
        if (!options.dryRun) {
          await Promise.all([
            database
              .ref(`profileEventPrizes/${mapping.id}/${eventId}`)
              .transaction((current) =>
                isMatchingProfileEventPrizeAssignment(
                  current,
                  eventId,
                  sourceAssignment?.prizeId,
                )
                  ? null
                  : undefined,
              ),
            targetRef.transaction((current) =>
              isMatchingProfileEventPrizeAssignment(
                current,
                eventId,
                sourceAssignment?.prizeId,
              )
                ? null
                : undefined,
            ),
          ]);
        }
        continue;
      }
      const expectedAssignment = {
        ...sourceAssignment,
        profileId: targetProfileId,
      };
      if (targetAssignment) {
        if (!equivalent(targetAssignment, expectedAssignment)) {
          conflicts.push({
            eventId,
            sourceProfileId: mapping.id,
            targetProfileId,
          });
        }
        continue;
      }
      const copy = buildProfileEventPrizeMergeCopies({
        sourceProfileId: mapping.id,
        targetProfileId,
        sourcePrizes: { [eventId]: sourceAssignment },
        targetPrizes: {},
      })[eventId];
      if (!copy) {
        continue;
      }
      changes.push({
        action: "copy",
        eventId,
        sourceProfileId: mapping.id,
        targetProfileId,
      });
      if (!options.dryRun) {
        await targetRef.transaction((current) =>
          current == null ? copy : undefined,
        );
        const postCopyWithdrawalSnapshot = await withdrawalRef.once("value");
        if (
          isCompletedEventPrizeWithdrawal(
            postCopyWithdrawalSnapshot.val(),
            eventId,
            sourceAssignment?.prizeId,
          )
        ) {
          await targetRef.transaction((current) =>
            equivalent(current, copy) ? null : undefined,
          );
        }
      }
    }
  }
  const hasMore = snapshot.docs.length > mappings.length;
  return {
    complete: !hasMore && conflicts.length === 0 && changes.length === 0,
    dryRun: options.dryRun,
    scanned: mappings.length,
    changes,
    conflicts,
    hasMore,
    nextCursor: hasMore && mappings.length > 0 ? mappings.at(-1).id : null,
  };
};

const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (!initAdmin(options.adminArgs)) throw new Error(ADC_FAILURE_MESSAGE);
  try {
    const result = await reconcileProfileEventPrizesPage(options);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    throw addApplicationDefaultCredentialHelp(error);
  } finally {
    await cleanupAdmin();
  }
};

if (require.main === module) {
  main()
    .then((result) => {
      if (!result.complete) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    });
}

module.exports = { main, parseArgs, reconcileProfileEventPrizesPage };
