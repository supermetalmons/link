const {
  isMaterialName,
  normalizeCount,
  applyMaterialDeltas,
  updateFrozenMaterials,
  updateFrozenMaterialsWithCap,
  reserveFrozenMaterials,
  reserveAcceptedMaterials,
  readUserMiningMaterials,
  updateUserMiningMaterials,
} = require("./gameplay/wagerMaterials");
const { resolveWagerParticipants } = require("./gameplay/wagerParticipants");
const {
  removeWagerProposalWithRetry,
} = require("./gameplay/wagerProposalRemoval");

module.exports = {
  isMaterialName,
  normalizeCount,
  applyMaterialDeltas,
  updateFrozenMaterials,
  updateFrozenMaterialsWithCap,
  reserveFrozenMaterials,
  reserveAcceptedMaterials,
  readUserMiningMaterials,
  updateUserMiningMaterials,
  resolveWagerParticipants,
  removeWagerProposalWithRetry,
};
