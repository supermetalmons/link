const { resolveMatchWinner } = require("./matchOutcome");

const resolveMatchResult = async (matchData, opponentMatchData) => {
  const { winner } = await resolveMatchWinner(matchData, opponentMatchData);
  const result =
    winner === "player" ? "win" : winner === "opponent" ? "gg" : "none";
  return { result };
};

module.exports = {
  resolveMatchResult,
};
