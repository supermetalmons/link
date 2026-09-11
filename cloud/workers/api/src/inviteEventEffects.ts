import { STATE_EFFECTS_FIELD } from "./stateCompatibility.ts";
import { STATE_VALUE_FIELD } from "./stateCompatibility.ts";
import { MAX_EVENT_PARTICIPANTS } from "@mons/shared/events";
import { normalizeHistoricalMatchRecord } from "@mons/shared/game-sessions";
import {
  MATCH_TIMER_CLAIM_ROOT,
  MATCH_TIMER_TERMINAL,
} from "@mons/shared/timers";
import type {
  EventInviteSourceMutation,
  EventTransitionIntent,
} from "./eventD1.ts";
import type { StateRepository } from "./stateRepositoryTypes.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import type {
  MatchStateEventEffectsRequest,
  MatchStateRecord,
} from "./matchStateTypes.ts";
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
  normalizeInviteSource,
  readInviteSourceControl,
  releaseInviteSourceAdmission,
} from "./inviteSourceD1.ts";
import {
  buildLoginMatchDiscoveryStatements,
  readResolvedLoginMatchInviteId,
  type LoginMatchDiscoveryInput,
} from "./loginMatchDiscoveryD1.ts";
import {
  buildMatchPresentationRegistrationStatements,
  type MatchPresentationRegistration,
  type PrepareMatchPresentations,
} from "./matchPresentationRegistry.ts";

type V2Intent = Extract<EventTransitionIntent, { schemaVersion: 2 }>;
type JsonRecord = Record<string, unknown>;
type EventEffectReceipt = {
  event_id: string;
  payload_digest: string;
};

async function applyTypedMatchEffects(
  db: D1Database,
  raw: StateRepository,
  intent: V2Intent,
  creations: [string, JsonRecord][],
  otherEffects: JsonRecord,
  signal?: AbortSignal,
): Promise<void> {
  if (!raw.applyMatchEventEffects)
    throw new Error("event-match-effects-unavailable");
  const groups = new Map<
    string,
    Omit<MatchStateEventEffectsRequest, "epoch">
  >();
  const group = (inviteId: string) => {
    let value = groups.get(inviteId);
    if (!value) {
      value = {
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
  for (const [path, value] of creations) {
    const [, playerId, , matchId] = path.split("/");
    group(matchId).creations!.push({
      playerId,
      matchId,
      value: value as MatchStateRecord,
      marker: await digest({
        transitionId: intent.transitionId,
        payloadDigest: intent.payloadDigest,
        path,
      }),
    });
  }
  for (const [path, value] of Object.entries(otherEffects)) {
    const parts = path.split("/");
    if (parts[0] !== MATCH_TIMER_CLAIM_ROOT) continue;
    if (
      !record(value) ||
      !isSafeRecordKey(value.inviteId) ||
      !isCanonicalLoginUid(value.playerId) ||
      !isCanonicalLoginUid(value.opponentId)
    )
      throw new Error("event-match-claim-invalid");
    group(value.inviteId).claims!.push({
      matchId: parts[1],
      playerId: value.playerId,
      opponentId: value.opponentId,
      claim: value as MatchStateRecord,
    });
  }
  for (const path of Object.keys(otherEffects)) {
    const parts = path.split("/");
    if (parts[0] !== "players") continue;
    const [, playerId, , matchId] = parts;
    const claim = otherEffects[`${MATCH_TIMER_CLAIM_ROOT}/${matchId}`];
    const inviteId =
      record(claim) && typeof claim.inviteId === "string"
        ? claim.inviteId
        : await readResolvedLoginMatchInviteId(db, playerId, matchId);
    if (!inviteId) throw new Error("event-match-route-unavailable");
    group(inviteId).terminalTimers!.push({ matchId, playerId });
  }
  for (const input of groups.values()) {
    signal?.throwIfAborted();
    await raw.applyMatchEventEffects(input, signal);
  }
  const cleanup = Object.keys(otherEffects).filter((path) =>
    path.startsWith("matchTimerStarts/"),
  );
  if (cleanup.length) {
    await db.batch(
      cleanup.map((path) => {
        const [, matchId, playerId] = path.split("/");
        return db
          .prepare(
            "DELETE FROM match_timer_starts WHERE match_id = ? AND player_id = ?",
          )
          .bind(matchId, playerId);
      }),
    );
  }
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  throw new Error("event-transition-invalid-effect");
}

async function digest(value: unknown): Promise<string> {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(result), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function resolveTimestamps(value: unknown, nowMs: number): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => resolveTimestamps(child, nowMs));
  }
  if (!record(value)) {
    canonical(value);
    return value;
  }
  if (Object.hasOwn(value, STATE_VALUE_FIELD)) {
    if (
      Object.keys(value).length !== 1 ||
      value[STATE_VALUE_FIELD] !== "timestamp"
    ) {
      throw new Error("event-transition-invalid-server-value");
    }
    return nowMs;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      resolveTimestamps(child, nowMs),
    ]),
  );
}

export function eventInviteSourceUpdates(
  effects: Readonly<JsonRecord>,
): JsonRecord {
  return Object.fromEntries(
    Object.entries(effects).filter(([path]) => path.startsWith("invites/")),
  );
}

function digestInput(intent: Omit<V2Intent, "payloadDigest">) {
  return {
    transitionId: intent.transitionId,
    eventId: intent.eventId,
    expectedRevision: intent.expectedRevision,
    sourceEpoch: intent.sourceEpoch,
    canonicalUpdates: intent.canonicalUpdates,
    inviteMutations: intent.inviteMutations,
    [STATE_EFFECTS_FIELD]: intent[STATE_EFFECTS_FIELD],
    createdAtMs: intent.createdAtMs,
  };
}

function effectLayout(intent: V2Intent): {
  creations: [string, JsonRecord][];
  otherEffects: JsonRecord;
  discovery: LoginMatchDiscoveryInput[];
} {
  const creations: [string, JsonRecord][] = [];
  const otherEffects: JsonRecord = {};
  const discovery: LoginMatchDiscoveryInput[] = [];
  const sources = new Map(
    intent.inviteMutations.map((mutation) => [
      mutation.current.inviteId,
      mutation,
    ]),
  );
  const paths = Object.keys(intent[STATE_EFFECTS_FIELD]);
  if (paths.length > MAX_EVENT_PARTICIPANTS * 4) {
    throw new Error("event-transition-too-many-effects");
  }
  for (const [path, value] of Object.entries(intent[STATE_EFFECTS_FIELD])) {
    const parts = path.split("/");
    if (
      parts.some((part) => !isSafeRecordKey(part)) ||
      parts[0] === "invites" ||
      parts[0] === "eventTransitionReceipts" ||
      paths.some((other) => other !== path && path.startsWith(`${other}/`))
    ) {
      throw new Error("event-transition-invalid-effect-path");
    }
    if (parts[0] === "players" && parts[2] === "matches") {
      if (parts.length === 4) {
        const source = sources.get(parts[3]);
        if (
          !record(value) ||
          Object.hasOwn(value, "sessionCreation") ||
          !source ||
          !isCanonicalLoginUid(parts[1]) ||
          source.value.eventId !== intent.eventId ||
          !isCanonicalLoginUid(source.value.hostId) ||
          !isCanonicalLoginUid(source.value.guestId) ||
          source.value.hostId === source.value.guestId ||
          ![source.value.hostId, source.value.guestId].includes(parts[1])
        ) {
          throw new Error("event-transition-invalid-match-creation");
        }
        creations.push([path, value]);
        discovery.push({
          loginUid: parts[1],
          matchId: parts[3],
          inviteId: parts[3],
          resolution: "resolved",
          provenance: "capture",
        });
      } else if (
        parts.length === 5 &&
        parts[4] === "timer" &&
        value === MATCH_TIMER_TERMINAL
      ) {
        otherEffects[path] = value;
      } else {
        throw new Error("event-transition-invalid-match-effect");
      }
    } else {
      if (!(
        (parts[0] === "matchTimerStarts" &&
          parts.length === 3 &&
          value === null) ||
        (parts[0] === MATCH_TIMER_CLAIM_ROOT &&
          parts.length === 2 &&
          record(value) &&
          value.status === "claimed")
      )) {
        throw new Error("event-transition-invalid-effect-path");
      }
      otherEffects[path] = value;
    }
  }
  for (const mutation of intent.inviteMutations) {
    if (
      canonical(normalizeInviteSource(mutation.value)) !==
        canonical(mutation.value) ||
      (mutation.current.value !== null &&
        canonical(normalizeInviteSource(mutation.current.value)) !==
          canonical(mutation.current.value))
    ) {
      throw new Error("event-transition-invalid-invite-source");
    }
    const { inviteId } = mutation.current;
    if (mutation.value.eventId !== intent.eventId) {
      throw new Error("event-transition-invite-owner-conflict");
    }
    if (mutation.current.value !== null) {
      if (mutation.current.value.eventId !== intent.eventId) {
        throw new Error("event-transition-invite-owner-conflict");
      }
      if (creations.some(([path]) => path.split("/")[3] === inviteId)) {
        throw new Error("event-transition-invite-already-exists");
      }
    }
    if (
      mutation.current.value === null &&
      (!isCanonicalLoginUid(mutation.value.hostId) ||
        !isCanonicalLoginUid(mutation.value.guestId) ||
        !paths.includes(
          `players/${mutation.value.hostId}/matches/${inviteId}`,
        ) ||
        !paths.includes(
          `players/${mutation.value.guestId}/matches/${inviteId}`,
        ))
    ) {
      throw new Error("event-transition-invite-matches-missing");
    }
  }
  return { creations, otherEffects, discovery };
}

export async function prepareInviteEventIntent(
  db: D1Database,
  intent: Extract<EventTransitionIntent, { schemaVersion: 1 }>,
  signal?: AbortSignal,
): Promise<V2Intent> {
  const control = await readInviteSourceControl(db);
  if (control.backend !== "d1" || control.state !== "active") {
    throw new Error("event-invite-source-unavailable");
  }
  const inviteMutations: EventInviteSourceMutation[] =
    await createInviteSourceD1Store(db).preparePatch(
      eventInviteSourceUpdates(intent[STATE_EFFECTS_FIELD]),
      intent.createdAtMs,
      signal,
    );
  const next: Omit<V2Intent, "payloadDigest"> = {
    ...intent,
    schemaVersion: 2,
    sourceEpoch: control.epoch,
    inviteMutations,
    [STATE_EFFECTS_FIELD]: Object.fromEntries(
      Object.entries(intent[STATE_EFFECTS_FIELD])
        .filter(([path]) => !path.startsWith("invites/"))
        .map(([path, value]) => [
          path,
          resolveTimestamps(value, intent.createdAtMs),
        ]),
    ),
  };
  const prepared = { ...next, payloadDigest: await digest(digestInput(next)) };
  effectLayout(prepared);
  return prepared;
}

async function readEffectReceipt(
  db: D1Database,
  intent: V2Intent,
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
    receipt.payload_digest !== intent.payloadDigest
  ) {
    throw new Error("event-invite-effect-receipt-conflict");
  }
  return true;
}

export async function applyInviteEventEffects(
  db: D1Database,
  raw: StateRepository,
  intent: V2Intent,
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
  raw: StateRepository,
  intent: V2Intent,
  signal?: AbortSignal,
  prepareMatchPresentations?: PrepareMatchPresentations,
): Promise<void> {
  if ((await digest(digestInput(intent))) !== intent.payloadDigest) {
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
    payloadDigest: intent.payloadDigest,
  };
  const admission = await acquireInviteSourceAdmission(
    db,
    EVENT_RECEIPT_ADMISSION_KIND,
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
            creations.map(async ([path, value]) => {
              const match = normalizeHistoricalMatchRecord(value);
              if (!match)
                throw new Error("event-match-presentation-creation-invalid");
              const [, actorUid, , matchId] = path.split("/");
              return {
                inviteId: matchId,
                matchId,
                actorUid,
                emojiId: match.emojiId,
                aura: match.aura,
                sourceId: await digest({
                  transitionId: intent.transitionId,
                  payloadDigest: intent.payloadDigest,
                  path,
                }),
              };
            }),
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
    try {
      await db.batch([
        ...guards(),
        ...store.buildRevisionGuardStatements(intent.inviteMutations),
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
      if (raw.applyMatchEventEffects) {
        await assertWritable();
        await applyTypedMatchEffects(
          db,
          raw,
          intent,
          creations,
          otherEffects,
          signal,
        );
      } else {
        for (const [path, value] of creations) {
          await assertWritable();
          const marker = await digest({
            transitionId: intent.transitionId,
            payloadDigest: intent.payloadDigest,
            path,
          });
          await raw.transactPath(
            path,
            (current) => {
              if (current !== null && current !== undefined) {
                if (record(current) && current.sessionCreation === marker) {
                  return { commit: false, decision: "applied" };
                }
                throw new Error("event-match-creation-conflict");
              }
              return {
                value: { ...value, sessionCreation: marker },
                decision: "created",
              };
            },
            signal,
            assertWritable,
          );
        }
        if (Object.keys(otherEffects).length) {
          await assertWritable();
          await raw.patchRoot(otherEffects, signal);
        }
      }
      await assertWritable();
      await ensureEventTransitionReceipt(db, expectedReceipt, {
        recordedAtMs: Date.now(),
        guards,
        signal,
      });
    }
    const registrations = await preparePresentations();
    signal?.throwIfAborted();
    try {
      await db.batch([
        ...guards(),
        ...eventTransitionReceiptGuardStatements(db, expectedReceipt),
        ...store.buildRevisionGuardStatements(intent.inviteMutations),
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
            intent.payloadDigest,
            intent.createdAtMs,
          ),
        ...store.buildCommitStatements(
          intent.inviteMutations,
          intent.createdAtMs,
        ),
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
