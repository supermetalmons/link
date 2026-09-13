import {
  INVITE_WAGERS_MAX_MESSAGE_BYTES,
  isReadInviteWagersResponse,
  type ReadInviteWagersResponse,
} from "@mons/shared/invite-wagers";
import { isInviteMetadataSnapshot } from "@mons/shared/invite-metadata";
import { AuthApiFailure } from "./authErrors.ts";
import type { WorkerExecutionContext } from "./sessionAuth.ts";
import type { InviteReactions } from "./inviteReactions.ts";
import {
  handleInviteReadRoute,
  isInviteReadPath,
  resolveInviteReadRole,
  type InviteReadRouteDependencies,
} from "./inviteReadRoute.ts";

export type InviteWagersRouteDependencies = InviteReadRouteDependencies & {
  room?: Pick<InviteReactions, "readWagers" | "fetch">;
};

export function isInviteWagersPath(pathname: string): boolean {
  return isInviteReadPath(pathname, "wagers");
}

export async function handleInviteWagersRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: InviteWagersRouteDependencies = {},
): Promise<Response> {
  return handleInviteReadRoute(request, env, ctx, {
    channel: "wagers",
    dependencies,
    getRoom: (inviteId) =>
      dependencies.room || env.INVITE_REACTIONS.getByName(inviteId),
    async prepare(room, access) {
      const { inviteId } = access;
      const read = await room.readWagers(inviteId);
      if (read.status === "missing") {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      if (read.status !== "ok") {
        throw new AuthApiFailure(
          503,
          "unavailable",
          "invite-wagers-unavailable",
        );
      }
      const body: ReadInviteWagersResponse = {
        ok: true,
        snapshot: read.snapshot,
      };
      if (
        !isReadInviteWagersResponse(body) ||
        !isInviteMetadataSnapshot(read.metadata.snapshot) ||
        read.metadata.status !== "ok" ||
        typeof read.metadata.passwordProtected !== "boolean" ||
        read.snapshot.inviteId !== inviteId ||
        read.metadata.snapshot.inviteId !== inviteId ||
        new TextEncoder().encode(JSON.stringify(body)).byteLength >
          INVITE_WAGERS_MAX_MESSAGE_BYTES
      ) {
        throw new AuthApiFailure(
          503,
          "unavailable",
          "invite-wagers-unavailable",
        );
      }
      const role = await resolveInviteReadRole(
        access,
        read.metadata.snapshot,
        read.metadata.passwordProtected,
      );
      return {
        body,
        role,
        revision: read.snapshot.revision,
        passwordProtected: read.metadata.passwordProtected,
      };
    },
  });
}
