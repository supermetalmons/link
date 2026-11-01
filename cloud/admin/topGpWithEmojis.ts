#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProfileD1Reader, type GpLeaderboardProfile } from "./_d1.ts";
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

export async function logTopGpWithEmojis(
  limit = 15,
  dependencies: {
    reader?: {
      readLeaderboard(
        metric: "gp",
        limit: number,
      ): Promise<GpLeaderboardProfile[]>;
    };
    sendCommand: TelegramCommandSender;
    log?: (message: string) => void;
  },
): Promise<void> {
  const reader = dependencies.reader || createProfileD1Reader();
  const profiles = await reader.readLeaderboard("gp", limit);
  let output = createLeaderboardHeading("gp", limit);
  let rank = 1;
  for (const data of profiles) {
    const username = data.username || "";
    const eth = data.eth || "";
    const sol = data.sol || "";
    const gp = (data.nonce ?? 0) + 1;
    const emoji = data.emoji ?? "";
    const name = getDisplayNameFromAddress(username, eth, sol, 0, emoji);
    output += `${rank}. ${name} ${gp}\n\n`;
    rank += 1;
  }
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
  (dependencies.log || console.log)(
    JSON.stringify({
      event: "admin_top_gp_dispatched",
      count: profiles.length,
    }),
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { bridgeSecretFile, remainingArgs } = parseBridgeSecretFile(argv);
  const limit = parseLeaderboardLimit(remainingArgs);
  const { sendCommand } = createDispatchers(readBridgeSecret(bridgeSecretFile));
  await logTopGpWithEmojis(limit, { sendCommand });
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
