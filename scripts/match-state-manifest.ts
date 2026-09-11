import { isSafeFirebaseKey } from "@mons/shared/ids";
import { createHash } from "node:crypto";
import {
  createInviteCandidatesFromMatchId,
  parseInviteMatchIndex,
  parseRematchIndices,
} from "@mons/shared/rematches";
import { digest, canonicalJson } from "./operator/runtime.ts";
import { matchStateCanonicalJson } from "../cloud/workers/api/src/matchStateMigration.ts";
import type {
  MatchStateImportSnapshot,
  MatchStateRecord,
} from "../cloud/workers/api/src/matchStateTypes.ts";

export type MatchSourceRecord = {
  actorUid: string;
  matchId: string;
  value: unknown;
};
export type MatchSourceClaim = { matchId: string; value: unknown };
export type MatchSourceInvite = {
  inviteId: string;
  value: Record<string, unknown>;
  revision: number;
};
export type MatchDiscoveryRow = {
  actorUid: string;
  matchId: string;
  inviteId: string | null;
  resolution: "resolved" | "missing" | "ambiguous";
};
export type MatchStateInventory = {
  records: MatchSourceRecord[];
  claims: MatchSourceClaim[];
  invites: MatchSourceInvite[];
  discovery: MatchDiscoveryRow[];
  crossChecks: unknown;
};
export type MatchRecordDescriptor = Omit<MatchSourceRecord, "value"> & {
  digest: string;
  inviteId: string | null;
  disposition:
    | "missing-invite"
    | "ambiguous-invite"
    | "nonparticipant"
    | "malformed"
    | null;
};
export type MatchClaimDescriptor = Omit<MatchSourceClaim, "value"> & {
  digest: string;
  inviteId: string | null;
  disposition: string | null;
};
export type MatchStateManifest = {
  schemaVersion: 1;
  importId: string;
  epoch: number;
  candidateVersionId: string;
  freezeGeneration: number;
  sourceDigest: string;
  records: MatchRecordDescriptor[];
  claims: MatchClaimDescriptor[];
  invites: Array<{ inviteId: string; digest: string }>;
  discoveryDigest: string;
  crossChecksDigest: string;
};

export function matchStateSourceFile(path: string): string {
  return `source-${digest(path)}.json`;
}

export function matchRecordPath(
  row: Pick<MatchSourceRecord, "actorUid" | "matchId">,
): string {
  return `players/${row.actorUid}/matches/${row.matchId}`;
}

export function matchClaimPath(row: Pick<MatchSourceClaim, "matchId">): string {
  return `matchTimerClaims/${row.matchId}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function key(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    isSafeFirebaseKey(value)
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique<T>(rows: readonly T[], identity: (value: T) => string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = identity(row);
    if (seen.has(id)) throw new Error("match-state-inventory-duplicate");
    seen.add(id);
  }
}

function inviteReferencesMatch(
  invite: MatchSourceInvite,
  matchId: string,
): boolean {
  const index = parseInviteMatchIndex(invite.inviteId, matchId);
  return (
    index === 0 ||
    (index !== null &&
      [
        ...parseRematchIndices(invite.value.hostRematches),
        ...parseRematchIndices(invite.value.guestRematches),
      ].includes(index))
  );
}

export function buildMatchStateManifest(
  inventory: MatchStateInventory,
  input: Pick<
    MatchStateManifest,
    "importId" | "epoch" | "candidateVersionId" | "freezeGeneration"
  >,
): MatchStateManifest {
  if (
    !key(input.importId) ||
    !Number.isSafeInteger(input.epoch) ||
    input.epoch < 2 ||
    !Number.isSafeInteger(input.freezeGeneration) ||
    input.freezeGeneration < 0 ||
    !/^[a-f0-9-]{36}$/.test(input.candidateVersionId)
  )
    throw new Error("invalid-match-state-manifest-identity");
  unique(inventory.records, matchRecordPath);
  unique(inventory.claims, matchClaimPath);
  unique(inventory.invites, (row) => row.inviteId);
  unique(inventory.discovery, (row) =>
    JSON.stringify([row.actorUid, row.matchId]),
  );
  const invites = new Map(
    inventory.invites.map((invite) => {
      if (
        !key(invite.inviteId) ||
        !record(invite.value) ||
        !key(invite.value.hostId) ||
        (invite.value.guestId != null && !key(invite.value.guestId)) ||
        !Number.isSafeInteger(invite.revision) ||
        invite.revision < 1
      )
        throw new Error("match-state-invalid-canonical-invite");
      return [invite.inviteId, invite];
    }),
  );
  const discovery = new Map(
    inventory.discovery.map((row) => [
      JSON.stringify([row.actorUid, row.matchId]),
      row,
    ]),
  );
  const relatedInvites = (matchId: string): MatchSourceInvite[] =>
    [
      ...new Set([matchId, ...createInviteCandidatesFromMatchId(matchId)]),
    ].flatMap((id) => {
      const invite = invites.get(id);
      return invite && inviteReferencesMatch(invite, matchId) ? [invite] : [];
    });
  const records: MatchRecordDescriptor[] = inventory.records
    .map((row): MatchRecordDescriptor => {
      if (!key(row.actorUid) || !key(row.matchId) || row.value === undefined)
        throw new Error("match-state-invalid-source-key");
      const captured = discovery.get(
        JSON.stringify([row.actorUid, row.matchId]),
      );
      const related = relatedInvites(row.matchId);
      const candidates = related.filter((invite) =>
        [invite.value.hostId, invite.value.guestId].includes(row.actorUid),
      );
      let invite: MatchSourceInvite | undefined;
      if (captured?.resolution === "resolved") {
        invite = captured.inviteId ? invites.get(captured.inviteId) : undefined;
        if (invite && !inviteReferencesMatch(invite, row.matchId))
          throw new Error("match-state-captured-mapping-conflict");
        if (
          candidates.some(
            (candidate) => candidate.inviteId !== captured.inviteId,
          )
        )
          throw new Error("match-state-canonical-mapping-conflict");
        if (
          invite &&
          ![invite.value.hostId, invite.value.guestId].includes(row.actorUid)
        )
          invite = undefined;
      } else if (candidates.length) {
        throw new Error("match-state-unresolved-playable-mapping");
      }
      if (invite && !record(row.value))
        throw new Error("match-state-malformed-playable-record");
      const nonparticipant = related.length > 0;
      return {
        actorUid: row.actorUid,
        matchId: row.matchId,
        digest: digest(row.value),
        inviteId: invite?.inviteId ?? null,
        disposition: invite
          ? null
          : !record(row.value)
            ? "malformed"
            : captured?.resolution === "ambiguous"
              ? "ambiguous-invite"
              : nonparticipant
                ? "nonparticipant"
                : "missing-invite",
      };
    })
    .sort(
      (left, right) =>
        compare(left.actorUid, right.actorUid) ||
        compare(left.matchId, right.matchId),
    );
  const claims: MatchClaimDescriptor[] = inventory.claims
    .map((row) => {
      if (!key(row.matchId) || row.value === undefined)
        throw new Error("match-state-invalid-claim-key");
      const candidates = relatedInvites(row.matchId);
      if (candidates.length > 1)
        throw new Error("match-state-claim-shared-by-multiple-invites");
      const value = record(row.value) ? row.value : null;
      const invite =
        typeof value?.inviteId === "string"
          ? candidates.find(
              (candidate) => candidate.inviteId === value.inviteId,
            )
          : undefined;
      if (
        candidates.length &&
        (!value ||
          !invite ||
          !candidates.some(
            (candidate) => candidate.inviteId === invite.inviteId,
          ) ||
          !key(value.playerId) ||
          !key(value.opponentId) ||
          value.playerId === value.opponentId ||
          ![invite.value.hostId, invite.value.guestId].includes(
            value.playerId,
          ) ||
          ![invite.value.hostId, invite.value.guestId].includes(
            value.opponentId,
          ))
      )
        throw new Error("match-state-unresolved-playable-claim");
      if (invite && value?.status === "pending")
        throw new Error("match-state-pending-claim-needs-reconciliation");
      if (invite && value?.status !== "claimed")
        throw new Error("match-state-malformed-playable-claim");
      return {
        matchId: row.matchId,
        digest: digest(row.value),
        inviteId: invite?.inviteId ?? null,
        disposition: invite ? null : "unreferenced-claim",
      };
    })
    .sort((left, right) => compare(left.matchId, right.matchId));
  const source = {
    records,
    claims,
    invites: inventory.invites
      .map((invite) => ({ inviteId: invite.inviteId, digest: digest(invite) }))
      .sort((left, right) => compare(left.inviteId, right.inviteId)),
    discoveryDigest: digest(
      [...inventory.discovery].sort(
        (left, right) =>
          compare(left.actorUid, right.actorUid) ||
          compare(left.matchId, right.matchId),
      ),
    ),
    crossChecksDigest: digest(inventory.crossChecks),
  };
  return {
    schemaVersion: 1,
    ...input,
    sourceDigest: digest(source),
    ...source,
  };
}

export function validateMatchStateManifest(value: unknown): MatchStateManifest {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !key(value.importId) ||
    !Number.isSafeInteger(value.epoch) ||
    Number(value.epoch) < 2 ||
    !Number.isSafeInteger(value.freezeGeneration) ||
    Number(value.freezeGeneration) < 0 ||
    typeof value.candidateVersionId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.candidateVersionId) ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.claims) ||
    !Array.isArray(value.invites) ||
    typeof value.discoveryDigest !== "string" ||
    typeof value.crossChecksDigest !== "string"
  )
    throw new Error("invalid-match-state-manifest");
  const manifest = value as MatchStateManifest;
  const { records, claims, invites, discoveryDigest, crossChecksDigest } =
    manifest;
  if (
    digest({ records, claims, invites, discoveryDigest, crossChecksDigest }) !==
    manifest.sourceDigest
  )
    throw new Error("match-state-manifest-digest-conflict");
  unique(records, matchRecordPath);
  unique(claims, matchClaimPath);
  unique(invites, (row) => row.inviteId);
  return manifest;
}

export function buildMatchStateBundle(
  manifest: MatchStateManifest,
  inviteId: string,
  readSource: (path: string) => unknown,
): MatchStateImportSnapshot {
  if (!manifest.invites.some((invite) => invite.inviteId === inviteId))
    throw new Error("match-state-invite-outside-manifest");
  const exact = (path: string, expected: string): MatchStateRecord => {
    const value = readSource(path);
    if (!record(value) || digest(value) !== expected)
      throw new Error("match-state-source-file-conflict");
    return value as MatchStateRecord;
  };
  const records = manifest.records
    .filter((row) => row.inviteId === inviteId)
    .map((row) => ({
      matchId: row.matchId,
      playerId: row.actorUid,
      value: exact(matchRecordPath(row), row.digest),
    }))
    .sort(
      (left, right) =>
        compare(left.matchId, right.matchId) ||
        compare(left.playerId, right.playerId),
    );
  const claims = manifest.claims
    .filter((row) => row.inviteId === inviteId)
    .map((row) => ({
      matchId: row.matchId,
      value: exact(matchClaimPath(row), row.digest),
    }))
    .sort((left, right) => compare(left.matchId, right.matchId));
  const source = {
    inviteId,
    epoch: manifest.epoch,
    importId: manifest.importId,
    records,
    claims,
  };
  return {
    ...source,
    digest: createHash("sha256")
      .update(matchStateCanonicalJson(source))
      .digest("hex"),
    recordCount: records.length,
    claimCount: claims.length,
  };
}

export function assertSameMatchStateSource(
  expected: MatchStateManifest,
  current: MatchStateManifest,
): void {
  if (
    expected.sourceDigest !== current.sourceDigest ||
    canonicalJson(expected) !== canonicalJson(current)
  )
    throw new Error("match-state-source-changed-refresh-export");
}
