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

export const TELEGRAM_TEST_ENV = {
  APPLE_AUDIENCES: "link.mons",
  AUTH_RECOVERY_QUEUE: queue,
  AUTH_MUTATIONS_DISABLED: "false" as unknown as Env["AUTH_MUTATIONS_DISABLED"],
  AUTH_RATE_LIMITER: rateLimit,
  EVENT_PROGRESS_WORKFLOW: workflow,
  EVENT_PRIZE_ADMIN_PRIVATE_KEY: "test-event-prize-private-key",
  EVENT_PRIZE_WITHDRAWAL_WORKFLOW: workflow,
  FIREBASE_RTDB_URL: "https://mons-link-default-rtdb.firebaseio.com",
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "firestore@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  GAMEPLAY_SERVICE_ACCOUNT_EMAIL: "gameplay@example.iam.gserviceaccount.com",
  GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: rateLimit,
  PROFILE_GAME_PROJECTION_QUEUE: queue,
  PROFILE_GAMES_DB: profileGamesDb,
  RATING_SERVICE_ACCOUNT_EMAIL: "rating@example.iam.gserviceaccount.com",
  RATING_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET: "test-announcement-secret",
  TELEGRAM_BOT_TOKEN: "test-telegram-token",
  TELEGRAM_DELIVERY_QUEUE: queue,
  TELEGRAM_PROJECTION_QUEUE: queue,
  TELEGRAM_EXTRA_CHAT_ID: "test-telegram-chat",
  TELEGRAM_FIREBASE_SERVICE_ACCOUNT_EMAIL:
    "telegram@example.iam.gserviceaccount.com",
  TELEGRAM_FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  TELEGRAM_QUEUE_BRIDGE_SECRET: "test-bridge-secret",
  USERNAME_SERVICE_ACCOUNT_EMAIL: "username@example.iam.gserviceaccount.com",
  USERNAME_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  X_CLIENT_ID: "test-x-client-id",
  X_CLIENT_SECRET: "test-x-client-secret",
} as const;
