const admin = require("../firebaseAdmin");

const removeWagerProposalWithRetry = async (
  inviteId,
  matchId,
  proposalUid,
  attempts = 2,
) => {
  const wagerRef = admin
    .database()
    .ref(`invites/${inviteId}/wagers/${matchId}`);
  let lastDebug = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const beforeSnap = await wagerRef.once("value");
    const beforeData = beforeSnap.val() || {};
    if (!beforeSnap.exists()) {
      lastDebug = { attempt, step: "missing-data" };
      return { ok: false, debug: lastDebug };
    }
    if (beforeData.resolved || beforeData.agreed) {
      lastDebug = {
        attempt,
        step: "already-resolved",
        resolved: !!beforeData.resolved,
        agreed: !!beforeData.agreed,
      };
      return { ok: false, debug: lastDebug };
    }
    const proposals = beforeData.proposals || {};
    const proposal = proposals[proposalUid];
    if (!proposal) {
      lastDebug = {
        attempt,
        step: "proposal-missing",
        proposalKeys: Object.keys(proposals),
      };
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 160));
        continue;
      }
      return { ok: false, debug: lastDebug };
    }
    await wagerRef.child(`proposals/${proposalUid}`).remove();
    const afterSnap = await wagerRef.once("value");
    const afterData = afterSnap.val() || {};
    const afterProposals = afterData.proposals || {};
    const stillExists = !!afterProposals[proposalUid];
    const canUnfreeze = !afterData.agreed && !afterData.resolved;
    lastDebug = {
      attempt,
      step: stillExists ? "proposal-still-present" : "proposal-removed",
      latestProposalKeys: Object.keys(afterProposals),
      latestAgreed: !!afterData.agreed,
      latestResolved: !!afterData.resolved,
    };
    if (!stillExists) {
      return {
        ok: true,
        removedProposal: proposal,
        canUnfreeze,
        debug: lastDebug,
      };
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 160));
      continue;
    }
  }
  return { ok: false, debug: lastDebug };
};

module.exports = { removeWagerProposalWithRetry };
