const DEFAULT_LEADERBOARD_LIMIT = 15;
const MAX_LEADERBOARD_LIMIT = 90;

function parseLeaderboardLimit(argv) {
  if (argv.length === 0) {
    return DEFAULT_LEADERBOARD_LIMIT;
  }
  if (argv.length !== 1) {
    throw new Error(
      `Expected at most one leaderboard limit (1-${MAX_LEADERBOARD_LIMIT}).`,
    );
  }

  const value = argv[0].trim();
  const limit = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LEADERBOARD_LIMIT
  ) {
    throw new Error(
      `Leaderboard limit must be an integer from 1 to ${MAX_LEADERBOARD_LIMIT}.`,
    );
  }
  return limit;
}

function createLeaderboardHeading(metric, limit) {
  return `<b>top ${limit} ${metric}</b>\n\n`;
}

module.exports = {
  DEFAULT_LEADERBOARD_LIMIT,
  MAX_LEADERBOARD_LIMIT,
  createLeaderboardHeading,
  parseLeaderboardLimit,
};
