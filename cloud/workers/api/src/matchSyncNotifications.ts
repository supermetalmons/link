import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import type { InviteRoomNotificationOptions } from "./inviteRoomNotifications.ts";
import { readResolvedLoginMatchInviteId } from "./loginMatchDiscoveryD1.ts";

export type MatchSyncTarget = { playerId: string; matchId: string };

type MatchSyncNotificationOptions = InviteRoomNotificationOptions & {
  resolveInvite?: (target: MatchSyncTarget) => Promise<string | null>;
};

export function changedMatchSyncTargets(
  updates: Record<string, unknown>,
): MatchSyncTarget[] {
  const targets = new Map<string, MatchSyncTarget>();
  for (const path of Object.keys(updates)) {
    const parts = path.replace(/^\/+|\/+$/g, "").split("/");
    if (
      parts[0] !== "players" ||
      parts[2] !== "matches" ||
      parts.length < 4 ||
      !isCanonicalFirebaseUid(parts[1]) ||
      parts[3] !== parts[3].trim() ||
      parts.slice(3).some((part) => !isSafeFirebaseKey(part))
    ) {
      continue;
    }
    const target = { playerId: parts[1], matchId: parts[3] };
    targets.set(`${target.playerId}/${target.matchId}`, target);
  }
  return [...targets.values()];
}

async function boundedNotification(
  work: (signal: AbortSignal) => Promise<void>,
  {
    timeoutMs = 1_000,
    logFailure = () => console.error({ event: "match_sync_notify_failed" }),
  }: InviteRoomNotificationOptions,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("match-sync-notify-timeout"));
        }, timeoutMs);
      }),
    ]);
  } catch {
    logFailure();
  } finally {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function notifyMatchSyncChanged(
  env: Env,
  updates: Record<string, unknown>,
  options: MatchSyncNotificationOptions = {},
): Promise<void> {
  const targets = changedMatchSyncTargets(updates);
  if (!targets.length || !env.INVITE_REACTIONS) return;
  await boundedNotification(async (signal) => {
    const resolved = await Promise.all(
      targets.map(async (target) => ({
        target,
        inviteId: await (
          options.resolveInvite ||
          ((value: MatchSyncTarget) =>
            readResolvedLoginMatchInviteId(
              env.PROFILE_GAMES_DB,
              value.playerId,
              value.matchId,
            ))
        )(target),
      })),
    );
    signal.throwIfAborted();
    const rooms = new Map<string, Set<string>>();
    for (const { target, inviteId } of resolved) {
      if (!isSafeFirebaseKey(inviteId) || inviteId !== inviteId.trim())
        continue;
      const matchIds = rooms.get(inviteId) || new Set<string>();
      matchIds.add(target.matchId);
      rooms.set(inviteId, matchIds);
    }
    await Promise.all(
      [...rooms].map(async ([inviteId, matchIds]) => {
        signal.throwIfAborted();
        await env.INVITE_REACTIONS.getByName(inviteId).notifyMatchesChanged(
          inviteId,
          [...matchIds],
        );
      }),
    );
  }, options);
}

export async function notifyMatchSyncInvites(
  env: Env,
  inviteIds: string[],
  options: InviteRoomNotificationOptions = {},
): Promise<void> {
  const ids = [...new Set(inviteIds)].filter(
    (id) => isSafeFirebaseKey(id) && id === id.trim(),
  );
  if (!ids.length || !env.INVITE_REACTIONS) return;
  await boundedNotification(async (signal) => {
    await Promise.all(
      ids.map(async (inviteId) => {
        signal.throwIfAborted();
        await env.INVITE_REACTIONS.getByName(inviteId).notifyMatchesChanged(
          inviteId,
        );
      }),
    );
  }, options);
}
