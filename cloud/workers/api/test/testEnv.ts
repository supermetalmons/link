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
  prepare: (query: string): D1PreparedStatement =>
    query.includes("invite_source_control") ||
    query.includes("invite_source_write_admissions")
      ? inviteSourceStatement(query)
      : query.includes("automatch_runtime_control") ||
          query.includes("automatch_write_admissions")
        ? automatchStatement(query)
        : d1Statement,
  withSession: (): D1DatabaseSession => ({
    prepare: (query: string): D1PreparedStatement =>
      profileGamesDb.prepare(query),
    batch: profileGamesDb.batch,
    getBookmark: () => null,
  }),
} satisfies D1Database;

function inviteSourceStatement(
  query: string,
  bindings: unknown[] = [],
): D1PreparedStatement {
  return {
    all: d1Statement.all,
    raw: d1Statement.raw,
    run: d1Statement.run,
    bind: (...values) => inviteSourceStatement(query, values),
    first: async <T>() =>
      (query.includes("INSERT INTO invite_source_write_admissions")
        ? { admission_id: bindings[0] }
        : {
            backend: "rtdb",
            state: "active",
            epoch: 0,
            freeze_generation: 0,
            candidate_version_id: null,
            source_digest: null,
            import_digest: null,
            verified_at_ms: null,
            activated_at_ms: null,
            metadata_json: null,
          }) as T,
  };
}

function automatchStatement(
  query: string,
  bindings: unknown[] = [],
): D1PreparedStatement {
  return {
    all: d1Statement.all,
    raw: d1Statement.raw,
    run: d1Statement.run,
    bind: (...values) => automatchStatement(query, values),
    first: async <T>() =>
      (query.includes("INSERT INTO automatch_write_admissions")
        ? {
            admission_id: bindings[0],
            kind: bindings[1],
            created_at_ms: bindings[2],
            backend: "rtdb",
            epoch: 1,
            freeze_generation: 0,
          }
        : {
            backend: "rtdb",
            state: "active",
            epoch: 1,
            freeze_generation: 0,
            staged_at_ms: null,
            candidate_version_id: null,
            imported_at_ms: null,
            source_digest: null,
            import_digest: null,
            activated_at_ms: null,
            metadata_json: null,
          }) as T,
  };
}

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
const wagerStateActivation = {
  activation_epoch: 1,
  verified_at_ms: 1,
  activated_at_ms: 1,
  invite_id: null,
  match_id: null,
  wager_json: null,
  resolution_marker: null,
  revision: null,
};
const wagerStateStatement: D1PreparedStatement = {
  all: async <T>() => ({
    success: true,
    results: [wagerStateActivation as T],
    meta: d1Meta,
  }),
  raw: d1Statement.raw,
  run: d1Statement.run,
  bind: () => wagerStateStatement,
  first: async <T>() => wagerStateActivation as T,
};
const profileDb = {
  ...profileGamesDb,
  withSession: () => ({
    prepare: (query: string): D1PreparedStatement => profileDb.prepare(query),
    batch: profileGamesDb.batch,
    getBookmark: () => null,
  }),
  prepare: (query: string): D1PreparedStatement =>
    query.includes("wager_state_activation")
      ? wagerStateStatement
      : query.includes("wager_reservation_runtime_control")
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

function eventAdmissionStatement(query: string): D1PreparedStatement {
  return {
    first: d1Statement.first,
    raw: d1Statement.raw,
    bind: () => eventAdmissionStatement(query),
    all: async <T>() => ({
      success: true,
      results: [{ freeze_generation: 0 } as T],
      meta: { ...d1Meta, changes: 1 },
    }),
    run: async <T>() => ({
      success: true,
      results: [] as T[],
      meta: { ...d1Meta, changes: 1 },
    }),
  };
}

const eventDb = {
  ...profileGamesDb,
  prepare: (query: string): D1PreparedStatement =>
    query.includes("event_write_admissions")
      ? eventAdmissionStatement(query)
      : profileGamesDb.prepare(query),
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
  MOVE_RATE_LIMITER: rateLimit,
  REACTION_RATE_LIMITER: rateLimit,
  INVITE_REACTIONS: inviteReactions,
  EVENT_PROGRESS_WORKFLOW: workflow,
  EVENT_DB: eventDb,
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
