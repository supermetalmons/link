import {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  isReadInviteMetadataResponse,
  type ReadInviteMetadataResponse,
} from "@mons/shared/invite-metadata";
import { GAME_SESSION_OPERATION_ID_PATTERN } from "@mons/shared/game-sessions";
import { AuthApiFailure } from "./authErrors.ts";
import type { WorkerExecutionContext } from "./sessionAuth.ts";
import type { InviteReactions } from "./inviteReactions.ts";
import {
  handleInviteReadRoute,
  isInviteReadPath,
  resolveInviteReadRole,
  type InviteReadRouteDependencies,
} from "./inviteReadRoute.ts";

export type InviteMetadataRouteDependencies = InviteReadRouteDependencies & {
  room?: Pick<InviteReactions, "readMetadata" | "fetch">;
};

export function isInviteMetadataPath(pathname: string): boolean {
  return isInviteReadPath(pathname, "metadata");
}

export async function handleInviteMetadataRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: InviteMetadataRouteDependencies = {},
): Promise<Response> {
  return handleInviteReadRoute(request, env, ctx, {
    channel: "metadata",
    dependencies,
    getRoom: (inviteId) =>
      dependencies.room || env.INVITE_REACTIONS.getByName(inviteId),
    async prepare(room, access) {
      const { inviteId, identity } = access;
      const read = await room.readMetadata(inviteId);
      if (read.status === "missing") {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      if (read.status !== "ok") {
        throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
      }
      const role = await resolveInviteReadRole(
        access,
        read.snapshot,
        read.passwordProtected,
      );
      const operationId = identity
        ? read.automatchOperationIds[identity.uid]
        : null;
      const body: ReadInviteMetadataResponse = {
        ok: true,
        snapshot: read.snapshot,
        viewer: {
          role: role.role,
          actorUid: role.actorUid,
          automatchOperationId:
            typeof operationId === "string" &&
            GAME_SESSION_OPERATION_ID_PATTERN.test(operationId)
              ? operationId
              : null,
        },
      };
      if (
        !isReadInviteMetadataResponse(body) ||
        new TextEncoder().encode(JSON.stringify(body)).byteLength >
          INVITE_METADATA_MAX_MESSAGE_BYTES
      ) {
        throw new AuthApiFailure(
          503,
          "unavailable",
          "invite-metadata-unavailable",
        );
      }
      return {
        body,
        role,
        revision: read.snapshot.revision,
        passwordProtected: read.passwordProtected,
      };
    },
  });
}
