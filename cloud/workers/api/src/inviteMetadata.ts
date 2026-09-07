import { GAME_SESSION_OPERATION_ID_PATTERN } from "@mons/shared/game-sessions";
import {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  isInviteMetadataSnapshot,
  type InviteMetadataSnapshot,
} from "@mons/shared/invite-metadata";
import { isCanonicalFirebaseUid } from "./firebaseKeys.ts";
import {
  createFirebaseRtdbClient,
  type FirebaseRtdbClient,
} from "./firebaseRtdb.ts";

export type InviteMetadataReadResult =
  | {
      status: "ok";
      snapshot: InviteMetadataSnapshot;
      passwordProtected: boolean;
      automatchOperationIds: Record<string, string>;
    }
  | { status: "missing" | "invalid" };

const METADATA_SOURCE_CLIENT_TTL_MS = 5 * 60 * 1_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeInviteMetadata(
  inviteId: string,
  value: unknown,
): InviteMetadataReadResult {
  if (value === null || value === undefined) return { status: "missing" };
  const invite = record(value);
  if (!invite) return { status: "invalid" };
  const snapshot = {
    inviteId,
    revision: 0,
    hostId: invite.hostId,
    guestId: invite.guestId ?? null,
    hostColor: invite.hostColor,
    hostRematches: invite.hostRematches ?? "",
    guestRematches: invite.guestRematches ?? "",
    automatchStateHint: invite.automatchStateHint ?? null,
    eventId: invite.eventId ?? null,
    eventOwned: invite.eventOwned === true,
  };
  if (
    !isInviteMetadataSnapshot(snapshot) ||
    new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 1, type: "snapshot", snapshot }),
    ).byteLength > INVITE_METADATA_MAX_MESSAGE_BYTES
  ) {
    return { status: "invalid" };
  }
  return {
    status: "ok",
    snapshot,
    passwordProtected: Object.hasOwn(invite, "password"),
    automatchOperationIds: Object.fromEntries(
      Object.entries(record(invite.automatchOperationIds) || {}).filter(
        (entry): entry is [string, string] =>
          isCanonicalFirebaseUid(entry[0]) &&
          typeof entry[1] === "string" &&
          GAME_SESSION_OPERATION_ID_PATTERN.test(entry[1]),
      ),
    ),
  };
}

export function createInviteMetadataReader(
  env: Env,
  {
    createClient = () =>
      createFirebaseRtdbClient(env, {
        credentials: {
          email: env.GAMEPLAY_SERVICE_ACCOUNT_EMAIL,
          privateKeyPem: env.GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY,
        },
      }),
    now = Date.now,
  }: {
    createClient?: () => Pick<FirebaseRtdbClient, "getPath">;
    now?: () => number;
  } = {},
): (inviteId: string) => Promise<InviteMetadataReadResult> {
  let client: Pick<FirebaseRtdbClient, "getPath"> | null = null;
  let expiresAtMs = 0;
  return async (inviteId) => {
    if (!client || now() >= expiresAtMs) {
      client = createClient();
      expiresAtMs = now() + METADATA_SOURCE_CLIENT_TTL_MS;
    }
    try {
      return normalizeInviteMetadata(
        inviteId,
        await client.getPath(`invites/${inviteId}`),
      );
    } catch (error) {
      client = null;
      throw error;
    }
  };
}
