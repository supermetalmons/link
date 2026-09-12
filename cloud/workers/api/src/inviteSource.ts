import { readAutomatchRuntimeControl } from "./automatchD1.ts";
import { assertGameSessionResourceAvailable } from "./gameSessionTransitions.ts";
import {
  createInviteSourceD1Store,
  InviteSourceFailure,
  readInviteSourceControl,
} from "./inviteSourceD1.ts";
export function createInviteSourceReader(
  env: Pick<Env, "PROFILE_GAMES_DB">,
): (inviteId: string) => Promise<unknown> {
  const source = createInviteSourceD1Store(env.PROFILE_GAMES_DB);
  return async (inviteId) => {
    const mode = await readAutomatchRuntimeControl(env.PROFILE_GAMES_DB);
    const control = await readInviteSourceControl(env.PROFILE_GAMES_DB);
    if (mode.backend !== "d1" && control.backend === "d1") {
      throw new InviteSourceFailure("invite-source-session-backend-conflict");
    }
    if (control.backend !== "d1") {
      throw new InviteSourceFailure("invite-source-not-activated");
    }
    await assertGameSessionResourceAvailable(env.PROFILE_GAMES_DB, inviteId);
    const snapshot = await source.read(inviteId);
    await assertGameSessionResourceAvailable(env.PROFILE_GAMES_DB, inviteId);
    return snapshot.value;
  };
}
