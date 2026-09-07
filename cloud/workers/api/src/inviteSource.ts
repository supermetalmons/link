import {
  createFirebaseRtdbClient,
  type FirebaseRtdbClient,
} from "./firebaseRtdb.ts";
import { createWagerStateRtdbClient } from "./wagerStateRepository.ts";

const INVITE_SOURCE_CLIENT_TTL_MS = 5 * 60 * 1_000;

export function createInviteSourceReader(
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
    createClient?: () => FirebaseRtdbClient;
    now?: () => number;
  } = {},
): (inviteId: string) => Promise<unknown> {
  let client: Pick<FirebaseRtdbClient, "getPath"> | null = null;
  let expiresAtMs = 0;
  return async (inviteId) => {
    if (!client || now() >= expiresAtMs) {
      client = createWagerStateRtdbClient(env.PROFILE_DB, createClient(), {
        now,
      });
      expiresAtMs = now() + INVITE_SOURCE_CLIENT_TTL_MS;
    }
    try {
      return await client.getPath(`invites/${inviteId}`);
    } catch (error) {
      client = null;
      throw error;
    }
  };
}
