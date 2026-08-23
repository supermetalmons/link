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

export const TELEGRAM_TEST_ENV = {
  APPLE_AUDIENCES: "link.mons",
  AUTH_RECOVERY_QUEUE: queue,
  AUTH_DISABLE_APPLE_VERIFY: "false",
  AUTH_DISABLE_MERGE: "false",
  AUTH_DISABLE_UNLINK: "false",
  AUTH_DISABLE_X_VERIFY: "false",
  AUTH_RATE_LIMITER: rateLimit,
  FIREBASE_RTDB_URL: "https://mons-link-default-rtdb.firebaseio.com",
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "firestore@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  GAMEPLAY_SERVICE_ACCOUNT_EMAIL: "gameplay@example.iam.gserviceaccount.com",
  GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: rateLimit,
  RATING_SERVICE_ACCOUNT_EMAIL: "rating@example.iam.gserviceaccount.com",
  RATING_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  SIWE_ALLOWED_DOMAINS: "mons.link,www.mons.link,localhost,127.0.0.1",
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
