import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;
type MigrationPhase = "preview" | "adopt-d1" | "final" | "rollback";
type CoordinationAuthority = "uninitialized" | "rtdb" | "d1";

type MigrationOptions = {
  allowEmptySourceDigest?: string;
  expectedTimerDigest?: string;
  phase: MigrationPhase;
  project: string;
  sourceVersionId?: string;
};

type ApiDeployment = {
  versions: Array<{
    percentage: number;
    versionId: string;
  }>;
};

type ApiVersion = {
  declaredAuthority: "rtdb" | "d1" | null;
  versionId: string;
};

type GameplayCoordinationControl = {
  authority: CoordinationAuthority;
  generation: number;
  sourceCount: number | null;
  sourceDigest: string | null;
  sourceVersionId: string | null;
  transitionedAtMs: number;
};

type LegacyLease = {
  expiresAtMs: number;
  lockId: string;
  operationId: string;
  ownerId: string;
};

type TimerMarker = {
  matchId: string;
  playerId: string;
  timer: string;
  turnNumber: number;
};

type D1TimerMarker = TimerMarker & {
  opponentId: string | null;
  updatedAtMs: number;
};

type LegacySnapshot = {
  leases: LegacyLease[];
  timerMarkers: TimerMarker[];
};

type PersistedArtifacts = {
  paths: Readonly<Record<string, string>>;
};

type MigrationDependencies = {
  applyD1Transition(path: string): void;
  log(message: string): void;
  now(): number;
  persistArtifacts(input: {
    exportedAtMs: number;
    files: Readonly<Record<string, string>>;
    phase: MigrationPhase;
  }): PersistedArtifacts;
  readActiveD1Leases(nowMs: number): number;
  readApiDeployment(): ApiDeployment;
  readApiVersion(versionId: string): ApiVersion;
  readD1TimerMarkers(): D1TimerMarker[];
  readGameplayControl(): GameplayCoordinationControl | null;
  readLegacySnapshot(project: string): LegacySnapshot;
  readProfileControl(): string;
  setRtdbTimerMarkers(project: string, path: string): void;
  transitionGameplayControl(
    expected: GameplayCoordinationControl,
    next: GameplayCoordinationControl,
  ): void;
  wait(milliseconds: number): void;
};

const PROFILE_GAMES_DATABASE = "mons-link-profile-games";
const PROFILE_DATABASE = "mons-link-profiles";
const CANONICAL_FIREBASE_PROJECT = "mons-link";
const CANONICAL_FIREBASE_INSTANCE = "mons-link-default-rtdb";
const CONFIG_PATH = "cloud/workers/api/wrangler.jsonc";
const RELEASE_ENV_PATH = "cloud/workers/api/release.env";
const STABILITY_WAIT_MS = 5_000;
const FIREBASE_SOURCE_OVERRIDE_KEYS = new Set([
  "FIREBASE_CONFIG",
  "FIREBASE_DATABASE_EMULATOR_HOST",
  "FIREBASE_REALTIME_URL",
]);

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function objectRoot(value: unknown, message: string): JsonRecord {
  if (value === null) return {};
  const root = record(value);
  if (!root) throw new Error(message);
  return root;
}

function validKey(value: string): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return (
    bytes > 0 &&
    bytes <= 768 &&
    value.trim() === value &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) || 0;
      return code > 0x1f && code !== 0x7f && !".#$[]/".includes(character);
    })
  );
}

function safeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function safeNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function validWorkerVersionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function parseLegacyTimer(value: unknown): {
  targetTimestamp: number;
  turnNumber: number;
} | null {
  if (typeof value !== "string" || !/^\d+;\d+$/.test(value)) return null;
  const [turnNumber, targetTimestamp] = value.split(";").map(Number);
  return Number.isSafeInteger(turnNumber) &&
    turnNumber >= 0 &&
    Number.isSafeInteger(targetTimestamp) &&
    targetTimestamp > 0
    ? { turnNumber, targetTimestamp }
    : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareMarkers(left: TimerMarker, right: TimerMarker): number {
  return (
    compareText(left.playerId, right.playerId) ||
    compareText(left.matchId, right.matchId)
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .sort(compareText)
      .map((key) => [key, canonicalize(object[key])]),
  );
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function normalizeLegacySnapshot(input: {
  locks: unknown;
  timerStarts: unknown;
}): LegacySnapshot {
  const leases = Object.entries(
    objectRoot(input.locks, "invalid gameplay mutation lock export"),
  ).map(([lockId, raw]) => {
    const lease = record(raw);
    if (
      !validKey(lockId) ||
      !lease ||
      !hasExactKeys(lease, ["ownerId", "operationId", "expiresAtMs"]) ||
      typeof lease.ownerId !== "string" ||
      lease.ownerId.length === 0 ||
      typeof lease.operationId !== "string" ||
      lease.operationId.length === 0 ||
      !safeTimestamp(lease.expiresAtMs)
    ) {
      throw new Error("invalid gameplay mutation lock record");
    }
    return {
      lockId,
      ownerId: lease.ownerId,
      operationId: lease.operationId,
      expiresAtMs: lease.expiresAtMs,
    };
  });
  leases.sort((left, right) => compareText(left.lockId, right.lockId));

  const timerMarkers: TimerMarker[] = [];
  for (const [playerId, rawMatches] of Object.entries(
    objectRoot(input.timerStarts, "invalid match timer start export"),
  )) {
    if (!validKey(playerId)) {
      throw new Error("invalid match timer start record");
    }
    for (const [matchId, rawMarker] of Object.entries(
      objectRoot(rawMatches, "invalid match timer start player record"),
    )) {
      const marker = record(rawMarker);
      const parsed = parseLegacyTimer(marker?.timer);
      if (
        !validKey(matchId) ||
        !marker ||
        !hasExactKeys(marker, ["timer", "turnNumber"]) ||
        !parsed ||
        !safeNonnegativeInteger(marker.turnNumber) ||
        parsed.turnNumber !== marker.turnNumber
      ) {
        throw new Error("invalid match timer start record");
      }
      timerMarkers.push({
        playerId,
        matchId,
        timer: String(marker.timer),
        turnNumber: Number(marker.turnNumber),
      });
    }
  }
  timerMarkers.sort(compareMarkers);
  return { leases, timerMarkers };
}

function normalizeD1TimerMarkers(rows: readonly JsonRecord[]): D1TimerMarker[] {
  const seen = new Set<string>();
  const markers = rows.map((row) => {
    const playerId = row.player_id;
    const matchId = row.match_id;
    const timer = row.timer;
    const turnNumber = row.turn_number;
    const updatedAtMs = row.updated_at_ms;
    const opponentId = row.opponent_id;
    const parsed = parseLegacyTimer(timer);
    if (
      typeof playerId !== "string" ||
      !validKey(playerId) ||
      typeof matchId !== "string" ||
      !validKey(matchId) ||
      typeof timer !== "string" ||
      !parsed ||
      !safeNonnegativeInteger(turnNumber) ||
      parsed.turnNumber !== turnNumber ||
      !safeNonnegativeInteger(updatedAtMs) ||
      !(
        opponentId === null ||
        (typeof opponentId === "string" && validKey(opponentId))
      )
    ) {
      throw new Error("invalid D1 match timer start record");
    }
    const key = `${playerId}\u0000${matchId}`;
    if (seen.has(key)) {
      throw new Error("duplicate D1 match timer start record");
    }
    seen.add(key);
    return {
      playerId,
      matchId,
      timer,
      turnNumber: Number(turnNumber),
      updatedAtMs: Number(updatedAtMs),
      opponentId,
    };
  });
  return markers.sort(compareMarkers);
}

function normalizeGameplayControl(value: unknown): GameplayCoordinationControl {
  const control = record(value);
  const authority = control?.authority;
  const generation = control?.generation;
  const sourceDigest = control?.source_digest;
  const sourceCount = control?.source_count;
  const sourceVersionId = control?.source_version_id;
  const transitionedAtMs = control?.transitioned_at_ms;
  const emptyProvenance =
    sourceDigest === null && sourceCount === null && sourceVersionId === null;
  const completeProvenance =
    typeof sourceDigest === "string" &&
    validDigest(sourceDigest) &&
    safeNonnegativeInteger(sourceCount) &&
    typeof sourceVersionId === "string" &&
    validWorkerVersionId(sourceVersionId);
  const uninitialized =
    authority === "uninitialized" &&
    generation === 0 &&
    emptyProvenance &&
    transitionedAtMs === 0;
  const initialized =
    (authority === "rtdb" || authority === "d1") &&
    Number.isSafeInteger(generation) &&
    Number(generation) >= 1 &&
    completeProvenance &&
    safeNonnegativeInteger(transitionedAtMs);
  if (!uninitialized && !initialized) {
    throw new Error("invalid gameplay coordination control state");
  }
  return {
    authority,
    generation: Number(generation),
    sourceDigest: sourceDigest as string | null,
    sourceCount: sourceCount as number | null,
    sourceVersionId: sourceVersionId as string | null,
    transitionedAtMs: Number(transitionedAtMs),
  };
}

function logicalD1Markers(markers: readonly D1TimerMarker[]): TimerMarker[] {
  return markers.map(({ matchId, playerId, timer, turnNumber }) => ({
    matchId,
    playerId,
    timer,
    turnNumber,
  }));
}

function summarizeLegacySnapshot(snapshot: LegacySnapshot, nowMs: number) {
  return {
    locks: snapshot.leases.length,
    activeLocks: snapshot.leases.filter((lease) => lease.expiresAtMs > nowMs)
      .length,
    timerMarkers: snapshot.timerMarkers.length,
    snapshotDigest: digest(snapshot),
    timerDigest: digest(snapshot.timerMarkers),
  };
}

function assertStableLegacySnapshots(
  first: LegacySnapshot,
  second: LegacySnapshot,
): void {
  if (digest(first) !== digest(second)) {
    throw new Error("gameplay coordination RTDB snapshots changed");
  }
}

function assertNoActiveLegacyLeases(
  snapshot: LegacySnapshot,
  nowMs: number,
): void {
  if (snapshot.leases.some((lease) => lease.expiresAtMs > nowMs)) {
    throw new Error("gameplay coordination RTDB has active leases");
  }
}

function assertFrozenProfileControl(state: string): void {
  if (state !== "frozen") {
    throw new Error(
      "gameplay coordination migration requires frozen profile storage",
    );
  }
}

function assertNoActiveD1Leases(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("invalid active D1 gameplay lease count");
  }
  if (count !== 0) {
    throw new Error("gameplay coordination D1 has active leases");
  }
}

function normalizeApiDeployment(value: unknown): ApiDeployment {
  const deployment = record(value);
  if (!deployment || !Array.isArray(deployment.versions)) {
    throw new Error("invalid API deployment status");
  }
  const versions = deployment.versions.map((raw) => {
    const version = record(raw);
    const versionId = version?.version_id;
    const percentage = version?.percentage;
    if (
      typeof versionId !== "string" ||
      !validWorkerVersionId(versionId) ||
      typeof percentage !== "number" ||
      !Number.isFinite(percentage) ||
      percentage < 0 ||
      percentage > 100
    ) {
      throw new Error("invalid API deployment status");
    }
    return { versionId, percentage };
  });
  if (versions.length === 0) {
    throw new Error("invalid API deployment status");
  }
  return { versions };
}

function normalizeApiVersion(value: unknown): ApiVersion {
  const version = record(value);
  const versionId = version?.id;
  const resources = record(version?.resources);
  if (
    typeof versionId !== "string" ||
    !validWorkerVersionId(versionId) ||
    !resources ||
    !Array.isArray(resources.bindings)
  ) {
    throw new Error("invalid API version metadata");
  }
  const authorityBindings = resources.bindings.filter(
    (value) => record(value)?.name === "GAMEPLAY_COORDINATION_AUTHORITY",
  );
  if (authorityBindings.length === 0) {
    return { versionId, declaredAuthority: null };
  }
  const binding = record(authorityBindings[0]);
  if (
    authorityBindings.length !== 1 ||
    binding?.type !== "plain_text" ||
    (binding.text !== "rtdb" && binding.text !== "d1")
  ) {
    throw new Error("invalid gameplay coordination authority binding");
  }
  return { versionId, declaredAuthority: binding.text };
}

function assertSourceApiDeployment(
  sourceVersionId: string | undefined,
  deployment: ApiDeployment,
): void {
  if (!sourceVersionId || !validWorkerVersionId(sourceVersionId)) {
    throw new Error("mutating migration requires a source API Version ID");
  }
  if (
    deployment.versions.length !== 1 ||
    deployment.versions[0]?.versionId !== sourceVersionId ||
    deployment.versions[0]?.percentage !== 100
  ) {
    throw new Error("source API Version ID is not serving 100% of traffic");
  }
}

function assertSourceApiVersion(
  sourceVersionId: string,
  expectedAuthority: "rtdb" | "d1",
  version: ApiVersion,
  allowLegacyD1Adoption = false,
): void {
  if (version.versionId !== sourceVersionId) {
    throw new Error("source API version metadata does not match");
  }
  if (
    allowLegacyD1Adoption &&
    expectedAuthority === "d1" &&
    version.declaredAuthority === null
  ) {
    return;
  }
  if (version.declaredAuthority !== expectedAuthority) {
    throw new Error("source API coordination authority does not match");
  }
}

function assertControlAuthority(
  control: GameplayCoordinationControl,
  authority: CoordinationAuthority,
): void {
  if (control.authority !== authority) {
    throw new Error(`gameplay coordination authority must be ${authority}`);
  }
}

function sameControl(
  left: GameplayCoordinationControl,
  right: GameplayCoordinationControl,
): boolean {
  return digest(left) === digest(right);
}

function assertD1SnapshotMatches(
  expected: readonly D1TimerMarker[],
  actual: readonly D1TimerMarker[],
): void {
  if (digest(expected) !== digest(actual)) {
    throw new Error("gameplay coordination D1 verification mismatch");
  }
}

function assertRtdbMarkersMatch(
  expected: readonly TimerMarker[],
  actual: readonly TimerMarker[],
): void {
  if (digest(expected) !== digest(actual)) {
    throw new Error("gameplay coordination RTDB verification mismatch");
  }
}

function assertEmptySourceAcknowledged(
  source: readonly TimerMarker[],
  destinationCount: number,
  acknowledgement: string | undefined,
): void {
  if (source.length > 0 || destinationCount === 0) return;
  if (acknowledgement !== digest(source)) {
    throw new Error(
      "empty source requires --allow-empty-source-digest from preview",
    );
  }
}

function textHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function sqlText(value: string): string {
  return `CAST(X'${textHex(value)}' AS TEXT)`;
}

function nextControl(
  current: GameplayCoordinationControl,
  authority: CoordinationAuthority,
  markers: readonly TimerMarker[],
  sourceVersionId: string,
  transitionedAtMs: number,
): GameplayCoordinationControl {
  return {
    authority,
    generation: current.generation + 1,
    sourceDigest: digest(markers),
    sourceCount: markers.length,
    sourceVersionId,
    transitionedAtMs,
  };
}

function buildD1ReplacementSql(
  markers: readonly D1TimerMarker[],
  current: GameplayCoordinationControl,
  next: GameplayCoordinationControl,
): string {
  if (
    current.authority !== "rtdb" ||
    next.authority !== "d1" ||
    next.generation !== current.generation + 1 ||
    next.sourceDigest === null ||
    next.sourceCount === null ||
    next.sourceVersionId === null
  ) {
    throw new Error("invalid D1 gameplay coordination transition");
  }
  const lines = [
    "INSERT INTO gameplay_coordination_transition_guard (singleton)",
    "SELECT CASE WHEN",
    `  EXISTS (SELECT 1 FROM gameplay_coordination_control WHERE singleton = 1 AND authority = 'rtdb' AND generation = ${current.generation})`,
    `  AND NOT EXISTS (SELECT 1 FROM game_session_mutation_locks WHERE expires_at_ms > ${next.transitionedAtMs})`,
    "THEN 1 ELSE 0 END;",
    "DELETE FROM match_timer_starts;",
  ];
  for (const marker of markers) {
    lines.push(
      `INSERT INTO match_timer_starts (player_id, match_id, timer, turn_number, updated_at_ms, opponent_id) VALUES (${sqlText(marker.playerId)}, ${sqlText(marker.matchId)}, ${sqlText(marker.timer)}, ${marker.turnNumber}, ${marker.updatedAtMs}, ${marker.opponentId === null ? "NULL" : sqlText(marker.opponentId)});`,
    );
  }
  lines.push(
    "UPDATE gameplay_coordination_control",
    `SET authority = 'd1', generation = ${next.generation}, source_digest = ${sqlText(next.sourceDigest)}, source_count = ${next.sourceCount}, source_version_id = ${sqlText(next.sourceVersionId)}, transitioned_at_ms = ${next.transitionedAtMs}`,
    `WHERE singleton = 1 AND authority = 'rtdb' AND generation = ${current.generation};`,
    "DELETE FROM gameplay_coordination_transition_guard WHERE singleton = 1;",
  );
  return `${lines.join("\n")}\n`;
}

function buildD1ControlTransitionSql(
  current: GameplayCoordinationControl,
  next: GameplayCoordinationControl,
): string {
  const validAuthorityTransition =
    (current.authority === "uninitialized" && next.authority === "d1") ||
    (current.authority === "rtdb" && next.authority === "d1") ||
    (current.authority === "d1" && next.authority === "rtdb");
  if (
    !validAuthorityTransition ||
    next.generation !== current.generation + 1 ||
    next.sourceDigest === null ||
    next.sourceCount === null ||
    next.sourceVersionId === null
  ) {
    throw new Error("invalid gameplay coordination control transition");
  }
  return `UPDATE gameplay_coordination_control SET authority = '${next.authority}', generation = ${next.generation}, source_digest = ${sqlText(next.sourceDigest)}, source_count = ${next.sourceCount}, source_version_id = ${sqlText(next.sourceVersionId)}, transitioned_at_ms = ${next.transitionedAtMs} WHERE singleton = 1 AND authority = '${current.authority}' AND generation = ${current.generation} RETURNING authority, generation, source_digest, source_count, source_version_id, transitioned_at_ms`;
}

function buildRtdbTimerRoot(
  markers: readonly TimerMarker[],
): JsonRecord | null {
  if (markers.length === 0) return null;
  const players = new Map<string, Array<[string, JsonRecord]>>();
  for (const marker of markers) {
    const matches = players.get(marker.playerId) || [];
    matches.push([
      marker.matchId,
      { timer: marker.timer, turnNumber: marker.turnNumber },
    ]);
    players.set(marker.playerId, matches);
  }
  return Object.fromEntries(
    Array.from(players, ([playerId, matches]) => [
      playerId,
      Object.fromEntries(matches),
    ]),
  );
}

function expectedD1Markers(
  markers: readonly TimerMarker[],
  updatedAtMs: number,
): D1TimerMarker[] {
  return markers.map((marker) => ({
    ...marker,
    opponentId: null,
    updatedAtMs,
  }));
}

function verifyForwardOutcome(input: {
  actualControl: GameplayCoordinationControl | null;
  actualMarkers: readonly D1TimerMarker[];
  beforeControl: GameplayCoordinationControl;
  beforeMarkers: readonly D1TimerMarker[];
  expectedControl: GameplayCoordinationControl;
  expectedMarkers: readonly D1TimerMarker[];
}): void {
  if (
    input.actualControl &&
    sameControl(input.actualControl, input.expectedControl)
  ) {
    assertD1SnapshotMatches(input.expectedMarkers, input.actualMarkers);
    return;
  }
  if (
    input.actualControl &&
    sameControl(input.actualControl, input.beforeControl) &&
    digest(input.actualMarkers) === digest(input.beforeMarkers)
  ) {
    throw new Error("D1 transition not applied; retry while frozen");
  }
  throw new Error("D1 transition outcome is contradictory; remain frozen");
}

function verifyAdoptionOutcome(input: {
  actualControl: GameplayCoordinationControl | null;
  actualMarkers: readonly D1TimerMarker[];
  beforeControl: GameplayCoordinationControl;
  expectedControl: GameplayCoordinationControl;
  expectedMarkers: readonly D1TimerMarker[];
}): void {
  assertD1SnapshotMatches(input.expectedMarkers, input.actualMarkers);
  if (
    input.actualControl &&
    sameControl(input.actualControl, input.expectedControl)
  ) {
    return;
  }
  if (
    input.actualControl &&
    sameControl(input.actualControl, input.beforeControl)
  ) {
    throw new Error("D1 adoption not applied; retry while frozen");
  }
  throw new Error("D1 adoption outcome is contradictory; remain frozen");
}

function verifyRollbackOutcome(input: {
  actualControl: GameplayCoordinationControl | null;
  actualD1Markers: readonly D1TimerMarker[];
  actualRtdbMarkers: readonly TimerMarker[];
  beforeControl: GameplayCoordinationControl;
  expectedControl: GameplayCoordinationControl;
  expectedD1Markers: readonly D1TimerMarker[];
  expectedRtdbMarkers: readonly TimerMarker[];
}): void {
  assertD1SnapshotMatches(input.expectedD1Markers, input.actualD1Markers);
  assertRtdbMarkersMatch(input.expectedRtdbMarkers, input.actualRtdbMarkers);
  if (
    input.actualControl &&
    sameControl(input.actualControl, input.expectedControl)
  ) {
    return;
  }
  if (
    input.actualControl &&
    sameControl(input.actualControl, input.beforeControl)
  ) {
    throw new Error("control transition not applied; retry while frozen");
  }
  throw new Error(
    "rollback transition outcome is contradictory; remain frozen",
  );
}

function parseArgs(argv: string[]): MigrationOptions {
  let phase: MigrationPhase = "preview";
  let phaseSet = false;
  let project = CANONICAL_FIREBASE_PROJECT;
  let sourceVersionId: string | undefined;
  let allowEmptySourceDigest: string | undefined;
  let expectedTimerDigest: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--preview" ||
      arg === "--adopt-d1" ||
      arg === "--final" ||
      arg === "--rollback"
    ) {
      if (phaseSet) throw new Error("choose one gameplay coordination phase");
      phaseSet = true;
      phase = arg.slice(2) as MigrationPhase;
      continue;
    }
    if (arg === "--project") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("missing project");
      project = value;
      continue;
    }
    if (arg === "--source-version-id") {
      const value = argv[++index];
      if (!value || !validWorkerVersionId(value)) {
        throw new Error("invalid source API Version ID");
      }
      sourceVersionId = value;
      continue;
    }
    if (arg === "--allow-empty-source-digest") {
      const value = argv[++index]?.toLowerCase();
      if (!value || !validDigest(value)) {
        throw new Error("invalid empty source digest");
      }
      allowEmptySourceDigest = value;
      continue;
    }
    if (arg === "--expected-timer-digest") {
      const value = argv[++index]?.toLowerCase();
      if (!value || !validDigest(value)) {
        throw new Error("invalid expected timer digest");
      }
      expectedTimerDigest = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (phase !== "preview" && project !== CANONICAL_FIREBASE_PROJECT) {
    throw new Error(
      "mutating gameplay coordination migration requires canonical source",
    );
  }
  if (phase !== "preview" && !sourceVersionId) {
    throw new Error("mutating migration requires a source API Version ID");
  }
  if (
    phase === "preview" &&
    (sourceVersionId || allowEmptySourceDigest || expectedTimerDigest)
  ) {
    throw new Error("preview accepts no mutation guards");
  }
  if (phase === "adopt-d1" && !expectedTimerDigest) {
    throw new Error("D1 adoption requires an expected timer digest");
  }
  if (phase === "adopt-d1" && allowEmptySourceDigest) {
    throw new Error("D1 adoption does not accept an empty-source guard");
  }
  if ((phase === "final" || phase === "rollback") && expectedTimerDigest) {
    throw new Error(
      "normal transitions do not accept an expected timer digest",
    );
  }
  return {
    phase,
    project,
    ...(sourceVersionId ? { sourceVersionId } : {}),
    ...(allowEmptySourceDigest ? { allowEmptySourceDigest } : {}),
    ...(expectedTimerDigest ? { expectedTimerDigest } : {}),
  };
}

function assertMigrationSource(
  options: MigrationOptions,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (options.phase === "preview") return;
  if (options.project !== CANONICAL_FIREBASE_PROJECT) {
    throw new Error(
      "mutating gameplay coordination migration requires canonical source",
    );
  }
  if (
    Object.keys(environment).some(
      (key) =>
        FIREBASE_SOURCE_OVERRIDE_KEYS.has(key) ||
        /^FIREBASE_(?:DATABASE|REALTIME|RTDB)_/.test(key),
    )
  ) {
    throw new Error(
      "gameplay coordination migration source override is not allowed",
    );
  }
}

function assertMutationGates(
  options: MigrationOptions,
  dependencies: MigrationDependencies,
  expectedControl: GameplayCoordinationControl,
  sourceAuthority: "rtdb" | "d1",
  allowLegacyD1Adoption = false,
): void {
  assertFrozenProfileControl(dependencies.readProfileControl());
  assertSourceApiDeployment(
    options.sourceVersionId,
    dependencies.readApiDeployment(),
  );
  assertSourceApiVersion(
    options.sourceVersionId as string,
    sourceAuthority,
    dependencies.readApiVersion(options.sourceVersionId as string),
    allowLegacyD1Adoption,
  );
  assertNoActiveD1Leases(dependencies.readActiveD1Leases(dependencies.now()));
  const actualControl = dependencies.readGameplayControl();
  if (!actualControl || !sameControl(actualControl, expectedControl)) {
    throw new Error("gameplay coordination control changed");
  }
}

function migrateGameplayCoordination(
  options: MigrationOptions,
  dependencies: MigrationDependencies,
): void {
  assertMigrationSource(options);
  const exportedAtMs = dependencies.now();
  if (!safeTimestamp(exportedAtMs)) {
    throw new Error("invalid gameplay coordination export timestamp");
  }

  if (options.phase === "preview") {
    const legacy = dependencies.readLegacySnapshot(options.project);
    const d1 = dependencies.readD1TimerMarkers();
    const control = dependencies.readGameplayControl();
    const legacySummary = summarizeLegacySnapshot(legacy, exportedAtMs);
    const d1Summary = {
      activeLocks: dependencies.readActiveD1Leases(exportedAtMs),
      timerMarkers: d1.length,
      timerDigest: digest(logicalD1Markers(d1)),
      snapshotDigest: digest(d1),
    };
    dependencies.persistArtifacts({
      exportedAtMs,
      phase: options.phase,
      files: {
        "metadata.json": `${JSON.stringify({
          phase: options.phase,
          legacy: legacySummary,
          d1: d1Summary,
          control,
        })}\n`,
        "rtdb-source.json": `${JSON.stringify(legacy)}\n`,
        "d1-source.json": `${JSON.stringify(d1)}\n`,
      },
    });
    dependencies.log(
      JSON.stringify({
        phase: options.phase,
        legacy: legacySummary,
        d1: d1Summary,
        authority: control?.authority || "missing",
        generation: control?.generation ?? null,
      }),
    );
    return;
  }

  const control = dependencies.readGameplayControl();
  if (!control) {
    throw new Error("gameplay coordination control is not installed");
  }
  const sourceVersionId = options.sourceVersionId as string;

  if (options.phase === "adopt-d1") {
    assertControlAuthority(control, "uninitialized");
    assertMutationGates(options, dependencies, control, "d1", true);
    const legacyBefore = dependencies.readLegacySnapshot(options.project);
    assertNoActiveLegacyLeases(legacyBefore, dependencies.now());
    const d1Source = dependencies.readD1TimerMarkers();
    const sourceMarkers = logicalD1Markers(d1Source);
    if (digest(sourceMarkers) !== options.expectedTimerDigest) {
      throw new Error("D1 timer digest does not match preview");
    }
    const transitionedAtMs = dependencies.now();
    const next = nextControl(
      control,
      "d1",
      sourceMarkers,
      sourceVersionId,
      transitionedAtMs,
    );
    dependencies.persistArtifacts({
      exportedAtMs,
      phase: options.phase,
      files: {
        "metadata.json": `${JSON.stringify({
          phase: options.phase,
          controlBefore: control,
          controlAfter: next,
          d1SourceCount: d1Source.length,
          d1SourceDigest: digest(d1Source),
          sourceCount: sourceMarkers.length,
          sourceDigest: digest(sourceMarkers),
        })}\n`,
        "d1-source.json": `${JSON.stringify(d1Source)}\n`,
        "rtdb-source.json": `${JSON.stringify(legacyBefore)}\n`,
      },
    });
    dependencies.log(
      JSON.stringify({
        phase: options.phase,
        sourceCount: sourceMarkers.length,
        sourceDigest: digest(sourceMarkers),
        generation: control.generation,
      }),
    );

    assertMutationGates(options, dependencies, control, "d1", true);
    assertD1SnapshotMatches(d1Source, dependencies.readD1TimerMarkers());
    const legacyAfter = dependencies.readLegacySnapshot(options.project);
    assertStableLegacySnapshots(legacyBefore, legacyAfter);
    assertNoActiveLegacyLeases(legacyAfter, dependencies.now());
    try {
      dependencies.transitionGameplayControl(control, next);
    } catch {}
    const actualControl = dependencies.readGameplayControl();
    const actualMarkers = dependencies.readD1TimerMarkers();
    verifyAdoptionOutcome({
      actualControl,
      actualMarkers,
      beforeControl: control,
      expectedControl: next,
      expectedMarkers: d1Source,
    });
    dependencies.log(
      JSON.stringify({
        phase: options.phase,
        verified: true,
        count: actualMarkers.length,
        digest: digest(actualMarkers),
        generation: next.generation,
      }),
    );
    return;
  }

  const expectedAuthority = options.phase === "final" ? "rtdb" : "d1";
  assertControlAuthority(control, expectedAuthority);
  assertMutationGates(options, dependencies, control, expectedAuthority);

  if (options.phase === "final") {
    const first = dependencies.readLegacySnapshot(options.project);
    dependencies.wait(STABILITY_WAIT_MS);
    const second = dependencies.readLegacySnapshot(options.project);
    const checkedAtMs = dependencies.now();
    assertStableLegacySnapshots(first, second);
    assertNoActiveLegacyLeases(second, checkedAtMs);
    const d1Before = dependencies.readD1TimerMarkers();
    assertEmptySourceAcknowledged(
      second.timerMarkers,
      d1Before.length,
      options.allowEmptySourceDigest,
    );
    const next = nextControl(
      control,
      "d1",
      second.timerMarkers,
      sourceVersionId,
      checkedAtMs,
    );
    const expected = expectedD1Markers(second.timerMarkers, checkedAtMs);
    const sql = buildD1ReplacementSql(expected, control, next);
    const artifacts = dependencies.persistArtifacts({
      exportedAtMs,
      phase: options.phase,
      files: {
        "metadata.json": `${JSON.stringify({
          phase: options.phase,
          controlBefore: control,
          controlAfter: next,
          source: summarizeLegacySnapshot(second, checkedAtMs),
          d1BeforeCount: d1Before.length,
          d1BeforeDigest: digest(d1Before),
          d1ExpectedCount: expected.length,
          d1ExpectedDigest: digest(expected),
          stableSnapshots: 2,
        })}\n`,
        "rtdb-first.json": `${JSON.stringify(first)}\n`,
        "rtdb-second.json": `${JSON.stringify(second)}\n`,
        "d1-before.json": `${JSON.stringify(d1Before)}\n`,
        "d1-expected.json": `${JSON.stringify(expected)}\n`,
        "d1-transition.sql": sql,
      },
    });
    dependencies.log(
      JSON.stringify({
        phase: options.phase,
        sourceCount: second.timerMarkers.length,
        sourceDigest: digest(second.timerMarkers),
        destinationCount: d1Before.length,
        destinationDigest: digest(d1Before),
        generation: control.generation,
      }),
    );

    assertMutationGates(options, dependencies, control, "rtdb");
    assertD1SnapshotMatches(d1Before, dependencies.readD1TimerMarkers());
    assertStableLegacySnapshots(
      second,
      dependencies.readLegacySnapshot(options.project),
    );
    const path = artifacts.paths["d1-transition.sql"];
    if (!path) throw new Error("missing D1 transition artifact");
    try {
      dependencies.applyD1Transition(path);
    } catch {}
    const actualControl = dependencies.readGameplayControl();
    const actualMarkers = dependencies.readD1TimerMarkers();
    verifyForwardOutcome({
      actualControl,
      actualMarkers,
      beforeControl: control,
      beforeMarkers: d1Before,
      expectedControl: next,
      expectedMarkers: expected,
    });
    assertStableLegacySnapshots(
      second,
      dependencies.readLegacySnapshot(options.project),
    );
    dependencies.log(
      JSON.stringify({
        phase: options.phase,
        verified: true,
        count: actualMarkers.length,
        digest: digest(actualMarkers),
        generation: next.generation,
      }),
    );
    return;
  }

  const checkedAtMs = dependencies.now();
  const d1Source = dependencies.readD1TimerMarkers();
  const sourceMarkers = logicalD1Markers(d1Source);
  const rtdbBefore = dependencies.readLegacySnapshot(options.project);
  assertEmptySourceAcknowledged(
    sourceMarkers,
    rtdbBefore.timerMarkers.length,
    options.allowEmptySourceDigest,
  );
  const next = nextControl(
    control,
    "rtdb",
    sourceMarkers,
    sourceVersionId,
    checkedAtMs,
  );
  const root = buildRtdbTimerRoot(sourceMarkers);
  const artifacts = dependencies.persistArtifacts({
    exportedAtMs,
    phase: options.phase,
    files: {
      "metadata.json": `${JSON.stringify({
        phase: options.phase,
        controlBefore: control,
        controlAfter: next,
        d1SourceCount: d1Source.length,
        d1SourceDigest: digest(d1Source),
        sourceCount: sourceMarkers.length,
        sourceDigest: digest(sourceMarkers),
        rtdbBeforeCount: rtdbBefore.timerMarkers.length,
        rtdbBeforeDigest: digest(rtdbBefore.timerMarkers),
      })}\n`,
      "d1-source.json": `${JSON.stringify(d1Source)}\n`,
      "rtdb-before.json": `${JSON.stringify(rtdbBefore)}\n`,
      "rtdb-expected.json": `${JSON.stringify(sourceMarkers)}\n`,
      "rtdb-set.json": `${JSON.stringify(root)}\n`,
    },
  });
  dependencies.log(
    JSON.stringify({
      phase: options.phase,
      sourceCount: sourceMarkers.length,
      sourceDigest: digest(sourceMarkers),
      destinationCount: rtdbBefore.timerMarkers.length,
      destinationDigest: digest(rtdbBefore.timerMarkers),
      generation: control.generation,
    }),
  );

  assertMutationGates(options, dependencies, control, "d1");
  assertD1SnapshotMatches(d1Source, dependencies.readD1TimerMarkers());
  const path = artifacts.paths["rtdb-set.json"];
  if (!path) throw new Error("missing RTDB set artifact");
  try {
    dependencies.setRtdbTimerMarkers(options.project, path);
  } catch {}
  const afterSet = dependencies.readLegacySnapshot(options.project);
  assertRtdbMarkersMatch(sourceMarkers, afterSet.timerMarkers);
  assertD1SnapshotMatches(d1Source, dependencies.readD1TimerMarkers());
  assertMutationGates(options, dependencies, control, "d1");
  try {
    dependencies.transitionGameplayControl(control, next);
  } catch {}
  const actualControl = dependencies.readGameplayControl();
  const actualD1Markers = dependencies.readD1TimerMarkers();
  const actualRtdbMarkers = dependencies.readLegacySnapshot(
    options.project,
  ).timerMarkers;
  verifyRollbackOutcome({
    actualControl,
    actualD1Markers,
    actualRtdbMarkers,
    beforeControl: control,
    expectedControl: next,
    expectedD1Markers: d1Source,
    expectedRtdbMarkers: sourceMarkers,
  });
  dependencies.log(
    JSON.stringify({
      phase: options.phase,
      verified: true,
      count: actualRtdbMarkers.length,
      digest: digest(actualRtdbMarkers),
      generation: next.generation,
    }),
  );
}

function run(
  executable: string,
  args: string[],
  { maxBuffer = 64 * 1024 * 1024 }: { maxBuffer?: number } = {},
): string {
  const result = spawnSync(executable, args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer,
    shell: false,
  });
  if (result.status !== 0) throw new Error("migration subprocess failed");
  return String(result.stdout);
}

function firebaseDatabaseGetArgs(project: string, path: string): string[] {
  const args = ["database:get", path, "--project", project];
  if (project === CANONICAL_FIREBASE_PROJECT) {
    args.push("--instance", CANONICAL_FIREBASE_INSTANCE);
  }
  return args;
}

function firebaseDatabaseSetArgs(project: string, path: string): string[] {
  const args = [
    "database:set",
    "/matchTimerStarts",
    path,
    "--force",
    "--project",
    project,
  ];
  if (project === CANONICAL_FIREBASE_PROJECT) {
    args.push("--instance", CANONICAL_FIREBASE_INSTANCE);
  }
  return args;
}

function firebaseGet(project: string, path: string): unknown {
  return JSON.parse(
    run(
      resolve("node_modules/.bin/firebase"),
      firebaseDatabaseGetArgs(project, path),
    ),
  ) as unknown;
}

function readRemoteLegacySnapshot(project: string): LegacySnapshot {
  return normalizeLegacySnapshot({
    locks: firebaseGet(project, "/gameplayMutationLocks"),
    timerStarts: firebaseGet(project, "/matchTimerStarts"),
  });
}

function wranglerArgs(database: string, args: string[]): string[] {
  return [
    "d1",
    "execute",
    database,
    "--remote",
    "--config",
    CONFIG_PATH,
    "--env-file",
    RELEASE_ENV_PATH,
    ...args,
  ];
}

function d1Rows(database: string, command: string): JsonRecord[] {
  const output = run(resolve("node_modules/.bin/wrangler"), [
    ...wranglerArgs(database, ["--command", command]),
    "--json",
  ]);
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error("invalid D1 JSON response");
  const entry = parsed.find(
    (value) => record(value) && Array.isArray(record(value)?.results),
  ) as JsonRecord | undefined;
  return entry && Array.isArray(entry.results)
    ? entry.results.filter((value): value is JsonRecord =>
        Boolean(record(value)),
      )
    : [];
}

function readRemoteProfileControl(): string {
  const row = d1Rows(
    PROFILE_DATABASE,
    "SELECT state FROM profile_canonical_control WHERE singleton = 1",
  )[0];
  return typeof row?.state === "string" ? row.state : "";
}

function readRemoteApiDeployment(): ApiDeployment {
  return normalizeApiDeployment(
    JSON.parse(
      run(resolve("node_modules/.bin/wrangler"), [
        "deployments",
        "status",
        "--config",
        CONFIG_PATH,
        "--env-file",
        RELEASE_ENV_PATH,
        "--json",
      ]),
    ) as unknown,
  );
}

function readRemoteApiVersion(versionId: string): ApiVersion {
  return normalizeApiVersion(
    JSON.parse(
      run(resolve("node_modules/.bin/wrangler"), [
        "versions",
        "view",
        versionId,
        "--json",
        "--config",
        CONFIG_PATH,
        "--env-file",
        RELEASE_ENV_PATH,
      ]),
    ) as unknown,
  );
}

function readRemoteActiveD1Leases(nowMs: number): number {
  const row = d1Rows(
    PROFILE_GAMES_DATABASE,
    `SELECT COUNT(*) AS active_leases FROM game_session_mutation_locks WHERE expires_at_ms > ${nowMs}`,
  )[0];
  const count = Number(row?.active_leases);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("invalid active D1 gameplay lease count");
  }
  return count;
}

function readRemoteD1TimerMarkers(): D1TimerMarker[] {
  const hasOpponentColumn =
    Number(
      d1Rows(
        PROFILE_GAMES_DATABASE,
        "SELECT COUNT(*) AS column_count FROM pragma_table_info('match_timer_starts') WHERE name = 'opponent_id'",
      )[0]?.column_count,
    ) === 1;
  return normalizeD1TimerMarkers(
    d1Rows(
      PROFILE_GAMES_DATABASE,
      `SELECT player_id, match_id, timer, turn_number, updated_at_ms, ${hasOpponentColumn ? "opponent_id" : "NULL AS opponent_id"} FROM match_timer_starts ORDER BY player_id, match_id`,
    ),
  );
}

function readRemoteGameplayControl(): GameplayCoordinationControl | null {
  const exists =
    Number(
      d1Rows(
        PROFILE_GAMES_DATABASE,
        "SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type = 'table' AND name = 'gameplay_coordination_control'",
      )[0]?.table_count,
    ) === 1;
  if (!exists) return null;
  const row = d1Rows(
    PROFILE_GAMES_DATABASE,
    "SELECT authority, generation, source_digest, source_count, source_version_id, transitioned_at_ms FROM gameplay_coordination_control WHERE singleton = 1",
  )[0];
  return normalizeGameplayControl(row);
}

function transitionRemoteGameplayControl(
  expected: GameplayCoordinationControl,
  next: GameplayCoordinationControl,
): void {
  const rows = d1Rows(
    PROFILE_GAMES_DATABASE,
    buildD1ControlTransitionSql(expected, next),
  );
  if (
    rows.length !== 1 ||
    !sameControl(normalizeGameplayControl(rows[0]), next)
  ) {
    throw new Error("gameplay coordination control transition failed");
  }
}

function persistMigrationArtifacts(
  input: Parameters<MigrationDependencies["persistArtifacts"]>[0],
  rootDirectory = resolve(".cache", "gameplay-coordination-migration"),
): PersistedArtifacts {
  mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  chmodSync(rootDirectory, 0o700);
  const runDirectory = mkdtempSync(
    resolve(
      rootDirectory,
      `${input.exportedAtMs}-${process.pid}-${input.phase}-`,
    ),
  );
  chmodSync(runDirectory, 0o700);
  const paths: Record<string, string> = {};
  for (const [name, contents] of Object.entries(input.files)) {
    if (!/^[a-z0-9.-]+$/.test(name)) {
      throw new Error("invalid migration artifact name");
    }
    const path = resolve(runDirectory, name);
    writeFileSync(path, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    paths[name] = path;
  }
  return { paths };
}

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function createDefaultDependencies(): MigrationDependencies {
  return {
    applyD1Transition: (path) => {
      run(
        resolve("node_modules/.bin/wrangler"),
        wranglerArgs(PROFILE_GAMES_DATABASE, ["--file", path, "--yes"]),
      );
    },
    log: console.log,
    now: Date.now,
    persistArtifacts: persistMigrationArtifacts,
    readActiveD1Leases: readRemoteActiveD1Leases,
    readApiDeployment: readRemoteApiDeployment,
    readApiVersion: readRemoteApiVersion,
    readD1TimerMarkers: readRemoteD1TimerMarkers,
    readGameplayControl: readRemoteGameplayControl,
    readLegacySnapshot: readRemoteLegacySnapshot,
    readProfileControl: readRemoteProfileControl,
    setRtdbTimerMarkers: (project, path) => {
      run(
        resolve("node_modules/.bin/firebase"),
        firebaseDatabaseSetArgs(project, path),
      );
    },
    transitionGameplayControl: transitionRemoteGameplayControl,
    wait,
  };
}

function execute(argv = process.argv.slice(2)): void {
  migrateGameplayCoordination(parseArgs(argv), createDefaultDependencies());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    execute();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "migration failed");
    process.exitCode = 1;
  }
}

export {
  assertEmptySourceAcknowledged,
  assertMigrationSource,
  assertNoActiveD1Leases,
  assertNoActiveLegacyLeases,
  assertStableLegacySnapshots,
  buildD1ControlTransitionSql,
  buildD1ReplacementSql,
  buildRtdbTimerRoot,
  canonicalize,
  digest,
  execute,
  firebaseDatabaseGetArgs,
  firebaseDatabaseSetArgs,
  migrateGameplayCoordination,
  normalizeApiDeployment,
  normalizeApiVersion,
  normalizeD1TimerMarkers,
  normalizeGameplayControl,
  normalizeLegacySnapshot,
  parseArgs,
  persistMigrationArtifacts,
  summarizeLegacySnapshot,
  verifyAdoptionOutcome,
  verifyForwardOutcome,
  verifyRollbackOutcome,
  type ApiDeployment,
  type ApiVersion,
  type D1TimerMarker,
  type GameplayCoordinationControl,
  type LegacySnapshot,
  type MigrationDependencies,
  type MigrationOptions,
  type TimerMarker,
};
