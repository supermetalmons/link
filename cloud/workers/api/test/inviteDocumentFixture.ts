import {
  readInviteDocument,
  type InviteDocument,
} from "@mons/shared/invite-records";
import { isRematchSeries, type RematchSeries } from "@mons/shared/rematches";

function fields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid invite fixture");
  return Object.fromEntries(Object.entries(value));
}
export function rematchSeriesFixture(value: unknown): RematchSeries {
  if (isRematchSeries(value)) return value;
  if (value === undefined || value === null || value === "")
    return { state: "open", indices: [] };
  if (typeof value !== "string") throw new TypeError("invalid rematch fixture");
  const ended = value.endsWith("x");
  const encoded = ended ? value.slice(0, -1) : value;
  const result = {
    state: ended ? "ended" : "open",
    indices: encoded ? encoded.split(";").map(Number) : [],
  };
  if (!isRematchSeries(result)) throw new TypeError("invalid rematch fixture");
  return result;
}
export function inviteDocumentFixture<Source extends object>(
  value: Source,
): InviteDocument & Omit<Source, keyof InviteDocument> {
  const source = fields(value);
  const event =
    source.eventOwned === true || typeof source.eventId === "string";
  const automatch =
    !event &&
    (source.kind === "automatch" ||
      (source.kind === undefined &&
        ((typeof source.password === "string" && source.password !== "") ||
          source.automatchStateHint != null ||
          source.telegramDeliveryVersion != null ||
          source.automatchOperationIds != null)));
  const invite = readInviteDocument({
    schemaVersion: 1,
    version: 2,
    kind: event ? "event" : automatch ? "automatch" : "manual",
    hostId: "host",
    hostColor: "white",
    sessionTransition: null,
    automatchMessage: null,
    automatchOperationIds: {},
    automatchStateHint: null,
    automatchCanceledAt: source.automatchStateHint === "canceled" ? 1 : null,
    telegramDeliveryVersion: null,
    eventOwned: event,
    eventId: null,
    eventRoundIndex: event ? 0 : null,
    eventMatchKey: event ? "0_0" : null,
    ...source,
    password:
      source.password === ""
        ? automatch
          ? "fixture-password"
          : null
        : (source.password ?? (automatch ? "fixture-password" : null)),
    guestId: source.guestId === "" ? null : (source.guestId ?? null),
    hostRematches: rematchSeriesFixture(source.hostRematches),
    guestRematches: rematchSeriesFixture(source.guestRematches),
  });
  if (!invite) throw new TypeError("invalid invite fixture");
  return Object.assign({}, value, invite);
}
export function retainedInviteSourceFixture(
  value: unknown,
): InviteDocument | null {
  return value === null ? null : inviteDocumentFixture(fields(value));
}
export function inviteRecordFixture(
  value: InviteDocument,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}
export function invokeInviteCompatibilityFixture<
  Operation extends (...args: never[]) => unknown,
>(operation: Operation, ...args: unknown[]): ReturnType<Operation> {
  return Reflect.apply(operation, undefined, args);
}
