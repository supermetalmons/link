import { readMatchCreationInput } from "./matchRecordCodec.ts";
import { readInviteDocument } from "@mons/shared/invite-records";
import {
  record,
  canonical,
  digest,
  eventIntentPayloadDigest,
  eventIntentInviteChanges,
  prepareEventIntentEnvelope,
  completeEventIntentEnvelope,
  effectLayout,
} from "./eventTransitionCodec.ts";
import { normalizeHistoricalMatchRecord } from "@mons/shared/game-sessions";
import type {
  EventTransitionDraftInput,
  EventTransitionIntent,
} from "../../../runtime/eventTransitionRecords.js";
import type { MatchStatePort } from "./repositoryContracts.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import type { MatchStateEventEffectsRequest } from "./matchStateTypes.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import {
  EVENT_RECEIPT_ADMISSION_KIND,
  ensureEventTransitionReceipt,
  eventReceiptControlGuardStatements,
  eventTransitionReceiptGuardStatements,
  readEventTransitionReceipt,
} from "./eventTransitionReceiptsD1.ts";
import {
  acquireInviteSourceAdmission,
  createInviteSourceD1Store,
  inviteSourceAdmissionGuardStatements,
  inviteSourceControlGuardStatements,
  readInviteSourceControl,
  releaseInviteSourceAdmission,
  type InviteSourceMutation,
} from "./inviteSourceD1.ts";
import {
  buildLoginMatchDiscoveryStatements,
  readResolvedLoginMatchInviteId,
} from "./loginMatchDiscoveryD1.ts";
import {
  buildMatchPresentationRegistrationStatements,
  type MatchPresentationRegistration,
  type PrepareMatchPresentations,
} from "./matchPresentationRegistry.ts";

type EventEffectReceipt = {
  event_id: string;
  payload_digest: string;
};

async function applyTypedMatchEffects(
  db: D1Database,
  raw: MatchStatePort,
  intent: EventTransitionIntent,
  creations: ReturnType<typeof effectLayout>["creations"],
  otherEffects: ReturnType<typeof effectLayout>["otherEffects"],
  signal?: AbortSignal,
): Promise<void> {
  const groups = new Map<
    string,
    Omit<MatchStateEventEffectsRequest, "epoch">
  >();
  const group = (inviteId: string) => {
    let value = groups.get(inviteId);
    if (!value) {
      value = {
        schemaVersion: 1,
        inviteId,
        operationId: intent.transitionId,
        creations: [],
        claims: [],
        terminalTimers: [],
      };
      groups.set(inviteId, value);
    }
    return value;
  };
  for (const { markerPath: path, value, playerId, matchId } of creations) {
    group(matchId).creations.push({
      playerId,
      matchId,
      value: readMatchCreationInput(value),
      marker: await digest({
        transitionId: intent.transitionId,
        payloadDigest: intent.operationDigest,
        path,
      }),
    });
  }
  for (const effect of otherEffects) {
    if (effect.kind !== "match-timer-claim") continue;
    const value = effect.value;
    if (
      !record(value) ||
      !isSafeRecordKey(value.inviteId) ||
      !isCanonicalLoginUid(value.playerId) ||
      !isCanonicalLoginUid(value.opponentId)
    )
      throw new Error("event-match-claim-invalid");
    group(value.inviteId).claims.push({
      matchId: effect.matchId,
      playerId: value.playerId,
      opponentId: value.opponentId,
      claim: value,
    });
  }
  for (const effect of otherEffects) {
    if (effect.kind !== "match-terminal-timer") continue;
    const { playerId, matchId } = effect;
    const claimEffect = otherEffects.find(
      (candidate) =>
        candidate.kind === "match-timer-claim" && candidate.matchId === matchId,
    );
    const claim =
      claimEffect?.kind === "match-timer-claim" ? claimEffect.value : null;
    const inviteId =
      record(claim) && typeof claim.inviteId === "string"
        ? claim.inviteId
        : await readResolvedLoginMatchInviteId(db, playerId, matchId);
    if (!inviteId) throw new Error("event-match-route-unavailable");
    group(inviteId).terminalTimers.push({ matchId, playerId });
  }
  for (const input of groups.values()) {
    signal?.throwIfAborted();
    await raw.applyMatchEventEffects(input, signal);
  }
}

export async function prepareInviteEventIntent(
  db: D1Database,
  intent: EventTransitionDraftInput,
  signal?: AbortSignal,
): Promise<EventTransitionIntent> {
  const control = await readInviteSourceControl(db);
  if (control.backend !== "d1" || control.state !== "active") {
    throw new Error("event-invite-source-unavailable");
  }
  const inviteMutations: InviteSourceMutation[] =
    await createInviteSourceD1Store(db).prepareChanges(
      eventIntentInviteChanges(intent),
      intent.createdAtMs,
      signal,
    );
  const next = prepareEventIntentEnvelope(
    intent,
    control.epoch,
    inviteMutations,
  );
  return completeEventIntentEnvelope(
    next,
    await eventIntentPayloadDigest(next),
  );
}

async function readEffectReceipt(
  db: D1Database,
  intent: EventTransitionIntent,
): Promise<boolean> {
  const receipt = await db
    .withSession("first-primary")
    .prepare(
      "SELECT event_id, payload_digest FROM invite_event_effect_receipts WHERE transition_id = ?",
    )
    .bind(intent.transitionId)
    .first<EventEffectReceipt>();
  if (!receipt) return false;
  if (
    receipt.event_id !== intent.eventId ||
    receipt.payload_digest !== intent.operationDigest
  ) {
    throw new Error("event-invite-effect-receipt-conflict");
  }
  return true;
}

export async function applyInviteEventEffects(
  db: D1Database,
  raw: MatchStatePort,
  intent: EventTransitionIntent,
  signal?: AbortSignal,
  prepareMatchPresentations?: PrepareMatchPresentations,
): Promise<void> {
  await requireActiveDurableMatchState(db);
  return applyAdmittedInviteEventEffects(
    db,
    raw,
    intent,
    signal,
    prepareMatchPresentations,
  );
}

async function applyAdmittedInviteEventEffects(
  db: D1Database,
  raw: MatchStatePort,
  intent: EventTransitionIntent,
  signal?: AbortSignal,
  prepareMatchPresentations?: PrepareMatchPresentations,
): Promise<void> {
  if ((await eventIntentPayloadDigest(intent)) !== intent.payloadDigest) {
    throw new Error("event-transition-payload-conflict");
  }
  const { creations, otherEffects, discovery } = effectLayout(intent);
  const control = await readInviteSourceControl(db);
  if (
    control.backend !== "d1" ||
    control.state !== "active" ||
    control.epoch !== intent.sourceEpoch
  ) {
    throw new Error("event-invite-source-unavailable");
  }
  const expectedReceipt = {
    schemaVersion: 2 as const,
    transitionId: intent.transitionId,
    eventId: intent.eventId,
    expectedRevision: intent.expectedRevision,
    payloadDigest: intent.operationDigest,
  };
  const admission = await acquireInviteSourceAdmission(
    db,
    EVENT_RECEIPT_ADMISSION_KIND,
    { expectedControl: control },
  );
  const guards = () => [
    ...inviteSourceControlGuardStatements(db, control),
    ...inviteSourceAdmissionGuardStatements(db, admission),
    ...eventReceiptControlGuardStatements(db),
  ];
  const assertWritable = async () => {
    signal?.throwIfAborted();
    await db.batch(guards());
  };
  let presentations: MatchPresentationRegistration[] | null = null;
  const preparePresentations = async () => {
    if (presentations !== null) return presentations;
    signal?.throwIfAborted();
    presentations = prepareMatchPresentations
      ? await prepareMatchPresentations(
          await Promise.all(
            creations.map(
              async ({
                markerPath: path,
                value,
                playerId: actorUid,
                matchId,
              }) => {
                const match = normalizeHistoricalMatchRecord(value);
                if (!match)
                  throw new Error("event-match-presentation-creation-invalid");
                return {
                  inviteId: matchId,
                  matchId,
                  actorUid,
                  emojiId: match.emojiId,
                  aura: match.aura,
                  sourceId: await digest({
                    transitionId: intent.transitionId,
                    payloadDigest: intent.operationDigest,
                    path,
                  }),
                };
              },
            ),
          ),
        )
      : [];
    return presentations;
  };
  const hasCommittedEffects = async () => {
    if (!(await readEffectReceipt(db, intent))) return false;
    await db.batch(eventTransitionReceiptGuardStatements(db, expectedReceipt));
    const registrations = await preparePresentations();
    if (registrations.length) {
      signal?.throwIfAborted();
      await db.batch([
        ...guards(),
        ...eventTransitionReceiptGuardStatements(db, expectedReceipt),
        ...buildMatchPresentationRegistrationStatements(
          db,
          registrations,
          Date.now(),
        ),
      ]);
    }
    return true;
  };
  try {
    await assertWritable();
    if (await hasCommittedEffects()) return;
    const store = createInviteSourceD1Store(db);
    const inviteMutations = intent.inviteMutations.map(
      (mutation): InviteSourceMutation => {
        const value = readInviteDocument(mutation.value);
        const currentValue =
          mutation.current.value === null
            ? null
            : readInviteDocument(mutation.current.value);
        if (
          !value ||
          (mutation.current.value !== null && currentValue === null)
        ) {
          throw new Error("event-transition-invalid-invite-source");
        }
        return { current: { ...mutation.current, value: currentValue }, value };
      },
    );
    try {
      await db.batch([
        ...guards(),
        ...store.buildRevisionGuardStatements(inviteMutations),
      ]);
    } catch (error) {
      if (await hasCommittedEffects()) return;
      throw error;
    }
    const receipt = await readEventTransitionReceipt(db, intent.transitionId);
    if (receipt !== null && receipt !== undefined) {
      if (canonical(receipt) !== canonical(expectedReceipt)) {
        throw new Error("event-transition-receipt-conflict");
      }
    } else {
      await assertWritable();
      await applyTypedMatchEffects(
        db,
        raw,
        intent,
        creations,
        otherEffects,
        signal,
      );
      await assertWritable();
      await ensureEventTransitionReceipt(db, expectedReceipt, {
        recordedAtMs: Date.now(),
        guards,
        ...(signal ? { signal } : {}),
      });
    }
    const registrations = await preparePresentations();
    signal?.throwIfAborted();
    try {
      await db.batch([
        ...guards(),
        ...eventTransitionReceiptGuardStatements(db, expectedReceipt),
        ...store.buildRevisionGuardStatements(inviteMutations),
        ...buildMatchPresentationRegistrationStatements(
          db,
          registrations,
          Date.now(),
        ),
        db
          .prepare(
            `INSERT INTO invite_event_effect_receipts
             (transition_id, event_id, payload_digest, applied_at_ms)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(
            intent.transitionId,
            intent.eventId,
            intent.operationDigest,
            intent.createdAtMs,
          ),
        ...store.buildCommitStatements(inviteMutations, intent.createdAtMs),
        ...buildLoginMatchDiscoveryStatements(
          db,
          discovery,
          intent.createdAtMs,
        ),
      ]);
    } catch (error) {
      if (!(await hasCommittedEffects())) throw error;
    }
  } finally {
    await releaseInviteSourceAdmission(db, admission);
  }
}
