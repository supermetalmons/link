#!/usr/bin/env node
const {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  admin,
  initAdmin,
  cleanupAdmin,
} = require("./_admin");
const { getDisplayNameFromAddress } = require("../functions/utils");
const { queueTelegramSend } = require("../functions/telegramDelivery");

async function logTopGpWithEmojis(limit = 15) {
  const initialized = initAdmin();
  if (initialized) {
    try {
      const firestore = admin.firestore();
      const snap = await firestore
        .collection("users")
        .orderBy("nonce", "desc")
        .limit(limit)
        .get();
      let output = "<b>top 15 gp</b>\n\n";
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
      const sourceId = admin.database().ref("telegramMessages").push().key;
      if (!sourceId) {
        throw new Error("Could not allocate a Telegram message ID.");
      }
      await queueTelegramSend({
        messageKey: `admin:top-gp:${sourceId}`,
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

async function main() {
  await logTopGpWithEmojis(15);
}

main().catch((err) => {
  console.error(addApplicationDefaultCredentialHelp(err));
  process.exit(1);
});
