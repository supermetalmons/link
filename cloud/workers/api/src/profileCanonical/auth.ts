import { type AuthMethodKey, AUTH_METHODS } from "@mons/shared/auth";
import { canonicalProfileRedirectCte } from "./redirectSql.ts";
import {
  type CanonicalLoginOwnerSnapshot,
  type LoginOwnerRow,
  CanonicalProfileCorruption,
  type CanonicalAuthMethodSnapshot,
  type AuthMethodRow,
  type CanonicalAuthOperationSnapshot,
  type AuthOperationRow,
  type CanonicalAuthRecoverySnapshot,
  type RecoveryRow,
  type CanonicalProfileSnapshot,
  type CanonicalPublicProfileSnapshot,
  type CanonicalProfileAggregateSnapshot,
  CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
  type CanonicalOwnershipResolutionRow,
  type ParsedCanonicalOwnershipResolution,
  type CanonicalOwnershipProfileRow,
  type CanonicalProfileOwnershipProfileSnapshot,
  type CanonicalOwnershipOwnerRow,
  type CanonicalProfileOwnershipQuery,
  type CanonicalProfileOwnershipSnapshot,
  type CanonicalResolvedProfileAggregateSnapshot,
  type CanonicalAuthMethodValue,
  type D1Value,
  type CanonicalAuthOperationValue,
  type CanonicalCooldownValue,
  type CanonicalAuthRecoveryValue,
} from "./types.ts";
import {
  record,
  nonempty,
  safeInteger,
  authMethod,
  nullableString,
  nullableSafeInteger,
  parseNullableObjectJson,
  parseStringArrayJson,
} from "./validation.ts";
import {
  CANONICAL_PUBLIC_PROFILE_COLUMNS,
  resolveCanonicalProfile,
  resolveCanonicalPublicProfile,
  parseCanonicalPublicProfileRow,
  parseCanonicalProfileRow,
  parseCanonicalMergeTargetRow,
} from "./profiles.ts";

const CANONICAL_OWNERSHIP_PROFILE_COLUMNS = [
  ...CANONICAL_PUBLIC_PROFILE_COLUMNS.split(",").map(
    (column) => `profile.${column.trim()}`,
  ),
  "profile.revision",
].join(", ");

export function parseCanonicalLoginOwnerRow(
  value: unknown,
): CanonicalLoginOwnerSnapshot {
  const row = record(value) as LoginOwnerRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  return {
    loginUid: nonempty(row.login_uid),
    profileId: nonempty(row.profile_id),
    revision: safeInteger(row.revision, 1),
    createdAtMs: safeInteger(row.created_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
  };
}

export function parseCanonicalAuthMethodRow(
  value: unknown,
): CanonicalAuthMethodSnapshot {
  const row = record(value) as AuthMethodRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  const method = authMethod(row.method);
  if (
    (method !== "apple" && row.apple_email_masked !== null) ||
    (method !== "x" && row.x_username !== null)
  ) {
    throw new CanonicalProfileCorruption();
  }
  const consentSource = row.consent_source;
  if (
    consentSource !== null &&
    consentSource !== "signin" &&
    consentSource !== "settings"
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    method,
    normalizedValue: nonempty(row.normalized_value),
    profileId: nonempty(row.profile_id),
    rawValue: nonempty(row.raw_value),
    appleEmailMasked: nullableString(row.apple_email_masked),
    xUsername: nullableString(row.x_username),
    linkedAtMs: nullableSafeInteger(row.linked_at_ms),
    consentAtMs: nullableSafeInteger(row.consent_at_ms),
    consentSource,
    revision: safeInteger(row.revision, 1),
    createdAtMs: safeInteger(row.created_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
  };
}

export function parseCanonicalAuthOperationRow(
  value: unknown,
): CanonicalAuthOperationSnapshot {
  const row = record(value) as AuthOperationRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  if (
    (row.kind !== "unlink" && row.kind !== "verify") ||
    (row.status !== "started" &&
      row.status !== "failed" &&
      row.status !== "success")
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    operationId: nonempty(row.operation_id),
    kind: row.kind,
    method: authMethod(row.method),
    loginUid: nonempty(row.login_uid),
    status: row.status,
    meta: parseNullableObjectJson(row.meta_json),
    result: parseNullableObjectJson(row.result_json),
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    startedAtMs: safeInteger(row.started_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
    revision: safeInteger(row.revision, 1),
  };
}

export function parseCanonicalAuthRecoveryRow(
  value: unknown,
): CanonicalAuthRecoverySnapshot {
  const row = record(value) as RecoveryRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  if (
    row.source_phase !== "prizes" &&
    row.source_phase !== "games" &&
    row.source_phase !== "finalize"
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    profileId: nonempty(row.profile_id),
    loginUids: parseStringArrayJson(row.login_uids_json),
    sourceProfileIds: parseStringArrayJson(row.source_profile_ids_json),
    sourcePhase: row.source_phase,
    prizeCursor: nullableString(row.prize_cursor),
    phaseStartedAtMs: safeInteger(row.phase_started_at_ms),
    lastEnqueuedAtMs: safeInteger(row.last_enqueued_at_ms),
    createdAtMs: safeInteger(row.created_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
    revision: safeInteger(row.revision, 1),
  };
}

export async function readCanonicalLoginOwner(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalLoginOwnerSnapshot | null> {
  const row = await db
    .prepare("SELECT * FROM profile_login_owners WHERE login_uid = ?")
    .bind(loginUid)
    .first<LoginOwnerRow>();
  return row ? parseCanonicalLoginOwnerRow(row) : null;
}

export async function readCanonicalAuthMethod(
  db: D1Database,
  method: AuthMethodKey,
  normalizedValue: string,
): Promise<CanonicalAuthMethodSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT * FROM profile_auth_methods
       WHERE method = ? AND normalized_value = ?`,
    )
    .bind(method, normalizedValue)
    .first<AuthMethodRow>();
  return row ? parseCanonicalAuthMethodRow(row) : null;
}

export async function readCanonicalProfileByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalProfileSnapshot | null> {
  const owner = await readCanonicalLoginOwner(db, loginUid);
  return owner ? resolveCanonicalProfile(db, owner.profileId) : null;
}

export async function readCanonicalPublicProfileByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalPublicProfileSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT ${CANONICAL_PUBLIC_PROFILE_COLUMNS.split(",")
        .map((column) => `profile.${column.trim()}`)
        .join(", ")},
              owner.login_uid AS lookup_login_uid,
              owner.profile_id AS lookup_profile_id,
              owner.revision AS lookup_revision,
              owner.created_at_ms AS lookup_created_at_ms,
              owner.updated_at_ms AS lookup_updated_at_ms,
              mapping.source_profile_id AS lookup_merge_source_profile_id
       FROM profile_login_owners AS owner
       LEFT JOIN profile_records AS profile
         ON profile.profile_id = owner.profile_id
       LEFT JOIN profile_merge_targets AS mapping
         ON mapping.source_profile_id = owner.profile_id
       WHERE owner.login_uid = ?`,
    )
    .bind(loginUid)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const owner = parseCanonicalLoginOwnerRow({
    login_uid: row.lookup_login_uid,
    profile_id: row.lookup_profile_id,
    revision: row.lookup_revision,
    created_at_ms: row.lookup_created_at_ms,
    updated_at_ms: row.lookup_updated_at_ms,
  });
  if (row.lookup_merge_source_profile_id !== null) {
    return resolveCanonicalPublicProfile(db, owner.profileId);
  }
  if (row.profile_id === null) return null;
  const profile = parseCanonicalPublicProfileRow(row);
  if (profile.state === "retiring") throw new CanonicalProfileCorruption();
  return profile;
}

function canonicalProfileAggregateStatements(
  db: D1Database,
  source: { profileId: string } | { loginUid: string },
): D1PreparedStatement[] {
  const profileIdSql =
    "profileId" in source
      ? "?"
      : "(SELECT profile_id FROM profile_login_owners WHERE login_uid = ?)";
  const key = "profileId" in source ? source.profileId : source.loginUid;
  return [
    `SELECT * FROM profile_records WHERE profile_id = ${profileIdSql}`,
    `SELECT * FROM profile_login_owners
     WHERE profile_id = ${profileIdSql} ORDER BY login_uid ASC`,
    `SELECT * FROM profile_auth_methods
     WHERE profile_id = ${profileIdSql} ORDER BY method ASC`,
    `SELECT opponent_profile_id FROM profile_february_opponents
     WHERE profile_id = ${profileIdSql} ORDER BY opponent_profile_id ASC`,
    `SELECT source_profile_id, target_profile_id, merged_at_ms, op_id
     FROM profile_merge_targets WHERE source_profile_id = ${profileIdSql}`,
    `SELECT * FROM profile_auth_recovery_jobs WHERE profile_id = ${profileIdSql}`,
  ].map((query) => db.prepare(query).bind(key));
}

function parseCanonicalProfileAggregateResults(
  results: readonly D1Result[],
): CanonicalProfileAggregateSnapshot {
  const profileRow = results[0].results[0];
  const mergeRow = results[4].results[0];
  const recoveryRow = results[5].results[0];
  return {
    profile: profileRow ? parseCanonicalProfileRow(profileRow) : null,
    loginOwners: results[1].results.map(parseCanonicalLoginOwnerRow),
    authMethods: results[2].results.map(parseCanonicalAuthMethodRow),
    februaryOpponentProfileIds: results[3].results.map((entry) =>
      nonempty(record(entry)?.opponent_profile_id),
    ),
    mergeTarget: mergeRow ? parseCanonicalMergeTargetRow(mergeRow) : null,
    recovery: recoveryRow ? parseCanonicalAuthRecoveryRow(recoveryRow) : null,
  };
}

export async function readCanonicalProfileAggregate(
  db: D1Database,
  profileId: string,
): Promise<CanonicalProfileAggregateSnapshot> {
  const [aggregate] = await readCanonicalProfileAggregates(db, [profileId]);
  return aggregate;
}

export async function readCanonicalProfileAggregates(
  db: D1Database,
  profileIds: readonly string[],
): Promise<CanonicalProfileAggregateSnapshot[]> {
  if (profileIds.length === 0) return [];
  const groups = profileIds.map((profileId) =>
    canonicalProfileAggregateStatements(db, { profileId }),
  );
  const results = await db.batch(groups.flat());
  let offset = 0;
  return groups.map((statements) => {
    const aggregate = parseCanonicalProfileAggregateResults(
      results.slice(offset, offset + statements.length),
    );
    offset += statements.length;
    return aggregate;
  });
}

export async function readCanonicalAuthRecoveryJob(
  db: D1Database,
  profileId: string,
): Promise<CanonicalAuthRecoverySnapshot | null> {
  const row = await db
    .prepare("SELECT * FROM profile_auth_recovery_jobs WHERE profile_id = ?")
    .bind(profileId)
    .first();
  return row === null ? null : parseCanonicalAuthRecoveryRow(row);
}

function assertCanonicalAggregateTopology(
  profileId: string,
  aggregate: CanonicalProfileAggregateSnapshot,
): void {
  const profile = aggregate.profile;
  if (!profile) {
    if (
      aggregate.loginOwners.length !== 0 ||
      aggregate.authMethods.length !== 0 ||
      aggregate.februaryOpponentProfileIds.length !== 0 ||
      aggregate.recovery !== null
    ) {
      throw new CanonicalProfileCorruption();
    }
    return;
  }
  if (profile.profileId !== profileId) {
    throw new CanonicalProfileCorruption();
  }
  if (profile.state === "active") {
    if (
      profile.mergedIntoProfileId !== null ||
      aggregate.mergeTarget !== null
    ) {
      throw new CanonicalProfileCorruption();
    }
    return;
  }
  if (
    !aggregate.mergeTarget ||
    aggregate.mergeTarget.sourceProfileId !== profileId ||
    aggregate.mergeTarget.targetProfileId !== profile.mergedIntoProfileId
  ) {
    throw new CanonicalProfileCorruption();
  }
}

export async function readCanonicalProfileAggregateSnapshot(
  db: D1Database,
  profileId: string,
): Promise<CanonicalProfileAggregateSnapshot> {
  const [aggregate] = await readCanonicalProfileAggregateSnapshots(db, [
    profileId,
  ]);
  return aggregate;
}

export async function readCanonicalProfileAggregateSnapshots(
  db: D1Database,
  profileIds: readonly string[],
): Promise<CanonicalProfileAggregateSnapshot[]> {
  const aggregates = await readCanonicalProfileAggregates(db, profileIds);
  aggregates.forEach((aggregate, index) =>
    assertCanonicalAggregateTopology(profileIds[index], aggregate),
  );
  return aggregates;
}

function canonicalOwnershipInputs(
  values: readonly string[],
  errorCode: string,
): string[] {
  if (values.some((value) => typeof value !== "string" || value === "")) {
    throw new TypeError(errorCode);
  }
  return [...new Set(values)];
}

function canonicalOwnershipResolutionStatement(
  db: D1Database,
  requestKeys: readonly string[],
  kind: "login" | "profile",
): D1PreparedStatement {
  return db
    .prepare(
      `${canonicalProfileRedirectCte(kind)}
       SELECT
         roots.request_index,
         roots.request_key,
         roots.root_profile_id,
         roots.owner_revision,
         roots.owner_created_at_ms,
         roots.owner_updated_at_ms,
         chain.chain_profile_id,
         chain.depth,
         profile.revision AS profile_revision,
         profile.state AS profile_state,
         profile.merged_into_profile_id,
         target.target_profile_id AS merge_target_profile_id,
         target.merged_at_ms AS merge_target_merged_at_ms,
         target.op_id AS merge_target_op_id
       FROM roots
       LEFT JOIN chain
         ON chain.request_index = roots.request_index
       LEFT JOIN profile_records profile
         ON profile.profile_id = chain.chain_profile_id
       LEFT JOIN profile_merge_targets target
         ON target.source_profile_id = chain.chain_profile_id
       ORDER BY roots.request_index ASC, chain.depth ASC`,
    )
    .bind(
      JSON.stringify(requestKeys),
      CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT + 1,
    );
}

function parseCanonicalOwnershipResolutions(
  rows: readonly CanonicalOwnershipResolutionRow[],
  requestKeys: readonly string[],
  kind: "login" | "profile",
): ParsedCanonicalOwnershipResolution[] {
  const grouped = requestKeys.map(
    () => [] as CanonicalOwnershipResolutionRow[],
  );
  for (const row of rows) {
    const requestIndex = safeInteger(row.request_index);
    if (
      requestIndex >= requestKeys.length ||
      row.request_key !== requestKeys[requestIndex]
    ) {
      throw new CanonicalProfileCorruption();
    }
    grouped[requestIndex].push(row);
  }
  return grouped.map((group, requestIndex) => {
    if (group.length === 0) throw new CanonicalProfileCorruption();
    const requestKey = requestKeys[requestIndex];
    const rootProfileId = nullableString(group[0].root_profile_id);
    if (!rootProfileId) {
      if (
        kind !== "login" ||
        group.length !== 1 ||
        group[0].owner_revision !== null ||
        group[0].owner_created_at_ms !== null ||
        group[0].owner_updated_at_ms !== null ||
        group[0].chain_profile_id !== null ||
        group[0].depth !== null
      ) {
        throw new CanonicalProfileCorruption();
      }
      return null;
    }
    const owner =
      kind === "login"
        ? parseCanonicalLoginOwnerRow({
            login_uid: requestKey,
            profile_id: rootProfileId,
            revision: group[0].owner_revision,
            created_at_ms: group[0].owner_created_at_ms,
            updated_at_ms: group[0].owner_updated_at_ms,
          })
        : null;
    if (
      kind === "profile" &&
      (group[0].owner_revision !== null ||
        group[0].owner_created_at_ms !== null ||
        group[0].owner_updated_at_ms !== null)
    ) {
      throw new CanonicalProfileCorruption();
    }
    const visited = new Set<string>();
    let canonicalProfileId: string | null = null;
    for (let index = 0; index < group.length; index += 1) {
      const row = group[index];
      if (
        row.request_key !== requestKey ||
        row.root_profile_id !== rootProfileId ||
        row.owner_revision !== group[0].owner_revision ||
        row.owner_created_at_ms !== group[0].owner_created_at_ms ||
        row.owner_updated_at_ms !== group[0].owner_updated_at_ms
      ) {
        throw new CanonicalProfileCorruption();
      }
      const depth = safeInteger(row.depth);
      const profileId = nonempty(row.chain_profile_id);
      if (
        depth !== index ||
        depth > CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT ||
        visited.has(profileId)
      ) {
        throw new CanonicalProfileCorruption();
      }
      visited.add(profileId);
      const profileState = row.profile_state;
      const hasProfile = row.profile_revision !== null;
      if (hasProfile !== (profileState !== null)) {
        throw new CanonicalProfileCorruption();
      }
      const mergedIntoProfileId = nullableString(row.merged_into_profile_id);
      const mergeTargetProfileId = nullableString(row.merge_target_profile_id);
      if (!hasProfile) {
        if (mergedIntoProfileId !== null) {
          throw new CanonicalProfileCorruption();
        }
        if (!mergeTargetProfileId) {
          if (
            index === 0 &&
            kind === "profile" &&
            row.merge_target_merged_at_ms === null &&
            row.merge_target_op_id === null &&
            group.length === 1
          ) {
            return null;
          }
          throw new CanonicalProfileCorruption();
        }
        safeInteger(row.merge_target_merged_at_ms);
        nullableString(row.merge_target_op_id);
        if (
          index + 1 >= group.length ||
          group[index + 1].chain_profile_id !== mergeTargetProfileId
        ) {
          throw new CanonicalProfileCorruption();
        }
        continue;
      }
      if (profileState !== "active" && profileState !== "retiring") {
        throw new CanonicalProfileCorruption();
      }
      safeInteger(row.profile_revision, 1);
      if (mergeTargetProfileId) {
        safeInteger(row.merge_target_merged_at_ms);
        nullableString(row.merge_target_op_id);
        if (
          profileState !== "retiring" ||
          mergedIntoProfileId !== mergeTargetProfileId ||
          index + 1 >= group.length ||
          group[index + 1].chain_profile_id !== mergeTargetProfileId
        ) {
          throw new CanonicalProfileCorruption();
        }
        continue;
      }
      if (
        row.merge_target_merged_at_ms !== null ||
        row.merge_target_op_id !== null ||
        profileState !== "active" ||
        mergedIntoProfileId !== null ||
        index + 1 !== group.length
      ) {
        throw new CanonicalProfileCorruption();
      }
      canonicalProfileId = profileId;
    }
    if (!canonicalProfileId) throw new CanonicalProfileCorruption();
    return { owner, profileId: canonicalProfileId };
  });
}

function canonicalOwnershipTerminalsCte(): string {
  return `WITH RECURSIVE
          requested_login(request_key) AS (
            SELECT CAST(value AS TEXT) FROM json_each(?)
          ),
          requested_profile(request_key) AS (
            SELECT CAST(value AS TEXT) FROM json_each(?)
          ),
          roots(root_profile_id) AS (
            SELECT owner.profile_id
            FROM requested_login requested
            JOIN profile_login_owners owner
              ON owner.login_uid = requested.request_key
            UNION
            SELECT request_key FROM requested_profile
          ),
          chain(chain_profile_id, depth) AS (
            SELECT root_profile_id, 0 FROM roots
            UNION ALL
            SELECT target.target_profile_id, chain.depth + 1
            FROM chain
            JOIN profile_merge_targets target
              ON target.source_profile_id = chain.chain_profile_id
            WHERE chain.depth <= ?
          ),
          terminals(profile_id) AS (
            SELECT DISTINCT chain.chain_profile_id
            FROM chain
            LEFT JOIN profile_merge_targets target
              ON target.source_profile_id = chain.chain_profile_id
            WHERE target.source_profile_id IS NULL
          )`;
}

function bindCanonicalOwnershipTerminals(
  statement: D1PreparedStatement,
  loginUids: readonly string[],
  profileIds: readonly string[],
): D1PreparedStatement {
  return statement.bind(
    JSON.stringify(loginUids),
    JSON.stringify(profileIds),
    CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
  );
}

function canonicalOwnershipProfilesStatement(
  db: D1Database,
  loginUids: readonly string[],
  profileIds: readonly string[],
): D1PreparedStatement {
  return bindCanonicalOwnershipTerminals(
    db.prepare(
      `${canonicalOwnershipTerminalsCte()}
       SELECT ${CANONICAL_OWNERSHIP_PROFILE_COLUMNS}
       FROM terminals
       JOIN profile_records profile ON profile.profile_id = terminals.profile_id
       ORDER BY profile.profile_id ASC`,
    ),
    loginUids,
    profileIds,
  );
}

function canonicalOwnershipOwnersStatement(
  db: D1Database,
  loginUids: readonly string[],
  profileIds: readonly string[],
): D1PreparedStatement {
  return bindCanonicalOwnershipTerminals(
    db.prepare(
      `${canonicalOwnershipTerminalsCte()}
       SELECT
         owner.login_uid AS owner_login_uid,
         owner.profile_id AS owner_profile_id,
         owner.revision AS owner_revision,
         owner.created_at_ms AS owner_created_at_ms,
         owner.updated_at_ms AS owner_updated_at_ms
       FROM terminals
       JOIN profile_login_owners owner
         ON owner.profile_id = terminals.profile_id
       ORDER BY owner.profile_id ASC, owner.login_uid ASC`,
    ),
    loginUids,
    profileIds,
  );
}

function parseCanonicalOwnershipProfiles(
  rows: readonly CanonicalOwnershipProfileRow[],
): Map<string, CanonicalProfileOwnershipProfileSnapshot> {
  const profileById = new Map<
    string,
    CanonicalProfileOwnershipProfileSnapshot
  >();
  for (const row of rows) {
    const profile = {
      ...parseCanonicalPublicProfileRow(row),
      revision: safeInteger(row.revision, 1),
    };
    if (
      profile.state !== "active" ||
      profile.mergedIntoProfileId !== null ||
      profileById.has(profile.profileId)
    ) {
      throw new CanonicalProfileCorruption();
    }
    profileById.set(profile.profileId, profile);
  }
  return profileById;
}

function parseCanonicalOwnershipOwners(
  rows: readonly CanonicalOwnershipOwnerRow[],
  profileById: ReadonlyMap<string, CanonicalProfileOwnershipProfileSnapshot>,
): {
  aggregateOwnerByUid: Map<string, CanonicalLoginOwnerSnapshot>;
  loginOwnersByProfileId: Map<string, readonly CanonicalLoginOwnerSnapshot[]>;
} {
  const mutableOwners = new Map<string, CanonicalLoginOwnerSnapshot[]>();
  for (const profileId of profileById.keys()) {
    mutableOwners.set(profileId, []);
  }
  const aggregateOwnerByUid = new Map<string, CanonicalLoginOwnerSnapshot>();
  for (const row of rows) {
    const owner = parseCanonicalLoginOwnerRow({
      login_uid: row.owner_login_uid,
      profile_id: row.owner_profile_id,
      revision: row.owner_revision,
      created_at_ms: row.owner_created_at_ms,
      updated_at_ms: row.owner_updated_at_ms,
    });
    const owners = mutableOwners.get(owner.profileId);
    if (!owners || aggregateOwnerByUid.has(owner.loginUid)) {
      throw new CanonicalProfileCorruption();
    }
    aggregateOwnerByUid.set(owner.loginUid, owner);
    owners.push(owner);
  }
  const loginOwnersByProfileId = new Map<
    string,
    readonly CanonicalLoginOwnerSnapshot[]
  >();
  for (const [profileId, owners] of mutableOwners) {
    loginOwnersByProfileId.set(profileId, Object.freeze(owners));
  }
  return { aggregateOwnerByUid, loginOwnersByProfileId };
}

export async function readCanonicalProfileIdMap(
  db: D1Database,
  profileIds: readonly string[],
): Promise<ReadonlyMap<string, string | null>> {
  const requestKeys = canonicalOwnershipInputs(
    profileIds,
    "invalid-canonical-profile-ownership-input",
  );
  if (requestKeys.length === 0) return new Map();
  const { results } = await canonicalOwnershipResolutionStatement(
    db,
    requestKeys,
    "profile",
  ).all<CanonicalOwnershipResolutionRow>();
  const resolutions = parseCanonicalOwnershipResolutions(
    results,
    requestKeys,
    "profile",
  );
  return new Map(
    requestKeys.map((profileId, index) => [
      profileId,
      resolutions[index]?.profileId ?? null,
    ]),
  );
}

export async function readCanonicalProfileOwnershipSnapshot(
  db: D1Database,
  query: CanonicalProfileOwnershipQuery,
): Promise<CanonicalProfileOwnershipSnapshot> {
  const loginUids = canonicalOwnershipInputs(
    query.loginUids,
    "invalid-canonical-login-ownership-input",
  );
  const profileIds = canonicalOwnershipInputs(
    query.profileIds,
    "invalid-canonical-profile-ownership-input",
  );
  if (loginUids.length === 0 && profileIds.length === 0) {
    return Object.freeze({
      canonicalProfileIdByProfileId: new Map(),
      loginOwnerByUid: new Map(),
      loginOwnersByProfileId: new Map(),
      profileById: new Map(),
    });
  }
  const results = await db.batch<
    | CanonicalOwnershipOwnerRow
    | CanonicalOwnershipProfileRow
    | CanonicalOwnershipResolutionRow
  >([
    canonicalOwnershipResolutionStatement(db, loginUids, "login"),
    canonicalOwnershipResolutionStatement(db, profileIds, "profile"),
    canonicalOwnershipProfilesStatement(db, loginUids, profileIds),
    canonicalOwnershipOwnersStatement(db, loginUids, profileIds),
  ]);
  const loginResolutions = parseCanonicalOwnershipResolutions(
    results[0].results as CanonicalOwnershipResolutionRow[],
    loginUids,
    "login",
  );
  const profileResolutions = parseCanonicalOwnershipResolutions(
    results[1].results as CanonicalOwnershipResolutionRow[],
    profileIds,
    "profile",
  );
  const profileById = parseCanonicalOwnershipProfiles(
    results[2].results as CanonicalOwnershipProfileRow[],
  );
  const { aggregateOwnerByUid, loginOwnersByProfileId } =
    parseCanonicalOwnershipOwners(
      results[3].results as CanonicalOwnershipOwnerRow[],
      profileById,
    );
  const canonicalProfileIds = new Set<string>();
  const loginOwnerByUid = new Map<
    string,
    Readonly<{ profileId: string; revision: number }> | null
  >();
  for (let index = 0; index < loginUids.length; index += 1) {
    const loginUid = loginUids[index];
    const resolution = loginResolutions[index];
    if (!resolution) {
      loginOwnerByUid.set(loginUid, null);
      continue;
    }
    const owner = resolution.owner;
    if (!owner || owner.profileId !== resolution.profileId) {
      throw new CanonicalProfileCorruption();
    }
    const aggregateOwner = aggregateOwnerByUid.get(loginUid);
    if (
      !aggregateOwner ||
      aggregateOwner.profileId !== resolution.profileId ||
      aggregateOwner.revision !== owner.revision
    ) {
      throw new CanonicalProfileCorruption();
    }
    canonicalProfileIds.add(resolution.profileId);
    loginOwnerByUid.set(
      loginUid,
      Object.freeze({
        profileId: resolution.profileId,
        revision: owner.revision,
      }),
    );
  }
  const canonicalProfileIdByProfileId = new Map<string, string | null>();
  for (let index = 0; index < profileIds.length; index += 1) {
    const profileId = profileIds[index];
    const resolution = profileResolutions[index];
    if (resolution?.owner) throw new CanonicalProfileCorruption();
    const canonicalProfileId = resolution?.profileId || null;
    canonicalProfileIdByProfileId.set(profileId, canonicalProfileId);
    if (canonicalProfileId) canonicalProfileIds.add(canonicalProfileId);
  }
  if (
    profileById.size !== canonicalProfileIds.size ||
    loginOwnersByProfileId.size !== canonicalProfileIds.size ||
    [...canonicalProfileIds].some(
      (profileId) =>
        !profileById.has(profileId) || !loginOwnersByProfileId.has(profileId),
    )
  ) {
    throw new CanonicalProfileCorruption();
  }
  return Object.freeze({
    canonicalProfileIdByProfileId,
    loginOwnerByUid,
    loginOwnersByProfileId,
    profileById,
  });
}

export async function readCanonicalProfileAggregateByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalResolvedProfileAggregateSnapshot | null> {
  const [ownerResult, ...aggregateResults] = await db.batch([
    db
      .prepare("SELECT * FROM profile_login_owners WHERE login_uid = ?")
      .bind(loginUid),
    ...canonicalProfileAggregateStatements(db, { loginUid }),
  ]);
  const ownerRow = ownerResult.results[0];
  if (!ownerRow) return null;
  const owner = parseCanonicalLoginOwnerRow(ownerRow);
  const aggregate = parseCanonicalProfileAggregateResults(aggregateResults);
  const profile = aggregate.profile;
  if (
    !profile ||
    profile.state !== "active" ||
    owner.loginUid !== loginUid ||
    owner.profileId !== profile.profileId
  ) {
    throw new CanonicalProfileCorruption();
  }
  assertCanonicalAggregateTopology(profile.profileId, aggregate);
  return { owner, aggregate };
}

export async function readCanonicalAuthOperation(
  db: D1Database,
  operationId: string,
): Promise<CanonicalAuthOperationSnapshot | null> {
  const row = await db
    .prepare("SELECT * FROM profile_auth_operations WHERE operation_id = ?")
    .bind(operationId)
    .first<AuthOperationRow>();
  return row ? parseCanonicalAuthOperationRow(row) : null;
}

export function authMethodParams(value: CanonicalAuthMethodValue): D1Value[] {
  if (
    !AUTH_METHODS.includes(value.method) ||
    !value.normalizedValue ||
    !value.profileId ||
    !value.rawValue
  ) {
    throw new TypeError("invalid-canonical-auth-method");
  }
  return [
    value.method,
    value.normalizedValue,
    value.profileId,
    value.rawValue,
    value.appleEmailMasked,
    value.xUsername,
    value.linkedAtMs,
    value.consentAtMs,
    value.consentSource,
    value.createdAtMs,
    value.updatedAtMs,
  ];
}

export function authOperationParams(
  value: CanonicalAuthOperationValue,
): D1Value[] {
  return [
    value.operationId,
    value.kind,
    value.method,
    value.loginUid,
    value.status,
    value.meta === null ? null : JSON.stringify(value.meta),
    value.result === null ? null : JSON.stringify(value.result),
    value.errorCode,
    value.errorMessage,
    value.startedAtMs,
    value.updatedAtMs,
  ];
}

export function cooldownParams(value: CanonicalCooldownValue): D1Value[] {
  return [
    value.profileId,
    value.method,
    value.scope,
    value.unlinkedByUid,
    value.cooldownMs,
    value.startedAtMs,
    value.retryAtMs,
    value.updatedAtMs,
  ];
}

export function recoveryParams(value: CanonicalAuthRecoveryValue): D1Value[] {
  return [
    value.profileId,
    JSON.stringify(value.loginUids),
    JSON.stringify(value.sourceProfileIds),
    value.sourcePhase,
    value.prizeCursor,
    value.phaseStartedAtMs,
    value.lastEnqueuedAtMs,
    value.createdAtMs,
    value.updatedAtMs,
  ];
}
