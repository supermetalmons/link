import {
  authDocumentName,
  createAuthFirestoreClient,
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
} from "./authFirestore.ts";
import {
  commitProfileDeletion,
  commitProfileProjection,
  commitProfileProjectionFailure,
  readProfileReconciliationState,
  type ProfileReconciliationState,
} from "./profileD1.ts";
import {
  createProfileProjection,
  parseFirestoreUpdateTime,
  PROFILE_PROJECTION_SCHEMA_VERSION,
  ProfileProjectionValidationError,
  type FirestoreUpdateVersion,
} from "./profileProjectionModel.ts";
import {
  parseProfileReadProjectionTask,
  type ProfileReadProjectionTask,
} from "./profileReadProjectionTasks.ts";
import type { WorkerExecutionContext } from "./firebaseAuth.ts";

const PROFILE_COLLECTION = "users";
const RECONCILIATION_FIELD_MASK = ["nonce"];
const QUEUE_BATCH_SIZE = 100;

type ProfileReadProjectionDependencies = {
  db?: D1Database;
  firestore?: AuthFirestoreClient;
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
};

type ProjectionStatus = "deleted" | "projected" | "stale";

function createTask(profileId: string): ProfileReadProjectionTask {
  const task = parseProfileReadProjectionTask({ profileId });
  if (!task) {
    throw new TypeError("invalid-profile-read-projection-task");
  }
  return task;
}

function sameVersion(
  first: FirestoreUpdateVersion,
  second: FirestoreUpdateVersion,
): boolean {
  return first.seconds === second.seconds && first.nanos === second.nanos;
}

function laterVersion(
  first: FirestoreUpdateVersion,
  second: FirestoreUpdateVersion,
): FirestoreUpdateVersion {
  return first.seconds > second.seconds ||
    (first.seconds === second.seconds && first.nanos >= second.nanos)
    ? first
    : second;
}

function latestKnownVersion(
  state: ProfileReconciliationState,
): FirestoreUpdateVersion | null {
  if (!state.profile) {
    return state.failureVersion;
  }
  return state.failureVersion
    ? laterVersion(state.profile.sourceVersion, state.failureVersion)
    : state.profile.sourceVersion;
}

function isCurrentProjectionSchema(
  sourceVersion: FirestoreUpdateVersion,
  schemaVersion: number | null,
  schemaSourceVersion: FirestoreUpdateVersion | null,
): boolean {
  return (
    schemaVersion === PROFILE_PROJECTION_SCHEMA_VERSION &&
    schemaSourceVersion !== null &&
    sameVersion(sourceVersion, schemaSourceVersion)
  );
}

async function processProfileDocument(
  profileId: string,
  document: AuthFirestoreDocument | null,
  db: D1Database,
  nowMs: number,
): Promise<ProjectionStatus> {
  if (document) {
    if (document.id !== profileId) {
      throw new ProfileProjectionValidationError("invalid-profile-source");
    }
    try {
      const projection = await createProfileProjection({
        profileId,
        fields: document.fields,
        updateTime: document.updateTime,
      });
      await commitProfileProjection(db, projection, nowMs);
      return "projected";
    } catch (error) {
      if (error instanceof ProfileProjectionValidationError) {
        await commitProfileProjectionFailure(
          db,
          profileId,
          parseFirestoreUpdateTime(document.updateTime),
          nowMs,
        );
      }
      throw error;
    }
  }

  const state = (await readProfileReconciliationState(db, [profileId])).get(
    profileId,
  );
  if (!state || (state.profile?.isDeleted && !state.failureVersion)) {
    return "stale";
  }
  const sourceVersion = latestKnownVersion(state);
  if (!sourceVersion) {
    return "stale";
  }
  await commitProfileDeletion(
    db,
    profileId,
    sourceVersion,
    nowMs,
    state.profile?.sourceVersion ?? null,
  );
  return "deleted";
}

export async function processProfileReadProjectionTask(
  task: ProfileReadProjectionTask,
  env: Env,
  dependencies: ProfileReadProjectionDependencies = {},
): Promise<ProjectionStatus> {
  const parsed = parseProfileReadProjectionTask(task);
  if (!parsed) {
    throw new TypeError("invalid-profile-read-projection-task");
  }
  const firestore = dependencies.firestore || createAuthFirestoreClient(env);
  const name = authDocumentName(PROFILE_COLLECTION, parsed.profileId);
  const documents = await firestore.batchGet([name]);
  if (!documents.has(name)) {
    throw new TypeError("missing-profile-read-projection-source");
  }
  return processProfileDocument(
    parsed.profileId,
    documents.get(name) || null,
    dependencies.db || env.PROFILE_DB,
    (dependencies.now || Date.now)(),
  );
}

function acknowledge(messages: Message<unknown>[]): void {
  for (const message of messages) {
    message.ack();
  }
}

function failureClassification(error: unknown): string {
  return error instanceof ProfileProjectionValidationError
    ? "invalid_projection"
    : "projection_unavailable";
}

export async function handleProfileReadProjectionMessage(
  message: Message<unknown>,
  env: Env,
  dependencies: ProfileReadProjectionDependencies = {},
): Promise<void> {
  const logger = dependencies.logger || console;
  const task = parseProfileReadProjectionTask(message.body);
  if (!task) {
    message.ack();
    logger.error(
      JSON.stringify({ event: "profile_read_projection_invalid_message" }),
    );
    return;
  }
  try {
    const status = await processProfileReadProjectionTask(
      task,
      env,
      dependencies,
    );
    message.ack();
    logger.info(
      JSON.stringify({ event: "profile_read_projection_processed", status }),
    );
  } catch (error) {
    message.ack();
    logger.error(
      JSON.stringify({
        event: "profile_read_projection_failed",
        classification: failureClassification(error),
      }),
    );
  }
}

export async function handleProfileReadProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  dependencies: ProfileReadProjectionDependencies = {},
): Promise<void> {
  const logger = dependencies.logger || console;
  const messagesByProfile = new Map<string, Message<unknown>[]>();
  for (const message of batch.messages) {
    const task = parseProfileReadProjectionTask(message.body);
    if (!task) {
      message.ack();
      logger.error(
        JSON.stringify({ event: "profile_read_projection_invalid_message" }),
      );
      continue;
    }
    const messages = messagesByProfile.get(task.profileId) || [];
    messages.push(message);
    messagesByProfile.set(task.profileId, messages);
  }
  if (messagesByProfile.size === 0) {
    return;
  }

  const firestore = dependencies.firestore || createAuthFirestoreClient(env);
  const profileNames = Array.from(messagesByProfile.keys(), (profileId) =>
    authDocumentName(PROFILE_COLLECTION, profileId),
  );
  let documents: Map<string, AuthFirestoreDocument | null>;
  try {
    documents = await firestore.batchGet(profileNames);
  } catch {
    for (const messages of messagesByProfile.values()) {
      acknowledge(messages);
    }
    logger.error(
      JSON.stringify({
        event: "profile_read_projection_batch_read_failed",
        count: messagesByProfile.size,
      }),
    );
    return;
  }

  const db = dependencies.db || env.PROFILE_DB;
  const now = dependencies.now || Date.now;
  for (const [profileId, messages] of messagesByProfile) {
    const name = authDocumentName(PROFILE_COLLECTION, profileId);
    try {
      if (!documents.has(name)) {
        throw new TypeError("missing-profile-read-projection-source");
      }
      const status = await processProfileDocument(
        profileId,
        documents.get(name) || null,
        db,
        now(),
      );
      acknowledge(messages);
      logger.info(
        JSON.stringify({
          event: "profile_read_projection_processed",
          status,
          count: messages.length,
        }),
      );
    } catch (error) {
      acknowledge(messages);
      logger.error(
        JSON.stringify({
          event: "profile_read_projection_failed",
          classification: failureClassification(error),
          count: messages.length,
        }),
      );
    }
  }
}

export async function enqueueProfileReadProjection(
  env: Env,
  profileId: string,
): Promise<void> {
  await env.PROFILE_PROJECTION_QUEUE.send(createTask(profileId));
}

async function enqueueProfileReadProjectionBatch(
  env: Env,
  profileIds: string[],
): Promise<void> {
  await env.PROFILE_PROJECTION_QUEUE.sendBatch(
    profileIds.map((profileId) => ({ body: createTask(profileId) })),
  );
}

export function scheduleProfileReadProjection(
  ctx: WorkerExecutionContext,
  env: Env,
  profileId: string,
  logger: Pick<Console, "error"> = console,
): void {
  ctx.waitUntil(
    enqueueProfileReadProjection(env, profileId).catch(() => {
      logger.error(
        JSON.stringify({ event: "profile_read_projection_enqueue_failed" }),
      );
    }),
  );
}

async function readCanonicalProfileVersions(
  firestore: Pick<AuthFirestoreClient, "listPage">,
): Promise<Map<string, FirestoreUpdateVersion>> {
  const profiles = new Map<string, FirestoreUpdateVersion>();
  const pageTokens = new Set<string>();
  let pageToken = "";
  do {
    if (pageTokens.has(pageToken)) {
      throw new TypeError("repeated-profile-reconciliation-page");
    }
    pageTokens.add(pageToken);
    const page = await firestore.listPage(
      "",
      PROFILE_COLLECTION,
      pageToken,
      RECONCILIATION_FIELD_MASK,
    );
    for (const document of page.documents) {
      if (profiles.has(document.id)) {
        throw new TypeError("invalid-profile-reconciliation-source");
      }
      createTask(document.id);
      profiles.set(document.id, parseFirestoreUpdateTime(document.updateTime));
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return profiles;
}

function profilesNeedingReconciliation(
  canonical: Map<string, FirestoreUpdateVersion>,
  projected: Map<string, ProfileReconciliationState>,
): string[] {
  const profileIds = new Set<string>();
  for (const [profileId, sourceVersion] of canonical) {
    const state = projected.get(profileId);
    if (!state) {
      profileIds.add(profileId);
      continue;
    }
    if (state.failureVersion) {
      if (
        !sameVersion(state.failureVersion, sourceVersion) ||
        !isCurrentProjectionSchema(
          state.failureVersion,
          state.failureSchemaVersion,
          state.failureSchemaSourceVersion,
        )
      ) {
        profileIds.add(profileId);
      }
      continue;
    }
    if (
      !state.profile ||
      !sameVersion(state.profile.sourceVersion, sourceVersion) ||
      !isCurrentProjectionSchema(
        state.profile.sourceVersion,
        state.profile.schemaVersion,
        state.profile.schemaSourceVersion,
      )
    ) {
      profileIds.add(profileId);
    }
  }
  for (const [profileId, state] of projected) {
    if (
      !canonical.has(profileId) &&
      (state.failureVersion !== null || state.profile?.isDeleted === false)
    ) {
      profileIds.add(profileId);
    }
  }
  return Array.from(profileIds).sort();
}

export async function reconcileProfileReadProjections(
  env: Env,
  dependencies: ProfileReadProjectionDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  try {
    const firestore = dependencies.firestore || createAuthFirestoreClient(env);
    const canonical = await readCanonicalProfileVersions(firestore);
    const projected = await readProfileReconciliationState(
      dependencies.db || env.PROFILE_DB,
    );
    const profileIds = profilesNeedingReconciliation(canonical, projected);
    for (let index = 0; index < profileIds.length; index += QUEUE_BATCH_SIZE) {
      await enqueueProfileReadProjectionBatch(
        env,
        profileIds.slice(index, index + QUEUE_BATCH_SIZE),
      );
    }
    logger.info(
      JSON.stringify({
        event: "profile_read_projection_reconciliation",
        canonicalCount: canonical.size,
        projectedCount: projected.size,
        enqueued: profileIds.length,
      }),
    );
    return profileIds.length;
  } catch (error) {
    logger.error(
      JSON.stringify({
        event: "profile_read_projection_reconciliation_failed",
      }),
    );
    throw error;
  }
}
