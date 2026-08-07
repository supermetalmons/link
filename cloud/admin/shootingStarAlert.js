#!/usr/bin/env node
const {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  admin,
  initAdmin,
  cleanupAdmin,
} = require("./_admin");
const { queueTelegramSend } = require("../functions/telegramDelivery");

async function main() {
  if (!initAdmin()) {
    throw new Error(ADC_FAILURE_MESSAGE);
  }
  try {
    const isoTime = new Date().toISOString();
    const raHoursTotal = Math.random() * 24;
    const raH = Math.floor(raHoursTotal);
    const raMFloat = (raHoursTotal - raH) * 60;
    let raM = Math.floor(raMFloat);
    let raS = (raMFloat - raM) * 60;
    if (raS >= 59.995) {
      raS = 0;
      raM += 1;
    }
    if (raM >= 60) {
      raM = 0;
    }
    const raStr = `${String(raH).padStart(2, "0")}h ${String(raM).padStart(2, "0")}m ${raS.toFixed(2).padStart(5, "0")}s`;
    const decTotal = Math.random() * 180 - 90;
    const decSign = decTotal >= 0 ? "+" : "-";
    const absDec = Math.abs(decTotal);
    const decD = Math.floor(absDec);
    const decMFloat = (absDec - decD) * 60;
    let decM = Math.floor(decMFloat);
    let decS = (decMFloat - decM) * 60;
    if (decS >= 59.995) {
      decS = 0;
      decM += 1;
    }
    if (decM >= 60) {
      decM = 0;
    }
    const decStr = `${decSign}${String(decD).padStart(2, "0")}° ${String(decM).padStart(2, "0")}' ${decS.toFixed(2).padStart(5, "0")}"`;
    const message = `🌠 shooting star alert https://mons.link\n\n${isoTime}\n\nRA ${raStr} • Dec ${decStr}`;
    const sourceId = admin.database().ref("telegramMessages").push().key;
    if (!sourceId) {
      throw new Error("Could not allocate a Telegram message ID.");
    }
    await queueTelegramSend({
      messageKey: `admin:shooting-star:${sourceId}`,
      destination: "community",
      instanceKey: sourceId,
      text: message,
      silent: true,
      sourceRevision: sourceId,
    });
  } finally {
    await cleanupAdmin();
  }
}

main().catch((err) => {
  console.error(addApplicationDefaultCredentialHelp(err));
  process.exit(1);
});
