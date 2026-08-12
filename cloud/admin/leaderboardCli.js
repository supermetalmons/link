const DEFAULT_LEADERBOARD_LIMIT = 15;
const MAX_LEADERBOARD_LIMIT = 90;
const ADMIN_VALUE_FLAGS = new Set(["--project", "--database-url"]);

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

function parseLeaderboardArgs(argv) {
  const adminArgs = [];
  const limitArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!ADMIN_VALUE_FLAGS.has(arg)) {
      limitArgs.push(arg);
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    adminArgs.push(arg, value);
    index += 1;
  }

  return {
    adminArgs,
    limit: parseLeaderboardLimit(limitArgs),
  };
}

function createLeaderboardHeading(metric, limit) {
  return `<b>top ${limit} ${metric}</b>\n\n`;
}

module.exports = {
  DEFAULT_LEADERBOARD_LIMIT,
  MAX_LEADERBOARD_LIMIT,
  createLeaderboardHeading,
  parseLeaderboardArgs,
  parseLeaderboardLimit,
};
