import {
  MATERIAL_KEYS,
  createDropsForMiningEvent,
  formatMiningDateUtc,
  normalizeMaterials,
  sumMaterials,
  type MineRockRequest,
  type MineRockResponse,
} from "@mons/shared/mining";
import {
  AuthApiFailure,
  authErrorResponse,
  isProfileWritesDisabledFailure,
} from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  verifyFirebaseRequest,
  type FirebaseIdentity,
  type WorkerExecutionContext,
} from "./firebaseAuth.ts";
import {
  createMiningRepository,
  type MiningRepository,
} from "./miningRepository.ts";
import { readBoundedJson } from "./http.ts";
import { assertProfileMutationAllowed } from "./profileCanonicalActivation.ts";

const MAX_WRITE_ATTEMPTS = 3;

export type MiningRouteDependencies = {
  logFailure?: (kind: string) => void;
  now?: () => number;
  repository?: MiningRepository;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<FirebaseIdentity>;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function parseMineRockRequest(
  request: Request,
): Promise<MineRockRequest> {
  let body: Record<string, unknown> | null;
  try {
    body = toRecord(await readBoundedJson(request));
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  if (!body || typeof body.date !== "string") {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    throw new AuthApiFailure(
      400,
      "invalid-argument",
      "A valid mining date is required.",
    );
  }
  const materials = normalizeMaterials(body.materials);
  if (!MATERIAL_KEYS.some((key) => materials[key] > 0)) {
    throw new AuthApiFailure(
      400,
      "invalid-argument",
      "At least one material amount must be greater than zero.",
    );
  }
  return { date: body.date, materials };
}

function dateIsInRange(date: string, nowMs: number): boolean {
  const miningDate = new Date(`${date}T00:00:00.000Z`);
  const serverDateString = formatMiningDateUtc(new Date(nowMs));
  const serverDate = new Date(`${serverDateString}T00:00:00.000Z`);
  const dayDiff = Math.abs(
    (miningDate.getTime() - serverDate.getTime()) / 86_400_000,
  );
  return Number.isFinite(dayDiff) && dayDiff <= 2;
}

async function enforceMiningRateLimit(env: Env, uid: string): Promise<void> {
  let outcome: RateLimitOutcome;
  try {
    outcome = await env.AUTH_RATE_LIMITER.limit({ key: `mining:${uid}` });
  } catch {
    throw new AuthApiFailure(503, "unavailable", "rate-limit-unavailable");
  }
  if (!outcome.success) {
    throw new AuthApiFailure(
      429,
      "resource-exhausted",
      "Too many mining attempts.",
    );
  }
}

async function mineRock(
  request: MineRockRequest,
  identity: FirebaseIdentity,
  repository: MiningRepository,
  nowMs: number,
): Promise<MineRockResponse> {
  if (!dateIsInRange(request.date, nowMs)) {
    return { ok: false, reason: "date-out-of-range" };
  }
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const profile = await repository.getProfile(identity.uid, identity.idToken);
    if (!profile) {
      return { ok: false, reason: "profile-not-found" };
    }
    if (
      profile.mining.lastRockDate &&
      request.date <= profile.mining.lastRockDate
    ) {
      return { ok: false, reason: "date-not-advanced" };
    }
    const expected = createDropsForMiningEvent(
      profile.profileId,
      request.date,
      profile.mining,
    );
    if (
      !MATERIAL_KEYS.every(
        (key) => request.materials[key] === expected.delta[key],
      )
    ) {
      return { ok: false, reason: "materials-mismatch" };
    }
    const mining = {
      lastRockDate: request.date,
      materials: sumMaterials(profile.mining.materials, expected.delta),
    };
    if (
      (await repository.updateMining(
        profile.profileId,
        mining,
        profile.updateTime,
      )) === "updated"
    ) {
      return { ok: true, mining };
    }
  }
  throw new AuthApiFailure(503, "unavailable", "mining-write-conflict");
}

export async function handleMiningRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: MiningRouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = getAuthCorsHeaders(request);
    if (request.method === "OPTIONS") {
      return authPreflightResponse(corsHeaders);
    }
    if (request.method !== "POST") {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    const identity = await (
      dependencies.verifyIdentity || verifyFirebaseRequest
    )(request, ctx);
    await assertProfileMutationAllowed(env);
    await enforceMiningRateLimit(env, identity.uid);
    const input = await parseMineRockRequest(request);
    const repository = dependencies.repository || createMiningRepository(env);
    return authJsonResponse(
      await mineRock(
        input,
        identity,
        repository,
        (dependencies.now || Date.now)(),
      ),
      200,
      corsHeaders,
    );
  } catch (error) {
    const failure =
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(503, "unavailable", "mining-service-unavailable");
    if (failure.status >= 500 && !isProfileWritesDisabledFailure(failure)) {
      (
        dependencies.logFailure ||
        ((kind) =>
          console.error(
            JSON.stringify({ event: "mining_route_failure", kind }),
          ))
      )(failure.message);
    }
    return authErrorResponse(failure, corsHeaders);
  }
}
