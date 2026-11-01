import {
  readMatchDocument,
  readMatchCreationInput,
  type MatchDocument,
} from "../src/matchRecordCodec.ts";
import {
  unwrapMatchStateRpc,
  type MatchStateRpcResult,
} from "../src/matchStateRpc.ts";

function fixtureFields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid-match-fixture");
  return Object.fromEntries(Object.entries(value));
}

export function matchDocumentFixture<Source extends object>(
  value: Source,
): MatchDocument & Omit<Source, keyof MatchDocument> {
  const fields = fixtureFields(value);
  const rawTimer = fields.timer;
  const timer =
    rawTimer === undefined || rawTimer === null || rawTimer === ""
      ? { state: "idle" }
      : rawTimer === "gg"
        ? { state: "finished" }
        : typeof rawTimer === "string" && /^\d+;\d+$/.test(rawTimer)
          ? {
              state: "running",
              turnNumber: Number(rawTimer.split(";")[0]),
              deadlineAtMs: Number(rawTimer.split(";")[1]),
            }
          : rawTimer;
  const document = readMatchDocument({
    schemaVersion: 1,
    version: 2,
    color: "white",
    gameVariant: "Classic",
    fen: "initial",
    flatMovesString: "",
    sessionCreation: null,
    reaction: null,
    ...fields,
    status:
      fields.status === undefined || fields.status === ""
        ? "active"
        : fields.status,
    aura:
      fields.aura === undefined || fields.aura === null || fields.aura === ""
        ? "none"
        : fields.aura,
    emojiId:
      typeof fields.emojiId === "string"
        ? Number(fields.emojiId)
        : (fields.emojiId ?? 1),
    timer,
  });
  if (!document) throw new TypeError("invalid-match-fixture");
  return Object.assign({}, value, document);
}

export function matchRecordFixture(
  value: unknown,
): Record<string, unknown> | null {
  return value === null
    ? null
    : Object.fromEntries(
        Object.entries(matchDocumentFixture(fixtureFields(value))),
      );
}

export function publicMatchFixture(value: object) {
  const {
    sessionCreation: _creation,
    reaction: _reaction,
    ...match
  } = matchDocumentFixture(value);
  return match;
}

export function matchCreationFixture(value: unknown) {
  return readMatchCreationInput(matchDocumentFixture(fixtureFields(value)));
}

export function retainedMatchFixture(value: unknown) {
  return value === null ? null : matchDocumentFixture(fixtureFields(value));
}

export function unwrapMatchStateWireFixture<Value>(
  result: MatchStateRpcResult<Value>,
): Value {
  return unwrapMatchStateRpc(result, (value) => {
    if (!result.ok || value !== result.value)
      throw new Error("unexpected RPC fixture value");
    return result.value;
  });
}
