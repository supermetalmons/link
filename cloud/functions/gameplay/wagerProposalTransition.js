const { normalizeCount } = require("@mons/shared/mining");

const transitionWagerProposal = (
  current,
  { playerUid, opponentUid, material, reservedCount, now },
) => {
  const unchanged = {
    value: undefined,
    autoAgreement: null,
    autoOpponentCount: 0,
  };
  const data = current || {};
  if (data.resolved || data.agreed) {
    return unchanged;
  }
  const proposals = data.proposals || {};
  const proposedBy = data.proposedBy || {};
  if (proposals[playerUid] || proposedBy[playerUid]) {
    return unchanged;
  }
  const opponentProposal =
    opponentUid && proposals ? proposals[opponentUid] : null;
  const opponentCount = opponentProposal
    ? normalizeCount(opponentProposal.count)
    : 0;
  if (
    opponentProposal &&
    opponentProposal.material === material &&
    opponentCount > 0
  ) {
    const acceptedCount = Math.min(reservedCount, opponentCount);
    if (acceptedCount <= 0) {
      return unchanged;
    }
    const agreed = {
      material,
      count: acceptedCount,
      total: acceptedCount * 2,
      proposerId: opponentUid,
      accepterId: playerUid,
      acceptedAt: now,
    };
    proposedBy[playerUid] = true;
    data.agreed = agreed;
    data.proposals = null;
    data.proposedBy = proposedBy;
    return {
      value: data,
      autoAgreement: agreed,
      autoOpponentCount: opponentCount,
    };
  }
  proposals[playerUid] = { material, count: reservedCount, createdAt: now };
  proposedBy[playerUid] = true;
  data.proposals = proposals;
  data.proposedBy = proposedBy;
  return {
    value: data,
    autoAgreement: null,
    autoOpponentCount: 0,
  };
};

module.exports = { transitionWagerProposal };
