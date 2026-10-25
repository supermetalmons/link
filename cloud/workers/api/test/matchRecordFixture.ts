import {
  readMatchDocument,
  readMatchCreationInput,
  readRetainedMatchValue,
  type MatchDocument,
} from "../src/matchRecordCodec.ts";
import {
  unwrapMatchStateRpc,
  type MatchStateRpcResult,
} from "../src/matchStateRpc.ts";

export function matchDocumentFixture<Source extends object>(
  value: Source,
): MatchDocument & Source {
  const document = readMatchDocument(value);
  if (!document) throw new TypeError("invalid-match-fixture");
  return Object.assign(document, value);
}

export function matchRecordFixture(
  value: unknown,
): Record<string, unknown> | null {
  const document = readMatchDocument(value);
  return document ? Object.fromEntries(Object.entries(document)) : null;
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

export {
  readMatchCreationInput as matchCreationFixture,
  readRetainedMatchValue as retainedMatchFixture,
};
