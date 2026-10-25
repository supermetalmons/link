import {
  readInviteDocument,
  type InviteDocument,
} from "@mons/shared/invite-records";

export function inviteDocumentFixture<Source extends object>(
  value: Source,
): InviteDocument & Source {
  const invite = readInviteDocument(value);
  if (!invite) throw new TypeError("invalid invite fixture");
  return Object.assign(invite, value);
}

export function retainedInviteSourceFixture(
  value: unknown,
): InviteDocument | null {
  const invite = readInviteDocument(value);
  if (invite || value === null) return invite;
  return Reflect.apply((source: InviteDocument | null) => source, undefined, [
    value,
  ]);
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
