import type {
  MatchDocument,
  MatchCreationWrite,
  MatchCreationInput,
  RetainedMatchValue,
} from "../src/matchRecordCodec.ts";
import type { MatchStatePort } from "../src/repositoryContracts.ts";
import type {
  MatchStateRpc,
  unwrapMatchStateRpc,
} from "../src/matchStateRpc.ts";
import type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";
import type { EventEffect } from "../../../runtime/eventCommands.js";
import type { MatchCreationRecord } from "@mons/shared/match-protocol";

type Assert<T extends true> = T;
type Rejects<Value, Contract> = Value extends Contract ? false : true;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;

export type MatchDocumentsHaveNoStringIndex = Assert<
  string extends keyof MatchDocument ? false : true
>;
export type OrdinaryRecordsDoNotBecomeDocuments = Assert<
  Rejects<{ fen: string }, MatchDocument>
>;
export type FreshCreationRetainsControllerVersion = Assert<
  Equal<MatchCreationWrite["version"], 2>
>;
export type FreshCreationCannotStartTerminal = Assert<
  Rejects<"surrendered", MatchCreationWrite["status"]>
>;
export type FreshCreationCannotContainHistory = Assert<
  Rejects<"a-b", MatchCreationWrite["flatMovesString"]>
>;
export type FreshCreationCannotContainTimer = Assert<
  Rejects<"7;100", MatchCreationWrite["timer"]>
>;
export type FreshCreationRequiresColor = Assert<
  Rejects<Omit<MatchCreationWrite, "color">, MatchCreationWrite>
>;
export type RetainedCreationIsAnExplicitOutcome = Assert<
  Rejects<{ fen: string }, MatchCreationInput>
>;
export type MatchReadPreservesRetainedSource = Assert<
  Equal<
    Awaited<ReturnType<MatchStatePort["readMatchRecord"]>>,
    RetainedMatchValue
  >
>;
export type SessionCreationRejectsAnArbitraryBag = Assert<
  Rejects<
    {
      kind: "match-create";
      playerId: string;
      matchId: string;
      value: { fen: string };
    },
    GameSessionChange
  >
>;
export type EventCreationRejectsAnArbitraryBag = Assert<
  Rejects<
    {
      kind: "match-creation";
      playerId: string;
      matchId: string;
      value: { fen: string };
    },
    EventEffect
  >
>;
export type MirroredCreationRetainsStatusHistoryAndTimer = Assert<
  {
    version: 2;
    color: "black";
    emojiId: 1;
    aura: "";
    gameVariant: "Classic";
    fen: "restored";
    status: "surrendered";
    flatMovesString: "a-b";
    timer: "7;100";
  } extends MatchCreationRecord
    ? true
    : false
>;
export type RpcUnwrapRequiresDecoder = Assert<
  Equal<Parameters<typeof unwrapMatchStateRpc>["length"], 2>
>;
export type RealRpcRecordResultIsSerializable = Assert<
  [Awaited<ReturnType<MatchStateRpc["readCanonicalMatchRecord"]>>] extends [
    never,
  ]
    ? false
    : true
>;
export type RealRpcCreateResultIsSerializable = Assert<
  [Awaited<ReturnType<MatchStateRpc["createCanonicalMatch"]>>] extends [never]
    ? false
    : true
>;
