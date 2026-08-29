#!/usr/bin/env node
const { randomUUID } = require("node:crypto");
const { createProfileD1Reader } = require("./_d1");
const { getDisplayNameFromAddress } = require("../functions/telegramDisplay");
const {
  createLeaderboardHeading,
  parseLeaderboardArgs,
} = require("./leaderboardCli");
const {
  createDispatchers,
  parseBridgeSecretFile,
  readBridgeSecret,
} = require("./telegramQueueCli");

async function logTopMpWithEmojis(
  limit = 15,
  adminArgs = process.argv.slice(2),
  dependencies = {},
) {
  if (adminArgs.length > 0) {
    throw new TypeError("Firebase target flags are not supported.");
  }
  const reader = dependencies.reader || createProfileD1Reader();
  const profiles = await reader.readLeaderboard("mp", limit);
  let output = createLeaderboardHeading("mp", limit);
  let rank = 1;
  for (const data of profiles) {
    const username = data.username || "";
    const eth = data.eth || "";
    const sol = data.sol || "";
    const mp = data.totalManaPoints || 0;
    const emoji = data.emoji ?? "";
    const name = getDisplayNameFromAddress(username, eth, sol, 0, emoji);
    output += `${rank}. ${name} ${mp}\n\n`;
    rank += 1;
  }
  const sourceId = randomUUID();
  await dependencies.sendCommand({
    kind: "send",
    messageKey: `admin:top-mp:${sourceId}`,
    generation: `admin:top-mp:${sourceId}`,
    destination: "community",
    instanceKey: sourceId,
    text: output,
    parseMode: "HTML",
    silent: false,
    sourceRevision: sourceId,
  });
  (dependencies.log || console.log)(
    JSON.stringify({
      event: "admin_top_mp_dispatched",
      count: profiles.length,
    }),
  );
}

async function main(argv = process.argv.slice(2)) {
  const { bridgeSecretFile, remainingArgs } = parseBridgeSecretFile(argv);
  const { adminArgs, limit } = parseLeaderboardArgs(remainingArgs);
  const { sendCommand } = createDispatchers(readBridgeSecret(bridgeSecretFile));
  await logTopMpWithEmojis(limit, adminArgs, { sendCommand });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { logTopMpWithEmojis, main };
