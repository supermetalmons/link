#!/usr/bin/env node
const { randomUUID } = require("node:crypto");
const {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  admin,
  initAdmin,
  cleanupAdmin,
} = require("./_admin");
const { getDisplayNameFromAddress } = require("../functions/utils");
const {
  createLeaderboardHeading,
  parseLeaderboardArgs,
} = require("./leaderboardCli");
const {
  createDispatchers,
  parseBridgeSecretFile,
  readBridgeSecret,
} = require("./telegramQueueCli");

async function logTopGpWithEmojis(
  limit = 15,
  adminArgs = process.argv.slice(2),
  dependencies = {},
) {
  const initialized = initAdmin(adminArgs);
  if (initialized) {
    try {
      const firestore = admin.firestore();
      const snap = await firestore
        .collection("users")
        .orderBy("nonce", "desc")
        .limit(limit)
        .get();
      let output = createLeaderboardHeading("gp", limit);
      let rank = 1;
      for (const doc of snap.docs) {
        const data = doc.data();
        const username = data.username || "";
        const eth = data.eth || "";
        const sol = data.sol || "";
        const gp = data.nonce + 1;
        const emoji =
          data.custom && data.custom.emoji !== undefined
            ? data.custom.emoji
            : (data.emoji ?? "");
        const name = getDisplayNameFromAddress(username, eth, sol, 0, emoji);
        output += `${rank}. ${name} ${gp}\n\n`;
        rank += 1;
      }
      console.log(output);
      const sourceId = randomUUID();
      await dependencies.sendCommand({
        kind: "send",
        messageKey: `admin:top-gp:${sourceId}`,
        generation: `admin:top-gp:${sourceId}`,
        destination: "community",
        instanceKey: sourceId,
        text: output,
        parseMode: "HTML",
        silent: false,
        sourceRevision: sourceId,
      });
      return;
    } finally {
      await cleanupAdmin();
    }
  }
  throw new Error(ADC_FAILURE_MESSAGE);
}

async function main(argv = process.argv.slice(2)) {
  const { bridgeSecretFile, remainingArgs } = parseBridgeSecretFile(argv);
  const { adminArgs, limit } = parseLeaderboardArgs(remainingArgs);
  const { sendCommand } = createDispatchers(readBridgeSecret(bridgeSecretFile));
  await logTopGpWithEmojis(limit, adminArgs, { sendCommand });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(addApplicationDefaultCredentialHelp(err));
    process.exit(1);
  });
}

module.exports = { logTopGpWithEmojis, main };
