const queue = {
  metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  send: async () => ({
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  }),
  sendBatch: async () => ({
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  }),
} satisfies Queue;

const rateLimit = {
  limit: async () => ({ success: true }),
} satisfies RateLimit;

const unexpectedInviteReactions = (): never => {
  throw new Error("test-invite-reactions-not-configured");
};
const inviteReactions = {
  newUniqueId: unexpectedInviteReactions,
  idFromName: unexpectedInviteReactions,
  idFromString: unexpectedInviteReactions,
  get: unexpectedInviteReactions,
  getByName: unexpectedInviteReactions,
  jurisdiction: unexpectedInviteReactions,
} satisfies Env["INVITE_REACTIONS"];

const workflowInstance = {
  id: "test-workflow-instance",
  delete: async () => undefined,
  pause: async () => undefined,
  restart: async () => undefined,
  resume: async () => undefined,
  sendEvent: async () => undefined,
  status: async () => ({ status: "complete" as const }),
  terminate: async () => undefined,
} satisfies WorkflowInstance;

const workflow = {
  create: async () => workflowInstance,
  createBatch: async () => [workflowInstance],
  deleteBatch: async () => ({ deleted: [], errors: [] }),
  get: async () => workflowInstance,
} satisfies Workflow;

const d1Meta = {
  changed_db: false,
  changes: 0,
  duration: 0,
  last_row_id: 0,
  rows_read: 0,
  rows_written: 0,
  size_after: 0,
};
async function d1Raw<T = unknown[]>(options: {
  columnNames: true;
}): Promise<[string[], ...T[]]>;
async function d1Raw<T = unknown[]>(options?: {
  columnNames?: false;
}): Promise<T[]>;
async function d1Raw<T = unknown[]>(options?: {
  columnNames?: boolean;
}): Promise<T[] | [string[], ...T[]]> {
  return options?.columnNames ? [[]] : [];
}
const d1Statement: D1PreparedStatement = {
  all: async () => ({ success: true, results: [], meta: d1Meta }),
  bind: () => d1Statement,
  first: async () => null,
  raw: d1Raw,
  run: async () => ({ success: true, results: [], meta: d1Meta }),
};
const profileGamesDb = {
  batch: async (statements: D1PreparedStatement[]) =>
    statements.map(() => ({
      success: true as const,
      results: [],
      meta: d1Meta,
    })),
  dump: async () => new ArrayBuffer(0),
  exec: async () => ({ count: 0, duration: 0 }),
  prepare: () => d1Statement,
  withSession: () => {
    throw new Error("test-profile-games-db-not-configured");
  },
} satisfies D1Database;

const canonicalControlStatement: D1PreparedStatement = {
  all: d1Statement.all,
  bind: () => canonicalControlStatement,
  first: async <T>() => ({ state: "active" }) as T,
  raw: d1Statement.raw,
  run: d1Statement.run,
};
const wagerControlStatement: D1PreparedStatement = {
  all: d1Statement.all,
  raw: d1Statement.raw,
  run: d1Statement.run,
  bind: () => wagerControlStatement,
  first: async <T>() =>
    ({
      storage_mode: "firebase",
      previous_storage_mode: null,
      freeze_generation: 0,
      activated_at_ms: null,
    }) as T,
};
const profileDb = {
  ...profileGamesDb,
  prepare: (query: string) =>
    query.includes("wager_reservation_runtime_control")
      ? wagerControlStatement
      : query.includes("profile_canonical_control")
        ? canonicalControlStatement
        : d1Statement,
} satisfies D1Database;

const telegramStatement: D1PreparedStatement = {
  all: d1Statement.all,
  bind: () => telegramStatement,
  raw: d1Statement.raw,
  run: d1Statement.run,
  first: async <T>() => ({ storage_mode: "d1" }) as T,
};
const telegramDb = {
  ...profileGamesDb,
  prepare: () => telegramStatement,
} satisfies D1Database;

const eventPrizeWithdrawalStatement: D1PreparedStatement = {
  all: d1Statement.all,
  bind: () => eventPrizeWithdrawalStatement,
  raw: d1Statement.raw,
  run: d1Statement.run,
  first: async <T>() =>
    ({ storage_mode: "d1", previous_storage_mode: null }) as T,
};
const eventPrizeWithdrawalsDb = {
  ...profileGamesDb,
  prepare: () => eventPrizeWithdrawalStatement,
} satisfies D1Database;

export const TELEGRAM_TEST_ENV = {
  APPLE_AUDIENCES: "link.mons",
  AUTH_MUTATIONS_DISABLED: "false",
  AUTH_RECOVERY_QUEUE: queue,
  AUTH_STATE_DB: profileGamesDb,
  AUTH_RATE_LIMITER: rateLimit,
  REACTION_RATE_LIMITER: rateLimit,
  INVITE_REACTIONS: inviteReactions,
  EVENT_PROGRESS_WORKFLOW: workflow,
  EVENT_DB: profileGamesDb,
  EVENT_PRIZE_ADMIN_PRIVATE_KEY: "test-event-prize-private-key",
  EVENT_PRIZE_WITHDRAWALS_DB: eventPrizeWithdrawalsDb,
  EVENT_PRIZE_WITHDRAWAL_WORKFLOW: workflow,
  FIREBASE_RTDB_URL: "https://mons-link-default-rtdb.firebaseio.com",
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL:
    "identity@example.iam.gserviceaccount.com",
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  GAMEPLAY_SERVICE_ACCOUNT_EMAIL: "gameplay@example.iam.gserviceaccount.com",
  GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: rateLimit,
  PROFILE_GAME_PROJECTION_QUEUE: queue,
  PROFILE_DB: profileDb,
  PROFILE_GAMES_DB: profileGamesDb,
  TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET: "test-announcement-secret",
  TELEGRAM_BOT_TOKEN: "test-telegram-token",
  TELEGRAM_DELIVERY_QUEUE: queue,
  TELEGRAM_DB: telegramDb,
  TELEGRAM_PROJECTION_QUEUE: queue,
  TELEGRAM_EXTRA_CHAT_ID: "test-telegram-chat",
  TELEGRAM_FIREBASE_SERVICE_ACCOUNT_EMAIL:
    "telegram@example.iam.gserviceaccount.com",
  TELEGRAM_FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  TELEGRAM_QUEUE_BRIDGE_SECRET: "test-bridge-secret",
  X_CLIENT_ID: "test-x-client-id",
  X_CLIENT_SECRET: "test-x-client-secret",
} as const;

export function withProfileControl(
  environment: Env,
  state: "frozen" | "active",
): Env {
  let statement: D1PreparedStatement;
  statement = {
    all: d1Statement.all,
    bind: () => statement,
    first: async <T>() => ({ state }) as T,
    raw: d1Statement.raw,
    run: d1Statement.run,
  };
  const database = {
    batch: environment.PROFILE_DB.batch.bind(environment.PROFILE_DB),
    dump: environment.PROFILE_DB.dump.bind(environment.PROFILE_DB),
    exec: environment.PROFILE_DB.exec.bind(environment.PROFILE_DB),
    prepare: (query: string) =>
      query.includes("profile_canonical_control")
        ? statement
        : environment.PROFILE_DB.prepare(query),
    withSession: environment.PROFILE_DB.withSession.bind(
      environment.PROFILE_DB,
    ),
  } satisfies D1Database;
  return { ...environment, PROFILE_DB: database };
}
