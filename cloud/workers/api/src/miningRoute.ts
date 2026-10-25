import type { ApiRequest, ApiResponse } from "@mons/shared/api-contracts";
import {
  MATERIAL_KEYS,
  createDropsForMiningEvent,
  formatMiningDateUtc,
  normalizeMaterials,
  sumMaterials,
} from "@mons/shared/mining";
import { AuthApiFailure } from "./authErrors.ts";
import { enforceRateLimit } from "./rateLimit.ts";
import { authJsonResponse } from "./authHttp.ts";
import type { WorkerExecutionContext } from "./sessionAuth.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import { authenticatedPost } from "./authenticatedPost.ts";
import {
  createMiningRepository,
  type MiningRepository,
} from "./miningRepository.ts";
import { readBoundedJson } from "./http.ts";
import { assertProfileMutationAllowed } from "./profileCanonicalActivation.ts";
import { profileOwnershipUnavailable } from "./profileOwnership.ts";
type MineRockRequest = ApiRequest<"POST /mining/rock">;
type MineRockResponse = ApiResponse<"POST /mining/rock">;

const MAX_WRITE_ATTEMPTS = 3;

export type MiningRouteDependencies = {
  logFailure?: (kind: string) => void;
  now?: () => number;
  repository?: MiningRepository;
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<RequestIdentity>;
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
  return enforceRateLimit(
    env.AUTH_RATE_LIMITER,
    `mining:${uid}`,
    "Too many mining attempts.",
  );
}

async function mineRock(
  request: MineRockRequest,
  identity: RequestIdentity,
  repository: MiningRepository,
  nowMs: number,
): Promise<MineRockResponse> {
  if (!dateIsInRange(request.date, nowMs)) {
    return { ok: false, reason: "date-out-of-range" };
  }
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const profile = await repository
      .getOwnedProfileSnapshot(identity.uid)
      .catch(() => {
        throw profileOwnershipUnavailable();
      });
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
    if ((await profile.commitMining(mining)) === "updated") {
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
  return authenticatedPost(
    request,
    env,
    ctx,
    {
      failureMessage: "mining-service-unavailable",
      failureEvent: "mining_route_failure",
      logFailure: dependencies.logFailure,
      verifyIdentity: dependencies.verifyIdentity,
    },
    async ({ corsHeaders, authenticate }) => {
      const identity = await authenticate();
      await assertProfileMutationAllowed(env);
      await enforceMiningRateLimit(env, identity.uid);
      const input = await parseMineRockRequest(request);
      const repository = dependencies.repository || createMiningRepository(env);
      return authJsonResponse<"POST /mining/rock", 200>(
        await mineRock(
          input,
          identity,
          repository,
          (dependencies.now || Date.now)(),
        ),
        200,
        corsHeaders,
      );
    },
  );
}
