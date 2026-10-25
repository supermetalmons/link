import type { InviteDocument } from "@mons/shared/invite-records";
import { AuthApiFailure } from "./authErrors.ts";
import {
  parseAutomatchRuntimeControlRow,
  prepareAutomatchRuntimeControlRead,
} from "./automatchD1.ts";
import {
  assertNoGameSessionResourceTransition,
  prepareGameSessionResourceTransitionRead,
} from "./gameSessionTransitions.ts";
import {
  decodeInviteSourceSnapshot,
  InviteSourceFailure,
  parseInviteSourceControlRow,
  prepareInviteSourceControlRead,
  prepareInviteSourceSnapshotRead,
} from "./inviteSourceD1.ts";

export async function readGameBootstrapAdmission(
  db: D1Database,
  inviteId: string,
  signal: AbortSignal,
): Promise<InviteDocument | null> {
  signal.throwIfAborted();
  const session = db.withSession("first-primary");
  const [modeRows, controlRows, transitionRows, sourceRows] =
    await session.batch([
      prepareAutomatchRuntimeControlRead(session),
      prepareInviteSourceControlRead(session),
      prepareGameSessionResourceTransitionRead(session, inviteId),
      prepareInviteSourceSnapshotRead(session, inviteId),
    ]);
  signal.throwIfAborted();
  const mode = parseAutomatchRuntimeControlRow(modeRows.results[0]);
  const control = parseInviteSourceControlRow(controlRows.results[0]);
  if (mode.backend !== "d1")
    throw new AuthApiFailure(
      503,
      "unavailable",
      "automatch-persistence-backend-retired",
    );
  if (control.backend !== "d1")
    throw new InviteSourceFailure("invite-source-backend-retired");
  assertNoGameSessionResourceTransition(transitionRows.results[0]);
  return decodeInviteSourceSnapshot(inviteId, sourceRows.results[0]).value;
}
