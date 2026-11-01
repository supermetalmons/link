import { isWagerRecord } from "./wagerModel.ts";
import { readInviteDocument } from "@mons/shared/invite-records";
import { normalizeRecordKey } from "@mons/shared/ids";
import {
  INVITE_WAGERS_MAX_MESSAGE_BYTES,
  isInviteWagersSnapshot,
  isPublicMatchWagerState,
  type InviteWagersSnapshot,
  type PublicMatchWagerState,
} from "@mons/shared/invite-wagers";
import {
  normalizeInviteMetadata,
  type InviteMetadataReadResult,
} from "./inviteMetadata.ts";

export type InviteWagersReadResult =
  | {
      status: "ok";
      snapshot: InviteWagersSnapshot;
      metadata: Extract<InviteMetadataReadResult, { status: "ok" }>;
    }
  | { status: "missing" | "invalid" };

export type InviteWagersSourceResult =
  | (Extract<InviteWagersReadResult, { status: "ok" }> & {
      fingerprint: string;
    })
  | { status: "missing" | "invalid" };

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SOURCE_DEPTH = 64;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeMatchWager(value: unknown): PublicMatchWagerState | null {
  if (!isWagerRecord(value)) return null;
  const wager: PublicMatchWagerState = {
    schemaVersion: 1,
    state: value.state,
    proposals: Object.fromEntries(
      Object.entries(value.proposals)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([uid, proposal]) => [
          uid,
          {
            material: proposal.material,
            count: proposal.count,
            createdAt: proposal.createdAt,
          },
        ]),
    ),
    proposedBy: Object.fromEntries(
      Object.entries(value.proposedBy).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    agreed:
      value.agreed === null
        ? null
        : {
            material: value.agreed.material,
            count: value.agreed.count,
            total: value.agreed.total,
            proposerId: value.agreed.proposerId,
            accepterId: value.agreed.accepterId,
            acceptedAt: value.agreed.acceptedAt,
          },
    resolved:
      value.resolved === null
        ? null
        : {
            material: value.resolved.material,
            count: value.resolved.count,
            total: value.resolved.total,
            winnerId: value.resolved.winnerId,
            loserId: value.resolved.loserId,
            resolvedAt: value.resolved.resolvedAt,
          },
    blocked:
      value.blocked === null
        ? null
        : { reason: value.blocked.reason, requiresManualReview: true },
  };
  return isPublicMatchWagerState(wager) ? wager : null;
}

function canonicalSource(value: unknown): string | null {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  const active = new Set<object>();
  let remaining = MAX_SOURCE_BYTES;
  const append = (part: string) => {
    if (part.length > remaining) throw new Error("source-too-large");
    remaining -= encoder.encode(part).byteLength;
    if (remaining < 0) throw new Error("source-too-large");
    parts.push(part);
  };
  const appendString = (part: string) => {
    if (part.length > remaining) throw new Error("source-too-large");
    append(JSON.stringify(part));
  };
  const visit = (entry: unknown, depth: number) => {
    if (depth > MAX_SOURCE_DEPTH) throw new Error("source-too-deep");
    if (entry === null || typeof entry === "boolean") {
      append(JSON.stringify(entry));
    } else if (typeof entry === "string") {
      appendString(entry);
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      append(JSON.stringify(entry));
    } else if (typeof entry === "object") {
      if (active.has(entry)) throw new Error("source-cycle");
      active.add(entry);
      if (Array.isArray(entry)) {
        append("[");
        for (let index = 0; index < entry.length; index++) {
          if (index > 0) append(",");
          visit(entry[index], depth + 1);
        }
        append("]");
      } else {
        const prototype = Object.getPrototypeOf(entry);
        if (prototype !== null && prototype !== Object.prototype) {
          throw new Error("source-not-json");
        }
        append("{");
        const source = entry as Record<string, unknown>;
        const keys = Object.keys(source).sort();
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index]!;
          if (index > 0) append(",");
          appendString(key);
          append(":");
          visit(source[key], depth + 1);
        }
        append("}");
      }
      active.delete(entry);
    } else {
      throw new Error("source-not-json");
    }
  };
  try {
    visit(value, 0);
    return parts.join("");
  } catch {
    return null;
  }
}

export async function normalizeInviteWagers(
  inviteId: string,
  value: unknown,
  knownMetadata?: InviteMetadataReadResult,
): Promise<InviteWagersSourceResult> {
  if (value === null || value === undefined) return { status: "missing" };
  const input = record(value);
  if (!input || Object.keys(input).length !== 3) return { status: "invalid" };
  const invite = readInviteDocument(input.invite);
  const markers = record(input.resolutionMarkers);
  if (
    !invite ||
    !markers ||
    Object.entries(markers).some(
      ([key, marker]) =>
        normalizeRecordKey(key) !== key || typeof marker !== "boolean",
    )
  )
    return { status: "invalid" };
  const metadata = knownMetadata ?? normalizeInviteMetadata(inviteId, invite);
  if (metadata.status !== "ok") return { status: "invalid" };
  if (
    metadata.snapshot.inviteId !== inviteId ||
    metadata.snapshot.hostId !== invite.hostId ||
    metadata.snapshot.guestId !== invite.guestId ||
    metadata.passwordProtected !== (invite.password !== null)
  ) {
    return { status: "invalid" };
  }
  const source = input.wagers;
  const rawWagers = record(source);
  if (!rawWagers) return { status: "invalid" };
  const canonical = canonicalSource({
    access: {
      hostId: metadata.snapshot.hostId,
      guestId: metadata.snapshot.guestId,
      passwordProtected: metadata.passwordProtected,
    },
    wagers: source,
  });
  if (canonical === null) return { status: "invalid" };
  const entries: [string, PublicMatchWagerState][] = [];
  for (const matchId of Object.keys(rawWagers).sort()) {
    const wager = normalizeMatchWager(rawWagers[matchId]);
    if (!wager) return { status: "invalid" };
    entries.push([matchId, wager]);
  }
  const snapshot = {
    inviteId,
    revision: 0,
    wagers: Object.fromEntries(entries),
  };
  if (
    !isInviteWagersSnapshot(snapshot) ||
    new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 1, type: "snapshot", snapshot }),
    ).byteLength > INVITE_WAGERS_MAX_MESSAGE_BYTES
  ) {
    return { status: "invalid" };
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return {
    status: "ok",
    snapshot,
    metadata,
    fingerprint: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
