#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProfileD1Reader, type MpLeaderboardProfile } from "./_d1.ts";
import { getDisplayNameFromAddress } from "../runtime/telegramDisplay.js";
import {
  createLeaderboardHeading,
  parseLeaderboardLimit,
} from "./leaderboardCli.ts";
import {
  createDispatchers,
  parseBridgeSecretFile,
  readBridgeSecret,
  type TelegramCommandSender,
} from "./telegramQueueCli.ts";

export async function logTopMpWithEmojis(
  limit = 15,
  dependencies: {
    reader?: {
      readLeaderboard(
        metric: "mp",
        limit: number,
      ): Promise<MpLeaderboardProfile[]>;
    };
    sendCommand: TelegramCommandSender;
    log?: (message: string) => void;
  },
): Promise<void> {
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

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { bridgeSecretFile, remainingArgs } = parseBridgeSecretFile(argv);
  const limit = parseLeaderboardLimit(remainingArgs);
  const { sendCommand } = createDispatchers(readBridgeSecret(bridgeSecretFile));
  await logTopMpWithEmojis(limit, { sendCommand });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
