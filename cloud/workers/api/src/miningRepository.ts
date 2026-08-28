import {
  MATERIAL_KEYS,
  normalizeMiningSnapshot,
  type MiningSnapshot,
} from "@mons/shared/mining";
import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import { FirestoreFailure } from "./firestore.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";

const FIRESTORE_PROJECT_ID = "mons-link";
const FIRESTORE_DATABASE_ID = "(default)";
const FIRESTORE_DOCUMENTS_ROOT = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}/documents`;
const FIRESTORE_TIMEOUT_MS = 5_000;
const MAX_FIRESTORE_BODY_BYTES = 64 * 1024;

export type MiningProfile = {
  mining: MiningSnapshot;
  profileId: string;
  updateTime: string;
};

export type MiningRepository = {
  getProfile: (
    uid: string,
    firebaseIdToken: string,
  ) => Promise<MiningProfile | null>;
  updateMining: (
    profileId: string,
    mining: MiningSnapshot,
    updateTime: string,
  ) => Promise<"conflict" | "updated">;
};

type MiningRepositoryDependencies = {
  fetcher?: typeof fetch;
  getAccessToken?: typeof createGoogleAccessToken;
  now?: () => number;
  projectionCommitted?: (profileId: string) => Promise<void> | void;
  timeoutMs?: number;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readFirestoreNumber(value: unknown): number {
  const encoded = toRecord(value);
  const raw =
    encoded?.integerValue ?? encoded?.doubleValue ?? encoded?.stringValue;
  const parsed =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function readMiningFields(fields: Record<string, unknown>): MiningSnapshot {
  const miningValue = toRecord(fields.mining);
  const miningMap = toRecord(miningValue?.mapValue);
  const miningFields = toRecord(miningMap?.fields) || {};
  const lastRockDateValue = toRecord(miningFields.lastRockDate);
  const materialsValue = toRecord(miningFields.materials);
  const materialsMap = toRecord(materialsValue?.mapValue);
  const materialFields = toRecord(materialsMap?.fields) || {};
  const materials = Object.fromEntries(
    MATERIAL_KEYS.map((key) => [key, readFirestoreNumber(materialFields[key])]),
  );
  return normalizeMiningSnapshot({
    lastRockDate:
      typeof lastRockDateValue?.stringValue === "string"
        ? lastRockDateValue.stringValue
        : null,
    materials,
  });
}

export function parseMiningProfileQuery(value: unknown): MiningProfile | null {
  if (!Array.isArray(value)) {
    throw new FirestoreFailure();
  }
  for (const entry of value) {
    const result = toRecord(entry);
    const document = toRecord(result?.document);
    if (!document) {
      continue;
    }
    const name = typeof document.name === "string" ? document.name.trim() : "";
    const updateTime =
      typeof document.updateTime === "string" ? document.updateTime.trim() : "";
    const fields = toRecord(document.fields);
    const profileId = name.split("/").pop()?.trim() || "";
    if (!fields || !profileId || !updateTime) {
      throw new FirestoreFailure();
    }
    return {
      mining: readMiningFields(fields),
      profileId,
      updateTime,
    };
  }
  return null;
}

function encodeMiningFields(mining: MiningSnapshot): Record<string, unknown> {
  const materialFields = Object.fromEntries(
    MATERIAL_KEYS.map((key) => [
      key,
      { integerValue: String(mining.materials[key]) },
    ]),
  );
  return {
    mining: {
      mapValue: {
        fields: {
          lastRockDate:
            mining.lastRockDate === null
              ? { nullValue: null }
              : { stringValue: mining.lastRockDate },
          materials: { mapValue: { fields: materialFields } },
        },
      },
    },
  };
}

function isPreconditionConflict(value: unknown): boolean {
  const body = toRecord(value);
  const error = toRecord(body?.error);
  return error?.status === "ABORTED" || error?.status === "FAILED_PRECONDITION";
}

export function createMiningRepository(
  env: Env,
  {
    fetcher = fetch,
    getAccessToken = createGoogleAccessToken,
    now = Date.now,
    projectionCommitted,
    timeoutMs = FIRESTORE_TIMEOUT_MS,
  }: MiningRepositoryDependencies = {},
): MiningRepository {
  let accessToken: Promise<string> | null = null;
  const notifyProfileProjection = async (profileId: string): Promise<void> => {
    try {
      await projectionCommitted?.(profileId);
    } catch {
      console.error(
        JSON.stringify({ event: "profile_read_projection_enqueue_failed" }),
      );
    }
  };

  const fetchWithTimeout = async (
    input: string,
    init: RequestInit,
  ): Promise<Response> => {
    try {
      return await fetcher(input, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new FirestoreFailure();
    }
  };

  return {
    async getProfile(uid, firebaseIdToken) {
      const response = await fetchWithTimeout(
        `${FIRESTORE_DOCUMENTS_ROOT}:runQuery`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firebaseIdToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            structuredQuery: {
              select: { fields: [{ fieldPath: "mining" }] },
              from: [{ collectionId: "users" }],
              where: {
                fieldFilter: {
                  field: { fieldPath: "logins" },
                  op: "ARRAY_CONTAINS",
                  value: { stringValue: uid },
                },
              },
              limit: 1,
            },
          }),
        },
      );
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new FirestoreFailure();
      }
      return parseMiningProfileQuery(
        await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new FirestoreFailure(),
        ),
      );
    },

    async updateMining(profileId, mining, updateTime) {
      accessToken ||= getAccessToken(env, { fetcher, now, timeoutMs }).catch(
        () => {
          throw new FirestoreFailure();
        },
      );
      const url = new URL(
        `${FIRESTORE_DOCUMENTS_ROOT}/users/${encodeURIComponent(profileId)}`,
      );
      url.searchParams.append("updateMask.fieldPaths", "mining.lastRockDate");
      url.searchParams.append("updateMask.fieldPaths", "mining.materials");
      url.searchParams.set("currentDocument.updateTime", updateTime);
      const response = await fetchWithTimeout(url.toString(), {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${await accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: encodeMiningFields(mining) }),
      });
      if (response.ok) {
        await cancelResponseBody(response);
        await notifyProfileProjection(profileId);
        return "updated";
      }
      if (response.status === 409 || response.status === 412) {
        await cancelResponseBody(response);
        return "conflict";
      }
      if (response.status === 400) {
        const body = await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new FirestoreFailure(),
        );
        if (isPreconditionConflict(body)) {
          return "conflict";
        }
        throw new FirestoreFailure();
      }
      await cancelResponseBody(response);
      throw new FirestoreFailure();
    },
  };
}
